# EXCH — Simulated Exchange & Trading Terminal

EXCH is a lightweight, high-performance self-hosted simulated exchange and trading terminal. It features a real-time order book visualizer, price chart, and an automated market-making bot, all packaged into a single-file web terminal interface and backed by an order matching engine.

---

## Features

* **High-Performance Matching Engine:** A Javascript matching engine (port of the C++ matching engine logic) that handles:
  * Order types: **Limit**, **Market**, **Immediate-Or-Cancel (IOC)**, **Fill-Or-Kill (FOK)**, and **Stop-Limit**.
  * Price-time (FIFO) matching priority.
  * Private fills, public trade broadcasts, order cancelations, and active order tracking.
* **Vibrant Web Dashboard:** Custom dark-themed terminal UI with:
  * Real-time order book depth visualization.
  * Price charting of trade history with dynamic gradients and micro-animations.
  * Trade blotter, position lists, P&L updates, and active order tracking.
* **Keyboard Shortcuts:** Fast entry actions for power traders.
* **Automated Market Maker (MM):** Built-in background bot (`_mm_`) that provides constant order book liquidity and performs randomized trades across BTC-USD and ETH-USD instruments.
* **Standalone Executable:** Ready-to-run compiled server (`exchange.exe`) containing the full engine and Web/WebSocket server.

---

## How to Run

### Option A: Using the Compiled Executable (Recommended)
1. Double-click or run `exchange.exe` from your terminal:
   ```cmd
   .\exchange.exe
   ```
2. Open your web browser and go to: `http://localhost:8080`
3. Enter any participant name, leave the default server address as `ws://localhost:9001`, and click **Connect**.

### Option B: Running from Source (Requires Node.js)
1. Install project dependencies:
   ```bash
   npm install
   ```
2. Launch the server:
   ```bash
   node server.js
   ```
3. Open `http://localhost:8080` in your web browser.

---

## How to Build the Executable
If you modify the matching engine, web front-end, or server config, you can recompile a new standalone executable:

* **On Windows:** Double-click or run `build.bat` in command prompt.
* **Alternative:** Run the build script directly via npm:
  ```bash
  npm run build
  ```

*Note: The packaging system uses a pinned version of `@yao-pkg/pkg@5.12.0` to avoid CommonJS/ESM module resolution conflicts.*

---

## Terminal Navigation & Shortcuts

Use the following hotkeys when navigating the dashboard (ensure focus is not inside an input box):

| Shortcut | Action |
|---|---|
| <kbd>B</kbd> | Toggle order side to **BUY** |
| <kbd>S</kbd> | Toggle order side to **SELL** |
| <kbd>Enter</kbd> | Submit the current order form |
| **Mouse Click on Book Row** | Automatically populates the input price field with that row's price |
