# Corrections to the working paper

**Date:** 2026-08-18 · raised by independent review, verified before acceptance

Four independent agents were commissioned to attack the paper. Their findings are
recorded here with my own verification, including one place where a reviewer's
criticism was right but its stated cause was wrong, and one where I could not
reproduce a reviewer's number at all.

---

## C1. rho = 0.663, not 0.449 — CONFIRMED, my error

The paper's central constraint is wrong, and it is wrong in a number quoted
throughout the project.

Recomputed from the cached bars: 12 assets, 26,279 aligned hourly bars, 66 pairs.

| | paper | verified |
|---|---|---|
| mean pairwise hourly correlation | 0.449 | **0.663** |
| n_eff = 12/(1+11ρ) | 2.02 | **1.45** |
| asymptote 1/ρ | 2.23 | **1.51** |

Pair distribution: min 0.396, median 0.696, max 0.817.

**Cause:** 0.449 was measured on a *different* sample — the 20-currency
positioning universe — and carried forward to the 12-major sample without
recomputation. It propagated into the paper, the harness source comments, the
README and a dozen commit messages.

**Effect:** the constraint is ~35% TIGHTER than claimed. The argument is
strengthened and the number is still wrong, which is the more embarrassing
combination. This is precisely the class of defect §8 is about, committed by the
document that catalogues it.

## C2. p = 0.491 was paired with the wrong statistic — CONFIRMED, cause differs

The reviewer flagged that the reported p does not test the reported correlation.
Correct. Its explanation was that p=0.491 belonged to raw `drift`; that is close
but not what happened.

| quantity | value |
|---|---|
| spearman(llm, driftAdj) | **+0.0192, p = 0.589** |
| spearman(llm, drift) | +0.0240, p = 0.499 |
| tTest(sign(llm) x driftAdj) — *what was printed* | **p = 0.491** |

The printed 0.491 is a sign-agreement t-test on driftAdj, a different test from
the rank correlation it was tabulated beside. **Correct value for the reported
correlation: p = 0.589.** Neither figure changes the verdict.

Recording the distinction because a reviewer being right about a flaw while wrong
about its cause is exactly the case where accepting the diagnosis unexamined
would propagate a second error.

## C3. Post-earnings drift is ABSENT in this sample — could not reproduce reviewer's figure

The reviewer reported that the announcement return predicts drift at rho = 0.078,
p = 0.027, "nominally significant" and un-preregistered. I cannot reproduce this
under any specification:

| specification | rho | p |
|---|---|---|
| spearman(announcement, driftAdj) | +0.0068 | 0.848 |
| pearson(announcement, driftAdj) | +0.0520 | 0.142 |
| spearman(announcement, drift) | +0.0024 | 0.947 |
| sign split, up vs down | spread 0.23pp | 0.715 |

**PEAD is not present in these 796 events.**

This matters far more than the arithmetic. Study 1 asked whether an LLM adds
information *beyond* the drift anomaly — and there is no anomaly here to add to.
The design presupposed an effect the sample does not contain.

The 8-ticker pilot did find drift (spread +2.52pp, t=2.04, naive p=0.046), and
that pilot's own sensitivity table showed the result evaporating at a residual
correlation of 0.05. **It did not survive scale-up.** The honest reading is that
the pilot signal was noise and the study was built on it.

**This is a design error of mine, not a reviewer's finding:** PEAD should have
been verified at full scale BEFORE committing 41 minutes of inference to testing
what an LLM adds to it.

## C4. The crypto nulls are economically informative and statistically uninformative

Minimum detectable effects at 80% power, from the actual samples:

| test | n / n_eff | MDE | observed |
|---|---|---|---|
| Study 1 rank correlation | 796 | ρ = 0.099 | +0.019 |
| Study 1 quintile spread | 159/quintile | 2.65pp | −0.10% |
| crypto weekly direction | n_eff 242 | **8.98pp** | −1.0 to +4.1pp |
| engine vs static, episodes | n_eff ~17 | ~34pp win-rate | 42% |

