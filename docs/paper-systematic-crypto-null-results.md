# Fifteen Null Results in Systematic Cryptocurrency Trading

### A pre-registered negative-results study, with an extension to LLM-derived equity signals

**Author:** Youfeng Xu · research conducted with Claude Opus 5
**Date:** 2026-08-18
**Status:** working paper, self-published

---

## Abstract

We test fifteen families of systematic trading strategies on liquid
cryptocurrency markets and one family of large-language-model text signals on US
equities. **All fifteen fail** under pre-registered criteria with held-out
evaluation and realistic costs.

Directional forecasting at daily-to-weekly horizons produces accuracies of
46.2%–51.3% against a 47.2% base rate across threshold rules, hidden Markov
models, Bayesian online changepoint detection, and Gaussian mixture clustering. A
deployed signal engine is shown to be economically indistinguishable from a
static 40% allocation that trades twice a year, while executing 3,698 trades per
asset and consuming 27–37% of gross profit in fees. Four active strategies —
funding carry, time-series trend, cross-sectional momentum and volatility scaling
— fail unlevered at the venue's real fee schedule. A weight-scaling rule that
improves Sharpe in 11 of 12 assets in-sample improves it in 3 of 12 out-of-sample.
An LLM scoring 796 post-cutoff earnings releases achieves rank correlation
+0.019 with subsequent market-adjusted drift, and incremental R² of 0.0023 over a
finance word-count.

We argue the more transferable contribution is **methodological**. Six distinct
measurement defects were found *during* the work, each of which independently
produced a false positive that survived casual inspection: an optimiser reporting
93% against a true −1.6%; a validation bar ("improves in both regime windows")
that was not out-of-sample at all; parameter selection where train and test rank
were *anti*-correlated (ρ = −0.339); three separate non-determinism bugs, one of
which flipped the sign of a decisive statistic between consecutive runs of
identical code; and effective sample sizes of ~2.2 where 12 were assumed. We
document each, because in every case the defect was more consequential than the
model it evaluated.

---

## 1. Introduction

The systematic trading literature is heavily selection-biased. Negative results
are rarely published, so a practitioner surveying it sees a field of successes
and cannot calibrate how many attempts produced them. This paper reports the
opposite: a complete, chronological account of one capital-constrained retail
research programme in which every hypothesis tested was rejected.

Three properties make the account informative despite its negative conclusion:

1. **Criteria were pre-registered** before each test, with thresholds and a
   stated prior, so post-hoc bar-lowering is visible in version control.
2. **Costs are the venue's actual schedule**, verified against the account
   (OKX Lv1: maker 0.0800%, taker 0.1000%), not an assumed value.
3. **Every false positive is reported alongside the defect that produced it.**
   Several of the strategies below *did* look successful before a specific
   measurement error was corrected.

### 1.1 Scope

Claims here are bounded to: publicly available price and funding data, daily-to-
weekly horizons, the twelve most liquid crypto majors, unlevered positions,
retail fee tiers, and capital of order $10⁴. We make no claim about
high-frequency trading, market making, cross-venue arbitrage, on-chain strategies,
institutional fee tiers, or leveraged structures. §8 argues these exclusions are
not incidental — they are where the surviving edge plausibly lives.

---

## 2. Data

| source | contents | period | notes |
|---|---|---|---|
| OKX `/market/history-candles` | hourly OHLCV, 12 majors | 2023-08 → 2026-08 | 26,280 bars each, verified contiguous |
| OKX `/public/funding-rate-history` | 8-hour perpetual funding | 2026-05 → 2026-08 | 287 periods; **~96 days is all the venue serves** |
| SEC EDGAR | 8-K Item 2.02 filings + EX-99.1 | 2024-07 → 2026-08 | point-in-time by construction |
| Yahoo Finance | daily adjusted equity bars | 2024-01 → 2026-08 | split/dividend adjusted |

**Universe.** BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK, AVAX, LTC, DOT, TRX for
crypto; 98 US equities with usable earnings events for the LLM extension.

