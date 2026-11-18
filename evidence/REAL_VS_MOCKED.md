# Real vs Mocked — honesty table

> Rule: say the limit before the judge finds it. A status is never stronger than the artifact that proves it.

This table is the canonical source of truth for what Alibi actually demonstrates. `README.md` and
`Alibi_PRD.md` must agree with it. The machine-readable version is [`claims.json`](claims.json).

| Capability | Status | What is real | What is mocked / missing | Artifact |
|---|---|---|---|---|
| 5% commission cap, payee allowlist, budget, duplicate hash | **VERIFIED (production policy layer)** | Conformance suite imports the PRODUCTION `CommissionPolicy` from `commission-service.js`; BigInt math, atomic in-process reservation including routing fee, stable rejection codes | No duplicated policy class; no LND involved in this deterministic run | `adversarial-results.json` (14/14) |
| Guards are load-bearing | **VERIFIED (production source)** | Mutation harness disables each guard in a throwaway copy of the PRODUCTION `commission-service.js` and observes the correlated test fail; source restored byte-identical | No duplicated policy is mutated | `mutation-results.json` (4/4) |
| NWC request-path authority | **VERIFIED (authority boundary)** | Unapproved callers blocked on both paths; authenticated pubkey threaded into the handler and never read from params; `pay_invoice` blocked; NIP-47 unsigned envelope returns `TRANSPORT_NOT_VERIFIED` | Full BIP-340 signed-event and NIP-44 decryption NOT implemented — the path fails closed instead of faking auth | `authority-results.json` (7/7) |
| Atomic budget under concurrency | **VERIFIED (single-process)** | 8 interleaved async arrivals against a 9-unit budget; exactly 3 approvals, committed=9, no double reserve | Node is single-threaded; NOT distributed/multi-root | `concurrency-results.json` (5/5) |
| HARBOR exit/recovery pipeline | **VERIFIED (offline)** | 34 deterministic checks, hash-chain integrity, force-close gating | Fixtures + temp dir; no live node | `runs/.../pipeline-stdout.txt` |
| Channel-backup auditor | **VERIFIED (offline)** | 10 checks, real SHA-256 staleness logic | In-process mock LND REST server | `runs/.../auditor-stdout.txt` |
| Cancellation / recovery invariants | **VERIFIED (SIM)** | Full state machine, 5 invariants, budget release | In-memory state; no real sats move | `runs/.../simulator-stdout.txt` |
| No credentials in git history | **VERIFIED** | 1,664 reachable historical blobs scanned, zero PEM keys / macaroons / seeds | `bitcoin:bitcoin` is a public regtest dev default; untracked local files not scanned | `runs/.../credential-scan.txt` |
| Central production transaction (hold → pay → verify → settle) | **VERIFIED (live regtest, production service)** | The real `CommissionService` is driven end-to-end: buyer HTLC ACCEPTED, premature settlement REFUSED, outgoing commission payment verified `SUCCEEDED` on the vendor node with in-policy fee, then the sale is released; all three nodes checked for final state | SQLite unavailable → in-memory fallback; durable restart recovery not proven by this artifact | `production-flow.json` (14/14 stages) — `claims.json` C13 |
| Full live settlement verified on LND (18/18) | **VERIFIED (live regtest)** | Three real LND nodes on regtest; same-hash hold invoices on Alice (sale, 100,000 sats) and Bob (commission, 5,000 sats); Carol paid the sale, Alice paid the commission, both settled with the shared preimage; verifier queried node state with read-only macaroons | Controlled regtest cycle — node-state verification, not Bitcoin consensus or trustless attestation; preimage checked in memory and redacted; read-only credentials only | `bundle.json` (18/18, exit 0) — `claims.json` C10 |
| Durable budget ledger (SQLite) | **IMPLEMENTED, NOT VERIFIED** | Schema, forward migrations and atomic reservation code exist in `commission-service.js` | `better-sqlite3` unavailable in build environment; in-memory fallback loses state on restart | code inspection only |
| Full NWC relay (NIP-44/NIP-47) | **NOT BUILT** | Method allowlist/blocklist HTTP server and fail-closed authority boundary exist | No encryption, no signed Nostr events, no relay transport | n/a — future work |
| Mainnet / testnet deployment | **NOT BUILT** | Regtest lab only | No public deployment | n/a — future work |

## What this means in one paragraph

The **policy invariant is proven and mutation-verified in the production code**, the NWC authority
boundary is tested and fails closed, the surrounding recovery/audit machinery passes all offline
suites, and the **central commission transaction has been driven through the real production service
on three live LND nodes**: the buyer's held payment is released only after the outgoing commission
payment is independently verified on node state (`production-flow.json` 14/14, `bundle.json` 18/18,
exit 0). The verifier queries node state directly with read-only credentials, checks the preimage
SHA-256 in memory, and writes no preimage or key material. Scope limits: controlled regtest cycle,
node-state verification (not a Bitcoin consensus proof or trustless attestation), no durable SQLite
verification, and no signed NIP-44 relay transport.
