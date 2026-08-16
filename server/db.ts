import { eq, desc, and, gte, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  priceCandles,
  metricSnapshots,
  tradingSignals,
  simulatorState,
  simulatorTrades,
  positioningSnapshots,
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
  cusumAlarm?: boolean | null; cusumUp?: number | null; cusumDown?: number | null;
  hurstExponent?: number | null; adx?: number | null; adxPlus?: number | null; adxMinus?: number | null;
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
  strategyVariant?: "champion" | "aggressive" | "conservative";
}) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(tradingSignals).values({
    ts: sig.ts, signal: sig.signal, price: sig.price,
    confidence: sig.confidence, reasoning: sig.reasoning,
    metricsSnapshot: sig.metricsSnapshot,
    portfolioValue: sig.portfolioValue,
    strategyVariant: sig.strategyVariant,
  });
  return result[0]?.insertId;
}

/**
 * Fetch resolved signals (outcome != pending) since a given timestamp, used by
 * the champion-challenger evaluator to construct paired observations.
 */
export async function getResolvedSignalsSince(sinceTs: number, limit = 1000) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(tradingSignals)
    .where(and(gte(tradingSignals.ts, sinceTs), ne(tradingSignals.outcome, "pending")))
    .orderBy(desc(tradingSignals.ts))
    .limit(limit);
}

export async function getRecentSignals(limit: number = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tradingSignals).orderBy(desc(tradingSignals.ts)).limit(limit);
}