**A data-completeness problem worth naming.** Both EDGAR and OKX paginate history,
and both silently truncate if pagination is not followed. EDGAR's `filings.recent`
caps at ~1,000 entries, which for an active filer is under two years; OKX's
history endpoint returns an empty page under rate limiting that is
indistinguishable from end-of-data. Each caused a real truncation during this
work — one dropped BTC entirely from a study without any error. All fetches were
subsequently paced, retried, contiguity-verified and cached to disk.

---

## 3. Method

### 3.1 Evaluation protocol

Every test after the first failure used:

- **Pre-registered criteria** with numeric thresholds, a stated prior, and an
  abandonment condition, hashed so that changing a threshold changes the hash.
- **Held-out evaluation.** Walk-forward folds where parameters are selected, or
  fixed literature-sourced parameters where they are not.
- **A dumb baseline in every comparison** — a static allocation, a trailing
  average, a word-count lexicon, or buy-and-hold at matched exposure.
- **Effective sample size** discounting, `n_eff = n / (1 + (n−1)ρ)`.
- **Deterministic reruns**: pinned window boundaries, cached inputs, temperature 0.

### 3.2 Effective sample size

This constraint governs the entire crypto section. Hourly returns across the
majors correlate at **ρ = 0.449**, giving

> n_eff = 12 / (1 + 11 × 0.449) = **2.02**,

and asymptoting at 1/ρ ≈ 2.23 *however many assets are added*. Twelve assets
agreeing is closer to two agreeing. Any cross-sectional claim in this market is
therefore near-unfalsifiable with three years of data, and we treat consistency of
*direction* as evidence of robustness while declining to attach significance to
means.

---

## 4. Results: directional forecasting

### 4.1 Threshold rules (families 1–8)

Eight rules — moving-average crossovers, momentum at 168h and 336h,
trend/ATR, ADX+DI, and majority votes — scored against a 47.2% base rate:

| classifier | accuracy | vs base | mean return |
|---|---|---|---|
| adx+di+sma200 | 51.3% | +4.1pp | +2.16% |
| sma50 > sma200 | 50.7% | +3.5pp | +2.73% |
| ema12 > ema26 | 48.0% | +0.8pp | +3.18% |
| mom 336h | 47.5% | +0.4pp | −1.29% |

The decisive observation is not the small edge but that **accuracy and return are
uncorrelated** (r = 0.45 across eight rules). The most accurate classifier returns
a middling +2.16% while the best-returning sits 0.8pp above chance. If these had
skill, being right more often would pay more.

### 4.2 State models and changepoint detection (families 9–12)

A Gaussian mixture model, hidden Markov models at 2/3/4 states, and Bayesian
online changepoint detection at four hazard rates. **Inference used forward
filtering only** — never smoothed posteriors, which use the whole sequence and are
the standard way an HMM backtest flatters its author.

HMM accuracy: 46.2%/49.9%/48.4% at k = 2/3/4. BOCPD: 0 of 4 criteria at every
hazard rate. Self-transition probabilities of 0.83–0.97 confirm the machinery
produced persistent, coherent states; the states simply did not predict direction.

### 4.3 Why the literature and these data disagree

Published HMM results in crypto are not wrong; they answer a different question.
We measured what the fitted clusters actually separate, out-of-sample:

| separates | in units of that variable's own s.d. |
|---|---|
| forward 168h **volatility** | **1.04** |
| forward 168h **return** | 0.33 |

**Regimes are real and volatility-defined, not directional.** "Bull/bear/calm"
labels in the literature are largely volatility states, and calm-versus-turbulent
is genuinely forecastable — this is why GARCH works. Every method in §4.2 applied
a working volatility detector to an unforecastable directional question.

Three secondary gaps: published regime charts frequently use *smoothed*
posteriors, unusable live; the effective sample here is ~2 regime episodes rather
than 31,206 bars; and "best one-step-ahead forecast among competing models" is a
far weaker claim than "profitable after 10bps through a binary switch".

### 4.4 A negative result on volatility-managed portfolios

Given §4.3, volatility scaling should help. Inverse-volatility weighting
(Moreira–Muir) scored **Sharpe 0.75** against constant weight's **0.87** across
12 assets. Separately, a fitted GMM was a *worse* volatility forecaster than a
20-line trailing average (r = 0.488 vs 0.619) and worse economically.

