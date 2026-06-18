'use strict';

/**
 * engine.js — Order Book Matching Engine
 *
 * Faithful JavaScript port of the C++ matching engine (order_book.cpp).
 * Supports: Limit, Market, IOC, FOK, StopLimit order types.
 * Uses FIFO price-time priority matching.
 */

// ─── Order ────────────────────────────────────────────────────────────────────

class Order {
    constructor({ id, side, type, price, quantity, stopPrice, participant }) {
        this.id          = id;
        this.side        = side;            // 'buy' | 'sell'
        this.type        = type;            // 'limit' | 'market' | 'ioc' | 'fok' | 'stop_limit'
        this.price       = price || 0;      // integer ticks (price × TICK_SCALE)
        this.stopPrice   = stopPrice || 0;
        this.quantity    = quantity;
        this.filled      = 0;
        this.status      = 'new';           // 'new' | 'partial' | 'filled' | 'cancelled' | 'rejected'
        this.participant = participant || '';
        this.timestamp   = Date.now();
    }

    leaves()   { return this.quantity - this.filled; }
    isDead()   { return this.status === 'filled' || this.status === 'cancelled' || this.status === 'rejected'; }
    isActive() { return !this.isDead(); }

    fill(qty) {
        this.filled += qty;
        this.status = this.filled >= this.quantity ? 'filled' : 'partial';
    }

    cancel() { this.status = 'cancelled'; }
}

// ─── PriceLevel ───────────────────────────────────────────────────────────────
// FIFO queue of resting Order pointers at a single price tick.
// Dead orders are pruned lazily from the front on access.

class PriceLevel {
    constructor() {
        this.queue     = [];
        this._totalQty = 0;
    }

    totalQty() { return this._totalQty; }
    empty()    { return this._totalQty <= 0; }

    add(order) {
        this.queue.push(order);
        this._totalQty += order.leaves();
    }

    reduceQty(qty) {
        this._totalQty -= qty;
        if (this._totalQty < 0) this._totalQty = 0;
    }

    front() {
        this._pruneDead();
        return this.queue.length > 0 ? this.queue[0] : null;
    }

    popFront() {
        if (this.queue.length > 0) this.queue.shift();
    }

    cancelOrder(order) {
        if (!order.isDead()) {
            this._totalQty -= order.leaves();
            if (this._totalQty < 0) this._totalQty = 0;
            order.cancel();
        }
    }

    _pruneDead() {
        while (this.queue.length > 0 && this.queue[0].isDead()) {
            this.queue.shift();
        }
    }
}

// ─── OrderBook ────────────────────────────────────────────────────────────────
// Central Limit Order Book.
//
// Uses Map<Price, PriceLevel> per side, with best bid/ask scanned on demand.
// Supports: submit (limit/market/ioc/fok/stop_limit), cancel, snapshots.

class OrderBook {
    constructor(symbol) {
        this.symbol     = symbol;
        this.bidLevels  = new Map();    // price → PriceLevel
        this.askLevels  = new Map();    // price → PriceLevel
        this.orderMap   = new Map();    // orderId → Order
        this.stopOrders = [];
    }

    // ── Public Interface ──────────────────────────────────────────────────────

    /**
     * Submit an order to the book.
     * @returns {{ fills: Fill[], order: Order, resting: boolean }}
     */
    submit({ id, side, type, price, quantity, stopPrice, participant }) {
        const order = new Order({ id, side, type, price, quantity, stopPrice, participant });

        switch (type) {
            case 'limit':      return this._matchLimit(order);
            case 'market':     return this._matchMarket(order);
            case 'ioc':        return this._matchIOC(order);
            case 'fok':        return this._matchFOK(order);
            case 'stop_limit': return this._matchStopLimit(order);
            default:
                order.status = 'rejected';
                return { fills: [], order, resting: false };
        }
    }

    /**
     * Cancel a resting order by ID.
     * @param {number} orderId
     * @param {string} [requester] — if provided, only cancel if owned by this participant
     * @returns {Order|null} the cancelled order, or null
     */
    cancel(orderId, requester) {
        const order = this.orderMap.get(orderId);
        if (!order) return null;
        if (requester && order.participant !== requester) return null;

        const levels = order.side === 'buy' ? this.bidLevels : this.askLevels;
        const level  = levels.get(order.price);
        if (level) {
            level.cancelOrder(order);
            if (level.empty()) levels.delete(order.price);
        }
        this.orderMap.delete(orderId);
        return order;
    }

