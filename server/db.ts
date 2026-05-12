import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  priceCandles,
  metricSnapshots,
  tradingSignals,
  simulatorState,
  simulatorTrades,
  weeklyPerformance,
  strategyParams,
  validationLog,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── User Helpers ────────────────────────────────────────────────────
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Price Candles ───────────────────────────────────────────────────
export async function insertCandles(
  candles: Array<{
    openTime: number; open: number; high: number; low: number;
    close: number; volume: number; closeTime: number; interval?: string;
  }>
) {
  const db = await getDb();
  if (!db || candles.length === 0) return;
  await db.insert(priceCandles).values(
    candles.map((c) => ({
      openTime: c.openTime, open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume, closeTime: c.closeTime,
      interval: c.interval ?? "1h",
    }))
  );
}

export async function getRecentCandles(interval: string = "1h", limit: number = 500) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(priceCandles)
    .where(eq(priceCandles.interval, interval))
    .orderBy(desc(priceCandles.openTime)).limit(limit);
}

export async function getLatestCandleTime(interval: string = "1h"): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select({ maxTime: sql<number>`MAX(openTime)` })
    .from(priceCandles).where(eq(priceCandles.interval, interval));
  return result[0]?.maxTime ?? null;
}

// ─── Metric Snapshots ────────────────────────────────────────────────
export async function insertMetricSnapshot(snapshot: {
  ts: number; price: number;
  rsi14?: number | null; macdLine?: number | null; macdSignal?: number | null;
  macdHist?: number | null; bbUpper?: number | null; bbMiddle?: number | null;
  bbLower?: number | null; ema12?: number | null; ema26?: number | null;
  sma50?: number | null; sma200?: number | null; volumeSma20?: number | null;
  volumeRatio?: number | null; zScore?: number | null; rollingStdDev?: number | null;
  trendClassification?: "trend" | "blip" | "neutral" | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(metricSnapshots).values(snapshot);
}

export async function getRecentMetrics(limit: number = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(metricSnapshots).orderBy(desc(metricSnapshots.ts)).limit(limit);
}

// ─── Trading Signals ─────────────────────────────────────────────────
export async function insertSignal(sig: {
  ts: number; signal: "buy" | "sell" | "hold"; price: number;
  confidence?: number; reasoning: string; metricsSnapshot?: unknown;
  portfolioValue?: number;
}) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(tradingSignals).values({
    ts: sig.ts, signal: sig.signal, price: sig.price,
    confidence: sig.confidence, reasoning: sig.reasoning,
    metricsSnapshot: sig.metricsSnapshot,
    portfolioValue: sig.portfolioValue,
  });
  return result[0]?.insertId;
}

export async function getRecentSignals(limit: number = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tradingSignals).orderBy(desc(tradingSignals.ts)).limit(limit);
}

export async function updateSignalOutcome(
  id: number, outcome: "win" | "loss", outcomePrice: number, outcomeTs: number
) {
  const db = await getDb();
  if (!db) return;
  await db.update(tradingSignals).set({ outcome, outcomePrice, outcomeTs })
    .where(eq(tradingSignals.id, id));
}

export async function getPendingSignals() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tradingSignals)
    .where(and(eq(tradingSignals.outcome, "pending"), sql`${tradingSignals.signal} != 'hold'`))
    .orderBy(desc(tradingSignals.ts)).limit(100);
}

