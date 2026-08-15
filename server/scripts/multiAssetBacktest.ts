/**
 * Multi-Asset Backtest — does the edge exist outside BTC?
 *
 * Runs the PRODUCTION strategy, unchanged, across the most liquid OKX USDT spot
 * pairs. Every parameter, gate and cost matches what is deployed; only the
 * instrument varies.
 *
 * This is the cheapest test of whether the strategy is real. Every result so far
 * comes from one asset over six months, which is exactly the sample size at
 * which a curve fit is indistinguishable from an edge. If the same parameters
 * earn across unrelated assets, that is evidence. If they earn only on BTC, the
 * parameters were fitted to BTC's particular six months.
 *
 * The column that matters is ALPHA — return minus what a static blend holding
 * the same average exposure would have returned. Crypto assets are highly
 * correlated, so a strategy that is simply long will look good on all ten in a
 * bull window and bad on all ten in a bear one, telling you nothing. Alpha
 * strips the market out.
 *
 * Usage:
 *   pnpm tsx server/scripts/multiAssetBacktest.ts
 *   pnpm tsx server/scripts/multiAssetBacktest.ts --top=10 --json=out.json
 */

import { computeAllMetrics, type CandleData } from "../engine/technicalAnalysis";
import { generateSignal } from "../engine/signalGenerator";
import * as okx from "../engine/okxClient";
import {
  getCandleLimit,
  convictionScaledFraction,
  MIN_TRADE_NOTIONAL_USD,
  type StrategyParameters,
} from "../../shared/tradingTypes";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const TOP_N = arg("top") ? parseInt(arg("top")!) : 10;
const JSON_OUT = arg("json") ?? null;
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const COOLDOWN_BARS = parseFloat(arg("cooldown") ?? "0");

const SEED = 10000;
const HISTORY_START = Date.parse("2026-02-15T00:00:00Z");
/** Split between the held-out (earlier) window and the live window. */
const LIVE_START = Date.parse("2026-05-15T00:00:00Z");
const MIN_BARS = 1500;
/** A 6-month high/low range under this is a pegged asset, not something to trade. */
const PEG_RANGE_PCT = 0.05;

/**
 * Production strategy_params version 10, read from the live deployment.
 * Deliberately NOT re-optimised per asset — the question is whether these exact
 * parameters generalise, and re-fitting each asset would answer a different and
 * much easier question.
 */
const LIVE_PARAMS: StrategyParameters = {
  rsiBuyThreshold: 28.74061332508282,
  rsiSellThreshold: 63.22790449858233,
  macdBuyThreshold: 0,
  macdSellThreshold: 0,
  bbBuyDeviation: 0,
  bbSellDeviation: 0,
  zScoreTrendThreshold: 2.5540479541232797,
  zScoreBlipThreshold: 0.518618839238333,
  volumeRatioThreshold: 1.1806481112185083,
  emaCrossoverWeight: 0.16840235206915224,
  maxPositionPct: 0.14610934129,
  minConfidence: 0.45,
};

interface Result {
  instId: string;
  bars: number;
  ret: number;
  buyHold: number;
  exposure: number;
  blend: number;
  alpha: number;
  trades: number;
  maxDD: number;
  sharpe: number;
}

/** Replays the deployed decision path over one candle series. */
function run(candles: CandleData[], from: number, to: number): Result | null {
  const scope = getCandleLimit("1h");
  if (to - from < 200) return null;

  let cash = SEED, btc = 0, trades = 0, lastTradeBar = -9999, expSum = 0;
  const buffer: ("buy" | "sell")[] = [];
  const equity: number[] = [];

  for (let i = from; i <= to; i++) {
    const window = candles.slice(Math.max(0, i - scope + 1), i + 1);
    const metrics = computeAllMetrics(
      window,
      LIVE_PARAMS.zScoreTrendThreshold,
      LIVE_PARAMS.zScoreBlipThreshold
    );
    const sig = generateSignal(metrics, LIVE_PARAMS);
    const price = candles[i].close;

    if (sig.signal !== "hold") {
      buffer.push(sig.signal);
      if (buffer.length > 2) buffer.shift();
    }
    const confirmed = sig.signal !== "hold" && buffer.length === 2 && buffer[0] === buffer[1];

    if (confirmed && i - lastTradeBar >= COOLDOWN_BARS) {
      const frac = convictionScaledFraction(
        LIVE_PARAMS.maxPositionPct, sig.confidence, LIVE_PARAMS.minConfidence
      );
      if (sig.signal === "buy" && cash > 0) {
        const usd = cash * frac;
        if (usd >= MIN_TRADE_NOTIONAL_USD) {
          const fee = usd * FEE;
          btc += (usd - fee) / price;
          cash -= usd;
          trades++; lastTradeBar = i;
        }
      } else if (sig.signal === "sell" && btc > 0) {
        const sz = btc * frac, gross = sz * price;
        if (gross >= MIN_TRADE_NOTIONAL_USD) {
          const fee = gross * FEE;
          btc -= sz; cash += gross - fee;
          trades++; lastTradeBar = i;
        }
      }
    }

    const value = cash + btc * price;
    equity.push(value);
    expSum += value > 0 ? (btc * price) / value : 0;
  }

  const final = equity[equity.length - 1];
  let peak = equity[0], maxDD = 0;
  for (const v of equity) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, (peak - v) / peak); }

  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));

  const entry = candles[from].close, exit = candles[to].close;
  const buyHold = exit / entry - 1;
  const exposure = expSum / (to - from + 1);
  // Zero-effort control: hold `exposure` of the seed in the asset, never trade.
  const blend = (SEED * exposure * (exit / entry) + SEED * (1 - exposure)) / SEED - 1;

  return {
    instId: "", bars: to - from + 1,
    ret: final / SEED - 1, buyHold, exposure, blend,
    alpha: final / SEED - 1 - blend,
    trades, maxDD,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(24 * 365) : 0,
  };
}