Published LLM-earnings effects sit at ρ ≈ 0.03–0.06 and PEAD spreads at
0.5–1.5pp: **both are below what this design could see.** The crypto directional
range of 46.2–51.3% fits entirely inside one confidence interval around the base
rate.

The pre-registered ΔR² ≥ 0.005 bar sits at ~51% power; the 80%-power threshold
was 0.0099. **The pre-registration was mis-specified** — that FAIL was a coin
flip under the alternative.

## C5. Claims to correct

| § | current | should be |
|---|---|---|
| 3.2 | ρ=0.449, n_eff 2.02 | ρ=0.663, n_eff 1.45 |
| 4.1 | "accuracy and return are uncorrelated (r=0.45)" | uninformative; r=0.45, n=8, 95% CI [−0.37, 0.88] |
| 5 | "wins 42% — worse than a coin flip" | 42%, n_eff≈17, p=0.50 — indistinguishable from a coin flip |
| 6.1 | "at zero fees the trend signal exactly ties" | differs by 0.002 Sharpe, inside a ±0.58 standard error |
| 7.3 | ρ=+0.019, p=0.491 | ρ=+0.019, p=0.589 (0.78 clustered by quarter) |
| 9.1 | "fifteen families agreeing is reasonably strong evidence" | families share ~1.5 effective assets and one price path; not independent tests |
| 10 | "sufficient to reject specific strategies" | sufficient to reject edges above the stated MDEs; smaller edges untested |

Also undisclosed and required: the exposure-matching multiplier in §6/§10 was
computed over the full window **including the held-out period**. It is disclosed
in `active-strategy-options.md` and appears in none of the paper's six
limitations.

## C6. Multiple testing cuts both ways

Fifteen families at α=0.05 give FWER 53.7% under independence, so finding nothing
is *mildly stronger* evidence than a single null — the paper does not say this.
Conversely the drawdown-scaling "11 of 12 assets" is not anomalous: at n_eff ≈
1.5 that is p ≈ 0.25, and across fifteen families such a hit is expected. Its
out-of-sample failure needs no drawdown-endpoint mechanism, though that
mechanism remains a plausible hypothesis rather than a finding.

---

## Standing

The paper's economic content survives: exposure accounting, verified fee
schedules, trade counts, and the deflation of funding carry from a quoted 10–30%
to under 1% unlevered. Its statistical content largely does not, and its central
constraint was numerically wrong.

The reviewer's closing judgement is accepted: the self-criticism was genuine in
the appendices and performative in the abstract and discussion. Strategies were
audited ruthlessly; the paper's own headline claims were not audited at all.

---

# Part 2 — code audit findings (agent 2 of 4)

An adversarial audit of the backtest and analysis code. **Every statistical
implementation checked clean** — Spearman tie handling, `tDistPValue` (matched to
numerical integration to <1e-4 including fractional df), `tTest`, and
`olsWithInteraction` (recovers known betas to 4dp). Fee accounting, off-by-one
indexing, `nextSessionAfter`, and data contiguity also verified correct.

**Every defect found was in USE, not implementation.** That is its own finding:
correct primitives applied incorrectly.

## C7. Exposure-matching look-ahead — CRITICAL, verdict-flipping, now fixed

`activeStrategies.ts` averaged realised exposure over the **entire** window and
applied the resulting multiplier from bar one. I disclosed this leak in
`active-strategy-options.md` and argued it was harmless *a fortiori* — the leak
favoured the active strategies and they lost anyway.

**That argument was wrong.** Corrected to a causal expanding window:

| | leaked | causal | control |
|---|---|---|---|
| B* full sample | +68.1% | **+41.6%** | +53.8% |

The leaked version beat the control; the causal one loses by 12.2pp. The per-year
table in the paper also changes — B* now loses **all three years**, where the
leaked version won two:

| window | CONTROL | B* (was) | **B* (causal)** | D* (causal) |
|---|---|---|---|---|
| Year 1 | +41.6% | +42.7% | **+28.9%** | +32.1% |
| Year 2 | +37.5% | +29.3% | **+35.8%** | +39.5% |
| Year 3 | −20.0% | −19.3% | **−20.3%** | −22.0% |
| chained | **+55.8%** | +48.9% | **+39.5%** | +43.7% |

