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