**Forecastable is not sufficient.** Volatility can be predicted and the prediction
still fails to improve risk-adjusted returns.

---

## 5. Results: the deployed engine versus a static allocation

The production system combined RSI, MACD, Bollinger, z-score and EMA signals with
walk-forward parameter optimisation. Evaluated across 165 overlapping 90-day
episodes, 5 assets, 3 years:

| regime bucket | n | hold | engine | static 40% |
|---|---|---|---|---|
| bear < −20% | 41 | −33.8% | −17.3% | −13.6% |
| mild bull 0–25% | 38 | +10.5% | +3.8% | +4.9% |
| strong 50–100% | 23 | +70.4% | +26.7% | +27.1% |
| parabolic > 100% | 8 | +209.2% | +89.5% | +65.7% |

**The engine captures ~35–40% of whatever the market does, in both directions**,
which its 38–43% average exposure fully explains. It beat buy-and-hold in 8 of 89
bull episodes (9%), and the shortfall scales linearly with bull strength (slope
−0.57: every +10pp of rally costs ~5.7pp of relative underperformance).

Against a static 40% allocation over 165 episodes: **mean return +5.7% vs +5.6%,
mean drawdown 15.7% vs 13.8%, mean trades 249 vs 2.** The engine wins 42% of
episodes — worse than a coin flip.

We interpret this as the central practical finding of the crypto work: **an engine
that cannot time is delivering beta, and a static weight delivers beta more
cheaply.**

---

## 6. Results: active strategies, unlevered, at real fees

Four strategies at verified OKX Lv1 rates, exposure-matched where comparable,
evaluated per-year across three years (two bull, one bear):

| window | BTC | static 40% | trend (vol-scaled) | vol-scaled |
|---|---|---|---|---|
| Year 1 | +115.6% | +41.6% | +42.7% | +36.7% |
| Year 2 | +104.9% | +37.5% | +29.3% | +38.4% |
| Year 3 | −46.4% | −20.0% | −19.3% | −21.7% |
| **chained** | | **+55.8%** | +48.9% | +48.2% |

Cross-sectional momentum, judged against buy-and-hold (its actual exposure peer),
returned +1.5pp, +0.6pp, then **−23.4pp** — tracking hold in bull markets while
paying 39–43 trades a year, then losing 23 points in the drawdown.

**Funding carry, unlevered.** Measured OKX funding is 1–5% APR gross, not the
10–30% widely quoted; that gap is leverage of 3–5×. Unlevered, capital funds two
legs, halving the yield, and fees take the remainder:

| perp | gross | **net on capital** |
|---|---|---|
| BTC | +1.62% APR | **+0.93%** |
| SOL | +0.47% | **−0.23%** |

### 6.1 Cost is not the binding constraint

A natural objection is that retail fees, not the signals, killed these. We tested
it directly by sweeping the fee schedule:

| fee | static 40% | trend-gated |
|---|---|---|
| 10bps | 0.551 | 0.491 |
| **0bps** | 0.552 | **0.550** |

**At zero fees the trend signal exactly ties the control.** A market maker paying
nothing would extract nothing from it. The constraint is the absence of edge, not
the cost of trading — which materially narrows where remaining edge could lie.

---

## 7. Results: LLM text signals in equities (family 15)

If price-derived features are exhausted, the natural extension is a different
information source. Equities offer mandatory disclosure — text that is not
derivable from price — and thousands of names rather than 2.2 effective assets.

### 7.1 The lookahead problem, and the control for it

An LLM asked to forecast an event inside its training data may simply recall the
outcome. Following Gao, Jiang & Yan, we measure **Lookahead Propensity** by
date-only recall probe. Measured directly:

| model | recall through | collapse | recorded cutoff |
|---|---|---|---|
| muse-glimmer-30b | 2024-04 | 2024-06 | 2024-05-31 |
| gpt-oss-120b | 2024-05 | 2024-07 | 2024-06-30 |

