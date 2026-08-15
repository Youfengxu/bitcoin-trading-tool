/**
 * Sizing Policy Backtest — A/B harness for the position-sizing fix.
 *
 * Answers one question: does replacing "fraction of REMAINING cash" sizing with
 * target-exposure sizing actually improve results on real history, once trading
 * costs are modelled?
 *
 * WHY FEES ARE NOT OPTIONAL HERE:
 *   The current rule spends maxPositionPct of what is LEFT, so consecutive
 *   same-direction signals average in at 25%, 18.75%, 14.1%... producing
 *   hundreds of small trades. Target sizing reaches the same exposure in one
 *   fill. With feeBps = 0 those two are nearly indistinguishable; the entire
 *   difference lives in transaction cost and fill quality. Run with a realistic
 *   --feeBps or the comparison is meaningless.
 *
 * FAITHFULNESS TO PRODUCTION:
 *   - Indicators run on a FIXED trailing window of getCandleLimit(interval)
 *     bars, exactly as heartbeatHandler does (walkForwardOptimizer's growing
 *     window does not match production — see P2-2).
 *   - The 2-of-2 confirmation gate is replicated, with an optional time bound.
 *   - External modifiers are NOT applied (they need live feeds and carry an
 *     unvalidated-threshold caveat). This isolates the sizing variable.
 *
 * USAGE
 *   pnpm tsx server/scripts/sizingBacktest.ts --days=180 --feeBps=13
 *   node --experimental-strip-types server/scripts/sizingBacktest.ts --synthetic
 *
 *   --days=N          history to pull (default 180)
 *   --interval=1h     candle interval (default 1h)
 *   --feeBps=13       per-side cost in basis points (13 ≈ Kraken taker 0.26% round trip)
 *   --slipBps=2       additional adverse fill assumption per side (default 2)
 *   --cache=PATH      read candles from PATH if present, otherwise fetch and write it
 *   --synthetic       generate a deterministic series instead of fetching (smoke test)
 *   --no-confirm      disable the 2-of-2 confirmation gate
 *   --json=PATH       write full results as JSON
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis.ts";
import { generateSignal } from "../engine/signalGenerator.ts";
import {
  DEFAULT_STRATEGY_PARAMS,
  getCandleLimit,
  type StrategyParameters,
} from "../../shared/tradingTypes.ts";
import * as fs from "fs";

// ─── CLI ──────────────────────────────────────────────────────────────
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const flag = (k: string) => process.argv.includes(`--${k}`);

const DAYS = Number(arg("days") ?? 180);
const INTERVAL = arg("interval") ?? "1h";
const FEE_BPS = Number(arg("feeBps") ?? 13);
const SLIP_BPS = Number(arg("slipBps") ?? 2);
const CACHE = arg("cache");
const JSON_OUT = arg("json");
const SYNTHETIC = flag("synthetic");
const CONFIRM = !flag("no-confirm");
const INITIAL_CASH = 10000;

const INTERVAL_MS: Record<string, number> = {
  "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "4h": 144e5, "1d": 864e5,
};
const BAR_MS = INTERVAL_MS[INTERVAL] ?? 36e5;
const BARS_PER_YEAR = (365 * 24 * 3600_000) / BAR_MS;

// ─── Candle sources ───────────────────────────────────────────────────
function syntheticCandles(n: number): CandleData[] {
  let s = 42 >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => { const u = Math.max(1e-12, rnd()), v = Math.max(1e-12, rnd()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const out: CandleData[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = acc * 0.97 + g() * 0.010;
    const close = 70000 * Math.exp(0.10 * Math.sin((2 * Math.PI * i) / 240) + acc);
    const prev = i > 0 ? out[i - 1].close : close;
    out.push({
      open: prev,
      high: Math.max(close, prev) * (1 + Math.abs(g()) * 0.002),
      low: Math.min(close, prev) * (1 - Math.abs(g()) * 0.002),
      close,
      volume: 100 * (1 + Math.abs((close - prev) / prev) * 60 + Math.abs(g()) * 0.3),
      openTime: i * BAR_MS,
    });
  }
  return out;
}

async function fetchCandles(days: number): Promise<CandleData[]> {
  const range = days <= 60 ? "2mo" : days <= 90 ? "3mo" : days <= 180 ? "6mo" : days <= 365 ? "1y" : "2y";
  const yahooInterval = INTERVAL === "4h" || INTERVAL === "1h" ? "1h" : INTERVAL === "1d" ? "1d" : INTERVAL;
  console.log(`Fetching ~${days}d of ${INTERVAL} candles (Yahoo BTC-USD, range=${range})...`);
  const res = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=${yahooInterval}&range=${range}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; btc-sizing-backtest/1.0)" } }
  );
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}`);
  const data = (await res.json()) as {
    chart: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> } }> };
  };
  const c = data.chart.result?.[0];
  if (!c) throw new Error("Yahoo Finance returned no chart result");
  const q = c.indicators.quote[0];
  const out: CandleData[] = [];
  for (let i = 0; i < c.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], cl = q.close[i];
    if (!o || !h || !l || !cl) continue;
    out.push({ open: o, high: h, low: l, close: cl, volume: q.volume[i] ?? 0, openTime: c.timestamp[i] * 1000 });
  }
  const cutoff = Date.now() - days * 864e5;
  return out.filter((x) => x.openTime >= cutoff).sort((a, b) => a.openTime - b.openTime);
}

async function loadCandles(): Promise<{ candles: CandleData[]; source: string }> {
  if (SYNTHETIC) {
    const need = getCandleLimit(INTERVAL) + Math.ceil((DAYS * 864e5) / BAR_MS);
    return { candles: syntheticCandles(need), source: "SYNTHETIC (deterministic — not real market data)" };
  }
  if (CACHE && fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8")) as CandleData[];
    return { candles: c, source: `cache: ${CACHE} (${c.length} bars)` };
  }
  const c = await fetchCandles(DAYS);
  if (CACHE) { fs.writeFileSync(CACHE, JSON.stringify(c)); console.log(`  cached → ${CACHE}`); }
  return { candles: c, source: `Yahoo Finance BTC-USD (${c.length} bars)` };
}

// ─── Signal replay (production-faithful) ──────────────────────────────
interface Sig { idx: number; ts: number; price: number; signal: "buy" | "sell" | "hold"; confidence: number }

function replaySignals(candles: CandleData[], params: StrategyParameters): Sig[] {
  const win = getCandleLimit(INTERVAL);
  const out: Sig[] = [];
  process.stderr.write("replaying signals");
  for (let i = win - 1; i < candles.length; i++) {
    const window = candles.slice(i - win + 1, i + 1);   // FIXED window — matches production
    const m = computeAllMetrics(window, params.zScoreTrendThreshold, params.zScoreBlipThreshold);
    const s = generateSignal(m, params);
    out.push({ idx: i, ts: candles[i].openTime, price: m.price, signal: s.signal, confidence: s.confidence });
    if (i % 250 === 0) process.stderr.write(".");
  }
  process.stderr.write(` ${out.length} bars\n`);
  return out;
}

// ─── Sizing policies ──────────────────────────────────────────────────
type Policy = "current" | "target" | "target-conf";

/** Returns desired BTC-value fraction of total equity after acting on this signal. */
function desiredExposure(policy: Policy, dir: "buy" | "sell", conf: number, curExposure: number, params: StrategyParameters): number {
  switch (policy) {
    case "current":
      // Fraction-of-remaining, expressed as a resulting exposure (the P1-1 behaviour).
      return dir === "buy"
        ? curExposure + (1 - curExposure) * params.maxPositionPct
        : curExposure - curExposure * params.maxPositionPct;
    case "target":
      // Decisive: fully in on buy, fully out on sell.
      return dir === "buy" ? 1 : 0;
    case "target-conf": {
      // Conviction-scaled: map confidence over [minConfidence, 1] to exposure [0.5, 1].
      const span = Math.max(1e-6, 1 - params.minConfidence);
      const scaled = Math.min(1, Math.max(0, (conf - params.minConfidence) / span));
      return dir === "buy" ? 0.5 + 0.5 * scaled : 0;
    }
  }
}

