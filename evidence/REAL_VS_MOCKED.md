# Real vs Mocked — honesty table

> Rule: say the limit before the judge finds it. A status is never stronger than the artifact that proves it.

This table is the canonical source of truth for what Alibi actually demonstrates. `README.md` and
`Alibi_PRD.md` must agree with it. The machine-readable version is [`claims.json`](claims.json).

| Capability | Status | What is real | What is mocked / missing | Artifact |
|---|---|---|---|---|
| 5% commission cap, payee allowlist, budget (incl. first-request fee), duplicate hash | **VERIFIED (production policy layer)** | Conformance suite imports the PRODUCTION `CommissionPolicy` from `commission-service.js`; BigInt math, fee-aware atomic reservation, stable rejection codes, mandatory first-request fee-allowance regression test | No duplicated policy class; no LND involved in this deterministic run | `adversarial-results.json` (16/16) |
| Guards are load-bearing | **VERIFIED (production source)** | Mutation harness disables each guard in a throwaway copy of the PRODUCTION `commission-service.js` and observes the correlated test fail; source restored byte-identical | No duplicated policy is mutated | `mutation-results.json` (4/4) |
| NWC request-path authority | **VERIFIED (authority boundary)** | Genuine NIP-47 transport: kind:23194 signed requests verified with BIP-340/Schnorr, NIP-44 v2 decryption, p-tag to wallet, timestamp tolerance, request-event dedup, method allowlist, connection approve/revoke; caller-supplied pubkey never trusted | Public relay used for live demo; no NWC connection-lifetime UI beyond seller revocation | `authority-results.json` (13/13) |
| Atomic budget under concurrency | **VERIFIED (production implementation)** | Production `reserve()` under 8 interleaved async arrivals; exactly 3 approvals, no over-commit; SQLite immediate transaction for cross-process serialization | Single-process Node is primary proof; multi-root/distributed atomicity not claimed | `concurrency-results.json` (8/8) |
| HARBOR exit/recovery pipeline | **VERIFIED (offline)** | 34 deterministic checks, hash-chain integrity, force-close gating | Fixtures + temp dir; no live node | `runs/.../pipeline-stdout.txt` |
| Channel-backup auditor | **VERIFIED (offline)** | 10 checks, real SHA-256 staleness logic | In-process mock LND REST server | `runs/.../auditor-stdout.txt` |
| Cancellation / recovery invariants | **VERIFIED (SIM)** | Full state machine, 5 invariants, budget release | In-memory state; no real sats move | `runs/.../simulator-stdout.txt` |
| No credentials in git history | **VERIFIED** | 1,709 reachable historical blobs scanned, zero PEM keys / macaroons / seeds | `bitcoin:bitcoin` is a public regtest dev default; untracked local files not scanned | `runs/.../credential-scan.txt` |
| Central production transaction (hold → pay → verify → settle) | **VERIFIED (live regtest, production service, durable SQLite)** | The real `CommissionService` driven end-to-end: buyer HTLC ACCEPTED, premature settlement REFUSED, outgoing commission payment verified `SUCCEEDED` on the vendor node with in-policy fee, sale released only after verification, idempotent re-settle, all three nodes final state checked | Kill/restart recovery timing not exercised (reconcile() path exists); live regtest only | `production-flow.json` (17/17 stages) — `claims.json` C13 |
| Full live settlement verified on LND (25/25) | **VERIFIED (live regtest)** | Three real LND nodes on regtest; same-hash hold invoices on Alice (sale, 100,000 sats) and Bob (commission, 5,000 sats); Carol paid the sale, Alice paid the commission, both settled with shared preimage; **Alice's outgoing commission payment independently verified** (SUCCEEDED, exact hash/amount/preimage/fee); seller net reconciled | Controlled regtest cycle — node-state verification, not Bitcoin consensus or trustless attestation; preimage checked in memory and redacted; read-only credentials only | `bundle.json` (25/25, exit 0) — `claims.json` C10 |
| Durable budget ledger (SQLite) | **VERIFIED (REAL mode)** | SQLite (better-sqlite3, WAL) with forward migrations; sale/commission/payment/reservation/audit persisted; budget debited exactly once (commission + actual fee); REAL mode fails closed if storage unavailable | Kill/restart recovery timing not yet exercised (reconcile() path implemented) | `production-flow.json` + `data/alibi.sqlite` — `claims.json` C14 |
| Full NWC relay transport (NIP-44/NIP-47) | **VERIFIED (build)** | nostr-tools based transport: kind:13194 wallet info, kind:23194 signed requests, kind:23195 encrypted responses, BIP-340 verification, NIP-44 v2, relay publish/subscribe | Live demo uses a public relay; no connection-lifetime UI beyond seller revocation | `engine/bin/nwc-transport.js`, `authority-results.json` (13/13) |
| Mainnet / testnet deployment | **NOT BUILT** | Regtest lab only | No public deployment | n/a — future work |

## What this means in one paragraph

The **policy invariant is proven and mutation-verified in the production code**, the NWC authority
boundary is tested and fails closed with a genuine signed NIP-47/NIP-44 transport, the surrounding
recovery/audit machinery passes all offline suites, durable SQLite storage is used in REAL mode
(fail closed if unavailable), and the **central commission transaction has been driven through the
real production service on three live LND nodes**: the buyer's held payment is released only after
the outgoing commission payment is independently verified on node state (`production-flow.json`
17/17, `bundle.json` 25/25 including Alice's outgoing payment, exit 0). The verifier queries node
state directly with read-only credentials, checks the preimage SHA-256 in memory, and writes no
preimage or key material. Scope limits: controlled regtest cycle, node-state verification (not a
Bitcoin consensus proof or trustless attestation), no kill/restart recovery timing exercise yet, no
mainnet deployment.
