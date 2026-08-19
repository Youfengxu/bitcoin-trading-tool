# Implementability of Systematic Trading Strategies at Retail Cost

### A replication study on liquid cryptocurrency majors, with a pre-registered LLM text-signal extension

**Author:** Youfeng Xu · research conducted with Claude Opus 5
**Version:** 2 (2026-08-18). Version 1 was withdrawn after independent review; §11 records what changed and why.
**Scope:** one venue (OKX), one operator, 36 months, unlevered, retail fee tier.

---

## Abstract

We ask whether published systematic trading strategies are *implementable* by a
retail participant at a verified fee schedule, rather than whether they exist. On
twelve liquid cryptocurrency majors over 36 months we test threshold rules, hidden
Markov models, Bayesian online changepoint detection, Gaussian mixture clustering,
time-series trend, cross-sectional momentum, volatility scaling and delta-neutral
funding carry. We then run one pre-registered test of an LLM text signal on 796
US earnings releases.

None is implementable. **We are careful to distinguish two very different
reasons.** The economic findings are well-identified: a deployed signal engine is
shown by exposure decomposition to be a ~40% beta position executing 3,698 trades
per asset, economically indistinguishable from a static allocation trading twice a
year; unlevered funding carry nets **+0.93% APR on BTC and −0.23% on SOL** against
a widely quoted 10–30%, because capital funds two legs and the quoted figures
assume 3–5× leverage. The directional findings are **statistically uninformative**:
with a measured cross-sectional correlation of **ρ = 0.663** the twelve-asset
universe carries **1.45 effective independent observations**, and the minimum
detectable directional edge at 80% power is **8.98pp** against an observed range
spanning −1.0 to +4.1pp. We report minimum detectable effects throughout, because
without them a null result is not a finding.

The LLM extension fails four pre-registered criteria (rank correlation +0.019,
incremental R² 0.0023 over a finance lexicon). We report a design error that
undermines it: **post-earnings drift is absent in our sample** (spread 0.23pp,
p=0.715), so the study asked what a text signal adds *beyond* an anomaly the
sample does not contain.

An appendix documents defects found by adversarial review of our own work,
including one disclosed look-ahead leak we wrongly argued was harmless, and one
pre-registered criterion that could not fail. We do not claim these as novel
methodology — most correspond to known results — but their *frequency* in a
carefully-conducted programme may be the paper's most useful datum.

---

## 1. Introduction

### 1.1 What this paper is, and is not

This is **not** a discovery paper and does not claim novel anomalies. Crypto
momentum (Liu & Tsyvinski 2021; Liu, Tsyvinski & Wu 2022), post-earnings drift
(Ball & Brown 1968; Bernard & Thomas 1989), volatility-managed portfolios
(Moreira & Muir 2017) and LLM return prediction (Lopez-Lira & Tang 2026) are
established literatures with far larger samples than ours.

It is a **replication-and-implementability** study asking a narrower question: at
a verified retail fee schedule, unlevered, with public data and ~$10⁴ of capital,
does any of this survive? That question is under-reported precisely because it is
unglamorous, and its answer does not follow from the existence of the anomaly.

### 1.2 Scope, stated as a limit

All claims are bounded to: public price and funding data; daily-to-weekly
horizons; the twelve most liquid crypto majors; unlevered positions; OKX Lv1 fees
(maker 0.0800%, taker 0.1000%, verified against the account); 36 months. We make
**no claim** about high-frequency trading, market making, cross-venue arbitrage,
on-chain strategies, institutional fee tiers, illiquid altcoins, or leverage.

---

## 2. Data

| source | contents | period |
|---|---|---|
| OKX history-candles | hourly OHLCV, 12 majors | 2023-08 → 2026-08 (26,280 bars each, contiguous) |
| OKX funding-rate-history | 8-hour perpetual funding | 2026-05 → 2026-08 (**96 days is all the venue serves**) |
| SEC EDGAR | 8-K Item 2.02 + EX-99.1 | 2024-07 → 2026-08 |
| Yahoo Finance | daily adjusted equity bars | 2024-01 → 2026-08 |

**Universe.** BTC ETH SOL BNB XRP DOGE ADA LINK AVAX LTC DOT TRX; 98 US equities
with usable earnings events.

