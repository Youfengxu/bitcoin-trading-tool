/**
 * Positioning & Flow Signal — built from who is positioned how, not from price shape.
 *
 * ── The hypothesis ────────────────────────────────────────────────────
 * Four experiments this session built signals from price indicators and all
 * failed out-of-sample: the 8-layer blend (0/10 assets positive in both
 * regimes), the regime switch (-16% alpha), the mirrored short (-25%), and the
 * short-specific signal (+0.77%, 2/8). The ONE condition that measurably
 * improved anything was perp funding — removing it flipped short alpha from
 * +0.77% to -1.39%.
 *
 * Funding is not a price indicator. It is a measure of POSITIONING: what longs
 * are paying to stay long. That suggests the informative variable is who is
 * positioned how and at what cost, and that price patterns are the part that
 * does not generalise. This script inverts the architecture to test that:
 * positioning and flow decide, price merely confirms.
 *
 * ── Inputs, all positioning/flow ──────────────────────────────────────
 *   funding rate         what longs pay to hold — direct cost of crowding
 *   open interest        whether money is ENTERING or LEAVING the trade
 *   long/short ratio     how retail accounts are positioned
 *   taker buy/sell       which side is crossing the spread, i.e. aggressive
 *
 * The core reading is the OI-vs-price matrix, which is a positioning statement
 * rather than a chart pattern:
 *
 *   price ↑  OI ↑   new longs entering        → crowding builds, fragile
 *   price ↑  OI ↓   short covering            → rally without conviction
 *   price ↓  OI ↑   new shorts entering       → bearish conviction
 *   price ↓  OI ↓   positions being closed    → liquidation/capitulation
 *
 * Capitulation (price down, OI down, funding falling) is the classic bottom:
 * leverage is being forcibly removed. Crowding (price up, OI up, funding high,
 * L/S ratio high) is the classic top: everyone is already in and paying for it.
 *
 * Price indicators appear ONLY as confirmation — a veto on acting against a
 * strong prevailing move — never as the source of the signal.
 *
 * ── Sample-size warning, stated up front ──────────────────────────────
 * OKX serves hourly positioning stats for 30 days only; daily reaches 179. Daily
 * is used so the test spans both a bull and a bear window, but that leaves
 * roughly 60 scored bars per window after warm-up, and few trades. This is
 * EXPLORATORY. A result here justifies collecting hourly data forward for a
 * proper test; it does not justify deploying anything.
 *
 * Usage:
 *   pnpm tsx server/scripts/positioningSignalBacktest.ts
 *   pnpm tsx server/scripts/positioningSignalBacktest.ts --price-confirm=off
 */

import * as okx from "../engine/okxClient";
import * as fs from "fs";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const FEE = parseFloat(arg("fee-bps") ?? "10") / 10000;
const PRICE_CONFIRM = (arg("price-confirm") ?? "on") !== "off";
/** Z-score above which a positioning reading counts as stretched. */
const Z_HOT = parseFloat(arg("z") ?? "1.0");
const BAND = parseFloat(arg("band") ?? "0.2");
const LOOKBACK = 30; // bars for rolling z-scores

const SEED = 10000;
const SPLIT = Date.parse("2026-05-15T00:00:00Z");
const HOURLY = process.argv.includes("--hourly");
/**
 * Hourly mode tests on assets that REVERSED DIRECTION inside the 30-day hourly
 * window, splitting each at its own turning point. That yields two genuine
 * sub-regimes per asset from data that exists today — 720 bars rather than the
 * ~60 daily bars that made the first run inconclusive — without waiting for the
 * market to provide a regime change on BTC's schedule.
 *
 * These reversals are idiosyncratic, which is a feature: a signal that only
 * works when everything moves together has not been tested.
 */
const CCYS = HOURLY
  ? ["UNI", "ZEC", "WLD", "HYPE", "BTC"]           // 4 reversals + BTC as control
  : ["BTC", "ETH", "SOL", "XRP", "DOGE", "LINK"];

interface Bar {
  ts: number;
  close: number;
  oi: number;          // open interest, USD
  lsRatio: number;     // long/short account ratio
  takerBuy: number;
  takerSell: number;
  funding: number;     // daily average of the 8h rates
}