const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function topPairs(n: number): Promise<string[]> {
  const tickers = await okx.publicGet<{ instId: string; volCcy24h: string }>(
    "/api/v5/market/tickers?instType=SPOT"
  );
  return tickers
    .filter((t) => t.instId.endsWith("-USDT"))
    .sort((a, b) => parseFloat(b.volCcy24h || "0") - parseFloat(a.volCcy24h || "0"))
    .map((t) => t.instId)
    .slice(0, n * 3); // over-fetch; pegged and newly-listed pairs get dropped below
}

async function main() {
  console.log(`\n${"═".repeat(104)}`);
  console.log(`Multi-Asset Backtest — production strategy v10, unchanged, ${(FEE * 10000).toFixed(0)}bps, cooldown ${COOLDOWN_BARS}`);
  console.log("═".repeat(104));

  const candidates = await topPairs(TOP_N);
  const selected: Array<{ instId: string; candles: CandleData[] }> = [];

  process.stdout.write("\nSelecting liquid pairs with enough history");
  for (const instId of candidates) {
    if (selected.length >= TOP_N) break;
    try {
      const raw = await okx.fetchCandlesFrom("1h", HISTORY_START, 5000, instId);
      const candles: CandleData[] = raw.map((c) => ({
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, openTime: c.openTime,
      }));
      if (candles.length < MIN_BARS) { process.stdout.write("."); continue; }
      const hi = Math.max(...candles.map((c) => c.high));
      const lo = Math.min(...candles.map((c) => c.low));
      if ((hi - lo) / ((hi + lo) / 2) < PEG_RANGE_PCT) { process.stdout.write("s"); continue; } // stablecoin
      selected.push({ instId, candles });
      process.stdout.write("+");
    } catch { process.stdout.write("x"); }
  }
  console.log(`\n  ${selected.length} pairs selected  (+ kept, s = pegged/stablecoin, . = too little history, x = fetch failed)\n`);

  const report: Record<string, Result[]> = {};

  for (const [label, winStart, winEnd] of [
    ["HELD-OUT WINDOW (Mar–May)", HISTORY_START, LIVE_START],
    ["LIVE WINDOW (May–Aug, the deployed period)", LIVE_START, Date.now()],
  ] as Array<[string, number, number]>) {
    console.log(`\n${label}`);
    console.log("─".repeat(104));
    console.log(
      "pair".padEnd(13) + pad("bars", 6) + pad("return", 10) + pad("buy&hold", 11) +
      pad("expo", 7) + pad("blend", 10) + pad("ALPHA", 10) + pad("trades", 8) +
      pad("maxDD", 8) + pad("Sharpe", 8)
    );
    console.log("─".repeat(104));

    const rows: Result[] = [];
    for (const { instId, candles } of selected) {
      const from = candles.findIndex((c) => c.openTime >= winStart);
      let to = candles.findIndex((c) => c.openTime >= winEnd);
      if (to < 0) to = candles.length - 1;
      const start = Math.max(from, getCandleLimit("1h"));
      const r = run(candles, start, to);
      if (!r) continue;
      r.instId = instId;
      rows.push(r);
      console.log(
        instId.padEnd(13) + pad(r.bars, 6) + pad(pct(r.ret), 10) + pad(pct(r.buyHold), 11) +
        pad(`${(r.exposure * 100).toFixed(0)}%`, 7) + pad(pct(r.blend), 10) +
        pad(pct(r.alpha), 10) + pad(r.trades, 8) +
        pad(`${(r.maxDD * 100).toFixed(1)}%`, 8) + pad(r.sharpe.toFixed(2), 8)
      );
    }
    console.log("─".repeat(104));
    const pos = rows.filter((r) => r.alpha > 0).length;
    const meanAlpha = rows.reduce((a, r) => a + r.alpha, 0) / Math.max(1, rows.length);
    console.log(`  positive alpha: ${pos}/${rows.length}   mean alpha ${pct(meanAlpha)}   ` +
                `median trades ${rows.map(r => r.trades).sort((a,b)=>a-b)[Math.floor(rows.length/2)]}`);
    report[label] = rows;
  }

  // ── Verdict ────────────────────────────────────────────────────────
  const [heldOut, live] = Object.values(report);
  const bothPositive = heldOut.filter((h) => {
    const l = live.find((x) => x.instId === h.instId);
    return l && h.alpha > 0 && l.alpha > 0;
  });
  console.log(`\n${"═".repeat(104)}`);
  console.log(`Assets with POSITIVE ALPHA IN BOTH windows: ${bothPositive.length}/${heldOut.length}` +
              (bothPositive.length ? ` — ${bothPositive.map((r) => r.instId).join(", ")}` : ""));
  console.log("A strategy that only works on the asset it was tuned on is a curve fit.");
  console.log("═".repeat(104) + "\n");

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`Wrote ${JSON_OUT}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
