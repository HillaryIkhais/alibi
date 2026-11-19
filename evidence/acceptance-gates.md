# Acceptance gates — binary definition of done

A gate is PASS only with a committed artifact and a command that regenerates it. No partial credit.

| # | Gate | Binary condition | Artifact | Status |
|---|---|---|---|---|
| G1 | Rate cap enforced | 20% and 5.01% rejected; 5% boundary accepted | `adversarial-results.json` | PASS |
| G2 | Payee + caller allowlist enforced | unauthorized payee and marketplace caller rejected | `adversarial-results.json` | PASS |
| G3 | Budget atomic (incl. first-request fee) | 5,000,000+26,000 rejected at 5,010,000; accepted at 5,026,000 | `adversarial-results.json` | PASS |
| G4 | Replay prevented | duplicate hash rejected; idempotent retry returns original | `adversarial-results.json` | PASS |
| G5 | Conformance suite green | 16/16, exit 0 | `runs/.../adversarial-stdout.txt` | PASS |
| G6 | Guards load-bearing | 4/4 mutants fail correlated test; source byte-identical | `mutation-results.json` | PASS |
| G7 | Recovery pipeline green | 34 checks, exit 0 | `runs/.../pipeline-stdout.txt` | PASS |
| G8 | Auditor green | 10 checks, exit 0 | `runs/.../auditor-stdout.txt` | PASS |
| G9 | Cancellation invariants | FLOW COMPLETE, 5 invariants hold | `runs/.../simulator-stdout.txt` | PASS |
| G10 | Credential hygiene | 0 keys/macaroons/seeds in history | `runs/.../credential-scan.txt` | PASS |
| G11 | Evidence pinned | manifest with self-checksum regenerates; all byte sizes/SHA-256 match | `manifest.json` | PASS |
| G12 | Atomic budget under concurrency | 8 interleaved arrivals, no over-commit, 8/8 | `concurrency-results.json` | PASS |
| G13 | Live 25/25 settlement | `bundle.json` with 25/25, exit 0, incl. Alice's outgoing payment | `bundle.json` | **PASS** |
| G14 | NWC authority boundary | 13/13; verified BIP-340 signatures, NIP-44 v2, method allowlist, no caller-supplied pubkey | `authority-results.json` | **PASS** |
| G15 | Production service completes central transaction | 17/17 stages; premature settle refused; outgoing payment verified before release; node final states checked | `production-flow.json` | **PASS** |
| G16 | Durable SQLite storage | REAL mode persists sale/commission/reservation/budget; fails closed if storage unavailable | `production-flow.json` + `data/alibi.sqlite` | **PASS** |
| G17 | NWC transport | Genuine signed NIP-47/NIP-44 relay transport; wallet info event published | `engine/bin/nwc-transport.js` | **PASS** |

**Definition of finished for the submission:** G1–G17 pass. G15 was closed by driving the real
`CommissionService` through a full live hold → pay → verify → settle cycle with
`engine/bin/production-flow.js` (buyer HTLC held, premature settlement refused, outgoing commission
payment verified `SUCCEEDED` on the vendor node with an in-policy fee, sale released only afterward).
G13 was closed by regenerating `evidence/bundle.json` with the independent read-only verifier against
that same settlement (25/25, exit 0, now covering Alice's outgoing commission payment). All 17 gates
have committed artifacts.

## Regeneration
All gates regenerate via `REPRODUCE.md`. The live-cycle/keepalive procedure is `REPRODUCE.md` §7. The
claim ledger with per-gate hashes is `evidence/claims.json`.