    /** Look up an order by ID (does not modify). */
    getOrder(orderId) {
        return this.orderMap.get(orderId) || null;
    }

    /** Best bid price, or -1 if no bids. */
    bestBid() {
        let best = -1;
        for (const [price, level] of this.bidLevels) {
            if (!level.empty() && price > best) best = price;
        }
        return best;
    }

    /** Best ask price, or -1 if no asks. */
    bestAsk() {
        let best = Infinity;
        for (const [price, level] of this.askLevels) {
            if (!level.empty() && price < best) best = price;
        }
        return best === Infinity ? -1 : best;
    }

    /** Snapshot: { symbol, bids: [[p,q],...], asks: [[p,q],...] } */
    getSnapshot() {
        const bids = [];
        const asks = [];

        for (const [price, level] of this.bidLevels) {
            const qty = level.totalQty();
            if (qty > 0) bids.push([price, qty]);
        }
        for (const [price, level] of this.askLevels) {
            const qty = level.totalQty();
            if (qty > 0) asks.push([price, qty]);
        }

        bids.sort((a, b) => b[0] - a[0]);   // highest first
        asks.sort((a, b) => a[0] - b[0]);   // lowest first

        return { symbol: this.symbol, bids, asks };
    }

    /** Active (resting) orders for a given participant. */
    getActiveOrders(participant) {
        const orders = [];
        for (const [, order] of this.orderMap) {
            if (order.participant === participant && order.isActive()) {
                orders.push({
                    id:        order.id,
                    side:      order.side,
                    type:      order.type,
                    price:     order.price,
                    quantity:  order.quantity,
                    filled:    order.filled,
                    leaves:    order.leaves(),
                    symbol:    this.symbol,
                    timestamp: order.timestamp,
                });
            }
        }
        return orders;
    }

    // ── Internal: rest an unfilled order on the book ──────────────────────────

    _restOrder(order) {
        const levels = order.side === 'buy' ? this.bidLevels : this.askLevels;
        let level = levels.get(order.price);
        if (!level) {
            level = new PriceLevel();
            levels.set(order.price, level);
        }
        level.add(order);
        this.orderMap.set(order.id, order);
    }

    // ── Internal: execute a single fill ──────────────────────────────────────

    _executeFill(taker, maker, level, fillPrice) {
        const qty = Math.min(taker.leaves(), maker.leaves());

        taker.fill(qty);
        maker.fill(qty);
        level.reduceQty(qty);

        if (maker.isDead()) {
            level.popFront();
            this.orderMap.delete(maker.id);
        }

        return {
            makerOrderId:     maker.id,
            takerOrderId:     taker.id,
            makerParticipant: maker.participant,
            takerParticipant: taker.participant,
            price:            fillPrice,
            quantity:         qty,
            symbol:           this.symbol,
            takerSide:        taker.side,
        };
    }

    // ── Internal: trigger stop orders after a trade ──────────────────────────

    _triggerStops(lastPrice, fills) {
        const remaining = [];
        for (const stop of this.stopOrders) {
            let triggered = false;
            if (stop.side === 'buy'  && lastPrice >= stop.stopPrice) triggered = true;
            if (stop.side === 'sell' && lastPrice <= stop.stopPrice) triggered = true;

            if (triggered) {
                stop.type = 'limit';
                const result = this._matchLimit(stop);
                fills.push(...result.fills);
            } else {
                remaining.push(stop);
            }
        }
        this.stopOrders = remaining;
    }

    // ── Matching: Limit ──────────────────────────────────────────────────────

    _matchLimit(taker) {
        const fills = [];

        if (taker.side === 'buy') {
            while (taker.leaves() > 0) {
                const askPrice = this.bestAsk();
                if (askPrice < 0 || askPrice > taker.price) break;

                const level = this.askLevels.get(askPrice);
                const maker = level ? level.front() : null;
                if (!maker) { this.askLevels.delete(askPrice); continue; }

                fills.push(this._executeFill(taker, maker, level, askPrice));
                if (level.empty()) this.askLevels.delete(askPrice);
            }
        } else {
            while (taker.leaves() > 0) {
                const bidPrice = this.bestBid();
                if (bidPrice < 0 || bidPrice < taker.price) break;

                const level = this.bidLevels.get(bidPrice);
                const maker = level ? level.front() : null;
                if (!maker) { this.bidLevels.delete(bidPrice); continue; }

                fills.push(this._executeFill(taker, maker, level, bidPrice));
                if (level.empty()) this.bidLevels.delete(bidPrice);
            }
        }

        let resting = false;
        if (taker.leaves() > 0 && !taker.isDead()) {
            this._restOrder(taker);
            resting = true;
        }

        if (fills.length > 0) {
            this._triggerStops(fills[fills.length - 1].price, fills);
        }

        return { fills, order: taker, resting };
    }

