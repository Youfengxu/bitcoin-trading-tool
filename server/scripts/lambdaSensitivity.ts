/**
 * Sensitivity test for the opportunity-cost weight λ.
 *
 * For each λ candidate:
 *   1. Run walkForwardOptimize on train data with that λ (selects "best params" by riskAdjustedWeekly).
 *   2. Backtest the selected params on held-out test data, scored by raw totalReturn (λ=0).
 *   3. Record the test-set totalReturn, Sharpe, drawdown.
 *
 * The λ that yields the best out-of-sample raw return is the one to ship.
 *
 * Run with:
 *   pnpm tsx server/scripts/lambdaSensitivity.ts
 *
 * Notes:
 *   - Uses a fixed RNG seed so results are reproducible across re-runs.
 *   - Pulls 1h candles via marketData (OKX paginates past the old 720 cap).
 *
 * WARM-UP: backtest() discards its first 200 bars building SMA-200, so a test
 * slice must carry those 200 bars IN FRONT of the period being measured. The
 * first version of this script sliced the test set at the split point, leaving
 * 217 bars of which 200 were warm-up — it scored every λ on 17 bars, produced a
 * flat 0.00% for all of them, and that flat result is what the "λ makes no
 * difference" note in shared/tradingTypes.ts was based on.
 */

import { fetchCandles } from "../engine/marketData";
import { walkForwardOptimize, backtest } from "../engine/walkForwardOptimizer";
import { DEFAULT_STRATEGY_PARAMS } from "../../shared/tradingTypes";

const LAMBDAS = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 3.0];
const TRAIN_RATIO = 0.7;
const RNG_SEED = 0xc0ffee;          // arbitrary, but fixed for reproducibility
const VARIATION_COUNT = 24;          // larger than live optimizer to reduce noise
const CANDLE_COUNT = 1500;
/** backtest() consumes this many leading bars building SMA-200 before it trades. */
const WARMUP_BARS = 200;

type Row = {
  lambda: number;
  trainRAR: number;
  testTotalReturn: number;
  testWeeklyReturn: number;
  testSharpe: number;
  testMaxDD: number;
  testHoldCount: number;
  testHoldRegret: number;
  trainHoldCount: number;
};

async function main() {
  console.log(`Fetching candles…`);
  const raw = await fetchCandles("1h", CANDLE_COUNT);
  const candles = raw.map((c) => ({
    open: c.open, high: c.high, low: c.low,
    close: c.close, volume: c.volume, openTime: c.openTime,
  }));
  console.log(`Got ${candles.length} candles.`);

  const splitIdx = Math.floor(candles.length * TRAIN_RATIO);
  const trainData = candles.slice(0, splitIdx);
  // Carry WARMUP_BARS of history in front of the split so backtest() starts
  // trading exactly at splitIdx and the scored period is genuinely held out.
  const testData = candles.slice(Math.max(0, splitIdx - WARMUP_BARS));
  const scoredBars = testData.length - WARMUP_BARS;
  if (scoredBars < 100) {
    throw new Error(
      `Only ${scoredBars} bars would be scored out-of-sample. Raise CANDLE_COUNT.`
    );
  }
  console.log(
    `Split: ${trainData.length} train (${trainData.length - WARMUP_BARS} scored) / ` +
    `${scoredBars} scored out-of-sample\n`
  );

  const rows: Row[] = [];

  for (const lambda of LAMBDAS) {
    process.stdout.write(`λ=${lambda.toFixed(2)} … `);

    // Optimize on train with this λ
    const opt = walkForwardOptimize(trainData, DEFAULT_STRATEGY_PARAMS, {
      trainRatio: 1.0,            // use all train data for selection (we have a separate test set)
      lambda,
      rngSeed: RNG_SEED,
      variationCount: VARIATION_COUNT,
    });

    // Score the selected params on the held-out test set with λ=0 (raw return is the truth)
    const test = backtest(testData, opt.bestParams, 10000, 0);

    rows.push({
      lambda,
      trainRAR: opt.bestResult.riskAdjustedWeekly,
      testTotalReturn: test.totalReturn,
      testWeeklyReturn: test.weeklyReturn,
      testSharpe: test.sharpeRatio,
      testMaxDD: test.maxDrawdown,
      testHoldCount: test.holdCount,
      testHoldRegret: test.holdRegret,
      trainHoldCount: opt.bestResult.holdCount,
    });

    console.log(
      `test return ${(test.totalReturn * 100).toFixed(2)}% | Sharpe ${test.sharpeRatio.toFixed(2)} | ` +
      `DD ${(test.maxDrawdown * 100).toFixed(2)}% | trades ${test.totalTrades} | holds ${test.holdCount} | ` +
      `minConf ${opt.bestParams.minConfidence.toFixed(3)}`
    );
  }

  console.log("\n## Results\n");
  console.log("| λ    | train RAR (wk) | test return | test weekly | test Sharpe | test maxDD | test holds | hold regret |");
  console.log("|------|----------------|-------------|-------------|-------------|------------|------------|-------------|");
  for (const r of rows) {
    console.log(
      `| ${r.lambda.toFixed(2)} | ${(r.trainRAR * 100).toFixed(3)}% | ${(r.testTotalReturn * 100).toFixed(2)}% | ${(r.testWeeklyReturn * 100).toFixed(2)}% | ${r.testSharpe.toFixed(2)} | ${(r.testMaxDD * 100).toFixed(2)}% | ${r.testHoldCount} | ${r.testHoldRegret.toFixed(3)} |`
    );
  }

  // Pick winner by test totalReturn (primary), Sharpe as tiebreaker
  const ranked = [...rows].sort((a, b) => {
    if (Math.abs(b.testTotalReturn - a.testTotalReturn) > 0.001) {
      return b.testTotalReturn - a.testTotalReturn;
    }
    return b.testSharpe - a.testSharpe;
  });
  console.log(`\n**Winner**: λ = ${ranked[0].lambda} (test return ${(ranked[0].testTotalReturn * 100).toFixed(2)}%, Sharpe ${ranked[0].testSharpe.toFixed(2)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