**Survivorship.** Both universes are today's large caps. In crypto this excludes
post-2023 listings and dead coins; in equities it biases *against* our hypothesis,
since the published LLM effect concentrates in small caps.

---

## 3. The binding constraint: effective sample size

Mean pairwise correlation of hourly log returns across the twelve majors is
**ρ = 0.663** (26,279 aligned bars, 66 pairs; min 0.396, median 0.696, max 0.817;
derived by `server/scripts/effectiveSample.ts`). Hence

> n_eff = 12 / (1 + 11 × 0.663) = **1.45**, asymptoting at 1/ρ ≈ **1.51**.

Adding assets cannot raise this above 1.51. **Twelve majors agreeing is closer to
1.5 observations agreeing**, and no cross-sectional claim in this market is
strongly falsifiable with three years of data.

*Version 1 of this paper used ρ = 0.449 and n_eff = 2.02 throughout. That figure
was never derived from data; see §11.*

## 4. Statistical power

Minimum detectable effects at 80% power, α = 0.05, computed from the realised
samples:

| test | n / n_eff | **MDE** | observed | verdict |
|---|---|---|---|---|
| crypto weekly direction | 242 | **8.98pp** | −1.0 to +4.1pp | **uninformative** |
| engine vs static, episodes | ~17 | ~34pp win-rate | 42% | uninformative *as a test* |
| Study 1 rank correlation | 796 | ρ = 0.099 | +0.019 | excludes only large effects |
| Study 1 quintile spread | 159/quintile | 2.65pp | −0.10% | **uninformative** |
| Study 1 incremental R² | 796 | ΔR² = 0.0099 | 0.0023 | pre-registration mis-specified |

**These numbers govern how the rest of the paper should be read.** Published
LLM-earnings effects sit at ρ ≈ 0.03–0.06 and PEAD spreads at 0.5–1.5pp: *both
are below what this design could detect.* The crypto directional range of
46.2%–51.3% fits entirely inside one confidence interval around the 47.2% base
rate, and is consistent with no edge and with a 5pp edge simultaneously.

Our pre-registered ΔR² ≥ 0.005 threshold sits at ~51% power; the 80%-power value
was 0.0099. That criterion was mis-specified: its FAIL was a coin flip under the
alternative.

---

## 5. Directional forecasting: uninformative nulls

Eight threshold rules, HMMs at 2/3/4 states (forward filtering only — never
smoothed posteriors), BOCPD at four hazard rates, and GMM clustering, against a
47.2% base rate: accuracies span **46.2%–51.3%**.

Per §4 this range is uninformative. We report it because the *pattern* is
suggestive even where the levels are not: accuracy and realised return are
unrelated across the eight rules (r = 0.45, n = 8, **95% CI [−0.37, 0.88]** — a
statistic that cannot distinguish "unrelated" from "strongly related").

### 5.1 What the fitted models actually separate

The one well-identified result here. Out-of-sample, the fitted GMM clusters
separate:

| separates | in units of that variable's own s.d. |
|---|---|
| forward 168h **volatility** | **1.04** |
| forward 168h **return** | 0.33 |

**Regimes are volatility states, not directional ones.** This reconciles our nulls
with the regime literature without impugning it: "bull/bear/calm" labels are
largely volatility-defined, and calm-versus-turbulent is genuinely forecastable —
which is why GARCH works. Our directional tests applied a working volatility
detector to a question it does not answer.

Three further gaps between published regime work and live use: smoothed posteriors
are unusable in real time; our effective sample is ~2 regime episodes; and "best
one-step-ahead forecast among competing models" is far weaker than "profitable
after costs through a binary switch".

### 5.2 A failed replication of volatility management

Inverse-volatility weighting scored **Sharpe 0.75** against constant weight's
**0.87** across 12 assets. A fitted GMM was a *worse* volatility forecaster than a
20-line trailing average (r = 0.488 vs 0.619).

This is consistent with Cederburg, O'Doherty, Wang & Yan (2020), the standard
out-of-sample refutation of Moreira–Muir, which we should have cited before
running the test rather than after. **Forecastable is not sufficient**: volatility
can be predicted and the prediction still fail to improve risk-adjusted returns.

---

## 6. The deployed engine: a well-identified economic result

Across 165 overlapping 90-day episodes, 5 assets, 3 years:

