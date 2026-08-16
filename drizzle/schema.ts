import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  double,
  bigint,
  boolean,
  json,
  unique,
} from "drizzle-orm/mysql-core";

// ─── Users ───────────────────────────────────────────────────────────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Price Candles (1-minute OHLCV from Binance) ────────────────────
export const priceCandles = mysqlTable("price_candles", {
  id: int("id").autoincrement().primaryKey(),
  openTime: bigint("openTime", { mode: "number" }).notNull(),
  open: double("open").notNull(),
  high: double("high").notNull(),
  low: double("low").notNull(),
  close: double("close").notNull(),
  volume: double("volume").notNull(),
  closeTime: bigint("closeTime", { mode: "number" }).notNull(),
  interval: varchar("interval", { length: 10 }).default("1m").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Computed Metrics Snapshots ──────────────────────────────────────
export const metricSnapshots = mysqlTable("metric_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  price: double("price").notNull(),
  rsi14: double("rsi14"),
  macdLine: double("macdLine"),
  macdSignal: double("macdSignal"),
  macdHist: double("macdHist"),
  bbUpper: double("bbUpper"),
  bbMiddle: double("bbMiddle"),
  bbLower: double("bbLower"),
  ema12: double("ema12"),
  ema26: double("ema26"),
  sma50: double("sma50"),
  sma200: double("sma200"),
  volumeSma20: double("volumeSma20"),
  volumeRatio: double("volumeRatio"),
  zScore: double("zScore"),
  rollingStdDev: double("rollingStdDev"),
  trendClassification: mysqlEnum("trendClassification", ["trend", "blip", "neutral"]),
  // Change-detection indicators
  cusumAlarm: boolean("cusumAlarm"),
  cusumUp: double("cusumUp"),
  cusumDown: double("cusumDown"),
  hurstExponent: double("hurstExponent"),
  adx: double("adx"),
  adxPlus: double("adxPlus"),
  adxMinus: double("adxMinus"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Trading Signals ─────────────────────────────────────────────────
export const tradingSignals = mysqlTable("trading_signals", {
  id: int("id").autoincrement().primaryKey(),
  ts: bigint("ts", { mode: "number" }).notNull(),
  signal: mysqlEnum("signal", ["buy", "sell", "hold"]).notNull(),
  price: double("price").notNull(),
  confidence: double("confidence"),
  reasoning: text("reasoning").notNull(),
  metricsSnapshot: json("metricsSnapshot"),
  executed: boolean("executed").default(false).notNull(),
  outcome: mysqlEnum("outcome", ["win", "loss", "pending", "hold_correct", "hold_missed"]).default("pending"),
  outcomePrice: double("outcomePrice"),
  outcomeTs: bigint("outcomeTs", { mode: "number" }),
  portfolioValue: double("portfolioValue"),
  /** Strategy variant: "champion" (acts on portfolio), "aggressive"/"conservative" (shadow-only).
   *  NULL for legacy/pre-Phase-2 signals. */
  strategyVariant: varchar("strategyVariant", { length: 20 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Simulator Portfolio ─────────────────────────────────────────────
/**
 * One row per execution venue. The `internal` row is the paper ledger and is
 * the analysis baseline; `okx-demo` / `okx-live` mirror the real account.
 *
 * Existing rows predate this column and default to `internal`, which is what
 * they were — the entire pre-2026-08-15 track record is the paper book.
 */
export const simulatorState = mysqlTable("simulator_state", {
  id: int("id").autoincrement().primaryKey(),
  venue: varchar("venue", { length: 32 }).notNull().default("internal"),
  cashUsd: double("cashUsd").notNull().default(10000),
  btcHolding: double("btcHolding").notNull().default(0),
  totalValueUsd: double("totalValueUsd").notNull().default(10000),
  seedAmountUsd: double("seedAmountUsd").notNull().default(10000),
  lastPrice: double("lastPrice").default(0),
  isRunning: boolean("isRunning").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ─── Simulator Trade History ─────────────────────────────────────────
export const simulatorTrades = mysqlTable("simulator_trades", {
  id: int("id").autoincrement().primaryKey(),
  /** Which book this fill belongs to: internal | okx-demo | okx-live. */
  venue: varchar("venue", { length: 32 }).notNull().default("internal"),
  /** Venue order id, when the venue has one. Null for the paper ledger. */
  venueOrderId: varchar("venueOrderId", { length: 64 }),
  /** Fee charged in USD. Zero for the paper ledger unless TRADING_FEE_BPS is set. */
  feeUsd: double("feeUsd").notNull().default(0),
  signalId: int("signalId"),
  action: mysqlEnum("action", ["buy", "sell"]).notNull(),
  price: double("price").notNull(),
  btcAmount: double("btcAmount").notNull(),
  usdValue: double("usdValue").notNull(),
  cashAfter: double("cashAfter").notNull(),
  btcAfter: double("btcAfter").notNull(),
  totalValueAfter: double("totalValueAfter").notNull(),
  reasoning: text("reasoning"),
  ts: bigint("ts", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * Hourly derivatives positioning and flow, recorded forward.
 *
 * Every exchange discards this data quickly: OKX serves 30 days of hourly
 * stats, Binance 21, Bybit 8, and none of them paginate further back — checked
 * 2026-08-16. So a positioning-based signal cannot be backtested on history
 * that does not exist; the only way to obtain a usable sample is to start
 * writing it down. Six currencies at hourly resolution reach ~2,000 bars each
 * within three months, against the ~60 daily bars that made the first
 * positioning test inconclusive.
 *
 * (ccy, ts) is unique so a collector run can re-fetch OKX's whole 720-row
 * window every time and simply let duplicates fall away. That makes the
 * collector self-healing: any gap left by downtime is refilled on the next run
 * with no gap-tracking logic.
 */
export const positioningSnapshots = mysqlTable("positioning_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  /** Currency the stats aggregate over, e.g. BTC. OKX reports these per-ccy. */
  ccy: varchar("ccy", { length: 16 }).notNull(),
  /** Start of the hour bucket, ms. */
  ts: bigint("ts", { mode: "number" }).notNull(),
  /** Open interest across contracts, USD. */
  openInterestUsd: double("openInterestUsd"),
  /** Contract trading volume for the bucket, USD. */
  volumeUsd: double("volumeUsd"),
  /** Long/short ACCOUNT ratio — how retail is positioned, not size-weighted. */
  longShortRatio: double("longShortRatio"),
  /** Taker volume crossing the spread to buy / to sell. */
  takerBuyUsd: double("takerBuyUsd"),
  takerSellUsd: double("takerSellUsd"),
  /** Perp funding rate in effect, e.g. 0.0001 = 0.01%/8h. */
  fundingRate: double("fundingRate"),
  /** Spot close for the bucket, so OI moves can be read against price. */
  price: double("price"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  ccyTs: unique("positioning_ccy_ts").on(t.ccy, t.ts),
}));

// ─── Weekly Performance Snapshots ────────────────────────────────────
export const weeklyPerformance = mysqlTable("weekly_performance", {
  id: int("id").autoincrement().primaryKey(),
  weekStart: bigint("weekStart", { mode: "number" }).notNull(),
  weekEnd: bigint("weekEnd", { mode: "number" }).notNull(),
  startValue: double("startValue").notNull(),
  endValue: double("endValue").notNull(),
  returnPct: double("returnPct").notNull(),
  btcBuyHoldReturnPct: double("btcBuyHoldReturnPct").notNull(),
  totalTrades: int("totalTrades").notNull(),
  winRate: double("winRate"),
  sharpeRatio: double("sharpeRatio"),
  maxDrawdown: double("maxDrawdown"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Strategy Parameters (self-learning) ─────────────────────────────
export const strategyParams = mysqlTable("strategy_params", {
  id: int("id").autoincrement().primaryKey(),
  version: int("version").notNull().default(1),
  params: json("params").notNull(),
  backtestReturnPct: double("backtestReturnPct"),
  backtestSharpe: double("backtestSharpe"),
  backtestWinRate: double("backtestWinRate"),
  isActive: boolean("isActive").default(false).notNull(),
  notes: text("notes"),
  /** Candle interval used for metric computation and signal quality per run.
   *  Valid values: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
   *  Defaults to '1h'. Does NOT affect how often the engine fires (see heartbeatScheduleMinutes). */
  candleInterval: varchar("candleInterval", { length: 10 }).default("1h").notNull(),
  /** Software-level throttle: minimum minutes between automated heartbeat runs.
   *  0 = Off (heartbeat fires but skips signal generation).
   *  The underlying cron still fires at its configured rate; the handler checks
   *  this value and skips if insufficient time has elapsed since the last run. */
  heartbeatScheduleMinutes: int("heartbeatScheduleMinutes").default(60).notNull(),
  /** Platform cron task UID returned by createHeartbeatJob / manus-heartbeat create.
   *  Persisted here so updateHeartbeatJob can target the correct job when the
   *  user changes the schedule from the Strategy Settings page. */
  heartbeatTaskUid: varchar("heartbeatTaskUid", { length: 65 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Validation Log ──────────────────────────────────────────────────
export const validationLog = mysqlTable("validation_log", {
  id: int("id").autoincrement().primaryKey(),
  periodStart: bigint("periodStart", { mode: "number" }).notNull(),
  periodEnd: bigint("periodEnd", { mode: "number" }).notNull(),
  totalSignals: int("totalSignals").notNull(),
  correctSignals: int("correctSignals").notNull(),
  winRate: double("winRate").notNull(),
  sharpeRatio: double("sharpeRatio"),
  maxDrawdown: double("maxDrawdown"),
  avgReturn: double("avgReturn"),
  /** Sum of |returnPct| across all hold signals in the window — raw inaction regret. */
  holdRegret: double("holdRegret"),
  /** Count of holds where |returnPct| > HOLD_NOISE_THRESHOLD (missed a real move). */
  holdMissed: int("holdMissed"),
  /** Count of holds where |returnPct| ≤ HOLD_NOISE_THRESHOLD (correctly cautious). */
  holdCorrect: int("holdCorrect"),
  /** avgReturn − λ × (holdRegret / total signals). Optimizer's objective. */
  riskAdjustedReturn: double("riskAdjustedReturn"),
  paramVersionUsed: int("paramVersionUsed"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});