const z = (series: number[], v: number) => {
  if (series.length < 5) return 0;
  const m = series.reduce((a, b) => a + b, 0) / series.length;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - m) ** 2, 0) / series.length);
  return sd > 0 ? (v - m) / sd : 0;
};

async function loadAsset(ccy: string): Promise<Bar[] | null> {
  const period = HOURLY ? "1H" : "1D";
  const q = `ccy=${ccy}&period=${period}`;
  const [oiRows, lsRows, tvRows, candles, funding] = await Promise.all([
    okx.publicGet<string[]>(`/api/v5/rubik/stat/contracts/open-interest-volume?${q}`).catch(() => []),
    okx.publicGet<string[]>(`/api/v5/rubik/stat/contracts/long-short-account-ratio?${q}`).catch(() => []),
    okx.publicGet<string[]>(`/api/v5/rubik/stat/taker-volume?${q}&instType=CONTRACTS`).catch(() => []),
    okx.fetchCandles(HOURLY ? "1h" : "1d", HOURLY ? 750 : 300, `${ccy}-USDT`).catch(() => []),
    fetchFundingDaily(`${ccy}-USDT-SWAP`),
  ]);
  if (!oiRows.length || !lsRows.length || !candles.length) return null;

  const day = (ts: number) => HOURLY
    ? String(Math.floor(ts / 3600_000) * 3600_000)
    : new Date(ts).toISOString().slice(0, 10);
  const oi = new Map(oiRows.map((r) => [day(parseInt(r[0])), parseFloat(r[1])]));
  const ls = new Map(lsRows.map((r) => [day(parseInt(r[0])), parseFloat(r[1])]));
  const tv = new Map(tvRows.map((r) => [day(parseInt(r[0])), [parseFloat(r[1]), parseFloat(r[2])]]));

  const bars: Bar[] = [];
  for (const c of candles) {
    const d = day(c.openTime);
    const o = oi.get(d), l = ls.get(d), t = tv.get(d), f = funding.get(d);
    if (o === undefined || l === undefined) continue;
    bars.push({
      ts: c.openTime, close: c.close, oi: o, lsRatio: l,
      takerSell: t?.[0] ?? 0, takerBuy: t?.[1] ?? 0, funding: f ?? 0,
    });
  }
  return bars.sort((a, b) => a.ts - b.ts);
}

async function fetchFundingDaily(instId: string): Promise<Map<string, number>> {
  const byDay = new Map<string, number[]>();
  let after: number | undefined;
  for (let p = 0; p < 8; p++) {
    const q = new URLSearchParams({ instId, limit: "100" });
    if (after !== undefined) q.set("after", String(after));
    let rows: Array<{ fundingRate: string; fundingTime: string }> = [];
    try { rows = await okx.publicGet(`/api/v5/public/funding-rate-history?${q}`); } catch { break; }
    if (!rows.length) break;
    for (const r of rows) {
      const d = new Date(parseInt(r.fundingTime)).toISOString().slice(0, 10);
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(parseFloat(r.fundingRate));
    }
    after = parseInt(rows[rows.length - 1].fundingTime);
  }
  const out = new Map<string, number>();
  byDay.forEach((v, d) => out.set(d, v.reduce((a: number, b: number) => a + b, 0) / v.length));
  return out;
}

/**
 * Target exposure in [0, 1] from positioning and flow alone.
 *
 * Reads the OI-vs-price matrix, then adjusts for how expensive the crowd's
 * position has become (funding) and how one-sided it is (L/S ratio, taker flow).
 */
