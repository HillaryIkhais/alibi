# Real vs Mocked — honesty table

> Rule: say the limit before the judge finds it. A status is never stronger than the artifact that proves it.

This table is the canonical source of truth for what Alibi actually demonstrates. `README.md` and
`Alibi_PRD.md` must agree with it. The machine-readable version is [`claims.json`](claims.json).

| Capability | Status | What is real | What is mocked / missing | Artifact |
|---|---|---|---|---|
| 5% commission cap, payee allowlist, budget, duplicate hash | **VERIFIED (policy layer)** | BigInt policy engine, atomic in-process reservation, stable rejection codes, deterministic assertions | Conformance suite defines its own copy of the policy logic (documented as matching the service); no LND involved | `adversarial-results.json` (12/12) |
| Guards are load-bearing | **VERIFIED** | Mutation harness disables each guard and observes the correlated test fail; source restored byte-identical | Mutates the conformance copy, not the production service | `mutation-results.json` (4/4) |
| Atomic budget under concurrency | **VERIFIED (single-process)** | 8 interleaved async arrivals against a 9-unit budget; exactly 3 approvals, committed=9, no double reserve | Node is single-threaded; NOT distributed/multi-root | `concurrency-results.json` (5/5) |
| HARBOR exit/recovery pipeline | **VERIFIED (offline)** | 34 deterministic checks, hash-chain integrity, force-close gating | Fixtures + temp dir; no live node | `runs/.../pipeline-stdout.txt` |
| Channel-backup auditor | **VERIFIED (offline)** | 10 checks, real SHA-256 staleness logic | In-process mock LND REST server | `runs/.../auditor-stdout.txt` |
| Cancellation / recovery invariants | **VERIFIED (SIM)** | Full state machine, 5 invariants, budget release | In-memory state; no real sats move | `runs/.../simulator-stdout.txt` |
| No credentials in git history | **VERIFIED** | 1,675 historical blobs scanned, zero PEM keys / macaroons / seeds | `bitcoin:bitcoin` is a public regtest dev default | `runs/.../credential-scan.txt` |
| Full live settlement verified on LND (18/18) | **NOT REPRODUCIBLE** | `verifier.js` is real, node-backed, and fails closed; three-node lab exists | **No bundle.json artifact.** Regtest nodes are stuck desynced (LND expects chain `ac3a47...`, bitcoind only has `1d8ef2...`); channels inactive; Bob/Carol lost history | none — see `claims.json` C10 |
| Durable budget ledger (SQLite) | **IMPLEMENTED, NOT VERIFIED** | Schema and atomic reservation code exist in `commission-service.js` | `better-sqlite3` unavailable in build environment; in-memory fallback loses state on restart | code inspection only |
| Full NWC relay (NIP-44/NIP-47) | **NOT BUILT** | Method allowlist/blocklist HTTP server exists | No encryption, no signed Nostr events, no relay transport | n/a — future work |
| Mainnet / testnet deployment | **NOT BUILT** | Regtest lab only | No public deployment | n/a — future work |

## What this means in one paragraph

The **policy invariant is proven and mutation-verified** at the deterministic layer, and the
surrounding recovery/audit machinery passes all offline suites. The **one headline claim that is not
currently provable is the live 18/18 node-backed settlement**, because no verifier bundle was ever
committed and the local regtest lab has drifted into a desynced state that cannot produce one
without a full rebuild. Until that bundle exists and is regenerable, the README describes that check
as **NOT REPRODUCIBLE**, not as passing.
