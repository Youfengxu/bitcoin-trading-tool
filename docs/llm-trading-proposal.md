# LLM-Powered Trading — Options Proposal

**Status:** proposal, nothing built
**Date:** 2026-08-16
**Scope:** equities, FX, and crypto — where an LLM plausibly adds something a
price-derived model cannot

---

## 0. The honest starting position

This project has just spent a long investigation establishing that **direction is
not forecastable at a weekly horizon on liquid crypto**. Thirteen method families
— eight threshold rules, HMM at 2/3/4 states, BOCPD at four hazard rates, GMM
clustering, exit-policy optimisation — all landed between 46.2% and 51.3%
accuracy against a 47.2% base rate. The deployed engine turned out to be a ~40%
beta position with 3,698 trades per asset of extra steps.

**An LLM pointed at a price series will not change that.** LLMs are worse than
purpose-built statistical models at extracting signal from numeric sequences, and
nothing about a transformer makes an efficient market inefficient. Any proposal
resting on "the LLM will spot patterns in the chart" is not worth building, and
this document does not contain one.

The defensible thesis is narrower and much more interesting:

> An LLM's edge is **unstructured text at scale**. Filings, transcripts, news and
> central-bank statements contain information that price-derived features
> genuinely do not, and until recently nobody could read all of it every day.

That is a real informational claim rather than a modelling trick, and it has
published support (§2).

### The structural reason to leave crypto

The single fact that killed every crypto approach was not the models — it was
**effective sample size**. Hourly returns across majors correlate at ~0.663, so
N/(1+(N-1)ρ) asymptotes at **~1.5 independent assets no matter how many are
added**. Twelve majors agreeing was closer to 1.5 agreeing. Every "improvement"
was being validated on a sample of about two.

Equities fix this at the root: thousands of names, genuine sectoral dispersion,
and a cross-section wide enough that a long-short portfolio has real statistical
power. **This is the strongest argument for the move — not that LLMs are magic,
but that the statistics finally work.**

FX does the opposite: ~8 liquid majors, dominated by the same global factor. It
is the crypto sample-size trap again, worse. That shapes the ranking below.

---

## 1. The binding constraint: lookahead bias

Before any strategy, the hazard that invalidates most LLM-trading work.

**An LLM has read the outcome.** Ask GPT-4 about a firm-date in 2023 and it may
simply recall what happened. Backtests over the training period therefore measure
memory, not forecasting, and they look spectacular.

There is now a proper statistical test for this. Gao, Jiang & Yan define
**Lookahead Propensity (LAP)**: a date-only recall query estimating the
probability the model has internalised a firm-date's realised outcome. Their
findings:

- LAP is **materially positive throughout the in-sample period** and **collapses
  essentially to zero right after the training cutoff**
- Forecast predictive power is **amplified on high-LAP firm-date pairs**
- That interaction **loses significance on post-cutoff samples**

In other words, a large part of reported LLM forecasting skill in the literature
is recall. Two defences, and we should use both:

1. **Test only after the model's knowledge cutoff.** Non-negotiable.
2. **Run the LAP interaction test** on any result, as a contamination check.

This is the same class of error as the defects already found in this codebase —
an optimiser reporting 93% in-sample against a true −1.6%, and "improves in both
regime windows" turning out not to be an out-of-sample test at all. The pattern
is consistent: **the harness is where the money is lost, not the model.**

---

## 2. What the evidence actually says

| finding | source | strength |
|---|---|---|
| GPT-4 scoring post-cutoff news headlines captures initial market reaction (~90% portfolio-day hit rates) and predicts subsequent drift | Lopez-Lira & Tang, *Journal of Financial Economics* | strong — peer reviewed, post-cutoff design |
| Effects concentrate in **small caps** and **negative news** | same | important caveat: worst liquidity, highest costs |
| **Strategy returns decline as LLM adoption rises** | same | documented alpha decay — this is a race |
| Lookahead bias is measurable and materially inflates in-sample results | Gao, Jiang & Yan (LAP) | strong, and directly actionable |
| LLMs classify central-bank tone reliably; sentiment predicts interbank rates and currency direction | IMF WP/2025/109; BIS CB-LMs; ECB and RBI studies | moderate — mostly *explanatory*, few tradeable-net-of-cost claims |

Read that table carefully. The headline result is real **and** already decaying,
concentrated in the least tradeable names, and heavily dependent on a
contamination control most practitioners skip.

---

## 3. Options

### Option A — Equity cross-section from news and filings ★ recommended second

Score a liquid universe daily with an LLM reading news and 8-K/10-Q text, rank
cross-sectionally, hold a long-short or long-tilt basket.

- **Why it fits:** directly supported by the JFE result; the cross-section gives
  genuine sample size, the exact thing crypto could not provide
- **Free data exists:** SEC EDGAR full-text is public and complete — no vendor
  needed for filings, only for news
- **Against it:** documented alpha decay; effect strongest in small caps where
  spreads eat it; daily LLM inference over hundreds of names has real cost;
  shorting needs margin
- **Cost:** moderate — inference scales with universe × frequency

### Option B — Earnings events, incremental over a known anomaly ★ recommended first

