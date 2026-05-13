# BTC Neural — Bitcoin Trading Intelligence Platform

A professional, full-stack Bitcoin trading intelligence dashboard with real-time price feeds, multi-indicator technical analysis, a statistical significance engine, automated buy/sell signal generation, a self-learning walk-forward optimization loop, a $10,000 paper trading simulator, and a cyberpunk HUD aesthetic.

---

## Features

| Feature | Description |
|---|---|
| **Live Price Feed** | Real-time BTC/USDT price via Kraken (primary), CoinGecko (secondary), Yahoo Finance (tertiary) |
| **Technical Metrics** | RSI, MACD, Bollinger Bands, EMA 12/26, SMA 50/200, Volume Ratio |
| **Statistical Significance** | Z-score engine classifies each price move as a meaningful **trend** or a noise **blip** |
| **Change Detection** | CUSUM changepoint alarm, Hurst Exponent regime classifier (trending / random walk / mean-reverting), Wilder ADX trend-strength filter |
| **Signal Generator** | Combines 8 indicator layers into a buy/sell/hold verdict with Hurst regime weighting and CUSUM confidence boost |
| **Self-Learning Optimizer** | Walk-forward backtest runs daily, selects parameters that maximise **risk-adjusted weekly return** (`totalReturn − λ × holdRegret`), accounting for the opportunity cost of inaction |
| **Signal Validation** | Tracks predicted vs actual outcomes for all signals including holds; reports win rate, Sharpe, max drawdown, hold regret, and risk-adjusted return |
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
    technicalAnalysis.ts   ← RSI, MACD, BB, EMA/SMA, Z-score, CUSUM, Hurst, ADX
    signalGenerator.ts     ← 8-layer signal aggregation with Hurst weighting and CUSUM boost
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

Each signal passes through eight analytical layers:

1. **RSI** — oversold/overbought thresholds (default: buy < 35, sell > 65)
2. **MACD Histogram** — bullish/bearish momentum crossover
3. **Bollinger Bands** — price touching or breaching the 2σ envelope
4. **EMA Crossover** — EMA12 vs EMA26 directional alignment
5. **Z-Score Trend Filter** — only acts on moves ≥ 2.0 standard deviations from the 20-period rolling mean; suppresses signals on noise (|Z| ≤ 0.5)
6. **Volume Confirmation** — applies a 1.15× multiplier when volume exceeds 1.5× the 20-period average
7. **ADX (Wilder)** — adds a directional component only when ADX > 25 (strong trend); +DI > -DI = bullish bias
8. **CUSUM Boost** — applies a 1.2× multiplier to the winning side when a cumulative-sum changepoint alarm is active and aligns with the signal direction

**Hurst regime weighting** is applied across all components before aggregation: trend-following components (MACD, EMA, Z-Score, ADX) are scaled up when H > 0.5 (persistent/trending regime) and scaled down when H < 0.5; mean-reversion components (RSI, Bollinger Bands) receive the inverse weighting.

A signal is emitted when the weighted, volume-boosted, CUSUM-adjusted winning score exceeds the minimum confidence threshold (default 55%).

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

## Work in Progress

### Champion-Challenger Learning (next up)

Run 2–3 strategy parameter sets in parallel against the same incoming heartbeat candles. Only the **champion** executes simulator trades. **Challengers** (one more aggressive, one more conservative) emit shadow signals that are logged and validated alongside the champion. This gives 3× labelled outcomes per heartbeat without portfolio risk.

**Promotion criterion**: a challenger must beat the champion on `riskAdjustedReturn` with **statistical significance** before promotion. Concrete test: paired t-test on the per-period reward series, p < 0.05 over a minimum of 30 paired observations. This avoids promoting on lucky streaks. Implementation will need a `strategyVariant` column on `trading_signals` and a new `challenger_state` table tracking the rolling reward series per variant.

### Regime-Conditional Parameters

Maintain three parameter sets keyed by the Hurst regime detected on each heartbeat (`H > 0.6` = trending, `0.45–0.6` = random walk, `< 0.45` = mean-reverting). The walk-forward optimizer runs per-regime, using only historical candles where that regime held. At signal time, route through the param set matching current Hurst. Defer until Phase 2 has accumulated enough per-regime data — otherwise each regime learns from too few samples.

### Coordinate Descent in the Optimizer

Replace the pure ±20% random jitter in `generateParamVariations` with coordinate descent: vary one parameter at a time (±10%, ±20%) and walk a greedy improvement path. Cheaper convergence than random search for the same compute budget. Sensitivity testing already shows random sampling under-explores the active-vs-passive axis, so this becomes important once challengers diversify the variation pool.

### BOCPD — Bayesian Online Changepoint Detection

[Adams & MacKay, 2007] A fully probabilistic alternative to CUSUM. Rather than a fixed threshold, BOCPD maintains a posterior distribution over the *run length* (time since the last changepoint) using a Gaussian conjugate prior on the local mean. At each step it computes the probability that a changepoint just occurred vs. the sequence continuing. This gives:

- Calibrated changepoint probabilities instead of a binary alarm
- Automatic sensitivity adjustment as volatility changes (no hand-tuned `k`/`h` parameters)
- Richer signal: the posterior hazard function can differentiate structural breaks from transient shocks

**Planned integration**: Replace the binary `cusumAlarm` flag with a continuous `bocpdChangeProb` score (0–1). The CUSUM boost in the signal generator would become `1 + bocpdChangeProb * 0.4` (smooth scaling). Current blockers: numerical stability of the log-sum-exp recursion at long run lengths; deciding between Gaussian and Student-t observation model.

---

## License

MIT