export async function updateSignalOutcome(
  id: number,
  outcome: "win" | "loss" | "hold_correct" | "hold_missed",
  outcomePrice: number,
  outcomeTs: number
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
//
// Every simulator read and write is scoped to a venue. `internal` is the paper
// ledger and the analysis baseline; `okx-demo` / `okx-live` mirror the real
// account. Defaulting the parameter to "internal" keeps every existing caller —
// and the whole pre-2026-08-15 track record — behaving exactly as before.

/** The paper ledger. Also the default for every venue-scoped helper here. */
export const INTERNAL_VENUE = "internal";

export async function getSimulatorState(venue: string = INTERNAL_VENUE) {
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select()
    .from(simulatorState)
    .where(eq(simulatorState.venue, venue))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function initSimulatorState(venue: string = INTERNAL_VENUE) {
  const db = await getDb();
  if (!db) return;
  const existing = await getSimulatorState(venue);
  if (existing) return existing;
  await db.insert(simulatorState).values({
    venue,
    cashUsd: 10000, btcHolding: 0, totalValueUsd: 10000,
    seedAmountUsd: 10000, lastPrice: 0, isRunning: true,
  });
  return getSimulatorState(venue);
}

export async function updateSimulatorState(
  update: {
    cashUsd?: number; btcHolding?: number; totalValueUsd?: number;
    lastPrice?: number; isRunning?: boolean;
  },
  venue: string = INTERNAL_VENUE
) {
  const db = await getDb();
  if (!db) return;
  const state = await getSimulatorState(venue);
  if (!state) return;
  await db.update(simulatorState).set(update).where(eq(simulatorState.id, state.id));
}

/** Resets one venue's book. Trades for other venues are left untouched. */
export async function resetSimulator(venue: string = INTERNAL_VENUE) {
  const db = await getDb();
  if (!db) return;
  const state = await getSimulatorState(venue);
  if (!state) { await initSimulatorState(venue); return; }
  await db.update(simulatorState).set({
    cashUsd: 10000, btcHolding: 0, totalValueUsd: 10000, lastPrice: 0, isRunning: true,
  }).where(eq(simulatorState.id, state.id));
  await db.delete(simulatorTrades).where(eq(simulatorTrades.venue, venue));
}

/** Venues that currently have a book, so the UI can offer a selector. */
export async function listSimulatorVenues(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [INTERNAL_VENUE];
  const rows = await db.select({ venue: simulatorState.venue }).from(simulatorState);
  const venues = rows.map((r) => r.venue);
  return venues.length > 0 ? venues : [INTERNAL_VENUE];
}

// ─── Simulator Trades ────────────────────────────────────────────────
export async function insertSimulatorTrade(trade: {
  signalId?: number; action: "buy" | "sell"; price: number;
  btcAmount: number; usdValue: number; cashAfter: number;
  btcAfter: number; totalValueAfter: number; reasoning?: string; ts: number;
  venue?: string; venueOrderId?: string; feeUsd?: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(simulatorTrades).values({
    ...trade,
    venue: trade.venue ?? INTERNAL_VENUE,
    feeUsd: trade.feeUsd ?? 0,
  });
}

export async function getRecentTrades(limit: number = 50, venue: string = INTERNAL_VENUE) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(simulatorTrades)
    .where(eq(simulatorTrades.venue, venue))
    .orderBy(desc(simulatorTrades.ts)).limit(limit);
}

export async function getTradesInRange(
  startTs: number,
  endTs: number,
  venue: string = INTERNAL_VENUE
) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(simulatorTrades)
    .where(and(
      eq(simulatorTrades.venue, venue),
      gte(simulatorTrades.ts, startTs),
      lte(simulatorTrades.ts, endTs)
    ))
    .orderBy(desc(simulatorTrades.ts));
}

// ─── Positioning Snapshots ───────────────────────────────────────────
/**
 * Inserts hourly positioning rows, discarding any already stored.
 *
 * Relies on the (ccy, ts) unique constraint rather than checking first: the
 * collector re-submits its whole 30-day window each run, so duplicates are the
 * normal case and letting the DB reject them is what makes the collector
 * self-healing after downtime. Returns the number of genuinely new rows.
 */
export async function insertPositioningSnapshots(rows: Array<{
  ccy: string; ts: number;
  openInterestUsd?: number; volumeUsd?: number; longShortRatio?: number;
  takerBuyUsd?: number; takerSellUsd?: number; fundingRate?: number; price?: number;
}>): Promise<number> {
  const db = await getDb();
  if (!db || rows.length === 0) return 0;

  const existing = await db.select({ ts: positioningSnapshots.ts })
    .from(positioningSnapshots)
    .where(eq(positioningSnapshots.ccy, rows[0].ccy));
  const have = new Set(existing.map((r) => r.ts));
  const fresh = rows.filter((r) => !have.has(r.ts));
  if (!fresh.length) return 0;

  // Chunked: a 720-row window across a few currencies exceeds comfortable
  // single-statement placeholder limits.
  for (let i = 0; i < fresh.length; i += 200) {
    await db.insert(positioningSnapshots).values(fresh.slice(i, i + 200));
  }
  return fresh.length;
}

/** Recorded positioning history for one currency, oldest first. */
export async function getPositioningHistory(ccy: string, limit = 2000) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(positioningSnapshots)
    .where(eq(positioningSnapshots.ccy, ccy))
    .orderBy(desc(positioningSnapshots.ts)).limit(limit);
  return rows.reverse();
}

/** Row counts and coverage per currency, for monitoring the collector. */
export async function getPositioningCoverage() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(positioningSnapshots);
  const byCcy = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byCcy.get(r.ccy) ?? [];
    arr.push(r.ts);
    byCcy.set(r.ccy, arr);
  }
  return Array.from(byCcy.entries()).map(([ccy, ts]) => ({
    ccy, rows: ts.length,
    oldest: Math.min(...ts), newest: Math.max(...ts),
    days: (Math.max(...ts) - Math.min(...ts)) / 86400000,
  }));
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
  if (result.length === 0) return null;
  const row = result[0]!;
  let p: unknown = row.params;
  while (typeof p === "string") p = JSON.parse(p);
  row.params = p;
  return row;
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
      params: DEFAULT_STRATEGY_PARAMS,
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
  maxDrawdown?: number; avgReturn?: number;
  holdRegret?: number; holdMissed?: number; holdCorrect?: number;
  riskAdjustedReturn?: number;
  paramVersionUsed?: number; notes?: string;
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
