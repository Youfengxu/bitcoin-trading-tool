# Active Crypto Strategy Options

**Status:** research + proposal, nothing built
**Date:** 2026-08-18
**Brief:** the static 40% allocation is too passive. What genuinely more-active
options exist, and which have a mechanism rather than a backtest?

---

## 0. The hurdle any active strategy has to clear

Activity is not free, and this is the number that kills most candidates before
any edge is discussed. At OKX spot taker fees of 10bps:

| trades/month | fraction of book each | annual fee drag |
|---|---|---|
| 2 (the current static rule) | 100% | **2.4%** |
| 10 | 15% | 1.8% |
| 60 | 15% | **11.4%** |
| 142 | 15% | **28.8%** |
| 300 | 15% | 69.6% |

The deployed engine ran ~3,698 trades per asset over three years and its fees
consumed **27–37% of gross P&L**. A strategy trading 142 times a month must earn
~29% a year before it beats doing nothing — not before it beats the market,
before it beats zero.

This is why "more active" is only worth wanting when the activity buys something
structural. Three of the four options below are forecasting bets; one is not.

## 1. What this project has already ruled out

Not repeatable as-is, and any proposal that quietly re-treads it should be
rejected:

- **Direction at a weekly horizon.** Thirteen method families — threshold rules,
  HMM at 2/3/4 states, BOCPD at four hazard rates, GMM, exit-policy tuning — all
  landed between 46.2% and 51.3% accuracy against a 47.2% base rate.
- **Cross-sectional breadth as a fix.** Hourly returns across majors correlate at
  0.449, so effective sample size asymptotes at **~2.2 assets** however many are
  added. This is the single most important constraint on anything below.
- **Parameter optimisation.** Train-best and test-best exit parameters were
  *anti*-correlated (Spearman ρ = −0.339).

What survived: **volatility is forecastable** (GMM clusters separate forward
volatility at 1.04sd against 0.33sd for forward return), and vol targeting cut
mean drawdown 42.3% → 31.4% across 7 of 7 assets.

---

## 2. Option A — Funding-rate carry, delta-neutral

Hold spot, short the perpetual in equal size, collect funding. Price risk nets
out; the return is the funding payment.

**Why it is the strongest candidate in principle:** the edge is *mechanical*, not
predictive. Perp longs pay shorts to maintain leverage. It requires no view on
direction — the one thing this project has established it cannot have.

**What the funding actually pays, measured on OKX rather than quoted:**

| perp | full-sample carry | positive periods | worst month |
|---|---|---|---|
| BTC-USDT-SWAP | **4.0% APR** | 82% | +1.2% |
| ETH-USDT-SWAP | 2.6% APR | 72% | −0.2% |
| SOL-USDT-SWAP | 1.0% APR | 61% | −2.1% |
| DOGE-USDT-SWAP | **5.3% APR** | 82% | +2.8% |

*(287 eight-hour periods each, 2026-05-14 → 2026-08-18 — all OKX serves.)*

**This is the finding that matters.** Retail guides quote 10–30% APY and one
cited 70% APR for January 2026. Actual OKX funding today is **1–5% APR gross**.
The gap is explained by leverage: run 3–5x and 4% becomes 12–20%, which is where
those headline numbers come from — and with it comes liquidation risk on the
short leg, which is the entire risk of the trade.

Round-trip cost is roughly 30bps (spot in/out plus perp in/out), so at 4% gross a
position must be held about **a month just to break even on execution**, before
any rehedging.

**The honest comparison:** unlevered BTC carry of ~4% gross, call it ~2.8% net,
against simply lending the USDT. If OKX pays anything comparable on USDT, this
strategy is taking basis risk, liquidation risk and execution risk across two
venues **to earn less than doing nothing**. That comparison should be made before
any code is written.

*Prior: the mechanism is real; at current funding the unlevered version is not
worth the operational risk. Worth building only if funding regimes are wide
enough that a conditional version — on only when carry exceeds a threshold —
clears costs.*

## 3. Option B — Time-series trend following, volatility-scaled

Long when trend is up, flat or short when down, sized inversely to predicted
volatility.

**Why this is genuinely untested here, despite appearances:** the deployed engine
is **mean-reverting** — RSI oversold, Bollinger deviation, z-score blips. Trend
following is the *opposite sign*. The momentum rules tested previously were used
as *regime classifiers* to switch between hold and engine, never as a standalone
strategy with volatility scaling. That is a real gap, not a re-run.

It also composes with the one thing measured to work: volatility scaling is what
the literature prescribes for momentum's documented crash risk, and this project
independently measured that volatility is forecastable.

**Evidence:** a 2026 framework reports Sharpe 2.41, 40.5% annualised, −12.7% max
drawdown over 2022–2024 across 150+ pairs, at 4bps costs and ~142 trades/month.

**Treat that Sharpe with suspicion.** Everything in this project that looked good
in backtest died on a genuinely held-out test, and 2.41 over a 36-month window on
a hand-chosen universe is precisely the shape of result that does. Note also that
142 trades/month is the **28.8% annual fee drag** row above at OKX's 10bps — the
paper assumes 4bps on Binance Futures.

