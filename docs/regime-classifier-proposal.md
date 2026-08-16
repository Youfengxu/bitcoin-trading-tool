# Regime Classifier — Proposal

**Status:** proposed, not started · **Date:** 2026-08-16
**Prerequisite for Tier 2:** positioning collector running since 2026-08-16

---

## 1. The target, measured rather than assumed

Switching between *hold* and *the engine* based on regime is worth **+29.35% mean
return** across 10 assets and 2 regime windows, against **~0%** for every blended
weight on the core/satellite frontier. The two sleeves are mirror images, so
blending earns their average; switching earns whichever fits.

The latency budget is unusually generous, and this is the single most important
input to the design:

| oracle lag | mean return | |
|---|---|---|
| 0h (perfect) | +29.35% | ceiling |
| 24h | +27.45% | **no measurable decay** |
| 72h | +22.06% | 75% of the prize retained |
| 168h | −2.72% | gone |

**A classifier has up to ~72 hours to make up its mind.** It does not need to be
fast. It needs to be right about the direction of the coming week.

This inverts the usual engineering instinct and it should shape every choice
below: methods that trade latency for accuracy are *free* here, up to three days.
Methods that buy speed at the cost of accuracy are worthless.

## 2. What is already ruled out

Eight classifiers, all pure functions of past price, scored on the pinned
10-asset sample:

| classifier | accuracy | vs base rate | mean return |
|---|---|---|---|
| adx+di+sma200 | 51.3% | +4.1pp | +2.16% |
| sma50>sma200 | 50.7% | +3.5pp | +2.73% |
| vote(3 slow) | 50.0% | +2.8pp | +2.54% |
| mom 168h | 50.0% | +2.8pp | +1.21% |
| price>sma200 | 49.8% | +2.7pp | +1.25% |
| trend/ATR>0.5 | 49.7% | +2.5pp | +0.64% |
| ema12>ema26 | 48.0% | +0.8pp | +3.18% |
| mom 336h | 47.5% | +0.4pp | −1.29% |

Base rate 47.2%. Best captures **11%** of the oracle prize.

The decisive detail is not that the numbers are small — it is that **accuracy and
return are uncorrelated** (r = 0.45 across 8 points; the most accurate classifier
returns a middling +2.16% while the best-returning one sits 0.8pp above chance).
If these had skill, being right more often would pay more. It does not. The
positive numbers are scatter around the ~0% a blend already achieves.

**Conclusion: thresholds on price-derived indicators are exhausted.** A ninth
variant of the same idea is not worth building.

## 3. Candidate methods

Ranked by evidence strength × fit to our constraints × effort. The common thread
is that all of them are *state estimators* rather than threshold rules: they
model the regime as a latent variable with persistence, which is what makes them
tolerant of the latency we can afford.

### Tier 1 — buildable now, on data already held

**A. Hidden Markov Model (2–4 states) on returns and volatility**

The dominant approach in the literature. Models the regime as an unobserved
state with transition probabilities, emitting observed returns. Crypto-specific
work reports a 4-state non-homogeneous HMM giving the best one-step-ahead
forecasting for Bitcoin, identifying bull, bear and calm regimes.

*Why it fits:* unsupervised (no labels needed), explicitly models persistence so
it does not flap the way threshold rules do, and its filtered state probability
is naturally lagging — which costs us nothing. Handles the non-stationarity that
defeats linear models.

*Features:* log returns, realized volatility, volume ratio. Deliberately small —
an HMM on 6 months of hourly bars can support only a handful of parameters.

*Effort:* moderate. No dependency needed; a Gaussian HMM with EM fitting is
~150 lines, or `hmmlearn` via a Python sidecar if a dependency is acceptable.

**B. Gaussian Mixture Model clustering on a feature vector**

Simpler than an HMM — clusters without modelling transitions. Worth building
*first* as a diagnostic: if the feature space does not separate into distinct
clusters at all, the HMM has nothing to find either and Tier 1 can be abandoned
cheaply.

*Effort:* low. EM for a 2–3 component GMM is ~80 lines.

**C. Bayesian Online Changepoint Detection (BOCPD)**

Detects structural breaks rather than classifying states — complementary to A
and B. Recent work reports BOCPD substantially outperforming Generalized
Likelihood Ratio and Kolmogorov–Smirnov tests on S&P 500 and CSI 300, with
`maxCPs` and hazard rate λ = 100 performing best.

