# Judge path — verify Alibi in 5 minutes

You do not need to trust the README. Run these in order. Each maps to a committed artifact.

## Minute 1 — the invariant under attack (no setup)

```bash
node engine/bin/adversarial-test.js
```

You should see `TEST RESULTS: 16 passed, 0 failed` and `VENDOR POLICY ENFORCEMENT: VERIFIED`.
This is the core claim: a marketplace cannot widen its commission authority beyond the vendor's
policy. A 20% request, an unauthorized payee, an exhausted budget, and a replayed hash are all refused.

## Minute 2 — the guards are not fake, and the budget holds under load

```bash
node engine/bin/mutation-test.js
node engine/bin/concurrency-test.js
node engine/bin/authority-test.js
```

You should see `4/4 guards confirmed load-bearing`, `Byte-identical restore: YES`, and
`ATOMIC BUDGET RESERVATION: VERIFIED (production implementation)`. If a guard were dead code, its
correlated test would still pass after being disabled — this harness proves it does not. The concurrency
test fires 8 interleaved arrivals against a budget that fits three fee-aware commitments and confirms
exactly 3 approvals, no over-commit. The authority test confirms 13/13: verified BIP-340 signatures,
NIP-44 v2 decryption, method allowlist, connection approve/revoke, and no caller-supplied pubkey trust.

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

## The live-settlement headline is now evidenced

`evidence/bundle.json` contains the independent verifier output: **25/25 pass, exit 0** against three
live LND nodes on regtest. It checks sale/commission invoice settlement, buyer payment finality, the
shared-preimage SHA-256 relation, the 100,000 = 5,000 + 95,000 split, **and Alice's outgoing
commission payment** (terminal SUCCEEDED, exact hash/amount/preimage/fee), using read-only macaroons
and no preimage in the artifact. Claim C10 in `claims.json` is VERIFIED; `REPRODUCE.md` §7 has the
full lab-rebuild and settlement-cycle procedure. Scope limit: controlled regtest node-state
verification, not Bitcoin consensus or trustlessness.

## Where things live
- `Alibi_PRD.md` — build-against spec, invariant, Q&A
- `REPRODUCE.md` — every command and expected output
- `THREAT_MODEL.md` — what is trusted and what is not
- `DECISIONS.md` — what was built, cut, and why
- `evidence/` — all artifacts and the frozen manifest
- `engine/bin/nwc-transport.js` — genuine signed NIP-47/NIP-44 relay transport