| regime | n | hold | engine | static 40% |
|---|---|---|---|---|
| bear < −20% | 41 | −33.8% | −17.3% | −13.6% |
| mild bull 0–25% | 38 | +10.5% | +3.8% | +4.9% |
| strong 50–100% | 23 | +70.4% | +26.7% | +27.1% |
| parabolic > 100% | 8 | +209.2% | +89.5% | +65.7% |

**The engine captures ~35–40% of whatever the market does, in both directions**,
which its 38–43% average exposure fully explains. Against a static 40% book: mean
return **+5.7% vs +5.6%**, mean drawdown **15.7% vs 13.8%**, mean trades **249 vs
2**.

This conclusion rests on **exposure decomposition and trade counts, not on
significance**. The engine wins 42% of episodes, but at n_eff ≈ 17 that is p = 0.50
— indistinguishable from a coin flip, and we do not claim otherwise.

*We previously reported a −0.57 "dose-response slope" of shortfall on bull
strength as a finding. For a constant-β book that slope is identically β − 1; at
40% exposure it is ≈ −0.6 mechanically. It is an identity and is withdrawn.*

---

## 7. Active strategies, unlevered, at verified fees

Exposure-matched with a **causal** expanding-window multiplier (see §11 — version
1 used a look-ahead here, and the correction reverses its conclusion):

| window | BTC | static 40% | trend, vol-scaled | vol-scaled |
|---|---|---|---|---|
| Year 1 | +115.6% | **+41.6%** | +28.9% | +32.1% |
| Year 2 | +104.9% | **+37.5%** | +35.8% | +39.5% |
| Year 3 | −46.4% | **−20.0%** | −20.3% | −22.0% |
| **chained** | | **+55.8%** | +39.5% | +43.7% |

Trend loses in **all three years**. Cross-sectional momentum, judged against
buy-and-hold (its exposure peer), returns +1.5pp, +0.6pp, then **−23.4pp** —
consistent with the crash risk documented by Daniel & Moskowitz (2016) and Barroso
& Santa-Clara (2015), and with Liu, Tsyvinski & Wu's finding that crypto momentum
lives in a far broader cross-section than twelve majors. **We tested where the
effect is documented not to be.**

### 7.1 Funding carry

Measured OKX funding is **1–5% APR gross**, against 10–30% widely quoted. The gap
is leverage. Unlevered, capital funds two legs, halving the yield; fees take the
rest:

| perp | gross | **net on capital** |
|---|---|---|
| BTC | +1.62% APR | **+0.93%** |
| SOL | +0.47% | **−0.23%** |

Ninety-six days of funding history cannot characterise a regime-dependent series;
this is one quarter, not an expected return.

### 7.2 Cost is not the binding constraint

Sweeping the fee schedule to zero, the trend signal scores 0.550 against the
control's 0.552 — a difference far inside the ±0.58 standard error of a 3-year
Sharpe. **The sweep does not isolate cost as the constraint**; it shows only that
removing costs does not produce a visible edge. Version 1 claimed this "exactly
ties" and inferred an absence of edge. That inference outran the data.

---

## 8. LLM text signals in equities

### 8.1 Lookahead control

Following Gao, Jiang & Yan (2025), knowledge cutoffs were measured rather than
assumed, by date-only recall probe:

| model | recall through | collapse | recorded cutoff |
|---|---|---|---|
| muse-glimmer-30b | 2024-04 | 2024-06 | 2024-05-31 |
| gpt-oss-120b | 2024-05 | 2024-07 | 2024-06-30 |

Cutoffs are recorded at the END of the last month showing recall — erring late
costs samples, erring early admits contamination. All events are strictly
post-cutoff, enforced by runtime assertion.

### 8.2 Comprehension holds; prediction does not

On 14 disclosures with known polarity the model scored rank correlation **0.870**
against human judgement on subtle cases, where a Loughran–McDonald-style lexicon
scored **−0.476** — worse than random, inverting on constructions like *"strong
momentum and record engagement… the board has suspended the dividend and the chief
executive will depart immediately."*

On 796 post-cutoff earnings releases, against 20-session market-adjusted drift:

| criterion | result |
|---|---|
| direction (ρ > 0) | PASS — +0.0192 (p = 0.589) |
| significance p ≤ 0.05 | **FAIL** — 0.589, or 0.78 clustered by quarter |
| incremental R² ≥ 0.005 | **FAIL** — 0.0023 |
| quintile spread > 0 | **FAIL** — −0.10% |

