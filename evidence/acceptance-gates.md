# Acceptance gates — binary definition of done

A gate is PASS only with a committed artifact and a command that regenerates it. No partial credit.

| # | Gate | Binary condition | Artifact | Status |
|---|---|---|---|---|
| G1 | Rate cap enforced | 20% and 5.01% rejected; 5% boundary accepted | `adversarial-results.json` | PASS |
| G2 | Payee allowlist enforced | unauthorized payee + marketplace rejected | `adversarial-results.json` | PASS |
| G3 | Budget atomic | exhaustion + sequential reservation enforced | `adversarial-results.json` | PASS |
| G4 | Replay prevented | duplicate hash rejected | `adversarial-results.json` | PASS |
| G5 | Conformance suite green | 12/12, exit 0 | `runs/.../adversarial-stdout.txt` | PASS |
| G6 | Guards load-bearing | 4/4 mutants fail correlated test; source byte-identical | `mutation-results.json` | PASS |
| G7 | Recovery pipeline green | 34 checks, exit 0 | `runs/.../pipeline-stdout.txt` | PASS |
| G8 | Auditor green | 10 checks, exit 0 | `runs/.../auditor-stdout.txt` | PASS |
| G9 | Cancellation invariants | FLOW COMPLETE, 5 invariants hold | `runs/.../simulator-stdout.txt` | PASS |
| G10 | Credential hygiene | 0 keys/macaroons/seeds in history | `runs/.../credential-scan.txt` | PASS |
| G11 | Evidence pinned | manifest with self-checksum regenerates | `manifest.json` | PASS |
| G12 | Atomic budget under concurrency | 8 interleaved arrivals, no over-commit, 5/5 | `concurrency-results.json` | PASS |
| G13 | Live 18/18 settlement | `bundle.json` with 18/18, exit 0, regenerable | **none** | **FAIL — not reproducible** |

**Definition of finished for the submission:** G1–G12 pass and G13 is either (a) made to pass with a
committed, regenerable `bundle.json`, or (b) explicitly disclosed as not reproducible everywhere a
number is quoted. The current submission takes path (b). It is honest, not finished on the live axis.

## Regeneration
All gates regenerate via `REPRODUCE.md`. G12's restore procedure is `REPRODUCE.md` §7. The claim
ledger with per-gate hashes is `evidence/claims.json`.
