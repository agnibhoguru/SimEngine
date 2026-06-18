#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { OrderBook }       = require('./engine');

// ── Configuration ─────────────────────────────────────────────────────────────

const HTTP_PORT  = parseInt(process.env.PORT    || '8080', 10);
const WS_PORT    = parseInt(process.env.WS_PORT || '9001', 10);
const TICK_SCALE = 100;
const BOT_NAME   = '_mm_';   // market-maker bot participant name

// ── Instruments ───────────────────────────────────────────────────────────────

const INSTRUMENTS = [
    { symbol: 'BTC-USD', basePrice: 68000 * TICK_SCALE },   // $68,000.00
    { symbol: 'ETH-USD', basePrice:  3500 * TICK_SCALE },   //  $3,500.00
];

// ── Exchange State ────────────────────────────────────────────────────────────

const books        = new Map();         // symbol → OrderBook
const participants = new Map();         // ws → { name }
const nameToWs     = new Map();         // name → Set<ws>
let   nextOrderId  = 1;

for (const inst of INSTRUMENTS) {
    books.set(inst.symbol, new OrderBook(inst.symbol));
}

// ── Load HTML ─────────────────────────────────────────────────────────────────

let htmlContent;
try {
    htmlContent = fs.readFileSync(path.join(__dirname, 'design.html'), 'utf8');
} catch {
    console.error('\n  ERROR: Could not read design.html.');
    console.error('  Make sure design.html is in the same directory as server.js\n');
    process.exit(1);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
        });
        res.end(htmlContent);
    } else if (req.url === '/status') {
        const unique = new Set([...participants.values()].map(p => p.name));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            instruments: INSTRUMENTS.map(i => i.symbol),
            participants: unique.size,
            uptime: Math.round(process.uptime()),
        }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        handleMessage(ws, msg);
    });

    ws.on('close', () => {
        const p = participants.get(ws);
        if (p) {
            const socks = nameToWs.get(p.name);
            if (socks) {
                socks.delete(ws);
                if (socks.size === 0) nameToWs.delete(p.name);
            }
            participants.delete(ws);
            log(`${p.name} disconnected`);
        }
    });

    ws.on('error', () => {});
});

// Heartbeat — close dead connections every 30s
setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
    }
}, 30_000);

// ── Message Handler ───────────────────────────────────────────────────────────

function handleMessage(ws, msg) {
    switch (msg.type) {

        // ── JOIN ──────────────────────────────────────────────────────────────
        case 'join': {
            const name = String(msg.participant || '').trim().slice(0, 20);
            if (!name) return sendTo(ws, { type: 'error', message: 'Name required' });

            participants.set(ws, { name });
            if (!nameToWs.has(name)) nameToWs.set(name, new Set());
            nameToWs.get(name).add(ws);
            log(`${name} joined`);

            // Instrument list
            sendTo(ws, { type: 'instruments', symbols: INSTRUMENTS.map(i => i.symbol) });

            // Book snapshots
            for (const [symbol, book] of books) {
                const snap = book.getSnapshot();
                sendTo(ws, { type: 'book_snapshot', symbol, bids: snap.bids, asks: snap.asks });
            }

            // Active orders
            sendActiveOrders(ws, name);
            break;
        }

        // ── ORDER ─────────────────────────────────────────────────────────────
        case 'order': {
            const p = participants.get(ws);
            if (!p) return sendTo(ws, { type: 'error', message: 'Not joined' });

            const { symbol, side, order_type, qty, price, stop_price } = msg;
            const book = books.get(symbol);
            if (!book)            return sendTo(ws, { type: 'order_reject', reason: `Unknown: ${symbol}` });
            if (!qty || qty <= 0) return sendTo(ws, { type: 'order_reject', reason: 'Invalid quantity' });
            if (order_type !== 'market' && (!price || price <= 0))
                return sendTo(ws, { type: 'order_reject', reason: 'Invalid price' });

            const orderId = nextOrderId++;
            const result  = book.submit({
                id: orderId, side, type: order_type,
                price: price || 0, quantity: qty,
                stopPrice: stop_price || 0, participant: p.name,
            });

            sendTo(ws, { type: 'order_ack', order_id: orderId });
            processFills(result.fills);
            broadcastBook(symbol);
            sendActiveOrders(ws, p.name);
            break;
        }

        // ── CANCEL ────────────────────────────────────────────────────────────
        case 'cancel': {
            const p = participants.get(ws);
            if (!p) return sendTo(ws, { type: 'error', message: 'Not joined' });

            const book = books.get(msg.symbol);
            if (!book) return sendTo(ws, { type: 'error', message: 'Unknown instrument' });

            // Ownership check: only cancel your own orders
            const cancelled = book.cancel(msg.order_id, p.name);
            if (cancelled) {
                sendTo(ws, { type: 'order_cancelled', order_id: msg.order_id });
                broadcastBook(msg.symbol);
                sendActiveOrders(ws, p.name);
            } else {
                sendTo(ws, { type: 'error', message: `Order ${msg.order_id} not found` });
            }
            break;
        }
    }
}