The lexicon's incremental R² over the LLM (0.0062) exceeds the LLM's over the
lexicon (0.0023).

### 8.3 A design error that undermines this test

**Post-earnings drift is absent in our sample.** Announcement return versus
subsequent market-adjusted drift: ρ = 0.0068 (p = 0.848); sign-split spread 0.23pp
(p = 0.715).

The study was designed to ask what a text signal adds *beyond* the drift anomaly —
and the sample contains no anomaly to add to. An 8-ticker pilot did find drift
(+2.52pp, naive p = 0.046), and that pilot's own sensitivity table showed the
result vanishing at a residual correlation of 0.05. It did not survive scale-up.

**We should have verified PEAD at full scale before testing what an LLM adds to
it.** §8.2 remains a valid statement about reading; §8.3 means the drift test
answers a question the data cannot pose. We also failed to use the correct PEAD
control — standardised unexpected earnings and the announcement-window return —
having built the latter and not applied it.

---

## 9. Discussion

### 9.1 What we can and cannot conclude

**Can:** at this fee tier, unlevered, with public data and this capital, none of
these strategies is implementable. The exposure decomposition, trade counts and
carry arithmetic are well-identified and do not depend on power.

**Cannot:** that no edge exists. Our design cannot see directional edges below
~9pp of accuracy, text effects below ρ ≈ 0.10, or drift spreads below 2.65pp — and
published effects are smaller than all three. Fifteen strategy families were
tested, but they share ~1.5 effective assets and one price path; **they are not
fifteen independent tests**, and their joint failure carries roughly one degree of
freedom.

Under independence, 15 tests at α = 0.05 give a family-wise error rate of 53.7%,
so finding *nothing* is mildly stronger evidence than a single null. We note this
in fairness; it does not rescue the power problem.

### 9.2 Structural versus predictive edge

Strategies that reportedly work in these markets — market making, cross-venue
arbitrage, MEV capture, levered basis at scale — are positions within market
*structure* rather than forecasts. Our carry result is consistent with this: the
one mechanical edge tested pays under 1% unlevered, i.e. roughly the compensation
one would expect for a service requiring no forecast. **We did not test these
strategies and state this as a hypothesis, not a finding** (version 1 asserted it
as fact, outside its declared scope).

---

## 10. Limitations

1. **~1.45 effective independent observations.** Most directional conclusions are
   underpowered, as §4 quantifies.
2. **Ninety-six days of funding history.**
3. **Standard, already-arbitraged signals only.** Absence of edge in public
   indicators is weak evidence about proprietary ones.
4. **The LLM universe skews large-cap**, where the published effect is weakest,
   and releases were truncated at 30,000 characters against a median of 31,757.
5. **PEAD absent in-sample** (§8.3): the flagship LLM test is mis-designed.
6. **Study 1's cross-sectional correlation estimator is inert** — it pairs the
   k-th event of one quarter with the k-th of another, returns ρ = 0.000, and the
   "discounted" p-value equals the naive one.
7. **One venue, one operator, one implementation.** No external replication of the
   backtests themselves.
8. **Version 1 contained a look-ahead leak in the exposure-matching multiplier**
   (§7, §11) that was disclosed in a companion document but not in that version's
   limitations.

---

## 11. What changed from version 1

Version 1 was submitted to four independent adversarial reviews — numerical
replication, code audit, statistical refereeing, and a hostile peer review. It did
not survive. Changes:

| finding | status |
|---|---|
| **ρ = 0.449 was never derived**; true value 0.663, n_eff 1.45 not 2.02 | corrected throughout; a deriving script now exists |
| **Exposure-matching look-ahead was verdict-flipping**, not harmless as argued: leaked B* +68.1%, causal +41.6%, control +53.8% | fixed; trend now loses all three years |
| **Running peak reset at fold boundaries**, so train and test scored different rules | fixed; the weight rule now beats the control in 6% of folds, not 22% |
| **Pre-registered criterion 1 could not fail** — `>= q1` at the 25th percentile returns 25% of any grid | replaced with cells-beating-control |
| **Study 1's correlation discount was inert** | disclosed as a limitation |
| **The −0.57 dose-response slope is the identity β−1** | withdrawn |
| **Funding-carry docstring claimed a rehedge cost never charged** | claim corrected; a linear perp needs no price-driven rehedge |
| **PEAD absent in-sample**, undermining the LLM test's design | disclosed as §8.3 |
| No power analysis | added as §4 |
| "Fifteen independent families" | withdrawn; they share ~1.5 effective assets |
| Missing literature | Liu & Tsyvinski, Liu/Tsyvinski/Wu, Detzel et al., Cederburg et al., Barroso & Santa-Clara, Daniel & Moskowitz, Loughran & McDonald, Ball & Brown, Bernard & Thomas, Bailey & López de Prado, Harvey/Liu/Zhu added |

