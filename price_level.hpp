#pragma once

#include "order.hpp"
#include <deque>
#include <cstdint>

// ── PriceLevel ────────────────────────────────────────────────────────────────
// Maintains a FIFO queue of live Order pointers at a single price tick.
// Dead orders are removed lazily from the front on access (not on cancel).
// total_qty tracks visible resting quantity in O(1).

class PriceLevel {
public:
    PriceLevel() : total_qty_(0) {}

    // ── Accessors ─────────────────────────────────────────────────────────────

    [[nodiscard]] Quantity total_qty() const noexcept { return total_qty_; }
    [[nodiscard]] bool     empty()     const noexcept { return total_qty_ == 0; }

    // ── Mutations ─────────────────────────────────────────────────────────────

    // Enqueue a new resting order.
    void add(Order* o) {
        queue_.push_back(o);
        total_qty_ += o->leaves();
    }

    // Reduce resting qty when an order is partially or fully filled externally.
    void reduce_qty(Quantity qty) noexcept {
        total_qty_ -= qty;
        if (total_qty_ < 0) total_qty_ = 0;   // guard against double-accounting
    }

    // Lazily prune dead orders from the front, then return the front live order
    // or nullptr if the level is empty.
    Order* front() {
        prune_dead();
        return queue_.empty() ? nullptr : queue_.front();
    }

    // Pop the front order (caller must have already called front()).
    void pop_front() {
        if (!queue_.empty()) queue_.pop_front();
    }

    // Cancel a specific order: mark dead, adjust qty. O(1) aside from the
    // order's own is_dead flag; actual queue cleanup is deferred to front().
    void cancel(Order* o) {
        if (!o->is_dead()) {
            total_qty_ -= o->leaves();
            if (total_qty_ < 0) total_qty_ = 0;
            o->cancel();
        }
    }

private:
    std::deque<Order*> queue_;
    Quantity           total_qty_;

    // Remove dead orders from the front of the queue.
    void prune_dead() {
        while (!queue_.empty() && queue_.front()->is_dead()) {
            queue_.pop_front();
        }
    }
};