Cutoffs are recorded at the END of the last month showing any recall: erring late
costs samples, erring early admits contaminated ones. **All study events are
strictly after the cutoff, enforced by a runtime assertion rather than a
convention.**

### 7.2 Comprehension is real

Before testing prediction we tested reading, on 14 disclosures with known
polarity, split into obvious and subtle cases:

| | LLM | lexicon |
|---|---|---|
| sign correct | 93% | 50% |
| rank corr. vs human (all) | 0.931 | 0.147 |
| **rank corr. (subtle only)** | **0.870** | **−0.476** |

On subtle text a finance word-count is *negatively* correlated with human reading
— worse than random. It scores *"strong momentum and record engagement… the board
has suspended the dividend and the chief executive will depart immediately"* at
**+0.50**; the model scores it **−0.80**. Comprehension is not in question.

### 7.3 Prediction is not

796 earnings releases, 98 tickers, all post-cutoff, 20-session market-adjusted
drift:

| criterion | result |
|---|---|
| direction (rank corr > 0) | PASS — +0.0192 |
| significance (p ≤ 0.05) | **FAIL** — 0.491 |
| incremental R² over lexicon ≥ 0.005 | **FAIL** — 0.0023 |
| top-minus-bottom quintile spread > 0 | **FAIL** — −0.10% |

The lexicon's incremental R² over the LLM (0.0062) *exceeds* the LLM's over the
lexicon (0.0023). Both are indistinguishable from noise.

**Reading well and forecasting are different problems**, and the gap between §7.2
and §7.3 is the cleanest demonstration of it in this paper.

---

## 8. Methodological findings

We regard this section as the paper's most transferable content. Each defect
below produced a *positive* result that was wrong.

### 8.1 In-sample results reported as held-out

A walk-forward optimiser reported 93% over six weeks against a true −1.6%. The
train/test split shared a warm-up window.

### 8.2 A validation bar that was not out-of-sample

"Improves in both regime windows" was this project's standard for months. A
7×7 exit-policy grid showed 31 of 49 cells beating the control in both windows.
On genuinely held-out folds, **2 of 49** did. Both windows partitioned the same
data; the bar had only ever been used to *reject*, so it produced no false
positive that reached production — but it could not validate.

### 8.3 Anti-correlated parameter selection

Across the same grid, Spearman ρ between train and test rank was **−0.339**.
Historically-optimal parameters performed *worse than average* subsequently.
Selection was worse than choosing blindly.

Notably, the converse does not rescue a strategy either: the drawdown-scaling rule
in §8.6 achieved ρ = **+0.470** — a well-behaved parameter space — and still lost,
because every cell lost to the control. **Stable within-grid ranking is not
evidence of edge.**

### 8.4 Non-determinism (three occurrences)

Three separate scripts returned different answers on consecutive runs of identical
code: live-clock window boundaries; fold boundaries derived from a growing array;
and silently truncated fetches. In one case the sign of the decisive statistic
flipped between runs (ρ = −0.339 vs +0.150). **Determinism is a correctness
property**: if two runs disagree, both are unusable and neither is identifiable as
the wrong one.

### 8.5 Correlated observations counted as independent

Treating 65 earnings events across 8 co-moving mega-caps as independent gave
p = 0.046. At a residual correlation of just 0.05, p = 0.337.

### 8.6 In-sample breadth mistaken for robustness

A drawdown-scaling weight rule improved Sharpe in **11 of 12** assets on the full
sample at lower cost than the control. On held-out folds it improved **3 of 12**,
winning 22% of 72 folds — worse than chance. The mechanism is understood: the
sample *ends* inside a sustained drawdown, and a rule that de-risks as price falls
below its running peak is mechanically flattered by any sample terminating in a
decline.

### 8.7 Metric pathology

Sharpe inverts when mean returns are negative: reducing volatility makes it *more*
negative, penalising exactly the risk reduction a defensive strategy provides.
Ranking strategies by Sharpe over a losing period rewards whichever lost more
wildly. We report Calmar where the mean is negative.

---

## 9. Discussion

### 9.1 The results are what efficiency looks like

