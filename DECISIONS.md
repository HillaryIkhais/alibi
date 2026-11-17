# Decisions — what was built, cut, and why

## D1 — One invariant, enforced wallet-side
**Decision:** The marketplace gets narrow commission authority; the vendor wallet enforces it.
**Why:** Custodial platforms and broad NWC scopes both require trusting the platform. A wallet-side
policy engine removes that trust. This is the wedge the whole submission rests on.

## D2 — Integer money math (BigInt), never floats
**Decision:** Commission math uses BigInt msat; `floor(sale * ppm / 1e6)`.
**Why:** Floating point in a payout path can round a 5% commission into 5.00001% or mis-handle msat.
The 5% boundary test and the 5.01% rejection test exist specifically to prove the boundary.

## D3 — Atomic reservation before invoice creation
**Decision:** Reserve `commission + routing fee` against remaining budget *before* creating the sale
hold invoice; refuse duplicates by payment hash.
**Why:** A check-then-create race could over-commit budget. The conformance suite includes a
sequential-reservation check and the mutation harness proves the budget guard is load-bearing.

## D4 — Self-contained conformance suite + mutation proof
**Decision:** `adversarial-test.js` defines its own policy copy; `mutation-test.js` proves each guard
is load-bearing and records byte-identical restoration.
**Why:** A suite that imports the exact production function could pass even if that function's guard
were dead. The mutation harness is the defence against "green tests that cannot fail." Honest limit:
the two policy copies are documented as matching, not mechanically identical.

## D5 — Verifier reads node state, not app state
**Decision:** `verifier.js` uses read-only macaroons, queries all three LND nodes, hashes the preimage
in memory, redacts it, and fails closed without credentials.
**Why:** A verifier that read Alibi's own database would be circular. Node-backed state is the only
independent source of truth for settlement.

## D6 — Do not claim 18/18 without a bundle (the hard call)
**Decision:** Downgrade the live 18/18 verifier claim to **NOT REPRODUCIBLE** across README, PRD, and
docs. No `evidence/bundle.json` exists, and the local regtest lab is desynced (LND expects chain
`ac3a47...`, bitcoind only has `1d8ef2...`; channels inactive; Bob/Carol lost history).
**Why:** The proof doctrine is that no number appears without a regenerable artifact. Claiming 18/18
without one would be the single lie that destroys every true claim. Better to ship a proven policy
layer plus an honest gap. Restore procedure is documented in `REPRODUCE.md` §7.

## D7 — Fix the reconcile/payCommission shadow bug
**Decision:** Renamed the second `payCommission(paymentRequest)` (which referenced undefined
`paymentHash`) to `reconcile({ paymentHash })`.
**Why:** The duplicate definition shadowed the working payment method and broke three CLI commands
(`look-up-invoice`, `reconcile`, cancel). Syntax and grep now confirm one `payCommission` and one
`reconcile`.

## D8 — Commit evidence, block credentials
**Decision:** Removed `evidence/` from `.gitignore`; kept `*.macaroon`, `*.seed`, `*.key`, `*.cert`,
`data/*.pass`, `*.log` blocked.
**Why:** Proof artifacts must be visible to judges; credentials must never be. History scan confirms
zero PEM keys, macaroons, or seeds across 1,675 blobs.

## D9 — Correct stale numbers
**Decision:** Reconcile the "buyer pays 105,000 sats" line in `harbor/README.md` and the "8/8" line in
`docs/scorecard.md` with the authoritative 100,000 sats and 12/12.
**Why:** Three surfaces disagreeing on the headline numbers is exactly what a judge uses to doubt
everything else. One record, three surfaces.

## D10 — Scope cuts (explicit non-goals)
Full NWC relay (NIP-44/NIP-47), SQLite durability in the build environment, multi-hop fee
optimization, multi-root reservation, and mainnet deployment are all deliberately out of scope. They
are listed as future work, never as demonstrated.
