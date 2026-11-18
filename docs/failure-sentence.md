# ALIBI — Failure Sentence

## One-sentence rule (from Hackathon Craft)

> The silent failure this sponsor/domain cares about is **a marketplace connection silently widening its commission authority beyond what the vendor approved**. My system makes this **preventable** by **vendor-wallet-side policy enforcement at delegation time**, and proves it with **adversarial test results plus an independent node-backed verifier**.

## Failure sentence (template)

```
When a marketplace requests a commission-bound sale, the system can silently
widen the commission beyond policy (higher %, unauthorized payee, budget
overdraw) because delegation checks only the connection's identity and not
the vendor's remaining headroom. The cost is vendor funds being siphoned
without a mechanism that enforces limits at request time. Today, marketplaces
trust vendors to pay commissions later (unreliable) or grant broad wallet
access (unsafe). We enforce "commission authority can only narrow, never
widen" with BigInt policy checks, atomic budget reservation, and duplicate-hash
prevention at delegation time, and prove it with 14/14 adversarial tests plus
an independent verifier that queries actual LND node state.
```

## Invariant (one sentence, testable)

> **Authority can only narrow, never widen.** A commission connection's effective
> authority at any moment is a subset of its initial grant; reserved budget cannot
> be double-spent; payment hashes cannot be replayed with different parameters.

## Closed loop (6 steps)

1. **Setup:** Vendor grants a commission-only NWC connection to a marketplace
   (allowed payee, max rate, budget).
2. **Normal use:** Marketplace requests a 5% commission-bound sale; vendor
   policy accepts; vendor returns a real hold sale invoice.
3. **The break:** Marketplace requests 20% commission, unauthorized payee,
   budget overdraw, or duplicate hash.
4. **The catch:** CommissionPolicy blocks each with a reason code;
   adversarial tests assert 14/14 blocks.
5. **The repair/verify:** Marketplace cancels its commission hold invoice;
   vendor releases the buyer's held sale only after outgoing payment resolves
   as failed; budget reservation returns.
6. **The proof:** Independent verifier queries Alice/Bob/Carol LND nodes;
   sale settled, commission settled, SHA256(preimage)==payment hash,
   amounts reconcile (100,000 == 5,000 + 95,000).

## Deterministic mechanism

| Rule | Implementation | Test |
|------|---------------|------|
| max_rate_ppm | BigInt comparison, no floats | adversarial-test.js |
| payee allowlist | allowedPubkey == marketplacePubkey | adversarial-test.js |
| budget reservation | SQLite atomic transaction + in-memory reservations | adversarial-test.js (sequential) |
| duplicate hash | Unique constraint on payment_hash | adversarial-test.js |
| routing fee cap | base_msat + floor(commission * rate_ppm / 1e6) | commission-service.js |

## Evidence plan

| Artifact | Location | Type |
|----------|----------|------|
| Adversarial results | evidence/adversarial-results.json | Machine-readable + SHA-256 |
| Verifier output | evidence/bundle.json (when LND live) | Independent node-backed |
| Demo script | docs/demo-script.md | 6 scenes, timestamps |
| Scorecard | docs/scorecard-drey.md | Drey 20-point honest score |

## Claim discipline

| Category | Meaning | Status |
|----------|---------|--------|
| Enforced | Guaranteed by mechanism | Policy engine, BigInt math, budget reservation |
| Demonstrated | Shown in demo | Simulator (SIM mode), console output |
| Measured | Reported with sample size | 14/14 adversarial tests |
| Future work | Not built | Live LND transaction, SQLite durability |