The conclusion is unchanged in direction and much stronger in degree. But the
*a fortiori* defence was not valid, and a paper whose thesis is self-auditing
should not have relied on it.

## C8. Running peak reset at fold boundaries — MAJOR, now fixed

`drawdownScalingValidation.ts` started the running peak at zero at each window
start. Train folds (`from = 0`) kept the inception peak; test folds (`from = ts`)
silently wiped theirs, so the two scored **structurally different rules** — which
also corrupted the train-vs-test rank criterion. A live book does not forget its
high-water mark at a fold boundary.

| | as written | peak carried (live behaviour) |
|---|---|---|
| beats control | 22% of folds | **6% of folds** |
| breadth | 3/12 assets | **1/12 assets** |
| train-test rho | +0.470 | +0.345 |

The rule fails considerably harder than reported.

## C9. A pre-registered criterion that could not fail — MAJOR, now fixed

Criterion 1 took `q1` as the element *at* the 25th percentile and counted cells
`>= q1`. That returns ≥25% of the grid **by construction** — an all-identical
grid scores 40/40. It was reported as `PASS (12/40)` as though it were an
informative control.

**A pre-registered criterion that cannot fail is worse than no criterion**,
because it reads as a passed check. Replaced with a substantive test — what
fraction of the grid beats the control cell — which now reports 36/39.

## C10. The funding-carry rehedge cost was advertised and never charged

The docstring called rehedging "the cost most often omitted", and the branch was
unreachable: `spotQty` was never mutated, so the drift test was identically zero
and `rehedges` always printed 0.

The correction is to the **claim**, not the code. For a linear USDT-margined
perpetual, X BTC spot against a short of X BTC notional is delta-neutral at any
price — the PnLs cancel exactly — so price moves alone do not force a rehedge.
Real rehedging is driven by redeploying accrued funding and by margin management,
both second-order at this size. The net figures are mildly optimistic, not
materially wrong. But describing a cost the code never charged is precisely the
failure mode §8 catalogues.

## C11. The dose-response slope is an identity — now flagged

`bullRunBehaviour.ts` regresses (engine − hold) on hold. For a book holding a
constant fraction β, that slope is **identically β − 1**. At ~40% exposure it is
≈ −0.6 with **zero information content**. The paper reports −0.57 as a finding
about the engine. It is arithmetic.

## C12. The correlation discount was inert — quantified

Already flagged as "not meaningful as written"; the audit quantifies it. The
estimator correlates quarterly cohorts *positionally* — the k-th event of one
quarter against the k-th of another, pairing unrelated tickers — returns
ρ = 0.0000 and n_eff = 796 = n, so the "DISCOUNTED" p-value is **byte-identical
to the naive one**. Under 200 random within-quarter reorderings ρ ranges
−0.08…+0.13 (n_eff 796…8). `minLen` also truncated every ~98-event cohort to 16.

Criterion 2 — the study's flagship control against its own stated central error —
did nothing at all.

## C13. Minor

- `incrementalR2` is in-sample with no df penalty: adequate at n=796 (noise mean
  0.00068) but 0.0078 with a 45% false-positive rate at n=100. Fragile if the
  sample shrinks.
- `prices.ts` `adjClose: adj?.[i] ?? close` silently mixes unadjusted closes into
  an adjusted series exactly where adjustment matters.
- `earningsDrift.ts` puts `today` in the cache key, so sample composition depends
  on run date.
- `activeStrategies.ts` prints "held-out window" while running no holdout.
- Survivorship is present in both universes but biases *against* the equity
  hypothesis, as documented.

---

## Revised standing

Of four independent reviews: the statistical machinery is correct; the paper's
central constant was wrong; its flagship statistical control was inert; one
disclosed leak was verdict-flipping rather than harmless; one pre-registered
criterion could not fail; and one headline "finding" is an algebraic identity.

The economic conclusions survive and in most cases strengthen. The paper's claim
to methodological rigour does not survive in the form it was written.