interface Result {
  policy: Policy;
  totalReturnPct: number; buyHoldPct: number;
  trades: number; turnoverX: number; feesPaid: number;
  maxDrawdownPct: number; sharpe: number;
  timeInMarketPct: number;
  avgEntrySlipPct: number; avgExitSlipPct: number;
  episodes: number;
}

function simulate(sigs: Sig[], policy: Policy, params: StrategyParameters): Result {
  const costRate = (FEE_BPS + SLIP_BPS) / 10000;
  let cash = INITIAL_CASH, btc = 0, trades = 0, fees = 0, turnover = 0;
  let peak = INITIAL_CASH, maxDd = 0, inMarket = 0;
  const equitySeries: number[] = [];

  // confirmation state
  let prevNonHold: { dir: "buy" | "sell"; ts: number } | null = null;
  const confirmWindowMs = BAR_MS * 2.5;

  // episode fill tracking
  let ep: { dir: "buy" | "sell"; firstPrice: number; qty: number; notional: number } | null = null;
  const entrySlip: number[] = [], exitSlip: number[] = [];
  const closeEpisode = () => {
    if (ep && ep.qty > 0) {
      const avgFill = ep.notional / ep.qty;
      const slip = (avgFill - ep.firstPrice) / ep.firstPrice;
      (ep.dir === "buy" ? entrySlip : exitSlip).push(slip);
    }
    ep = null;
  };

  for (const s of sigs) {
    const equity = cash + btc * s.price;
    equitySeries.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
    if (btc * s.price > equity * 0.01) inMarket++;

    if (s.signal === "hold") continue;
    const dir = s.signal;

    // 2-of-2 confirmation, time-bounded (P0-4 fix applied here)
    let confirmed = true;
    if (CONFIRM) {
      confirmed = !!prevNonHold && prevNonHold.dir === dir && (s.ts - prevNonHold.ts) <= confirmWindowMs;
    }
    prevNonHold = { dir, ts: s.ts };
    if (!confirmed) continue;

    if (!ep || ep.dir !== dir) { closeEpisode(); ep = { dir, firstPrice: s.price, qty: 0, notional: 0 }; }

    const curExp = equity > 0 ? (btc * s.price) / equity : 0;
    const wantExp = Math.min(1, Math.max(0, desiredExposure(policy, dir, s.confidence, curExp, params)));
    const deltaUsd = (wantExp - curExp) * equity;

    if (dir === "buy" && deltaUsd > 1) {
      const spend = Math.min(cash, deltaUsd);
      if (spend <= 1) continue;
      const cost = spend * costRate;
      const qty = (spend - cost) / s.price;
      cash -= spend; btc += qty; fees += cost; turnover += spend; trades++;
      ep.qty += qty; ep.notional += qty * s.price;
    } else if (dir === "sell" && deltaUsd < -1) {
      const sellUsd = Math.min(btc * s.price, -deltaUsd);
      if (sellUsd <= 1) continue;
      const qty = sellUsd / s.price;
      const cost = sellUsd * costRate;
      btc -= qty; cash += sellUsd - cost; fees += cost; turnover += sellUsd; trades++;
      ep.qty += qty; ep.notional += qty * s.price;
    }
  }
  closeEpisode();

  const lastPrice = sigs[sigs.length - 1].price;
  const finalValue = cash + btc * lastPrice;
  const rets: number[] = [];
  for (let i = 1; i < equitySeries.length; i++) rets.push((equitySeries[i] - equitySeries[i - 1]) / equitySeries[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  return {
    policy,
    totalReturnPct: ((finalValue - INITIAL_CASH) / INITIAL_CASH) * 100,
    buyHoldPct: ((lastPrice - sigs[0].price) / sigs[0].price) * 100,
    trades, turnoverX: turnover / INITIAL_CASH, feesPaid: fees,
    maxDrawdownPct: maxDd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(BARS_PER_YEAR) : 0,
    timeInMarketPct: (inMarket / sigs.length) * 100,
    avgEntrySlipPct: avg(entrySlip) * 100,
    avgExitSlipPct: avg(exitSlip) * 100,
    episodes: entrySlip.length + exitSlip.length,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const hr = "─".repeat(94);
  const { candles, source } = await loadCandles();
  const params = DEFAULT_STRATEGY_PARAMS;
  const win = getCandleLimit(INTERVAL);

  if (candles.length < win + 50) {
    throw new Error(`Need at least ${win + 50} candles for a ${INTERVAL} backtest, got ${candles.length}.`);
  }

  console.log(`\n${hr}`);
  console.log(`SIZING POLICY BACKTEST`);
  console.log(hr);
  console.log(`  data           : ${source}`);
  console.log(`  interval       : ${INTERVAL}   indicator window: ${win} bars (production-faithful)`);
  console.log(`  period         : ${new Date(candles[0].openTime).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10)}`);
  console.log(`  cost model     : ${FEE_BPS}bps fee + ${SLIP_BPS}bps slippage = ${((FEE_BPS + SLIP_BPS) / 100).toFixed(2)}% per side`);
  console.log(`  confirmation   : ${CONFIRM ? "2-of-2, time-bounded" : "disabled"}`);
  if (SYNTHETIC) console.log(`  ⚠  SYNTHETIC DATA — validates the harness, proves nothing about live performance.`);
  if (FEE_BPS === 0) console.log(`  ⚠  feeBps=0 — the sizing comparison is NOT meaningful without costs.`);

  const sigs = replaySignals(candles, params);
  const results = (["current", "target", "target-conf"] as Policy[]).map((p) => simulate(sigs, p, params));

  console.log(`\n${hr}`);
  console.log(`  ${"policy".padEnd(14)} ${"return".padStart(9)} ${"vs B&H".padStart(9)} ${"trades".padStart(7)} ${"turnover".padStart(9)} ${"fees$".padStart(8)} ${"maxDD".padStart(7)} ${"Sharpe".padStart(7)} ${"inMkt".padStart(7)}`);
  console.log(hr);
  for (const r of results) {
    console.log(
      `  ${r.policy.padEnd(14)} ` +
      `${(r.totalReturnPct >= 0 ? "+" : "") + r.totalReturnPct.toFixed(2) + "%"}`.padStart(10) +
      `${(r.totalReturnPct - r.buyHoldPct >= 0 ? "+" : "") + (r.totalReturnPct - r.buyHoldPct).toFixed(2) + "%"}`.padStart(10) +
      `${r.trades}`.padStart(8) +
      `${r.turnoverX.toFixed(1) + "x"}`.padStart(10) +
      `${r.feesPaid.toFixed(0)}`.padStart(9) +
      `${r.maxDrawdownPct.toFixed(1) + "%"}`.padStart(8) +
      `${r.sharpe.toFixed(2)}`.padStart(8) +
      `${r.timeInMarketPct.toFixed(0) + "%"}`.padStart(8)
    );
  }
  console.log(hr);
  console.log(`  buy & hold over the same period: ${(results[0].buyHoldPct >= 0 ? "+" : "") + results[0].buyHoldPct.toFixed(2)}%`);

  console.log(`\n  FILL QUALITY (average fill vs the price of the signal that opened the episode)`);
  for (const r of results) {
    console.log(`    ${r.policy.padEnd(14)} entries ${(r.avgEntrySlipPct >= 0 ? "+" : "") + r.avgEntrySlipPct.toFixed(3)}%   exits ${(r.avgExitSlipPct >= 0 ? "+" : "") + r.avgExitSlipPct.toFixed(3)}%   (${r.episodes} episodes)`);
  }
  console.log(`    Positive entry slip = you bought above your own trigger. Closer to 0 is better.`);

  const cur = results[0], tgt = results[1];
  console.log(`\n  VERDICT`);
  const delta = tgt.totalReturnPct - cur.totalReturnPct;
  const costDelta = tgt.feesPaid - cur.feesPaid;
  console.log(`    target vs current: ${(delta >= 0 ? "+" : "") + delta.toFixed(2)} pts return, ` +
    `${Math.abs(cur.trades - tgt.trades)} ${tgt.trades < cur.trades ? "fewer" : "more"} trades, ` +
    `$${Math.abs(costDelta).toFixed(0)} ${costDelta > 0 ? "MORE" : "less"} in costs, ` +
    `${(tgt.maxDrawdownPct - cur.maxDrawdownPct >= 0 ? "+" : "") + (tgt.maxDrawdownPct - cur.maxDrawdownPct).toFixed(1)} pts drawdown.`);
  if (costDelta > 0) {
    console.log(`    Note: fewer trades does NOT mean lower cost — full-size round trips move more`);
    console.log(`    notional than fractional averaging. Target sizing's edge is fill quality, not fees.`);
  }
  console.log(`    ${delta > 0 && tgt.maxDrawdownPct <= cur.maxDrawdownPct * 1.25
    ? "→ Target sizing wins on this sample. Confirm on a second, non-overlapping period before shipping."
    : "→ Not a clean win on this sample. Do NOT ship on this evidence alone; test other periods first."}`);
  console.log(`${hr}\n`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      meta: { source, interval: INTERVAL, days: DAYS, feeBps: FEE_BPS, slipBps: SLIP_BPS, confirm: CONFIRM, synthetic: SYNTHETIC, bars: sigs.length },
      results,
    }, null, 2));
    console.log(`Full results → ${JSON_OUT}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