**Every statistical primitive checked clean** under audit — Spearman tie handling,
the t-distribution implementation (to <1e-4 against numerical integration),
`tTest`, OLS with interaction, fee accounting, index alignment, data contiguity.
Every defect was in *use*, not implementation.

### 11.1 On the methodological appendix

Version 1 framed these defects as its principal contribution. That was overstated.
Most correspond to known results: in-sample leakage is the subject of Bailey &
López de Prado's Probability of Backtest Overfitting; clustered standard errors
are Petersen (2009); Sharpe's pathology under negative means is textbook. Our
train/test rank anti-correlation (ρ = −0.339) *is* the PBO diagnostic, and we
reported it as a discovery.

What may be genuinely useful is not the taxonomy but the **base rate**: eight
distinct defects, each independently sufficient to produce a false positive,
arising in a single programme that was explicitly trying to avoid them — and four
of the eight surviving until adversarial review, after the paper claiming
methodological rigour had been written.

---

## 12. Conclusion

For a retail participant at OKX Lv1 fees, unlevered, with public data and ~$10⁴ of
capital, none of the strategies tested is implementable. The strongest results are
economic rather than statistical: a signal engine that is a beta position with
extra steps, and a carry trade that pays under 1% once leverage is removed.

The directional nulls are not evidence of absence. They are evidence that this
design could not have seen the effects the literature reports, and we would rather
say so than let a null masquerade as a finding.

---

## References

Adams & MacKay (2007). *Bayesian Online Changepoint Detection.*
Bailey & López de Prado (2015). *The Probability of Backtest Overfitting.* Journal of Computational Finance.
Ball & Brown (1968). *An Empirical Evaluation of Accounting Income Numbers.* JAR.
Barroso & Santa-Clara (2015). *Momentum Has Its Moments.* JFE.
Bernard & Thomas (1989). *Post-Earnings-Announcement Drift.* JAR.
Cederburg, O'Doherty, Wang & Yan (2020). *On the Performance of Volatility-Managed Portfolios.* JFE.
Daniel & Moskowitz (2016). *Momentum Crashes.* JFE.
Detzel, Liu, Strauss, Zhou & Zhu (2021). *Learning and Predictability via Technical Analysis: Bitcoin.* Financial Management.
Gao, Jiang & Yan (2025). *Detecting Lookahead Bias in LLM Forecasts.* arXiv:2512.23847.
Hansen (2005). *A Test for Superior Predictive Ability.* JBES.
Harvey, Liu & Zhu (2016). *…and the Cross-Section of Expected Returns.* RFS.
Liu & Tsyvinski (2021). *Risks and Returns of Cryptocurrency.* RFS.
Liu, Tsyvinski & Wu (2022). *Common Risk Factors in Cryptocurrency.* JF.
Lopez-Lira & Tang (2026). *Can ChatGPT Forecast Stock Price Movements?* JFE. arXiv:2304.07619.
Loughran & McDonald (2011). *When Is a Liability Not a Liability?* JF.
Moreira & Muir (2017). *Volatility-Managed Portfolios.* JF.
Moskowitz, Ooi & Pedersen (2012). *Time Series Momentum.* JFE.
Petersen (2009). *Estimating Standard Errors in Finance Panel Data Sets.* RFS.
White (2000). *A Reality Check for Data Snooping.* Econometrica.

---

## Reproducibility

`bitcoin-trading-tool` (crypto strategies, deployed system) and
`llm-alpha-harness` (LLM harness, cutoff probes, EDGAR/price connectors, Study 1).
All results regenerate from cached data; pre-registrations are hashed so a moved
threshold is visible in version control. `server/scripts/effectiveSample.ts`
derives the correlation constant that version 1 asserted.

**This is research, not investment advice.**
