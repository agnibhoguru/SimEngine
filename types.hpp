#pragma once

#include <cstdint>

// ── Type Aliases ─────────────────────────────────────────────────────────────

using OrderId  = int64_t;
using Price    = int64_t;   // integer ticks (raw price × TICK_SCALE)
using Quantity = int64_t;

// ── Constants ─────────────────────────────────────────────────────────────────

// Fixed-point scaling: 1 tick = 0.01 (two decimal places)
static constexpr int64_t TICK_SCALE   = 100;

// Bitset layout: each block is a 64-bit word
static constexpr int NUM_BLOCKS       = 64;
static constexpr int TOTAL_LEVELS     = NUM_BLOCKS * 64;   // 4096 price levels per side

// ── Enumerations ──────────────────────────────────────────────────────────────

enum class Side : uint8_t {
    Buy  = 0,
    Sell = 1
};

enum class OrderType : uint8_t {
    Limit     = 0,
    Market    = 1,
    IOC       = 2,   // Immediate-Or-Cancel
    FOK       = 3,   // Fill-Or-Kill
    StopLimit = 4
};

enum class OrderStatus : uint8_t {
    New            = 0,
    PartiallyFilled = 1,
    Filled         = 2,
    Cancelled      = 3,
    Rejected       = 4
};

// ── Fill ─────────────────────────────────────────────────────────────────────

struct Fill {
    OrderId  maker_order_id;
    OrderId  taker_order_id;
    Price    price;        // in ticks
    Quantity quantity;
};
