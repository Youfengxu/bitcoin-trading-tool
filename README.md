# BTC Neural — Bitcoin Trading Intelligence Platform

A professional, full-stack Bitcoin trading intelligence dashboard with real-time price feeds, multi-indicator technical analysis, a statistical significance engine, automated buy/sell signal generation, a self-learning walk-forward optimization loop, a $10,000 paper trading simulator, and a cyberpunk HUD aesthetic.

---

## Features

| Feature | Description |
|---|---|
| **Live Price Feed** | Real-time BTC/USDT price via Kraken (primary), CoinGecko (secondary), Yahoo Finance (tertiary) |
| **Technical Metrics** | RSI, MACD, Bollinger Bands, EMA 12/26, SMA 50/200, Volume Ratio |
| **Statistical Significance** | Z-score engine classifies each price move as a meaningful **trend** or a noise **blip** |
| **Signal Generator** | Combines 6 indicator layers into a buy/sell/hold verdict with full component-by-component reasoning |
| **Self-Learning Optimizer** | Walk-forward backtest runs weekly, selects parameters that maximise weekly returns |
| **Signal Validation** | Tracks predicted vs actual outcomes; reports win rate, Sharpe ratio, and max drawdown |
| **Paper Trading Simulator** | Starts with $10,000 USD seed, executes signals automatically, tracks portfolio over time |
| **Weekly Performance Report** | Returns, trade history, portfolio growth chart, vs BTC buy-and-hold baseline |
| **AI Analysis Assistant** | On-demand LLM commentary interpreting current metrics, signals, and portfolio state |
| **Telegram Notifications** | Sends signal rationale, current price, and portfolio value on every buy/sell trigger |

---

## Tech Stack

- **Frontend**: React 19, Tailwind CSS 4, Recharts, shadcn/ui, Framer Motion
- **Backend**: Express 4, tRPC 11, Drizzle ORM, MySQL/TiDB
- **Trading Engine**: Pure TypeScript — no external TA libraries
- **Auth**: Manus OAuth
- **Notifications**: Telegram Bot API + Manus in-app notifications
- **Scheduling**: Manus Heartbeat (hourly cron for signal generation, weekly for optimization)
- **Tests**: Vitest — 72 tests across 4 test files

---

## Project Structure

```
server/
  engine/
    technicalAnalysis.ts   ← RSI, MACD, BB, EMA/SMA, Z-score, volume
    signalGenerator.ts     ← 6-layer signal aggregation with reasoning
    walkForwardOptimizer.ts← Self-learning parameter optimization
    marketData.ts          ← Kraken / CoinGecko / Yahoo Finance data layer
  heartbeatHandler.ts      ← Scheduled signal generation, validation, optimization
  routers.ts               ← All tRPC procedures
  db.ts                    ← Database query helpers
client/src/pages/
  LivePrice.tsx            ← Real-time price chart
  Metrics.tsx              ← Technical indicators dashboard
  Signals.tsx              ← Signal log with reasoning
  Simulator.tsx            ← Paper trading portfolio
  Performance.tsx          ← Weekly reports and validation metrics
  Strategy.tsx             ← Parameter tuning and optimization history
drizzle/schema.ts          ← Database schema (price_data, metrics_snapshots,
                              trading_signals, simulator_state, simulator_trades,
                              strategy_params, validation_log)
shared/tradingTypes.ts     ← Shared strategy parameter types
```

---

## Signal Methodology

Each signal passes through six analytical layers:

1. **RSI** — oversold/overbought thresholds (default: buy < 35, sell > 65)
2. **MACD Histogram** — bullish/bearish momentum crossover
3. **Bollinger Bands** — price touching or breaching the 2σ envelope
4. **EMA Crossover** — EMA12 vs EMA26 directional alignment
5. **Z-Score Trend Filter** — only acts on moves ≥ 2.0 standard deviations from the 20-period rolling mean; suppresses signals on noise (|Z| ≤ 0.5)
6. **Volume Confirmation** — applies a 1.15× multiplier when volume exceeds 1.5× the 20-period average

Each layer produces a directional vote and a strength score (0–1). Scores are aggregated and normalized; a signal is only emitted when the winning side exceeds the minimum confidence threshold (default 55%).

---

## Setup

```bash
# Install dependencies
pnpm install

# Set environment variables (copy and fill .env.example)
cp .env.example .env

# Apply database migrations
pnpm drizzle-kit generate
pnpm drizzle-kit migrate

# Start development server
pnpm dev

# Run tests
pnpm test
```

### Required Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | MySQL/TiDB connection string |
| `JWT_SECRET` | Session cookie signing secret |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for trade alerts |
| `TELEGRAM_CHAT_ID` | Telegram chat ID to receive alerts |
| `BUILT_IN_FORGE_API_KEY` | Manus built-in API key (LLM, storage, notifications) |
| `BUILT_IN_FORGE_API_URL` | Manus built-in API base URL |

---

## Scheduled Jobs

The platform uses a heartbeat endpoint (`POST /api/heartbeat`) for recurring automation:

| Job | Frequency | Action |
|---|---|---|
| Signal generation | Hourly | Fetch candles → compute metrics → generate signal → execute simulator trade → notify |
| Signal validation | Every 4 hours | Evaluate recent signal outcomes → compute win rate, Sharpe, drawdown |
| Walk-forward optimization | Weekly | Backtest parameter grid on last 1,000 candles → save best-performing strategy version |

Configure the heartbeat schedule from the Manus project Settings → Schedules panel after publishing.

---

## License

MIT
