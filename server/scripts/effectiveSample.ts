/**
 * Derives the cross-sectional correlation and effective sample size.
 *
 * This exists because the figure it computes was, until 2026-08-18, a HARDCODED
 * CONSTANT (0.449) appearing in eleven places across six files, attributed
 * variously to 20 assets, "majors", ten majors and twelve — and derived nowhere.
 * Independent replication put the true 12-asset value at 0.663, making the
 * project's central constraint ~35% tighter than every document claimed.
 *
 * A number that governs an entire analysis must be reproducible from data. Cite
 * this script rather than restating a literal.
 */
import { loadHourly } from "./lib/historyCache";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const END = Date.parse(arg("end") ?? "2026-08-16T00:00:00Z");
const YEARS = parseFloat(arg("years") ?? "3");
const START = END - YEARS * 365 * 24 * 3600 * 1000;
const PAIRS = (arg("pairs") ??
  "BTC-USDT,ETH-USDT,SOL-USDT,BNB-USDT,XRP-USDT,DOGE-USDT,ADA-USDT,LINK-USDT,AVAX-USDT,LTC-USDT,DOT-USDT,TRX-USDT").split(",");

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; num += u * v; da += u * u; db += v * v; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

async function main() {
  const series: Array<[string, number[]]> = [];
  for (const id of PAIRS) {
    const { candles } = await loadHourly(id, START, END, false);
    if (candles.length < 5000) continue;
    const lr: number[] = [];
    for (let i = 1; i < candles.length; i++) lr.push(Math.log(candles[i].close / candles[i - 1].close));
    series.push([id.replace("-USDT", ""), lr]);
  }
  const n = Math.min(...series.map(([, s]) => s.length));
  const trimmed = series.map(([id, s]) => [id, s.slice(-n)] as [string, number[]]);

  const pairs: number[] = [];
  for (let i = 0; i < trimmed.length; i++)
    for (let j = i + 1; j < trimmed.length; j++) pairs.push(pearson(trimmed[i][1], trimmed[j][1]));

  const N = trimmed.length;
  const rho = pairs.reduce((a, b) => a + b, 0) / pairs.length;
  const sorted = [...pairs].sort((a, b) => a - b);
  const nEff = N / (1 + (N - 1) * rho);

  console.log(`\n${"═".repeat(64)}`);
  console.log(`Effective sample size · ${N} assets · ${n.toLocaleString()} aligned hourly bars`);
  console.log(`${new Date(START).toISOString().slice(0, 10)} → ${new Date(END).toISOString().slice(0, 10)}`);
  console.log("═".repeat(64));
  console.log(`  mean pairwise correlation   ${rho.toFixed(4)}`);
  console.log(`  min / median / max          ${sorted[0].toFixed(3)} / ${sorted[Math.floor(sorted.length / 2)].toFixed(3)} / ${sorted[sorted.length - 1].toFixed(3)}`);
  console.log(`  n_eff = N/(1+(N-1)rho)      ${nEff.toFixed(2)}`);
  console.log(`  asymptote 1/rho             ${(1 / rho).toFixed(2)}`);
  console.log(`\n  Adding assets cannot raise n_eff above ${(1 / rho).toFixed(2)}.`);
  console.log("═".repeat(64) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