function positioningTarget(bars: Bar[], i: number): { target: number; why: string } {
  const hist = bars.slice(Math.max(0, i - LOOKBACK), i);
  const b = bars[i], prev = bars[i - 1];

  const fundZ = z(hist.map((x) => x.funding), b.funding);
  const lsZ = z(hist.map((x) => x.lsRatio), b.lsRatio);
  const oiChg = prev.oi > 0 ? (b.oi - prev.oi) / prev.oi : 0;
  const priceChg = prev.close > 0 ? (b.close - prev.close) / prev.close : 0;
  const flow = b.takerBuy + b.takerSell > 0
    ? (b.takerBuy - b.takerSell) / (b.takerBuy + b.takerSell) : 0;

  // Crowded longs: everyone positioned long, paying above-normal funding to be
  // there, with money still entering. The classic fragile top.
  const crowded = fundZ > Z_HOT && lsZ > 0 && oiChg > 0 && priceChg > 0;

  // Capitulation: price falling while open interest falls too — leverage being
  // forcibly removed rather than new shorts arriving. The classic bottom.
  const capitulation = priceChg < 0 && oiChg < -0.02 && fundZ < 0;

  // New shorts entering with conviction: price down, OI up.
  const bearishConviction = priceChg < 0 && oiChg > 0.02 && fundZ < 0;

  if (crowded) return { target: 0.1, why: "crowded-longs" };
  if (capitulation) return { target: 0.9, why: "capitulation" };
  if (bearishConviction) return { target: 0.2, why: "new-shorts" };

  // Otherwise lean on aggressive flow, damped — this is the weak default.
  return { target: Math.max(0, Math.min(1, 0.5 + flow * 1.5)), why: "flow" };
}

interface Res {
  ccy: string; ret: number; buyHold: number; expo: number;
  blend: number; alpha: number; trades: number; bars: number;
}

function run(bars: Bar[], from: number, to: number): Res | null {
  if (to - from < 25) return null;
  let cash = SEED, units = 0, trades = 0, expSum = 0;
  const eq: number[] = [];

  for (let i = from; i <= to; i++) {
    const px = bars[i].close;
    let { target } = positioningTarget(bars, i);

    // Price as CONFIRMATION ONLY: veto buying into a still-falling 5-day trend,
    // and veto selling out of a still-rising one. It cannot create a signal.
    if (PRICE_CONFIRM && i >= 5) {
      const ma5 = bars.slice(i - 5, i).reduce((a, b) => a + b.close, 0) / 5;
      const cur = (units * px) / (cash + units * px || 1);
      if (target > cur && px < ma5 * 0.97) target = cur; // hold off buying the knife
      if (target < cur && px > ma5 * 1.03) target = cur; // hold off selling strength
    }

    const value = cash + units * px;
    if (value <= 0) break;
    const cur = (units * px) / value;
    if (Math.abs(target - cur) > BAND) {
      const targetUnits = (target * value) / px;
      const delta = targetUnits - units;
      cash -= delta * px + Math.abs(delta) * px * FEE;
      units = targetUnits;
      trades++;
    }
    const v = cash + units * px;
    eq.push(v);
    expSum += v > 0 ? (units * px) / v : 0;
  }

  const final = eq[eq.length - 1];
  const p0 = bars[from].close, p1 = bars[to].close;
  const expo = expSum / eq.length;
  const blend = (SEED * expo * (p1 / p0) + SEED * (1 - expo)) / SEED - 1;
  return {
    ccy: "", ret: final / SEED - 1, buyHold: p1 / p0 - 1, expo, blend,
    alpha: final / SEED - 1 - blend, trades, bars: to - from + 1,
  };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);