*Why it fits:* the literature's main criticism of BOCPD is **detection latency**
— it must accumulate posterior evidence before signalling, so changepoints lag
the true break. That is precisely the constraint we have already priced in.

*Effort:* moderate; the Adams & MacKay recursion is well specified.

### Tier 2 — the genuinely novel bet, needs the collector (≈November)

**D. HMM or GMM with positioning features**

Same machinery as A/B, different inputs: funding rate z-score, open-interest
change, long/short account ratio, taker buy/sell imbalance — the series the
collector has been recording hourly since 2026-08-16.

*Why this is the interesting one:* every failure this project has recorded came
from price-derived features. Positioning is a different information source, and
crucially it is **slow-moving** — which is why it failed at hourly trade timing
(0/10 assets) and why it may suit a weekly-horizon regime call with 72h of slack.
Industry regime products use exactly these inputs: cross-exchange funding, open
interest, liquidations and long/short ratios, with regimes described as having
"unique open-interest, funding and liquidation signatures".

*Known caution from the literature:* funding rate changes may be **trailing
by-products of momentum rather than leading indicators**. If so, D degenerates to
a laggy price signal and fails like the rest. Long/short ratio extremes (>2.0 or
<0.5) are reported to precede reversals — BTC currently sits at 2.2, which is
testable directly.

*Blocked until:* ~2,000 hourly rows per currency, i.e. November.

### Explicitly not proposed

- **More threshold rules on price indicators** — eight tested, all chance-level.
- **Anything optimising for speed** — we have a 72h budget and cannot spend it.
- **Options-implied measures** (skew, term structure) — no data source wired, and
  OKX options liquidity is thin outside BTC/ETH.
- **Sentiment/news features** — unavailable historically, unverifiable, and would
  reintroduce the retroactive-data problem the collector exists to solve.

## 4. Test protocol

Non-negotiable, because every failure this session came from a methodology gap
rather than a modelling one.

1. **Walk-forward fitting.** HMM/GMM parameters fit on data strictly before the
   scored bar. Fitting on the full sample and scoring in-sample is the exact
   defect found in `walkForwardOptimize` (it reported 93% over six weeks against
   a true −1.6%).
2. **Pinned 10-asset sample**, both regime windows, via `--pairs`. Selection by
   live volume shifts between runs and silently made two earlier tables
   non-comparable.
3. **Score on both axes** using `regimeClassifierScore`: accuracy against the
   47.2% base rate, and economic return through the actual switch with fees.
4. **Fixed window end.** `Date.now()` made consecutive runs measure different
   periods and turned an ablation into noise.

## 5. Decision criteria

A method proceeds to deployment only if **all** hold:

| criterion | threshold | why |
|---|---|---|
| Accuracy over base rate | **≥ +8pp** | double the best price rule's +4.1pp |
| Oracle prize captured | **≥ 30%** | best price rule got 11% |
| Accuracy ↔ return | **correlated** | the 8 rules' r = 0.45 is the signature of noise |
| Positive in **both** windows | required | the bar nothing has cleared yet |

If a method clears accuracy but not the correlation test, treat it as unproven
regardless of return — that pattern is what a lucky draw looks like.

## 6. Honest prior

The literature reports success for HMM regime detection in crypto. Published
finance results are heavily selection-biased, replication is rare, and this
project has now produced nine consecutive negative results against methods that
sounded equally plausible.

Realistic assessment: **perhaps 20–30% that any Tier 1 method clears Section 5**,
and Tier 2 is a genuine unknown that cannot be assessed before the data exists.
The value of Tier 1 is partly that it is cheap and partly that it calibrates
whether the feature space is separable at all — a fast negative there would
sharpen Tier 2 rather than waste it.

**What would make me abandon this line entirely:** a GMM that finds no stable
cluster structure in either price or positioning features. That would say the
regimes are not identifiable from the data available at any latency, and the
switching prize — real as it is — would be unreachable.

## 7. Suggested sequence

1. **GMM diagnostic** (~half a day) — is the feature space separable at all?
2. **HMM on price features** (~1–2 days) — the literature's main claim, tested
   against our criteria.
3. **BOCPD** (~1 day) — only if 1 or 2 shows promise; it complements rather than
   replaces them.
4. **Hold for the collector**, then Tier 2 in November with the same protocol.

Steps 1–3 need no new data and reuse the harness already in place. If all three
fail, that is a well-evidenced answer and the strategy stays what it demonstrably
is: a drawdown-reduction tool.