BTC and ETH are among the most heavily arbitraged instruments in existence.
Finding no exploitable directional signal in their daily bars, using public data
at retail cost, is a *measurement* rather than a methodological failure. Fifteen
families agreeing is reasonably strong evidence for that bounded claim.

### 9.2 What survives is structural, not predictive

Every strategy that demonstrably works in these markets — market making,
cross-venue and DEX–CEX arbitrage, MEV and liquidation capture, levered basis
carry at scale — shares a property: **none is a forecast.** Each is a position
within market structure requiring infrastructure, latency or balance sheet rather
than a better signal. Our funding-carry result reaches the same conclusion from
the opposite direction: the one mechanical edge tested pays under 1% unlevered.

### 9.3 On LLMs specifically

The defensible thesis was never that an LLM predicts prices. It was that
comprehension at scale was scarce, and text contains information price does not.
§7.2 confirms the comprehension; §7.3 finds no predictive content in this sample.

We caution against reading §7.3 as a general refutation. The published effect
concentrates in small caps and negative news, and is documented as *decaying with
adoption*. Our sample is large-cap-skewed and entirely post-adoption — we tested
where and when the effect should be weakest.

---

## 10. Limitations

1. **Three years, one asset class, ~2.2 effective independent observations.**
   Sufficient to reject specific strategies at specific costs; insufficient for
   general claims about trend following or momentum.
2. **Funding history is 96 days.** Carry is regime-dependent and this is a single
   quarter.
3. **Standard signals only.** We tested well-known indicators — precisely those
   most likely already arbitraged. Absence of edge in public signals is weak
   evidence about proprietary ones.
4. **The LLM universe skews large-cap** despite intent, and releases were
   truncated at 30,000 characters against a median length of 31,757.
5. **One model family per test.** Different LLMs might read differently, though
   two models scored near-identically in the fitness pre-flight (ρ 0.939 vs 0.870).
6. **The cross-sectional correlation estimator in Study 1 returned 0.000 and is
   not meaningful as written.** Immaterial to a p of 0.491, but it must be fixed
   before any positive result is reported.

---

## 11. Conclusion

Fifteen strategy families, pre-registered and held-out, at a verified retail fee
schedule, produce no exploitable edge. The deployed system was economically
equivalent to a static allocation trading twice a year, and every attempt to
improve on that allocation — by forecasting direction, by scaling with
volatility, by trend, by cross-section, by carry, or by reading disclosure text
with a language model — failed on held-out data.

The strategy question, for this capital, venue and data access, is closed. We
believe the durable output is §8: six measurement defects, each of which produced
a convincing false positive, and each of which would have been mistaken for a
discovery had the corresponding control not been in place. In a literature that
publishes successes, the practitioner's binding constraint is rarely the model.
It is knowing which of your own results to disbelieve.

---

## References

- Adams, R. & MacKay, D. (2007). *Bayesian Online Changepoint Detection.*
- Gao, Z., Jiang, W. & Yan, Y. (2025). *Detecting Lookahead Bias in LLM Forecasts.* arXiv:2512.23847
- Lopez-Lira, A. & Tang, Y. (2026). *Can ChatGPT Forecast Stock Price Movements? Return Predictability and Large Language Models.* Journal of Financial Economics. arXiv:2304.07619
- Moreira, A. & Muir, T. (2017). *Volatility-Managed Portfolios.* Journal of Finance.
- Moskowitz, T., Ooi, Y. H. & Pedersen, L. H. (2012). *Time Series Momentum.* Journal of Financial Economics.
- IMF (2025). *A Large-Scale LLM Analysis of Central Bank Communication.* WP/2025/109
- BIS (2025). *CB-LMs: Language Models for Central Banking.* Working Paper 1215

---

## Reproducibility

All code, cached inputs and pre-registered criteria:

- `bitcoin-trading-tool` — crypto strategies, backtests, and the deployed system
- `llm-alpha-harness` — LLM evaluation harness, cutoff probes, EDGAR/price
  connectors, Study 1

Every result is regenerable from cached data. Pre-registrations are hashed so
that a moved threshold is visible in version control.

**This is research, not investment advice.**