// ── Messaging Helpers ─────────────────────────────────────────────────────────

function sendTo(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendToParticipant(name, obj) {
    const socks = nameToWs.get(name);
    if (socks) for (const ws of socks) sendTo(ws, obj);
}

function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of wss.clients) {
        if (ws.readyState === 1) ws.send(data);
    }
}

function broadcastBook(symbol) {
    const book = books.get(symbol);
    if (!book) return;
    const snap = book.getSnapshot();
    broadcast({ type: 'book_snapshot', symbol, bids: snap.bids, asks: snap.asks });
}

function sendActiveOrders(ws, participant) {
    const orders = [];
    for (const [, book] of books) orders.push(...book.getActiveOrders(participant));
    sendTo(ws, { type: 'active_orders', orders });
}

/**
 * Process fills: broadcast public trades and send private fill messages.
 * Handles bot fills correctly (no message sent to bot participant).
 */
function processFills(fills) {
    const now = Date.now();
    for (const f of fills) {
        // Public trade broadcast
        broadcast({ type: 'trade', symbol: f.symbol, price: f.price, qty: f.quantity });

        // Private fill to taker (if real participant)
        if (f.takerParticipant !== BOT_NAME) {
            sendToParticipant(f.takerParticipant, {
                type: 'fill', symbol: f.symbol, side: f.takerSide,
                price: f.price, qty: f.quantity,
                counterparty: f.makerParticipant === BOT_NAME ? 'Market' : f.makerParticipant,
                order_id: f.takerOrderId, timestamp: now,
            });
        }

        // Private fill to maker (opposite side, if real participant)
        if (f.makerParticipant !== BOT_NAME) {
            sendToParticipant(f.makerParticipant, {
                type: 'fill', symbol: f.symbol,
                side: f.takerSide === 'buy' ? 'sell' : 'buy',
                price: f.price, qty: f.quantity,
                counterparty: f.takerParticipant === BOT_NAME ? 'Market' : f.takerParticipant,
                order_id: f.makerOrderId, timestamp: now,
            });
        }
    }
}

// ── Market-Making Bot ─────────────────────────────────────────────────────────
// Provides liquidity and generates trades so the terminal isn't empty.
// The bot:
//   1. Maintains 15 bid + 15 ask levels around a random-walking reference price
//   2. Periodically crosses the spread with small market orders to create trades
//   3. Refreshes its orders every 2.5 seconds

const botState = new Map();

for (const inst of INSTRUMENTS) {
    botState.set(inst.symbol, {
        refPrice: inst.basePrice,
        ids:      [],
        vol:      inst.symbol.startsWith('BTC') ? 80 : 30,   // per-step tick volatility
    });
}

