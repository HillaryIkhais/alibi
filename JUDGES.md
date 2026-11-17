# Judge path — verify Alibi in 5 minutes

You do not need to trust the README. Run these in order. Each maps to a committed artifact.

## Minute 1 — the invariant under attack (no setup)

```bash
node engine/bin/adversarial-test.js
```

You should see `TEST RESULTS: 12 passed, 0 failed` and `VENDOR POLICY ENFORCEMENT: VERIFIED`.
This is the core claim: a marketplace cannot widen its commission authority beyond the vendor's
policy. A 20% request, an unauthorized payee, an exhausted budget, and a replayed hash are all refused.

## Minute 2 — the guards are not fake, and the budget holds under load

```bash
node engine/bin/mutation-test.js
node engine/bin/concurrency-test.js
```

You should see `4/4 guards confirmed load-bearing`, `Byte-identical restore: YES`, and
`ATOMIC BUDGET RESERVATION: VERIFIED (single-process)`. If a guard were dead code, its correlated test
would still pass after being disabled — this harness proves it does not. The concurrency test fires 8
interleaved arrivals at a 9-unit budget and confirms exactly 3 approvals, no over-commit.

## Minute 3 — pin the bytes

```bash
node engine/bin/evidence-manifest.js
```

Compare the printed SHA-256 values to `evidence/manifest.json`. This confirms the artifacts you just
ran match the bytes in the repo — no post-hoc substitution.

## Minute 4 — the surrounding machinery

```bash
(cd engine && node test/run-pipeline.mjs)   # ALL PIPELINE CHECKS PASSED
(cd auditor && node test/run-offline.mjs)   # ALL OFFLINE CHECKS PASSED
node engine/bin/commission-flow-simulator.js # FLOW COMPLETE
```

## Minute 5 — read the honesty table

Open [`evidence/REAL_VS_MOCKED.md`](evidence/REAL_VS_MOCKED.md) and
[`evidence/claims.json`](evidence/claims.json). Every README sentence resolves to one of these rows.

## The one thing Alibi does NOT claim right now

The live 18/18 node-backed verifier result is **NOT REPRODUCIBLE** in the shipped environment: no
`evidence/bundle.json` exists and the local regtest nodes are desynced. The verifier itself is real
and fails closed, but the artifact is absent. See claim C10 in `claims.json` and the last section of
`REPRODUCE.md` for the exact restore procedure. Judge accordingly: the deterministic policy layer is
proven; the live settlement headline is not currently evidenced.

## Where things live
- `Alibi_PRD.md` — build-against spec, invariant, Q&A
- `REPRODUCE.md` — every command and expected output
- `THREAT_MODEL.md` — what is trusted and what is not
- `DECISIONS.md` — what was built, cut, and why
- `evidence/` — all artifacts and the frozen manifest
