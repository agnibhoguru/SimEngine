#pragma once

#include "price_level.hpp"
#include "types.hpp"

#include <array>
#include <cstdint>
#include <unordered_map>
#include <vector>

// ── OrderBook ─────────────────────────────────────────────────────────────────
// Central Limit Order Book.
//
// Price representation
//   All prices are stored as integer tick offsets from BASE_PRICE.
//   tick_offset = (price_in_ticks) - BASE_PRICE
//   Supported range: [BASE_PRICE, BASE_PRICE + TOTAL_LEVELS - 1]
//
// Level discovery
//   Two bitset arrays (one per side), each NUM_BLOCKS × 64-bit words.
//   A bit is set iff the corresponding PriceLevel is non-empty.
//   Best bid: highest set bit  → scanned with __builtin_clzll
//   Best ask: lowest  set bit  → scanned with __builtin_ctzll
//
// Cancel
//   unordered_map<OrderId, Order*> gives O(1) lookup for cancels.

class OrderBook {
public:
    // Base tick around which the 4096-level window is centred.
    static constexpr Price BASE_PRICE = 50000;   // e.g. represents $500.00

    explicit OrderBook();
    ~OrderBook();

    // Disable copy; moves are fine but not needed yet.
    OrderBook(const OrderBook&)            = delete;
    OrderBook& operator=(const OrderBook&) = delete;

    // ── Public Interface ──────────────────────────────────────────────────────

    // Submit an order. Returns fills produced. Order object is heap-allocated
    // and owned by the book (freed on fill/cancel or destructor).
    std::vector<Fill> submit(OrderId   id,
                             Side      side,
                             OrderType type,
                             Price     price,
                             Quantity  quantity,
                             Price     stop_price = 0);

    // Cancel a resting order by id. Returns true if found and cancelled.
    bool cancel(OrderId id);

    // ── Book State ────────────────────────────────────────────────────────────

    [[nodiscard]] Price    best_bid()      const noexcept;
    [[nodiscard]] Price    best_ask()      const noexcept;
    [[nodiscard]] Quantity bid_qty_at(Price tick) const noexcept;
    [[nodiscard]] Quantity ask_qty_at(Price tick) const noexcept;

private:
    // ── Storage ───────────────────────────────────────────────────────────────

    std::array<PriceLevel, TOTAL_LEVELS> bids_;   // indexed by tick offset
    std::array<PriceLevel, TOTAL_LEVELS> asks_;

    // Bitsets: bit i of block b is set iff level (b*64 + i) is non-empty.
    std::array<uint64_t, NUM_BLOCKS> bid_bits_;
    std::array<uint64_t, NUM_BLOCKS> ask_bits_;

    // O(1) cancel lookup
    std::unordered_map<OrderId, Order*> order_map_;

    // Stop-limit orders resting unmatched until triggered
    std::vector<Order*> stop_orders_;

    // ── Internal Helpers ──────────────────────────────────────────────────────

    // Convert absolute tick price → array index (0-based offset from BASE).
    [[nodiscard]] int  tick_to_index(Price tick) const noexcept;
    [[nodiscard]] bool index_valid(int idx)       const noexcept;

    // Bitset helpers
    void set_bit  (std::array<uint64_t, NUM_BLOCKS>& bits, int idx) noexcept;
    void clear_bit(std::array<uint64_t, NUM_BLOCKS>& bits, int idx) noexcept;

    // Returns index of highest set bit, or -1 if all zero (for bids).
    [[nodiscard]] int highest_set(const std::array<uint64_t, NUM_BLOCKS>& bits) const noexcept;
    // Returns index of lowest set bit, or -1 if all zero (for asks).
    [[nodiscard]] int lowest_set (const std::array<uint64_t, NUM_BLOCKS>& bits) const noexcept;

    // Core matching routines
    std::vector<Fill> match_limit    (Order* taker);
    std::vector<Fill> match_market   (Order* taker);
    std::vector<Fill> match_ioc      (Order* taker);
    std::vector<Fill> match_fok      (Order* taker);
    std::vector<Fill> match_stop_limit(Order* taker);

    // Execute a single fill between taker and the resting maker level.
    Fill execute_fill(Order* taker, Order* maker, PriceLevel& level, Price fill_price);

    // Place a fully unmatched (or partial) limit order onto the book.
    void rest_order(Order* o);

    // Check and trigger any stop orders after a trade at last_price.
    std::vector<Fill> trigger_stops(Price last_price, std::vector<Fill>& fills);
};