Restrict to earnings dates. LLM reads the transcript and guidance language. The
test is not "does this predict returns" but **"does the LLM's read add anything
beyond the numeric surprise?"**

- **Why this first:** post-earnings-announcement drift is one of the most robust
  documented anomalies in finance, so there is a *known baseline to beat*. That
  makes the question well-posed in a way "does it predict returns" never is.
  This session's entire lesson is that the control is what kills ideas — static
  40% killed the engine, a trailing average beat the GMM. Start where the control
  is built in.
- **Also:** event-driven means clean windows, bounded inference cost, and far
  fewer trades than a daily cross-section
- **Against it:** fewer observations (~4 events/name/year), transcripts usually
  need a paid vendor

### Option C — FX and central-bank communication ✗ not recommended first

LLM scores FOMC/ECB/BoJ statements hawkish↔dovish; trade rate-sensitive pairs.

- **Superficially attractive:** real literature, clean events, and text is
  genuinely where the information lives
- **Why not:** **~8 liquid majors driven by one global factor, and ~8 policy
  meetings per bank per year.** That is a handful of effectively independent
  observations per year — the crypto sample-size trap in a more expensive suit.
  We would be unable to distinguish skill from luck for years.
- Revisit only as a *risk overlay* (Option D) or after A/B prove the harness

### Option D — LLM as risk/regime overlay, not alpha

Use the LLM to classify macro state from text and **size** positions, never to
pick direction.

- **Why it is credible:** this session measured that regimes are real but
  **volatility-defined, not directional** — GMM clusters separated forward
  volatility at 1.04sd versus forward return at 0.33sd. Volatility targeting
  cut mean drawdown 42.3%→31.4% across 7/7 assets
- **Ceiling is lower** (risk control, not return generation) but the probability
  of it working is much higher, and it applies to the existing BTC book
- **Caution:** a trailing 168h average beat the GMM at forecasting volatility
  (r=0.619 vs 0.488). Any LLM regime signal must beat *that* baseline, not zero

### Option E — LLM as research accelerant, not a trader

Use the model to read filings, generate hypotheses, and drive the evaluation
harness — with humans and statistics deciding what trades.

- **Least glamorous, most reliably positive.** It is also what this session
  actually demonstrated: the value delivered was not a winning strategy, it was
  thirteen well-killed hypotheses and the harness that killed them
- Zero market risk, immediate benefit, and it compounds into A/B

---

## 4. Recommended sequence

**Phase 0 — the harness (build this regardless of which option wins).**
Nothing else is trustworthy without it. It must include:

1. **Post-cutoff-only evaluation.** Pin the model version and its knowledge
   cutoff; score nothing before it.
2. **The LAP contamination test** as a standing check.
3. **Point-in-time data.** No survivorship bias, no restated fundamentals, no
   index membership known before it was announced.
4. **Pre-registered criteria**, written before the run — the discipline that made
   thirteen negative results trustworthy instead of arguable.
5. **A dumb baseline in every comparison.** A sentiment dictionary, the numeric
   surprise alone, an equal-weight basket. In this project the dumb baseline won
   every single time; assume it will again.
6. **Realistic costs**: spread, impact, borrow, and the fact that fees ate 27–37%
   of gross P&L on the crypto book.
7. **Deterministic reruns** — pinned windows and cached data. Three separate
   bugs this session produced different answers on consecutive runs of the same
   script.

**Phase 1 — Option B.** Best-posed question, bounded cost, built-in control.

**Phase 2 — Option A** if B shows anything, since they share the harness.

**Phase 3 — Option D** on the existing BTC book, independent of A/B.

**Not now — Option C.** Revisit only if the sample-size objection can be answered.

---

## 5. Practical constraints

- **Broker:** equities and FX from Singapore realistically means Interactive
  Brokers. That is a live-money account with none of the demo-venue safety the
  crypto book has, so the paper/shadow-book architecture already built here
  should be carried over before any capital is committed.
- **Data:** EDGAR is free. News and transcripts are not. Budget for this before
  building — a strategy that needs data you will not buy is not a strategy.
- **Inference cost:** scales with universe × frequency × prompt size. Option B is
  cheap; a daily 1000-name cross-section is not.
- **Alpha decay is documented, not hypothetical.** Any edge here has a shelf life,
  which argues for building the harness (durable) over tuning a strategy
  (perishable).

---

## 6. Honest prior

The published equity/news result is real, peer-reviewed, and uses a defensible
post-cutoff design. It is also decaying as adoption rises, concentrated in small
caps where costs bite hardest, and surrounded by a literature the LAP work
suggests is substantially contaminated.

Realistic assessment: **perhaps 25–35% that Option B clears a properly controlled
bar** — higher than the 20–30% assigned to the crypto regime work, because the
information source is genuinely new rather than another transform of price, and
because the cross-section finally provides the sample size that made the crypto
results unfalsifiable in practice.

**What would make me stop:** an LLM signal that fails to beat a sentiment
dictionary or the raw numeric surprise. That would say the model is adding
nothing over cheap text features, and the whole premise — that reading
comprehension is the edge — would be wrong.

**This document proposes engineering and research, not investment advice.** No
part of it is a recommendation to buy or sell any security, and position sizing
and capital allocation remain the owner's decisions.