async function main() {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`Positioning & Flow Signal — daily bars · price confirmation ${PRICE_CONFIRM ? "ON" : "OFF"} · ${(FEE * 10000).toFixed(0)}bps`);
  console.log("EXPLORATORY: hourly positioning data covers 30 days only, so this uses daily");
  console.log("bars — roughly 60 scored bars per window. Thin. Not a deployment decision.");
  console.log("═".repeat(92));

  const assets: Array<{ ccy: string; bars: Bar[] }> = [];
  for (const ccy of CCYS) {
    const bars = await loadAsset(ccy);
    if (bars && bars.length >= 60) assets.push({ ccy, bars });
    else console.log(`  skipped ${ccy} (${bars?.length ?? 0} usable bars)`);
  }
  console.log(`\n${assets.length} assets: ${assets.map((a) => `${a.ccy}(${a.bars.length}d)`).join(", ")}`);

  if (HOURLY) {
    console.log("\nSplit at each asset's own turning point — the extremum separating its two regimes.\n");
    console.log("ccy".padEnd(7) + "half".padEnd(14) + pad("bars", 6) + pad("return", 10) +
                pad("buy&hold", 11) + pad("expo", 7) + pad("blend", 10) + pad("ALPHA", 10) + pad("trades", 8));
    console.log("─".repeat(92));
    let posBoth = 0, tested = 0;
    for (const { ccy, bars } of assets) {
      const px = bars.map((b) => b.close);
      const mid = Math.floor(px.length / 2);
      const h1 = (px[mid] - px[0]) / px[0];
      // Turning point: the peak if it rose then fell, the trough if the reverse.
      const rising = h1 > 0;
      let turn = LOOKBACK + 10;
      let best = rising ? -Infinity : Infinity;
      for (let i = LOOKBACK + 10; i < px.length - 60; i++) {
        if (rising ? px[i] > best : px[i] < best) { best = px[i]; turn = i; }
      }
      const segs: Array<[string, number, number]> = [
        [rising ? "1 up" : "1 down", LOOKBACK, turn],
        [rising ? "2 down" : "2 up", turn, bars.length - 1],
      ];
      let alphas: number[] = [];
      for (const [name, a, b] of segs) {
        const r = run(bars, a, b);
        if (!r) continue;
        alphas.push(r.alpha);
        console.log(ccy.padEnd(7) + name.padEnd(14) + pad(r.bars, 6) + pad(pct(r.ret), 10) +
          pad(pct(r.buyHold), 11) + pad(`${(r.expo * 100).toFixed(0)}%`, 7) +
          pad(pct(r.blend), 10) + pad(pct(r.alpha), 10) + pad(r.trades, 8));
      }
      if (alphas.length === 2) { tested++; if (alphas.every((a) => a > 0)) posBoth++; }
    }
    console.log("─".repeat(92));
    console.log(`\nPositive alpha in BOTH of its own regimes: ${posBoth}/${tested} assets`);
    console.log("Each asset is its own controlled experiment: same asset, same signal, opposite regimes.\n");
    return;
  }

  const report: Record<string, Res[]> = {};
  for (const [label, lo, hi] of [
    ["HELD-OUT (before 2026-05-15, bull)", 0, SPLIT],
    ["LIVE (after 2026-05-15, bear)", SPLIT, Infinity],
  ] as Array<[string, number, number]>) {
    console.log(`\n${label}`);
    console.log("─".repeat(92));
    console.log("ccy".padEnd(8) + pad("bars", 6) + pad("return", 10) + pad("buy&hold", 11) +
                pad("expo", 8) + pad("blend", 10) + pad("ALPHA", 10) + pad("trades", 8));
    console.log("─".repeat(92));
    const rows: Res[] = [];
    for (const { ccy, bars } of assets) {
      let from = bars.findIndex((b) => b.ts >= lo);
      if (from < LOOKBACK) from = LOOKBACK;
      let to = hi === Infinity ? bars.length - 1 : bars.findIndex((b) => b.ts >= hi) - 1;
      if (to < 0) to = bars.length - 1;
      const r = run(bars, from, to);
      if (!r) continue;
      r.ccy = ccy; rows.push(r);
      console.log(ccy.padEnd(8) + pad(r.bars, 6) + pad(pct(r.ret), 10) + pad(pct(r.buyHold), 11) +
        pad(`${(r.expo * 100).toFixed(0)}%`, 8) + pad(pct(r.blend), 10) +
        pad(pct(r.alpha), 10) + pad(r.trades, 8));
    }
    console.log("─".repeat(92));
    const pos = rows.filter((r) => r.alpha > 0).length;
    console.log(`  positive alpha ${pos}/${rows.length}   mean alpha ${pct(rows.reduce((a, r) => a + r.alpha, 0) / Math.max(1, rows.length))}`);
    report[label] = rows;
  }

  const [ho, lv] = Object.values(report);
  const both = ho.filter((h) => { const l = lv.find((x) => x.ccy === h.ccy); return l && h.alpha > 0 && l.alpha > 0; });
  console.log(`\n${"═".repeat(92)}`);
  console.log(`POSITIVE ALPHA IN BOTH REGIMES: ${both.length}/${ho.length}` + (both.length ? ` — ${both.map((r) => r.ccy).join(", ")}` : ""));
  console.log(`For reference: the price-indicator strategy scores 0/10 on the same test.`);
  console.log("═".repeat(92) + "\n");

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2)); }
}
const JSON_OUT = arg("json") ?? null;

main().catch((e) => { console.error(e); process.exit(1); });
