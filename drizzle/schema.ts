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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Simulator Portfolio ─────────────────────────────────────────────
export const simulatorState = mysqlTable("simulator_state", {
  id: int("id").autoincrement().primaryKey(),
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