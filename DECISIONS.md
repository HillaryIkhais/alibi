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

## D4 — Production policy under test + mutation proof
**Decision:** `adversarial-test.js` imports the PRODUCTION `CommissionPolicy` from
`commission-service.js` — there is no local copy. `mutation-test.js` disables guards in a throwaway
copy of that same production file and records byte-identical restoration of the working tree source.
**Why:** A self-defined policy copy can pass its own suite while the shipped service stays broken
(this happened: the production LND adapter had wrong field names while a duplicated policy was green).
Importing production removes the drift; mutation is still the defence against guards that cannot fail.

## D5 — Verifier reads node state, not app state
**Decision:** `verifier.js` uses read-only macaroons, queries all three LND nodes, hashes the preimage
in memory, redacts it, and fails closed without credentials.
**Why:** A verifier that read Alibi's own database would be circular. Node-backed state is the only
independent source of truth for settlement.

## D6 — Do not claim 18/18 without a bundle (the hard call) — CLOSED
**Decision:** The live 18/18 verifier claim was downgraded to **NOT REPRODUCIBLE** while no
`evidence/bundle.json` existed and the regtest lab was desynced. That gap is now closed: the lab was
rebuilt from clean volumes, a full same-hash settlement cycle was executed, and `bundle.json` was
regenerated at 18/18, exit 0. All claims were restored to VERIFIED.
**Why:** The proof doctrine is that no number appears without a regenerable artifact. Claiming 18/18
without one would be the single lie that destroys every true claim — so the downgrade was correct at
the time, and the restoration is equally evidence-driven. Restore procedure: `REPRODUCE.md` §7.

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
zero PEM keys, macaroons, or seeds across 1,664 reachable blobs.

## D9 — Correct stale numbers
**Decision:** Reconcile the "buyer pays 105,000 sats" line in `harbor/README.md` and the "8/8" line in
`docs/scorecard.md` with the authoritative 100,000 sats and 14/14.
**Why:** Three surfaces disagreeing on the headline numbers is exactly what a judge uses to doubt
everything else. One record, three surfaces.

## D10 — Scope cuts (explicit non-goals)
Full NWC relay (NIP-44/NIP-47), SQLite durability in the build environment, multi-hop fee
optimization, multi-root reservation, and mainnet deployment are all deliberately out of scope. They
are listed as future work, never as demonstrated.

## D11 — Verify the outgoing payment before releasing the buyer's HTLC
**Decision:** `settleSale()` queries the vendor node's durable outgoing-payment record
(`ListPayments`; `TrackPaymentV2` only serves in-flight payments) and requires `SUCCEEDED`, matching
hash/preimage and an in-policy actual fee before calling `SettleInvoice`. The production flow
harness proves the negative case: with no outgoing payment, settlement is refused even though the
correct preimage is held.
**Why:** The preimage alone does not prove the vendor paid the marketplace. Possession of the
preimage is expected from the shared-hash protocol; releasing the buyer first would let the vendor
keep the commission. The node is the only independent source of truth for the outgoing leg.

## D12 — Two identities, and fail closed on unverified transport
**Decision:** `HARBOR_MARKETPLACE_PUBKEY` (who may call) and `HARBOR_COMMISSION_PAYEE_PUBKEY` (where
the Lightning invoice pays) are separate policy fields. `handleNip47()` refuses unsigned/unencrypted
envelopes with `TRANSPORT_NOT_VERIFIED` instead of accepting a claimed pubkey from request JSON.
**Why:** Treating one pubkey as both caller and destination lets an attacker authorize their own
payee. With no Nostr/secp dependency in the build, faking event verification would be a lie; failing
closed is honest and keeps the authority boundary testable (`authority-results.json`, 7/7).