*Prior: the sign is untested and the mechanism (momentum risk premium) is
documented across asset classes. This is the most interesting of the forecasting
options — but it must be tested long-only first, since the short leg needs perps
and doubles the operational surface.*

## 4. Option C — Cross-sectional momentum, long-short

Rank the universe on trailing return, long the top decile, short the bottom.

**Why it is ranked below B despite better academic support:** it is precisely the
strategy the 0.449 correlation finding damages most. Cross-sectional momentum
monetises *dispersion between* assets; when everything moves together, the spread
compresses. That is not a hypothesis — the published evidence says exactly this,
that gains reverse during broad corrections and the strategy behaves like mean
reversion in downturns.

*Prior: real but structurally hampered here, needs shorting, and lands hardest on
the constraint this project has already measured. Not first.*

## 5. Option D — Volatility-scaled active exposure

Keep the static allocation's discipline but let the weight move continuously with
predicted volatility rather than sitting in a band.

**Why it deserves a place:** it is the only option built on something this
project *measured itself* rather than imported. Trailing-vol scaling already cut
mean drawdown 42.3% → 31.4% in 7 of 7 assets.

**Its ceiling is honest and low.** It is risk control, not return generation, and
a 20-line trailing average beat a fitted GMM at forecasting volatility
(r = 0.619 vs 0.488). It would be *more active* than the current rule while
remaining non-predictive.

*Prior: highest probability of working, lowest ceiling. The right answer if
"too passive" means "I want the book to respond to conditions", and the wrong one
if it means "I want higher returns".*

---

## 6. Recommendation

**Test in this order, cheapest decisive test first:**

1. **Option A's economics, before any code.** Compare net carry against the USDT
   lending rate on the same account. One spreadsheet. If lending wins, A is dead
   without a backtest — and that is a five-minute answer to a strategy that would
   otherwise take a week.

2. **Option B, long-only, on the existing harness.** Same walk-forward protocol
   that killed the exit-policy work: pre-registered criteria, held-out folds,
   effective-sample-size discounting, and the static 40% book as the control to
   beat. Long-only first because it needs no perps.

3. **Option D** if B fails, as the honest fallback that is still more active than
   today.

4. **Option C** only if B succeeds, since they share machinery.

**What I would not do:** deploy any of these on the reasoning that the current
strategy is boring. The static allocation's case was never that it is exciting —
it was that thirteen more interesting things were measured and none of them
worked. The bar for replacing it is evidence, and the fee table in §0 is how much
evidence is required.

---

## 7. Honest prior

Realistic assessment: **~20% that Option B clears a properly controlled bar
long-only after 10bps costs.** Higher than the regime work's 20–30% would suggest
in spirit, because the sign is genuinely untested and momentum has cross-asset
support — but the fee hurdle at OKX's retail rates is brutal, and every previous
candidate in this project died at exactly the point where costs and held-out
testing were applied together.

**What would make me stop:** a trend strategy that cannot beat the static 40%
book after costs on held-out folds. At that point the conclusion is not that the
implementation was wrong but that retail-fee crypto does not support active
trading at this capital size, which is itself a decision-grade answer.

**This document is engineering research, not investment advice.** Position sizing
and capital allocation remain the owner's decisions.

---

## 8. Results — all four built, unlevered, real fees

**Fees verified against the account: OKX Lv1, maker 0.0800%, taker 0.1000%.**
Taker is charged throughout. This also corrects an earlier claim in this project
that passive limit orders were a meaningful fee lever — maker saves 2bps of 10,
a 20% reduction, not a step change.

### Held-out year (2025-08 → 2026-08, BTC −46.5%)

| strategy | return | maxDD | trades | exposure | fees |
|---|---|---|---|---|---|
| **CONTROL static 40%** | **−20.0%** | **24.3%** | 2 | 37% | **$5** |
| B trend 30d, vol-scaled | −19.0% | 29.0% | 44 | 37% | $320 |
| B* trend, exposure-matched | −19.3% | 29.6% | 43 | 38% | $325 |
| D* vol-scaled, exposure-matched | −21.7% | 26.2% | 13 | 38% | $16 |
| C cross-sectional top-3 | **−69.9%** | **76.0%** | 45 | 67% | $92 |
| REF buy & hold | −46.5% | 53.8% | 1 | 100% | $10 |

**Nothing beat the control.** B's 1.0pp return edge came with 5.3pp *more*
drawdown and 64× the fees. D* was worse on both. C was a disaster.

### Full sample (3 years) — and why it is the trap

| strategy | return | maxDD | fees |
|---|---|---|---|
| C cross-sectional | **+176.1%** | 52.1% | $1,024 |
| REF buy & hold | +136.6% | 53.7% | $10 |
| B2 trend on/off | +103.0% | 38.6% | $2,210 |
| B trend vol-scaled | +85.5% | 33.3% | $1,878 |
| CONTROL static 40% | +53.8% | 25.7% | $10 |

