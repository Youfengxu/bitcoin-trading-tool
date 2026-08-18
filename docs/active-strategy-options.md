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
