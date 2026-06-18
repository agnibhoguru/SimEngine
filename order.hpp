#pragma once

#include "types.hpp"
#include <cstdint>

// ── Order ─────────────────────────────────────────────────────────────────────
// Cache-line aligned POD so arrays of Order* never straddle cache lines.

struct alignas(64) Order {
    OrderId    id;
    Price      price;          // limit price in ticks; 0 for market orders
    Price      stop_price;     // trigger price for StopLimit; 0 otherwise
    Quantity   quantity;       // original quantity
    Quantity   filled;         // cumulative filled quantity
    OrderType  type;
    Side       side;
    OrderStatus status;

    // ── Inline Helpers ────────────────────────────────────────────────────────

    [[nodiscard]] inline Quantity leaves() const noexcept {
        return quantity - filled;
    }

    [[nodiscard]] inline bool is_dead() const noexcept {
        return status == OrderStatus::Filled
            || status == OrderStatus::Cancelled
            || status == OrderStatus::Rejected;
    }

    [[nodiscard]] inline bool is_active() const noexcept {
        return !is_dead();
    }

    inline void fill(Quantity qty) noexcept {
        filled += qty;
        status  = (filled >= quantity) ? OrderStatus::Filled
                                       : OrderStatus::PartiallyFilled;
    }

    inline void cancel() noexcept {
        status = OrderStatus::Cancelled;
    }
};
