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
  0.663, so effective sample size asymptotes at **~1.5 assets** however many are
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
strategy the 0.663 correlation finding damages most. Cross-sectional momentum
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
universe is ten majors; the twelve-asset figure is 0.663, so effective breadth is ~1.5 assets.
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
asset class, ten names; measured correlation 0.663. That is roughly **1.5 effective
independent observations** of a market cycle — enough to reject these specific
strategies at these fees, not enough to make a general claim about trend
following.

---

## 11. What CAN inform the weight — and what cannot

The frontier in §10 said the weight is a pure risk choice with no analytical
answer. That was too strong. Testing weight RULES on risk-adjusted terms
(Sharpe, which is scale-invariant, so different exposures are comparable):

### BTC, 3 years, target vol calibrated on Year 1 only

| rule | ann. return | Sharpe | maxDD | exposure | trades | fees |
|---|---|---|---|---|---|---|
| constant 40% | +15.9% | 0.87 | 25.7% | 41% | 5 | $10 |
| constant 60% | +23.2% | 0.89 | 35.8% | 60% | 5 | $14 |
| constant 100% | +34.3% | 0.87 | 53.7% | 100% | 1 | $10 |
| **inverse-vol (Moreira–Muir)** | +24.4% | **0.75** | 52.0% | 90% | 105 | $377 |
| trend-gated 67/0 | +21.0% | 0.94 | 27.1% | 40% | 108 | $1,239 |
| **drawdown-scaled** | +17.4% | **0.99** | **21.0%** | 38% | **5** | **$10** |

Constant weight gives Sharpe ~0.87–0.89 at *every* level, exactly as theory
predicts — scaling a constant weight is leverage on the same return stream and
cannot change Sharpe. That is the flat frontier restated.

**The volatility-managed claim did not replicate.** Inverse-vol scaling scored
0.75–0.80 against constant weight's 0.87 — worse, not better. This project had
already measured volatility to be forecastable; forecastable is evidently not
sufficient for it to improve risk-adjusted returns here.

### Across 12 assets — which separates luck from signal

| rule | mean Sharpe | improves in | mean fees |
|---|---|---|---|
| constant 40% | 0.55 | — | $18 |
| **drawdown-scaled** | **0.68** | **11 / 12** | **$12** |
| trend-gated 67/0 | 0.49 | 6 / 12 | $1,055 |

**Trend-gating was a BTC artefact.** It looked positive on BTC alone (+0.06) and
is a coin flip across the universe (6/12, mean −0.06). Breadth caught what a
single asset could not — the same lesson as every other false positive here.

**Drawdown-scaling improved Sharpe in 11 of 12, and cost LESS than the control**
($12 vs $18) because de-risking reduces rebalancing. Only ETH was negative.

### The mechanism, and why it survives when trend does not

`w = 0.40 x max(0.3, price / running_peak)` is a *slow* trend signal: weight
falls as price falls below its high. Fast trend-gating carries the same
information and gets 6/12, because at 108 trades a year it pays ~3.5%/yr in fees
— roughly 0.18 of Sharpe on a 20%-vol book, which is the whole edge.

**The signal was never the problem; the turnover was.** Expressed through
drawdown state it costs 5 trades instead of 108, and survives.

### Why this is not yet a recommendation

Every caution this project has learned applies:

- **Effective sample size.** Twelve assets at rho = 0.663 is **1.45 independent
  observations**. "11 of 12" is closer to *2 of 2* agreeing.
- **One path.** Drawdown-scaling de-risks after falls, which flatters a sample
  containing a sustained Year-3 decline and would *hurt* on a sharp V-shaped
  recovery. One cycle cannot distinguish the two.
- **I chose the parameters.** The 0.40 base and 0.30 floor are mine, not the
  literature's. Untested for whether they sit on a plateau or a spike — and the
  exit-policy work failed at exactly that question (rho = −0.339).
- **No held-out test.** No parameter was fitted per asset, but the rule form was
  chosen after seeing BTC.

**Required before acting:** the same protocol that killed the exit policy —
parameter sweep for a plateau, walk-forward across folds, and pre-registered
criteria. On this project's record the prior should be that it does not survive.

### The honest revision

§10's "there is no analytical answer" was too strong. The correct statement is
narrower: **nothing forecasts the return that would justify a weight, but a rule
that lowers weight during drawdowns improved risk-adjusted outcomes in 11 of 12
assets at no extra cost.** That is a defensive rule, not a forecast — it reacts
to what has already happened rather than predicting what comes next, which is
precisely why it is plausible after thirteen failed forecasting attempts.

---

## 12. Validation of drawdown-scaling — it fails

Section 11 found the rule improved Sharpe in 11 of 12 assets on the full sample
and flagged that this had the profile of both a real finding and a false
positive. Run against pre-registered criteria, it is the latter.

| criterion | result |
|---|---|
| 1. plateau, not spike | **PASS** — 12/40 top-quartile, surface genuinely flat |
| 2. train rank predicts test rank | **PASS** — Spearman rho = **+0.470** |
| 3. fixed parameter beats control out of sample | **FAIL** — 22% of 72 folds |
| 4. breadth >= 8/12 assets | **FAIL** — **3/12** |

### The reversal

Full sample: improves Sharpe in **11 of 12**. Held-out folds: improves in **3 of
12**, and 22% of folds — *worse than a coin flip*.

| asset | held-out, floor 0.3 | constant weight | diff |
|---|---|---|---|
| DOGE | −0.089 | +0.124 | **−0.213** |
| ETH | −0.206 | −0.055 | −0.151 |
| SOL | −0.308 | −0.161 | −0.146 |
| AVAX | −0.478 | −0.341 | −0.137 |
| BTC | +0.170 | +0.176 | −0.005 |
| DOT | −0.632 | −0.708 | +0.076 |
| TRX | +1.592 | +1.518 | +0.074 |
| LTC | −0.043 | −0.106 | +0.064 |

### Why — and it is not simply noise

The full sample **ends inside the Year-3 drawdown**. A rule whose entire
behaviour is "reduce exposure as price falls below its running peak" is
mechanically flattered by any sample terminating in a decline: it is short
exactly where the sample stops. Rolling held-out folds mostly do *not* end in a
drawdown, and there the rule simply carries less exposure for no compensation.

This is the path-dependency named in §11 — "it would hurt on a V-shaped
recovery" — confirmed rather than avoided.

### The most interesting part: criterion 2 passed

Spearman rho = **+0.470**, against the exit-policy work's −0.339. The parameter
space is genuinely well-behaved: a floor that beat another floor on training data
usually beat it on test data too.

**And it did not help at all.** Stable *within-grid* ranking is worthless when
the whole grid loses to the control — selecting the best-on-train parameter won
16 of 72 folds, exactly the same 22% as the fixed one. A well-behaved parameter
space is not evidence of edge; it only means that if an edge existed, you could
find it.

That distinction is worth keeping. Criterion 2 was designed to catch a lottery,
and it correctly reports this is not one — the strategy is simply, consistently,
slightly worse.

### Standing

This is the **fourteenth** method family to fail here. The pattern is unchanged:
promising in-sample, gone on held-out data. The full-sample "11 of 12" in §11 was
a false positive produced by this project's own analysis and caught by this
project's own protocol, which is the protocol working.

**§11's revision is itself revised.** The correct statement returns to §10's:
nothing tested informs the weight. It is a risk-tolerance choice.
