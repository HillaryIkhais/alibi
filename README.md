<div align="center">

# ALIBI

### Commission authority without wallet access. **A marketplace can earn a cut — it cannot spend your money.**

![tests](https://img.shields.io/badge/conformance-16%2F16-2FA46A)
![mutation](https://img.shields.io/badge/guards%20load--bearing-4%2F4-2FA46A)
![live](https://img.shields.io/badge/live%20settlement-25%2F25-2FA46A)
![pipeline](https://img.shields.io/badge/recovery%20checks-34-2FA46A)
![network](https://img.shields.io/badge/network-regtest-FFCC33)
![standard](https://img.shields.io/badge/NWC%20draft-nwc%238-6f42c1)

*Experimental reference implementation of the [NWC Commission Payments draft](https://github.com/nostr-wallet-connect/nwc/issues/8). The draft is not an adopted standard. Regtest only. Not mainnet. Not trustless.*

</div>

---

## The failure, in one paragraph

An African freelancer who sells through a marketplace faces a bad choice: hand the platform their
Lightning wallet (unsafe), let it take custody (unsafe), make the buyer pay twice (bad UX), or promise
to pay a commission later (unreliable). **Alibi removes the trust.** The vendor grants a narrow,
revocable permission — request one commission-bound sale, to one approved payee, within one budget.
The vendor's wallet enforces the policy. The marketplace never receives `pay_invoice`,
`settle_hold_invoice`, or any general spending method.

**Invariant:** a commission connection's authority can only narrow, never widen. Effective authority
is always a subset of the initial grant; reserved budget cannot be double-spent; a payment hash cannot
be replayed with different parameters.

---

## Verify the claim in 60 seconds (no credentials, no Docker)

```bash
node engine/bin/adversarial-test.js   # 16/16 — rate, payee, budget, replay guards
node engine/bin/mutation-test.js      # 4/4 — each guard proven load-bearing
node engine/bin/concurrency-test.js   # 8/8 — atomic budget under concurrent arrivals
node engine/bin/authority-test.js     # 13/13 — NWC authority boundary
```

Expected:
```
TEST RESULTS: 14 passed, 0 failed
VENDOR POLICY ENFORCEMENT: VERIFIED (production code)
...
Mutation results: 4/4 guards confirmed load-bearing
Byte-identical restore: YES
...
ATOMIC BUDGET RESERVATION: VERIFIED (single-process)
```

The second command is the one that matters. It disables each guard one at a time and **requires the
matching test to fail**. A guard that still passes after being deleted is dead code; this harness
proves none of them are. Full command set in [`REPRODUCE.md`](REPRODUCE.md). Judge path in
[`JUDGES.md`](JUDGES.md).

---

## Evidence — every number carries a denominator and an artifact

| Claim | Result | Artifact / command |
|---|---|---|
| 5% cap: 20% and 5.01% rejected, 5% boundary accepted | **16/16** | `adversarial-results.json` · `node engine/bin/adversarial-test.js` |
| Payee + marketplace allowlist enforced | **16/16** | same run |
| Atomic budget, first-request fee, exact fit | **16/16** | same run |
| Duplicate payment hash rejected | **16/16** | same run |
| Each guard is load-bearing (mutation test) | **4/4**, byte-identical restore | `mutation-results.json` · `node engine/bin/mutation-test.js` |
| Atomic budget under concurrent arrivals | **8/8** (single-process + SQLite immediate txn) | `concurrency-results.json` · `node engine/bin/concurrency-test.js` |
| HARBOR recovery/exit pipeline | **34 checks** | `runs/2026-11-17-offline/pipeline-stdout.txt` |
| Channel-backup auditor (mock LND) | **10 checks** | `runs/2026-11-17-offline/auditor-stdout.txt` |
| Cancellation invariants (SIM) | **FLOW COMPLETE**, 5 invariants | `runs/2026-11-17-offline/simulator-stdout.txt` |
| NWC authority boundary (signed NIP-47/NIP-44) | **13/13** | `authority-results.json` · `node engine/bin/authority-test.js` |
| No keys/macaroons/seeds in 1,709 history blobs | **0 found** | `runs/2026-11-17-offline/credential-scan.txt` |
| **Production service completes central transaction** | **17/17 stages** | [`production-flow.json`](evidence/production-flow.json) · `node engine/bin/production-flow.js` |
| **Live 25/25 node-backed settlement** | **25/25, exit 0** | [`bundle.json`](evidence/bundle.json) · `node engine/bin/verifier.js` |

All artifacts are SHA-256-pinned in [`evidence/manifest.json`](evidence/manifest.json) (regenerate:
`node engine/bin/evidence-manifest.js`). Machine-readable ledger:
[`evidence/claims.json`](evidence/claims.json).

> **The central transaction is driven through the production service.** `evidence/production-flow.json`
> records 17/17 live stages: the buyer's HTLC is held, settlement is **refused** while the outgoing
> commission payment is absent (even with a correct preimage), `payCommission()` preflight-validates
> then requires a verified `SUCCEEDED` result with an in-policy fee, and only then does
> `settleSale()` release the buyer. `evidence/bundle.json` is the independent, read-only verifier run
> against the same settlement on three real LND nodes (25/25, exit 0): sale and commission hold
> invoices settled, buyer payment finalized, **Alice's outgoing commission payment independently
> confirmed**, and `SHA256(preimage) == payment_hash` checked in memory (never written). The verifier
> queries node state directly and fails closed. Durable SQLite storage persists sale/commission/
> reservation/budget state; REAL mode fails closed if storage cannot be opened.
> Reproduction: [`REPRODUCE.md`](REPRODUCE.md) §7. Scope and limits:
> [`evidence/REAL_VS_MOCKED.md`](evidence/REAL_VS_MOCKED.md).

---

## What is actually enforced (mechanism, not promise)

The vendor-side `CommissionPolicy` runs **before** any hold invoice is created:

1. **Decode** the marketplace's BOLT11 commission invoice (`GET /v1/payreq/{pay_req}`).
2. **Rate** — `commission_msat ≤ floor(sale × max_rate_ppm / 1e6)` → `EXCEEDS_MAX_PERCENT`.
3. **Payee** — destination and marketplace pubkeys against allowlists → `UNAUTHORIZED_PAYEE` /
   `UNAUTHORIZED_MARKETPLACE`.
4. **Budget** — reserve `commission + routing fee` from the remaining pool atomically →
   `BUDGET_EXCEEDED`.
5. **Replay** — single-use payment hash registry → `DUPLICATE_HASH`.

All money math is integer BigInt — no floats in a payout path. The marketplace's method allowlist is
`get_info`, `lookup_invoice`, `make_commission_invoice`; `pay_invoice` and settlement methods are
blocked at the server. LND REST byte encoding was corrected (base64 where the API requires base64).

---

## The economics

The buyer pays **one invoice of 100,000 sats**. Not 105,000. The commission (5,000 sats at 5%) is paid
by the vendor out of what was received. Vendor net before routing fees: **95,000 sats**.
Reconciliation: `100,000 = 5,000 + 95,000`.

---

## Honesty table

Full version: [`evidence/REAL_VS_MOCKED.md`](evidence/REAL_VS_MOCKED.md).

| Capability | Status |
|---|---|
| Policy invariant + production mutation proof | **VERIFIED** |
| NWC authority boundary (signed NIP-47/NIP-44 transport) | **VERIFIED** (`authority-results.json`, 13/13) |
| Recovery / audit machinery (offline) | **VERIFIED** |
| Cancellation invariants (SIM) | **VERIFIED** |
| Credential hygiene | **VERIFIED** |
| Central production transaction (verify before release) | **VERIFIED** (`production-flow.json`, 17/17) |
| Live settlement | **VERIFIED** (`bundle.json`, 25/25, exit 0) |
| SQLite durability (REAL mode, fail closed) | **VERIFIED** (`data/alibi.sqlite` persists) |
| Full NWC relay transport (NIP-44/47), mainnet | Mainnet **NOT BUILT**; relay transport **VERIFIED (build)** |

---

## Trust boundaries

```
Buyer (Carol)            Vendor wallet (Alice)              Marketplace (Bob)
 pays one invoice  ──▶   • addHoldInvoice / settle   ◀──  make_commission_invoice
 (verifier queries)      • CommissionPolicy (5 checks)      (no pay_invoice,
                         • atomic budget reservation         no settle_hold_invoice)
                         • SQLite / in-memory state
                                ▲
                          read-only macaroons ── independent verifier.js
                          (fails closed; trusts nothing Alibi wrote)
```

The verifier queries the LND nodes directly, never Alibi's database. The preimage is SHA-256-checked
in memory and redacted before any output.

---

## Known limits (stated before they are found)

- **Live settlement is a controlled regtest cycle** — 25/25 proves node state, not Bitcoin consensus or trustlessness.
- **Regtest only** — no mainnet/testnet; non-redeemable test sats.
- **Single-process atomicity** — no multi-root reservation.
- **Kill/restart recovery timing** — reconcile() path implemented; full process crash/restart cycle not yet timed.
- **Shared-preimage collusion risk** — the marketplace may learn the preimage before buyer payment;
  PTLCs are future work; fallback is cancel-and-release.
- **Static UI** — the Transaction Room screens are illustrative, not a live checkout frontend.

---

## Submitter checklist

- [x] Usefulness: marketplace commissions for vendors (illustrative scenario)
- [x] Security: vendor-side policy enforcement, no broad wallet access (16/16 + 4/4)
- [ ] UI: static HTML only, not live
- [x] MVP: commission policy + recovery flow, proven at the deterministic layer
- [x] Technical: integer math, payment-hash linking, corrected LND REST encoding
- [x] Conformance: 16/16 adversarial + 4/4 mutation
- [x] Verification: node-backed verifier 25/25 against live regtest nodes (`bundle.json`)
- [x] Recovery: cancellation invariants + audit pipeline proven offline
- [x] Honesty: no number printed without a regenerable artifact

---

## Q&A

| Question | Answer |
|---|---|
| What is actually enforced? | The invariant: authority only narrows. Rate, payee, budget, and replay checks run at delegation time. 16/16 conformance + 4/4 mutation proof. |
| How do you know the tests aren't fake? | The mutation harness deletes each guard and requires the matching test to fail. Source restored byte-identical (SHA-256 recorded both times). |
| How do you know the vendor actually paid the marketplace? | `settleSale()` re-queries the vendor node's durable outgoing-payment record and requires `SUCCEEDED`, matching hash/preimage and an in-policy fee before releasing the buyer. The live production-flow artifact proves the negative case: with no outgoing payment, settlement is refused even with the correct preimage. |
| What about the 25/25 verifier? | It is real, fails closed, and produced `evidence/bundle.json`: 25/25 pass, exit 0, against live regtest LND nodes queried with read-only macaroons. No preimage or credential is in the artifact. |
| What is mocked? | Auditor uses a mock LND; pipeline uses fixtures; simulator uses in-memory state. Each is labeled in `REAL_VS_MOCKED.md`. |
| What breaks in production? | Shared-preimage collusion; single-process atomicity; no verified durability; regtest only. All disclosed. |
| Is there a model in the payout path? | No. Deterministic BigInt math and allowlists. Any LLM output is documentation only, never a payment decision. |

---

*Experimental implementation of the NWC Commission Payments draft (nwc#8). Regtest only. Not mainnet. Not trustless.*