function botSeedBook(symbol) {
    const book = books.get(symbol);
    const bs   = botState.get(symbol);
    if (!book || !bs) return;

    // Cancel old bot orders
    for (const id of bs.ids) book.cancel(id, BOT_NAME);
    bs.ids = [];

    // Random walk the reference price
    bs.refPrice = Math.max(5000,
        Math.round(bs.refPrice + (Math.random() - 0.5) * bs.vol * 2));

    const LEVELS     = 15;
    const halfSpread = Math.max(50, Math.round(bs.refPrice * 0.0002));

    for (let i = 0; i < LEVELS; i++) {
        const gap  = halfSpread + i * Math.round(halfSpread * 0.6 + Math.random() * halfSpread * 0.4);
        const bidP = bs.refPrice - gap;
        const askP = bs.refPrice + gap;
        const bidQ = Math.floor(5 + Math.random() * 80);
        const askQ = Math.floor(5 + Math.random() * 80);
        const bidId = nextOrderId++;
        const askId = nextOrderId++;

        const bRes = book.submit({ id: bidId, side: 'buy',  type: 'limit', price: bidP, quantity: bidQ, participant: BOT_NAME });
        const aRes = book.submit({ id: askId, side: 'sell', type: 'limit', price: askP, quantity: askQ, participant: BOT_NAME });

        // Handle any fills produced (e.g. bot orders crossing user resting orders)
        processFills(bRes.fills);
        processFills(aRes.fills);

        bs.ids.push(bidId, askId);
    }
}

function botCrossTrade(symbol) {
    const book = books.get(symbol);
    if (!book) return;

    const side = Math.random() > 0.5 ? 'buy' : 'sell';
    const qty  = Math.floor(1 + Math.random() * 8);
    const id   = nextOrderId++;

    const result = book.submit({
        id, side, type: 'market', price: 0,
        quantity: qty, participant: BOT_NAME,
    });

    processFills(result.fills);
    if (result.fills.length > 0) broadcastBook(symbol);
}

// ── Bot Lifecycle ─────────────────────────────────────────────────────────────

// Seed initial books
for (const inst of INSTRUMENTS) {
    botSeedBook(inst.symbol);
}

// Refresh orders every 2.5s
setInterval(() => {
    for (const inst of INSTRUMENTS) {
        botSeedBook(inst.symbol);
        broadcastBook(inst.symbol);
    }
}, 2500);

// Random bot trades at variable intervals (0.8s – 3.8s)
(function scheduleTrade() {
    setTimeout(() => {
        const inst = INSTRUMENTS[Math.floor(Math.random() * INSTRUMENTS.length)];
        botCrossTrade(inst.symbol);
        scheduleTrade();
    }, 800 + Math.random() * 3000);
})();

// ── Startup ───────────────────────────────────────────────────────────────────

httpServer.listen(HTTP_PORT, () => {
    console.log('');
    console.log('  \x1b[36m╔══════════════════════════════════════════╗\x1b[0m');
    console.log('  \x1b[36m║\x1b[0m       \x1b[1mEXCH\x1b[0m — Simulated Exchange          \x1b[36m║\x1b[0m');
    console.log('  \x1b[36m╠══════════════════════════════════════════╣\x1b[0m');
    console.log(`  \x1b[36m║\x1b[0m  HTTP  →  \x1b[32mhttp://localhost:${HTTP_PORT}\x1b[0m             \x1b[36m║\x1b[0m`);
    console.log(`  \x1b[36m║\x1b[0m  WS    →  \x1b[33mws://localhost:${WS_PORT}\x1b[0m               \x1b[36m║\x1b[0m`);
    console.log('  \x1b[36m║\x1b[0m                                          \x1b[36m║\x1b[0m');
    console.log('  \x1b[36m║\x1b[0m  Open the HTTP URL in your browser.      \x1b[36m║\x1b[0m');
    console.log('  \x1b[36m║\x1b[0m  Press Ctrl+C to stop.                   \x1b[36m║\x1b[0m');
    console.log('  \x1b[36m╚══════════════════════════════════════════╝\x1b[0m');
    console.log('');
    log('Market maker bot initialized');
    log(`Serving ${INSTRUMENTS.length} instruments: ${INSTRUMENTS.map(i => i.symbol).join(', ')}`);
});

function log(msg) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`  \x1b[90m[${ts}]\x1b[0m ${msg}`);
}