C is the **best strategy in-sample and the worst out-of-sample** — +176% then
−69.9%, against holding's −46.5%. That is precisely the crash the literature
documents: cross-sectional spreads compress in broad corrections and the strategy
behaves like mean reversion. It is also the exact shape of every false positive
this project has produced.

### Option A — funding carry, unlevered

| perp | gross carry | fees | **net on capital** |
|---|---|---|---|
| BTC | +1.62% APR | $12 | **+0.93% APR** |
| ETH | +1.12% | $12 | +0.43% |
| SOL | +0.47% | $12 | **−0.23%** |
| DOGE | +1.87% | $11 | +1.26% |

**Unlevered carry is dead at current funding.** Two compounding reductions: the
quoted 4.0% APR on BTC halves to ~2% because capital funds *two* legs, then fees
take it to 0.93%. SOL is negative. This is worse than any deposit account, for
basis risk, execution risk across two venues and continuous monitoring.

The 10–30% APY figures in circulation are levered 3–5x. That is available, but it
converts a mechanical edge into a liquidation-risk bet, which is a different
strategy from the one requested.

### A flaw in my own method, stated

The exposure-matching multiplier for B* and D* was computed over the **full
window including the held-out period** — a look-ahead leak. It should have been
derived from training data only.

It does not change the conclusion, and the direction matters: the leak gives the
active strategies a *free calibration on the test set*, and they lost anyway. The
negative result therefore holds a fortiori. Had any of them won, the number would
have been unusable.

## 9. Conclusion

At retail fees, unlevered, on a held-out year, **none of the four beat a static
40% allocation** — the strategy that trades twice a year and pays $5.

Caveats that cut both ways: the held-out window is a single 12-month bear market,
which is one regime and not a cycle; funding history is one quarter; and the
universe is ten majors correlating at 0.449, so effective breadth is ~2.2 assets.
A bull-market held-out window would likely favour the trend options, and that
test is worth running when the data exists.

What is not ambiguous is the cost structure. B paid **3.2% of the book in one
year** to finish level with a strategy that paid 0.05%. For an active strategy to
be worth running here it must clear roughly 3–5% a year of pure friction before
it adds anything, and none of these did.

---

## 10. The bear-market objection, tested — and my prediction was wrong

§9 conceded that the held-out year was one bear market and predicted "a
bull-market held-out window would likely favour the trend options". That
prediction was **wrong**, and testing it properly is what this section does.

First, the held-out year was worse than "a bear market" — it was **uniform**:

| asset | held-out year | asset | held-out year |
|---|---|---|---|
| TRX | −6.4% | LTC | −63.5% |
| BNB | −27.1% | XRP | −67.6% |
| BTC | −46.4% | DOGE | −70.4% |
| LINK | −57.2% | AVAX | −73.7% |
| ETH | −57.9% | DOT | −80.7% |
| SOL | −59.8% | ADA | −81.8% |

**0 of 12 positive.** No asset rose, so cross-sectional strategies had no
favourable dispersion to find and trend strategies were never tested on an
uptrend. That single window genuinely could not separate "the strategy fails"
from "the regime was hostile".

### Testing every year instead

Because **no parameter is fitted** — every constant comes from the literature or
from a measurement on different data — there is no train/test boundary to
violate, and each year is a clean test. Years 1 and 2 were strong bulls.

At matched ~40% exposure:

| window | BTC | CONTROL | B* trend | D* vol-scaled |
|---|---|---|---|---|
| Year 1 | +115.6% | +41.6% | **+42.7%** | +36.7% |
| Year 2 | +104.9% | **+37.5%** | +29.3% | +38.4% |
| Year 3 | −46.4% | −20.0% | **−19.3%** | −21.7% |
| **chained** | | **+55.8%** | +48.9% | +48.2% |

**The conclusion strengthens rather than reverses.** B* wins Year 1 by 1.1pp,
loses Year 2 by 8.2pp, wins Year 3 by 0.7pp — and finishes 6.9pp behind a
strategy that trades twice a year. The bear market was not what beat it.

### Cross-sectional, judged against the right benchmark

C runs 67–69% exposure, so the control is the wrong comparison; buy-and-hold is:

| window | C | buy & hold | difference |
|---|---|---|---|
| Year 1 | +117.0% | +115.5% | +1.5pp |
| Year 2 | +105.4% | +104.8% | +0.6pp |
| Year 3 | −69.9% | −46.5% | **−23.4pp** |

C tracks buy-and-hold almost exactly in bull markets — earning ~1pp for 39–43
trades a year — and then loses 23pp in the drawdown. That is not a strategy with
crash risk attached; **it is a leveraged-feeling proxy for holding, with a crash
attached.**

### What this changes

The §9 caveat is now resolved and can be dropped: the negative result is **not**
a bear-market artefact. Two strong bull years were available and neither trend
nor volatility scaling beat a static 40% allocation across them at matched risk.

The one caveat that survives is narrower: three consecutive years of a single
asset class, ten names correlating at 0.449. That is roughly **2.2 effective
independent observations** of a market cycle — enough to reject these specific
strategies at these fees, not enough to make a general claim about trend
following.
