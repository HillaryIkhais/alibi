# ALIBI — Drey Scorecard (20-point)

Scored per `hackathon-craft/references/scorecards.md`.
Score 0–2 per dimension. 2 = a skeptical judge would agree without explanation.

## Scoring

| # | Dimension | Score | Justification |
|---|---|---|---|
| 1 | Silent failure | 1 | Marketplace broad-wallet access is obvious, not a hidden second-order failure |
| 2 | Insight | 1 | NWC commission draft has no implementation — known gap, not non-obvious |
| 3 | Invariant | 2 | "Authority can only narrow, never widen" — one sentence, testable |
| 4 | Architecture | 1 | Policy gates exist; shared action contracts, provenance, revocation not yet built |
| 5 | Completeness | 1 | Golden path simulated; full loop incl. failure + recovery not live |
| 6 | Verification | 1 | Adversarial assertions pass; independent oracle (verifier.js) not live against nodes |
| 7 | Evidence | 0 | No live link, no public state + digest + verify-yourself path |
| 8 | Sponsor fit | 1 | NWC API used; not load-bearing/inspectable in workflow yet |
| 9 | Narrative | 1 | Problem→solution mostly; not fully problem→failure→proof |
| 10 | Honesty | 2 | Specific limitations documented; SIM/Missing labels honest |

**Total: 10/20 — not yet competitive. Fix the lowest two: Evidence (0) and Silent failure/Insight (1 each).**

## Lowest dimensions and cheapest fixes

1. **Evidence (0)**: Need a live verify-yourself path + public state + digest
2. **Silent failure (1)**: Need to sharpen — the second-order failure is *marketplace silently widens commission authority beyond what vendor approved*, not just "broad access is bad"
3. **Architecture (1)**: Need shared action contracts + provenance + revocation
6. **Verification (1)**: Need fresh-run verification against LND
8. **Sponsor fit (1)**: Need NWC method inspectable inside the workflow

## Cut list (per scorecard cuts)

- Never cut: failure injection, deterministic check, evidence artifact, live demo path, known-limitations section
- Cut first: extra integrations, settings/profiles/onboarding, secondary roles, visual polish, multi-tenant architecture, features not in demo script

## Next 3 actions

1. Write the failure sentence (second-order, mechanically checkable)
2. Create verify-yourself commands tested on a clean machine
3. Add shared action contracts + audit provenance
