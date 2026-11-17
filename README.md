<div align="center">

# ALIBI

### Commission authority without wallet access. **A marketplace can earn a cut — it cannot spend your money.**

![tests](https://img.shields.io/badge/conformance-12%2F12-2FA46A)
![mutation](https://img.shields.io/badge/guards%20load--bearing-4%2F4-2FA46A)
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
node engine/bin/adversarial-test.js   # 12/12 — rate, payee, budget, replay guards
node engine/bin/mutation-test.js      # 4/4 — each guard proven load-bearing
node engine/bin/concurrency-test.js   # 5/5 — atomic budget under concurrent arrivals
```

Expected:
```
TEST RESULTS: 12 passed, 0 failed
VENDOR POLICY ENFORCEMENT: VERIFIED
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
| 5% cap: 20% and 5.01% rejected, 5% boundary accepted | **12/12** | `adversarial-results.json` · `node engine/bin/adversarial-test.js` |
| Payee + marketplace allowlist enforced | **12/12** | same run |
| Atomic budget, sequential reservations, exact fit | **12/12** | same run |
| Duplicate payment hash rejected | **12/12** | same run |
| Each guard is load-bearing (mutation test) | **4/4**, byte-identical restore | `mutation-results.json` · `node engine/bin/mutation-test.js` |
| Atomic budget under concurrent arrivals | **5/5** (single-process) | `concurrency-results.json` · `node engine/bin/concurrency-test.js` |
| HARBOR recovery/exit pipeline | **34 checks** | `runs/2026-11-17-offline/pipeline-stdout.txt` |
| Channel-backup auditor (mock LND) | **10 checks** | `runs/2026-11-17-offline/auditor-stdout.txt` |
| Cancellation invariants (SIM) | **FLOW COMPLETE**, 5 invariants | `runs/2026-11-17-offline/simulator-stdout.txt` |
| No keys/macaroons/seeds in 1,675 history blobs | **0 found** | `runs/2026-11-17-offline/credential-scan.txt` |
| **Live 18/18 node-backed settlement** | **NOT REPRODUCIBLE** | no `bundle.json`; see below |

All artifacts are SHA-256-pinned in [`evidence/manifest.json`](evidence/manifest.json) (regenerate:
`node engine/bin/evidence-manifest.js`). Machine-readable ledger:
[`evidence/claims.json`](evidence/claims.json).

> **The one claim we do not make right now.** There is no `evidence/bundle.json`, and the local
> regtest nodes are desynced (LND expects chain `ac3a47…`, bitcoind's only tip is `1d8ef2…`; channels
> inactive; Bob/Carol have no invoice history). The verifier itself is real and fails closed, but the
> 18/18 result is **not evidenced**. We will not print a number a command cannot regenerate. Restore
> procedure: [`REPRODUCE.md`](REPRODUCE.md) §7. Full disclosure:
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
| Policy invariant + mutation proof | **VERIFIED** |
| Recovery / audit machinery (offline) | **VERIFIED** |
| Cancellation invariants (SIM) | **VERIFIED** |
| Credential hygiene | **VERIFIED** |
| Live 18/18 settlement | **NOT REPRODUCIBLE** (no artifact) |
| SQLite durability | **IMPLEMENTED, NOT VERIFIED** (`better-sqlite3` unavailable) |
| Full NWC relay (NIP-44/47), mainnet | **NOT BUILT** |

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

- **No live-settlement artifact today** — 18/18 is not claimed; see above.
- **Regtest only** — no mainnet/testnet; non-redeemable test sats.
- **Single-process atomicity** — no multi-root reservation.
- **In-memory fallback** — no verified SQLite durability in this environment.
- **Shared-preimage collusion risk** — the marketplace may learn the preimage before buyer payment;
  PTLCs are future work; fallback is cancel-and-release.
- **Static UI** — the Transaction Room screens are illustrative, not a live checkout frontend.

---

## Submitter checklist

- [x] Usefulness: marketplace commissions for vendors (illustrative scenario)
- [x] Security: vendor-side policy enforcement, no broad wallet access (12/12 + 4/4)
- [ ] UI: static HTML only, not live
- [x] MVP: commission policy + recovery flow, proven at the deterministic layer
- [x] Technical: integer math, payment-hash linking, corrected LND REST encoding
- [x] Conformance: 12/12 adversarial + 4/4 mutation
- [x] Verification: node-backed verifier exists and fails closed (result not reproduced — disclosed)
- [x] Recovery: cancellation invariants + audit pipeline proven offline
- [x] Honesty: no number printed without a regenerable artifact

---

## Q&A

| Question | Answer |
|---|---|
| What is actually enforced? | The invariant: authority only narrows. Rate, payee, budget, and replay checks run at delegation time. 12/12 conformance + 4/4 mutation proof. |
| How do you know the tests aren't fake? | The mutation harness deletes each guard and requires the matching test to fail. Source restored byte-identical (SHA-256 recorded both times). |
| What about the 18/18 verifier? | It is real and fails closed, but there is no artifact and the local lab is desynced. We do not claim it until `bundle.json` is committed and regenerable. |
| What is mocked? | Auditor uses a mock LND; pipeline uses fixtures; simulator uses in-memory state. Each is labeled in `REAL_VS_MOCKED.md`. |
| What breaks in production? | Shared-preimage collusion; single-process atomicity; no verified durability; regtest only. All disclosed. |
| Is there a model in the payout path? | No. Deterministic BigInt math and allowlists. Any LLM output is documentation only, never a payment decision. |

---

*Experimental implementation of the NWC Commission Payments draft (nwc#8). Regtest only. Not mainnet. Not trustless.*