// ─── Simulator State ─────────────────────────────────────────────────
export async function getSimulatorState() {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(simulatorState).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function initSimulatorState() {
  const db = await getDb();
  if (!db) return;
  const existing = await getSimulatorState();
  if (existing) return existing;
  await db.insert(simulatorState).values({
    cashUsd: 10000, btcHolding: 0, totalValueUsd: 10000,
    seedAmountUsd: 10000, lastPrice: 0, isRunning: true,
  });
  return getSimulatorState();
}

export async function updateSimulatorState(update: {
  cashUsd?: number; btcHolding?: number; totalValueUsd?: number;
  lastPrice?: number; isRunning?: boolean;
}) {
  const db = await getDb();
  if (!db) return;
  const state = await getSimulatorState();
  if (!state) return;
  await db.update(simulatorState).set(update).where(eq(simulatorState.id, state.id));
}

export async function resetSimulator() {
  const db = await getDb();
  if (!db) return;
  const state = await getSimulatorState();
  if (!state) { await initSimulatorState(); return; }
  await db.update(simulatorState).set({
    cashUsd: 10000, btcHolding: 0, totalValueUsd: 10000, lastPrice: 0, isRunning: true,
  }).where(eq(simulatorState.id, state.id));
  await db.delete(simulatorTrades);
}

// ─── Simulator Trades ────────────────────────────────────────────────
export async function insertSimulatorTrade(trade: {
  signalId?: number; action: "buy" | "sell"; price: number;
  btcAmount: number; usdValue: number; cashAfter: number;
  btcAfter: number; totalValueAfter: number; reasoning?: string; ts: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(simulatorTrades).values(trade);
}

export async function getRecentTrades(limit: number = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(simulatorTrades).orderBy(desc(simulatorTrades.ts)).limit(limit);
}

export async function getTradesInRange(startTs: number, endTs: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(simulatorTrades)
    .where(and(gte(simulatorTrades.ts, startTs), lte(simulatorTrades.ts, endTs)))
    .orderBy(desc(simulatorTrades.ts));
}

// ─── Weekly Performance ──────────────────────────────────────────────
export async function insertWeeklyPerformance(perf: {
  weekStart: number; weekEnd: number; startValue: number; endValue: number;
  returnPct: number; btcBuyHoldReturnPct: number; totalTrades: number;
  winRate?: number; sharpeRatio?: number; maxDrawdown?: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(weeklyPerformance).values(perf);
}

export async function getWeeklyPerformance(limit: number = 52) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(weeklyPerformance)
    .orderBy(desc(weeklyPerformance.weekEnd)).limit(limit);
}

// ─── Strategy Parameters ─────────────────────────────────────────────
export async function getActiveStrategyParams() {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(strategyParams)
    .where(eq(strategyParams.isActive, true))
    .orderBy(desc(strategyParams.version)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function insertStrategyParams(params: {
  version: number; params: unknown; backtestReturnPct?: number;
  backtestSharpe?: number; backtestWinRate?: number;
  isActive?: boolean; notes?: string;
}) {
  const db = await getDb();
  if (!db) return;
  if (params.isActive) {
    await db.update(strategyParams).set({ isActive: false });
  }
  await db.insert(strategyParams).values(params);
}

export async function updateStrategySettings(settings: {
  candleInterval?: string;
  heartbeatScheduleMinutes?: number;
  heartbeatTaskUid?: string;
}) {
  const db = await getDb();
  if (!db) return;
  // Find the currently active row
  const active = await db.select({ id: strategyParams.id })
    .from(strategyParams).where(eq(strategyParams.isActive, true)).limit(1);
  if (active.length > 0) {
    // Update existing active row
    await db.update(strategyParams)
      .set(settings)
      .where(eq(strategyParams.id, active[0]!.id));
  } else {
    // No active row exists (e.g. fresh production deployment) — seed one with defaults
    const { DEFAULT_STRATEGY_PARAMS } = await import("../shared/tradingTypes");
    await db.insert(strategyParams).values({
      version: 1,
      params: JSON.stringify(DEFAULT_STRATEGY_PARAMS),
      isActive: true,
      notes: "Auto-seeded on first settings update",
      candleInterval: settings.candleInterval ?? "1h",
      heartbeatScheduleMinutes: settings.heartbeatScheduleMinutes ?? 60,
      heartbeatTaskUid: settings.heartbeatTaskUid ?? null,
    });
  }
}

export async function getAllStrategyVersions() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(strategyParams).orderBy(desc(strategyParams.version)).limit(20);
}

// ─── Validation Log ──────────────────────────────────────────────────
export async function insertValidationEntry(entry: {
  periodStart: number; periodEnd: number; totalSignals: number;
  correctSignals: number; winRate: number; sharpeRatio?: number;
  maxDrawdown?: number; avgReturn?: number; paramVersionUsed?: number; notes?: string;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(validationLog).values(entry);
}

export async function getValidationHistory(limit: number = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(validationLog).orderBy(desc(validationLog.periodEnd)).limit(limit);
}
