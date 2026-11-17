# Launch thread — Alibi (10 posts)

> Post only after the build is frozen. Attach the money shot (the adversarial run output and the
> mutation `FAIL` lines) to post 4/6. Pin the thread; put its link in README and submission. Never
> claim a number the repo cannot regenerate. Fill event handle/team in post 10 from the real event.

---

**1/ Hook**
A marketplace asked to collect a 5% commission and got a request for 20% — because the vendor had handed it wallet-level spending authority. There is no wallet-side primitive that says "you may collect exactly this fee, from this payee, within this budget." Alibi is that primitive.

**2/ The build**
Alibi lets a vendor grant a Lightning marketplace one narrow, revocable permission — request a commission-bound sale — while the vendor's wallet enforces rate, payee, budget, and replay policy. The marketplace never receives `pay_invoice` or any settlement method.

**3/ The flow**
Configure the policy → marketplace calls `make_commission_invoice` → wallet validates and reserves → buyer pays one invoice → commission settles to the approved payee → vendor keeps the remainder → cancel releases the reservation.

**4/ The verified run**
Real terminal output: `node engine/bin/adversarial-test.js` → `TEST RESULTS: 12 passed, 0 failed`. `node engine/bin/mutation-test.js` → `4/4 guards confirmed load-bearing`, source restored byte-identical. `node engine/bin/concurrency-test.js` → `5/5`, eight interleaved arrivals, budget for three, exactly three approved. Every artifact is SHA-256-pinned in `evidence/manifest.json`.

**5/ The mechanism**
The hard part is that authority must only narrow. Budget is reserved atomically before any hold invoice exists — check and commit with no await between — so a burst of requests cannot jointly exceed the cap. It's BigInt msat math and a single conditional update, not a heuristic.

**6/ The attack**
A hostile marketplace sends 20% against a 5% cap → `EXCEEDS_MAX_PERCENT`. Unapproved payee → `UNAUTHORIZED_PAYEE`. Replayed hash → `DUPLICATE_HASH`. Then we delete each guard in turn and confirm the matching test FAILS — proof the guards are not decorative.

**7/ The sponsor layer**
The load-bearing primitive is the NWC Commission Payments draft's `make_commission_invoice` method (`nwc#8`), implemented in `engine/bin/commission-service.js` and restricted in `engine/bin/nwc-server.js`. Remove it and there is no product — this is structural dependence, not a logo.

**8/ The honesty limit**
Here's why you can believe the rest: the live 18/18 node-backed verifier result is NOT currently reproduced — no `evidence/bundle.json`, and the local regtest lab is desynced. We do not claim it. The deterministic policy layer is proven (12/12 + 4/4 + 5/5); the live settlement artifact is a documented gap with a restore procedure. Regtest only, no mainnet, single-process atomicity, static UI.

**9/ The links**
Repo: github.com/HillaryIkhais/alibi · Verify in 60s: the three commands in post 4 · Judge path: `JUDGES.md` · Mechanism: `THREAT_MODEL.md` · Honesty: `evidence/REAL_VS_MOCKED.md`.

**10/ Credit**
Built for [EVENT — FILL FROM OFFICIAL PAGE]. Thanks to the NWC draft authors and the LND engineers whose REST API docs made the byte-encoding fixes possible. [Team names + roles — FILL BEFORE POSTING.]
