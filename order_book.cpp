#include "order_book.hpp"
#include <algorithm>
#include <cassert>
#include <stdexcept>

// ─────────────────────────────────────────────────────────────────────────────
// Construction / Destruction
// ─────────────────────────────────────────────────────────────────────────────

OrderBook::OrderBook() {
    bid_bits_.fill(0);
    ask_bits_.fill(0);
}

OrderBook::~OrderBook() {
    for (auto& [id, ptr] : order_map_) delete ptr;
    for (auto* ptr : stop_orders_)     delete ptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Interface
// ─────────────────────────────────────────────────────────────────────────────

std::vector<Fill> OrderBook::submit(OrderId   id,
                                    Side      side,
                                    OrderType type,
                                    Price     price,
                                    Quantity  quantity,
                                    Price     stop_price)
{
    auto* o          = new Order{};
    o->id            = id;
    o->price         = price;
    o->stop_price    = stop_price;
    o->quantity      = quantity;
    o->filled        = 0;
    o->type          = type;
    o->side          = side;
    o->status        = OrderStatus::New;

    switch (type) {
        case OrderType::Limit:      return match_limit(o);
        case OrderType::Market:     return match_market(o);
        case OrderType::IOC:        return match_ioc(o);
        case OrderType::FOK:        return match_fok(o);
        case OrderType::StopLimit:  return match_stop_limit(o);
        default:
            o->status = OrderStatus::Rejected;
            delete o;
            return {};
    }
}

bool OrderBook::cancel(OrderId id) {
    auto it = order_map_.find(id);
    if (it == order_map_.end()) return false;

    Order* o = it->second;
    int    idx  = tick_to_index(o->price);

    if (o->side == Side::Buy) {
        bids_[idx].cancel(o);
        if (bids_[idx].empty()) clear_bit(bid_bits_, idx);
    } else {
        asks_[idx].cancel(o);
        if (asks_[idx].empty()) clear_bit(ask_bits_, idx);
    }

    order_map_.erase(it);
    // Note: Order memory is freed lazily by PriceLevel::prune_dead via front()
    // To avoid leaking, free here since we removed it from order_map_.
    delete o;
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Book State
// ─────────────────────────────────────────────────────────────────────────────

Price OrderBook::best_bid() const noexcept {
    int idx = highest_set(bid_bits_);
    return idx < 0 ? -1 : BASE_PRICE + idx;
}

Price OrderBook::best_ask() const noexcept {
    int idx = lowest_set(ask_bits_);
    return idx < 0 ? -1 : BASE_PRICE + idx;
}

Quantity OrderBook::bid_qty_at(Price tick) const noexcept {
    int idx = tick_to_index(tick);
    if (!index_valid(idx)) return 0;
    return bids_[idx].total_qty();
}

Quantity OrderBook::ask_qty_at(Price tick) const noexcept {
    int idx = tick_to_index(tick);
    if (!index_valid(idx)) return 0;
    return asks_[idx].total_qty();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bitset Helpers
// ─────────────────────────────────────────────────────────────────────────────

int OrderBook::tick_to_index(Price tick) const noexcept {
    return static_cast<int>(tick - BASE_PRICE);
}

bool OrderBook::index_valid(int idx) const noexcept {
    return idx >= 0 && idx < TOTAL_LEVELS;
}

void OrderBook::set_bit(std::array<uint64_t, NUM_BLOCKS>& bits, int idx) noexcept {
    bits[idx / 64] |= (uint64_t(1) << (idx % 64));
}

void OrderBook::clear_bit(std::array<uint64_t, NUM_BLOCKS>& bits, int idx) noexcept {
    bits[idx / 64] &= ~(uint64_t(1) << (idx % 64));
}

// Highest set bit = best bid (highest price).
// Scans blocks from high to low using __builtin_clzll.
int OrderBook::highest_set(const std::array<uint64_t, NUM_BLOCKS>& bits) const noexcept {
    for (int b = NUM_BLOCKS - 1; b >= 0; --b) {
        if (bits[b] == 0) continue;
        int bit = 63 - __builtin_clzll(bits[b]);
        return b * 64 + bit;
    }
    return -1;
}

// Lowest set bit = best ask (lowest price).
// Scans blocks from low to high using __builtin_ctzll.
int OrderBook::lowest_set(const std::array<uint64_t, NUM_BLOCKS>& bits) const noexcept {
    for (int b = 0; b < NUM_BLOCKS; ++b) {
        if (bits[b] == 0) continue;
        int bit = __builtin_ctzll(bits[b]);
        return b * 64 + bit;
    }
    return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: rest_order
// ─────────────────────────────────────────────────────────────────────────────

void OrderBook::rest_order(Order* o) {
    int idx = tick_to_index(o->price);
    if (!index_valid(idx)) {
        o->status = OrderStatus::Rejected;
        delete o;
        return;
    }

    if (o->side == Side::Buy) {
        bids_[idx].add(o);
        set_bit(bid_bits_, idx);
    } else {
        asks_[idx].add(o);
        set_bit(ask_bits_, idx);
    }

    order_map_[o->id] = o;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: execute_fill
// ─────────────────────────────────────────────────────────────────────────────

Fill OrderBook::execute_fill(Order* taker, Order* maker,
                              PriceLevel& level, Price fill_price)
{
    Quantity qty = std::min(taker->leaves(), maker->leaves());

    taker->fill(qty);
    maker->fill(qty);
    level.reduce_qty(qty);

    if (maker->is_dead()) {
        level.pop_front();
        // maker is owned by order_map_; erase so we don't double-free.
        order_map_.erase(maker->id);
        delete maker;
    }

    return Fill{ maker->id, taker->id, fill_price, qty };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: trigger_stops
// ─────────────────────────────────────────────────────────────────────────────

std::vector<Fill> OrderBook::trigger_stops(Price last_price, std::vector<Fill>& fills) {
    std::vector<Fill> stop_fills;
    std::vector<Order*> remaining;

    for (Order* s : stop_orders_) {
        bool triggered = false;
        if (s->side == Side::Buy  && last_price >= s->stop_price) triggered = true;
        if (s->side == Side::Sell && last_price <= s->stop_price) triggered = true;

        if (triggered) {
            // Convert to limit and match
            s->type = OrderType::Limit;
            auto f = match_limit(s);
            stop_fills.insert(stop_fills.end(), f.begin(), f.end());
        } else {
            remaining.push_back(s);
        }
    }

    stop_orders_ = std::move(remaining);
    fills.insert(fills.end(), stop_fills.begin(), stop_fills.end());
    return fills;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching: Limit
// ─────────────────────────────────────────────────────────────────────────────

std::vector<Fill> OrderBook::match_limit(Order* taker) {
    std::vector<Fill> fills;

    if (taker->side == Side::Buy) {
        // Match against asks from lowest price upward while price ≤ taker limit
        while (taker->leaves() > 0) {
            int ask_idx = lowest_set(ask_bits_);
            if (ask_idx < 0) break;

            Price ask_price = BASE_PRICE + ask_idx;
            if (ask_price > taker->price) break;   // no crossable ask

            PriceLevel& level = asks_[ask_idx];
            Order* maker = level.front();
            if (!maker) { clear_bit(ask_bits_, ask_idx); continue; }

            fills.push_back(execute_fill(taker, maker, level, ask_price));

            if (level.empty()) clear_bit(ask_bits_, ask_idx);
        }
    } else {
        // Match against bids from highest price downward while price ≥ taker limit
        while (taker->leaves() > 0) {
            int bid_idx = highest_set(bid_bits_);
            if (bid_idx < 0) break;

            Price bid_price = BASE_PRICE + bid_idx;
            if (bid_price < taker->price) break;   // no crossable bid

            PriceLevel& level = bids_[bid_idx];
            Order* maker = level.front();
            if (!maker) { clear_bit(bid_bits_, bid_idx); continue; }

            fills.push_back(execute_fill(taker, maker, level, bid_price));

            if (level.empty()) clear_bit(bid_bits_, bid_idx);
        }
    }

    // Rest any unfilled remainder
    if (taker->leaves() > 0 && !taker->is_dead()) {
        rest_order(taker);
    } else if (taker->leaves() == 0) {
        delete taker;   // fully filled taker, not resting
    }

    // Trigger any stop orders hit by the fills
    if (!fills.empty()) {
        Price last = fills.back().price;
        trigger_stops(last, fills);
    }

    return fills;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching: Market
// ─────────────────────────────────────────────────────────────────────────────

std::vector<Fill> OrderBook::match_market(Order* taker) {
    std::vector<Fill> fills;

    if (taker->side == Side::Buy) {
        while (taker->leaves() > 0) {
            int ask_idx = lowest_set(ask_bits_);
            if (ask_idx < 0) break;

            PriceLevel& level = asks_[ask_idx];
            Order* maker = level.front();
            if (!maker) { clear_bit(ask_bits_, ask_idx); continue; }

            fills.push_back(execute_fill(taker, maker, level, BASE_PRICE + ask_idx));

            if (level.empty()) clear_bit(ask_bits_, ask_idx);
        }
    } else {
        while (taker->leaves() > 0) {
            int bid_idx = highest_set(bid_bits_);
            if (bid_idx < 0) break;

            PriceLevel& level = bids_[bid_idx];
            Order* maker = level.front();
            if (!maker) { clear_bit(bid_bits_, bid_idx); continue; }

            fills.push_back(execute_fill(taker, maker, level, BASE_PRICE + bid_idx));

            if (level.empty()) clear_bit(bid_bits_, bid_idx);
        }
    }

    // Market orders do not rest; any unfilled qty is cancelled.
    if (taker->leaves() > 0) taker->status = OrderStatus::Cancelled;
    delete taker;

    if (!fills.empty()) {
        Price last = fills.back().price;
        trigger_stops(last, fills);
    }

    return fills;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching: IOC (Immediate-Or-Cancel)
// ─────────────────────────────────────────────────────────────────────────────

std::vector<Fill> OrderBook::match_ioc(Order* taker) {
    // IOC behaves like limit matching but never rests the remainder.
    std::vector<Fill> fills;

    if (taker->side == Side::Buy) {
        while (taker->leaves() > 0) {
            int ask_idx = lowest_set(ask_bits_);
            if (ask_idx < 0) break;
            Price ask_price = BASE_PRICE + ask_idx;
            if (ask_price > taker->price) break;

            PriceLevel& level = asks_[ask_idx];
            Order* maker = level.front();
            if (!maker) { clear_bit(ask_bits_, ask_idx); continue; }

            fills.push_back(execute_fill(taker, maker, level, ask_price));
            if (level.empty()) clear_bit(ask_bits_, ask_idx);
        }
    } else {
        while (taker->leaves() > 0) {
            int bid_idx = highest_set(bid_bits_);
            if (bid_idx < 0) break;
            Price bid_price = BASE_PRICE + bid_idx;
            if (bid_price < taker->price) break;

            PriceLevel& level = bids_[bid_idx];
            Order* maker = level.front();
            if (!maker) { clear_bit(bid_bits_, bid_idx); continue; }

            fills.push_back(execute_fill(taker, maker, level, bid_price));
            if (level.empty()) clear_bit(bid_bits_, bid_idx);
        }
    }

    // Never rest: cancel any remainder
    if (taker->leaves() > 0) taker->status = OrderStatus::Cancelled;
    delete taker;

    if (!fills.empty()) {
        Price last = fills.back().price;
        trigger_stops(last, fills);
    }

    return fills;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching: FOK (Fill-Or-Kill)
// ─────────────────────────────────────────────────────────────────────────────

std::vector<Fill> OrderBook::match_fok(Order* taker) {
    // Pre-check: can the full quantity be filled at the limit price?
    Quantity available = 0;

    if (taker->side == Side::Buy) {
        for (int b = 0; b < NUM_BLOCKS; ++b) {
            uint64_t word = ask_bits_[b];
            while (word) {
                int bit     = __builtin_ctzll(word);
                int idx     = b * 64 + bit;
                Price price = BASE_PRICE + idx;
                if (price > taker->price) goto fok_check_done;
                available += asks_[idx].total_qty();
                if (available >= taker->quantity) goto fok_check_done;
                word &= word - 1;   // clear lowest set bit
            }
        }
    } else {
        for (int b = NUM_BLOCKS - 1; b >= 0; --b) {
            uint64_t word = bid_bits_[b];   // local copy — never mutate bid_bits_ here
            while (word) {
                int bit     = 63 - __builtin_clzll(word);
                int idx     = b * 64 + bit;
                Price price = BASE_PRICE + idx;
                if (price < taker->price) goto fok_check_done;
                available += bids_[idx].total_qty();
                if (available >= taker->quantity) goto fok_check_done;
                word &= ~(uint64_t(1) << bit);   // clear processed bit in local copy only
            }
        }
    }

fok_check_done:
    if (available < taker->quantity) {
        // Kill the order — do not fill anything
        taker->status = OrderStatus::Cancelled;
        delete taker;
        return {};
    }

    // Full fill is possible: re-use IOC logic (which never rests)
    taker->type = OrderType::IOC;
    return match_ioc(taker);
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching: StopLimit
// ─────────────────────────────────────────────────────────────────────────────

std::vector<Fill> OrderBook::match_stop_limit(Order* taker) {
    // A stop-limit order rests in stop_orders_ until the stop price is touched.
    // It does NOT interact with the order_map_ until triggered.
    stop_orders_.push_back(taker);
    return {};
}