    // ── Matching: Market ─────────────────────────────────────────────────────

    _matchMarket(taker) {
        const fills = [];

        if (taker.side === 'buy') {
            while (taker.leaves() > 0) {
                const askPrice = this.bestAsk();
                if (askPrice < 0) break;

                const level = this.askLevels.get(askPrice);
                const maker = level ? level.front() : null;
                if (!maker) { this.askLevels.delete(askPrice); continue; }

                fills.push(this._executeFill(taker, maker, level, askPrice));
                if (level.empty()) this.askLevels.delete(askPrice);
            }
        } else {
            while (taker.leaves() > 0) {
                const bidPrice = this.bestBid();
                if (bidPrice < 0) break;

                const level = this.bidLevels.get(bidPrice);
                const maker = level ? level.front() : null;
                if (!maker) { this.bidLevels.delete(bidPrice); continue; }

                fills.push(this._executeFill(taker, maker, level, bidPrice));
                if (level.empty()) this.bidLevels.delete(bidPrice);
            }
        }

        if (taker.leaves() > 0) taker.status = 'cancelled';

        if (fills.length > 0) {
            this._triggerStops(fills[fills.length - 1].price, fills);
        }

        return { fills, order: taker, resting: false };
    }

    // ── Matching: IOC (Immediate-Or-Cancel) ──────────────────────────────────

    _matchIOC(taker) {
        const fills = [];

        if (taker.side === 'buy') {
            while (taker.leaves() > 0) {
                const askPrice = this.bestAsk();
                if (askPrice < 0 || askPrice > taker.price) break;

                const level = this.askLevels.get(askPrice);
                const maker = level ? level.front() : null;
                if (!maker) { this.askLevels.delete(askPrice); continue; }

                fills.push(this._executeFill(taker, maker, level, askPrice));
                if (level.empty()) this.askLevels.delete(askPrice);
            }
        } else {
            while (taker.leaves() > 0) {
                const bidPrice = this.bestBid();
                if (bidPrice < 0 || bidPrice < taker.price) break;

                const level = this.bidLevels.get(bidPrice);
                const maker = level ? level.front() : null;
                if (!maker) { this.bidLevels.delete(bidPrice); continue; }

                fills.push(this._executeFill(taker, maker, level, bidPrice));
                if (level.empty()) this.bidLevels.delete(bidPrice);
            }
        }

        if (taker.leaves() > 0) taker.status = 'cancelled';

        if (fills.length > 0) {
            this._triggerStops(fills[fills.length - 1].price, fills);
        }

        return { fills, order: taker, resting: false };
    }

    // ── Matching: FOK (Fill-Or-Kill) ─────────────────────────────────────────

    _matchFOK(taker) {
        // Pre-check: can the full quantity be filled?
        let available = 0;

        if (taker.side === 'buy') {
            const sorted = [...this.askLevels.entries()]
                .filter(([, l]) => !l.empty())
                .sort((a, b) => a[0] - b[0]);
            for (const [price, level] of sorted) {
                if (price > taker.price) break;
                available += level.totalQty();
                if (available >= taker.quantity) break;
            }
        } else {
            const sorted = [...this.bidLevels.entries()]
                .filter(([, l]) => !l.empty())
                .sort((a, b) => b[0] - a[0]);
            for (const [price, level] of sorted) {
                if (price < taker.price) break;
                available += level.totalQty();
                if (available >= taker.quantity) break;
            }
        }

        if (available < taker.quantity) {
            taker.status = 'cancelled';
            return { fills: [], order: taker, resting: false };
        }

        // Full fill possible → use IOC logic (never rests)
        taker.type = 'ioc';
        return this._matchIOC(taker);
    }

    // ── Matching: StopLimit ──────────────────────────────────────────────────

    _matchStopLimit(taker) {
        this.stopOrders.push(taker);
        return { fills: [], order: taker, resting: false };
    }
}

module.exports = { OrderBook, Order };
