# Judge gate — scorecard, red-team, checklist

Scored as a tired judge: README top, 60-second verify, JUDGES.md, honesty table. No code read during
scoring. Rubric from `hackathon-judge`.

## 1. Scorecard (1–5 per dimension)

| Dimension | Score | One-line justification |
|---|---|---|
| Novelty | 4 | A genuine missing layer — vendor-side commission authority instead of custody or broad NWC scopes; draft not adopted, so not a 5. |
| Technical depth | 5 | Invariant + 12 attacks + 4 mutation + 5 concurrency + reconciliation/recovery + 18/18 live node-backed settlement; full proof chain. |
| Sponsor fit | 3 | `make_commission_invoice` is load-bearing — remove it and there is no product. **But event/sponsor is unconfirmed.** If the sponsor is Celo, there is no Celo integration: this score collapses to 1–2 until confirmed. |
| Completeness | 4 | Full lifecycle implemented and now proven end-to-end on live regtest nodes (18/18); mainnet and full NWC relay remain unbuilt. |
| Credibility | 4 | Frozen SHA-256 manifest, honesty table, clean-clone verify commands; the live-reproduction gap is disclosed, not hidden. |
| Presentation | 4 | 60-second verify block, JUDGES.md, tight honest README/demo script; no rendered video yet and no hosted demo, so not a 5. |

**Total: 24/30. Decision: SUBMIT (live-settlement gap closed).**
No dimension ≤ 2, so nothing is disqualifying. G13 is now PASS with a committed, regenerable
`bundle.json` (18/18, exit 0). The single biggest remaining *risk* is the unconfirmed sponsor/event
(see red-team R1).

### Sponsor-prize path
If a narrower "NWC / Lightning tooling" prize exists, this entry is a stronger fit (sponsor primitive is
the core mechanism) than it is for a generic marketplace prize. Reframe the submission around the NWC
primitive for that path. If the sponsor is a chain platform with no Lightning/NWC relation, there is no
credible sponsor-prize path — fix the event mapping before submitting.

## 2. The 20 questions (two sentences + artifact)

1. **What is broken, with numbers?** Marketplaces need a commission but get custody or broad wallet scopes. There is no wallet-side policy primitive; 0 existing tools enforce rate+payee+budget+replay at delegation time. → `README` failure paragraph.
2. **Why has nobody fixed it?** The NWC Commission Payments draft is unadopted and LND REST byte encoding (base64 vs hex) is easy to get wrong; six such defects were found and corrected. → `DECISIONS.md` D1, D7.
3. **The invariant?** Authority can only narrow, never widen — effective authority is always a subset of the grant. → `THREAT_MODEL.md`.
4. **Holding under concurrency?** Eight interleaved arrivals at a 9-unit budget yield exactly 3 approvals, committed=9, no double reserve. → `concurrency-results.json`, `concurrency-test.js`.
5. **Holding under attack?** 14 adversarial cases all blocked; mutation harness proves all 4 guards are load-bearing. → `adversarial-results.json`, `mutation-results.json`.
6. **Timeout / partial failure?** Cancellation releases the reservation; buyer's held payment is released only after the outgoing payment resolves. Uncertain states are reconciled from LND state, not app state. → `simulator-stdout.txt`, `reconcile()`.
7. **What is mocked, why?** Auditor uses a mock LND and pipeline uses fixtures because no stable live chain was available; each is labeled. → `REAL_VS_MOCKED.md`.
8. **Testnet/mainnet, with a hash?** Regtest only, no mainnet. The live settlement hash is `0c3104c35224eb97bfb99af6d86e8d3cb9445b9f524080bf5f29aef87cd6c0c4`, committed in `bundle.json`. → `REAL_VS_MOCKED.md`, `evidence/bundle.json`.
9. **Load-bearing sponsor primitive?** `make_commission_invoice` in `commission-service.js` / `nwc-server.js` — remove it and the product has no reason to exist. → `README` mechanism section.
10. **Different from nearest project?** NobPay/Twese/SatsFarm lack wallet-side commission policy; Alibi enforces it at the vendor wallet with restricted NWC methods. → `README` (note: their exact test counts are not independently verified here — see R4).
11. **Can the model be wrong?** No model is in the payout path; commission is integer BigInt math and authorization is allowlist+cap checks. → `THREAT_MODEL.md`.
12. **Deliberately not built?** Full NWC relay, SQLite durability in build env, multi-root reservation, mainnet. → `DECISIONS.md` D10.
13. **Breaks at 1000x?** Single-process atomicity and in-memory fallback; no multi-root reservation or automated budget renewal. → `THREAT_MODEL.md`.
14. **Revoke / recover?** `cancelSale` releases the budget reservation; `reconcile()` fixes LND/app desync from node state. → `THREAT_MODEL.md`.
15. **What tests prove that a demo doesn't?** Mutation + concurrency tests fail when guards are removed or budget logic breaks — a happy-path demo cannot show that. → `mutation-results.json`, `concurrency-results.json`.
16. **Clean clone in one command?** The deterministic layer: `node engine/bin/adversarial-test.js` (plus mutation/concurrency). The live lab now reproduces from clean volumes via `harbor/lab/setup.sh` — see `REPRODUCE.md` §7. → `REPRODUCE.md`.
17. **Why this stack?** Node for fast iteration on LND REST; BigInt for exact msat math; the sponsor primitive is NWC. → `DECISIONS.md`.
18. **What surprised you?** Six of the seven defects were byte-encoding errors (hex vs base64) in LND REST calls. → `DECISIONS.md` D7.
19. **Least-comfortable limitation?** Regtest node-state verification is not Bitcoin consensus or trustlessness; single-process atomicity and static UI remain. The 18/18 live result is now evidenced in `bundle.json`. → `REAL_VS_MOCKED.md`, `REPRODUCE.md` §7.
20. **Why win over the prettiest demo?** One invariant, enforced wallet-side, proven by tests that fail when the guards are removed, and a real live settlement artifact instead of a faked proof. → `README` 60-second block.

## 3. Red-team findings (severity → evidence → fix/disclose)

| # | Severity | Finding | Fix or disclose |
|---|---|---|---|
| R1 | **HIGH** | Event/sponsor/track unconfirmed. Original PRD asserted "Celo Builders Hackathon — Marketplace Track — 2026-11-23" with no artifact. If Celo is the sponsor, there is zero Celo integration — sponsor-fit score collapses. | PRD line corrected to UNCONFIRMED. **Action: fill from the official submission page before submitting; if the sponsor requires chain integration, this entry is not a fit and must be reframed or withdrawn from that prize.** |
| R2 | ~~HIGH~~ **CLOSED** | Live 18/18 claim previously had no `bundle.json`; a prior video/storyboard/UI said "Verified on live LND regtest · 18/18". | Regtest lab rebuilt from clean volumes; full same-hash settlement cycle executed; `evidence/bundle.json` regenerated (18/18, exit 0). Claims restored across README, PRD, demo script, storyboard, UI, Drey scorecard. `REPRODUCE.md` §7 has the procedure. Any pre-existing rendered video with stale "not reproduced" strings must be re-rendered. |
| R3 | MEDIUM | Test count "14/14" appears in `docs/scorecard.md` as "8/8" historically and comparison table cites rivals' "929 tests". | Stale 8/8 fixed to 14/14. Rival counts are unverified — remove or label as "as claimed by their authors" before final submission. |
| R4 | ~~MEDIUM~~ **CLOSED** | Conformance suite defined its own policy copy rather than importing the production function; a matching-copy bug could hide a production defect (it did: production LND field names were wrong while the copy stayed green). | `adversarial-test.js` now imports the production `CommissionPolicy`; `mutation-test.js` mutates the production `commission-service.js`. Production service itself is exercised end-to-end by `production-flow.js` (14/14). `claims.json` C05/C13 and `REAL_VS_MOCKED.md` updated. |
| R5 | MEDIUM | No hosted demo / rendered video; judge cannot click a live link. | Disclosed in Presentation score. Demo script is honest and reproducible; host a static build of `interface/` before submission if time allows. |
| R6 | LOW | `docs/scorecard.md` "TLS verification not disabled by default" — verifier.js respects `NODE_TLS_REJECT_UNAUTHORIZED=0`. | Currently true by default (strict TLS with pinned cert); the escape hatch is explicit and documented. No change. |
| R7 | LOW | Repo has duplicate older test/service copies (`engine/adversarial-test.js`, `harbor/engine/bin/*`) with older numbers. | Authoritative paths are documented as `engine/bin/*`; duplicates are legacy snapshots. Consider deleting before submission to remove judge confusion (not done — user work, left intact). |

R2 and R4 are closed; R1 and R3 have concrete actions. R5 remains disclosed.

## 4. Binary pre-submission checklist

**Mechanism**
- [x] Invariant stated in one sentence and enforced in one place (`CommissionPolicy`).
- [x] Real integration completed; live settlement identifier `0c3104c3...6c0c4` committed in `evidence/bundle.json` and `evidence/production-flow.json` (18/18 verifier, 14/14 production stages, exit 0).
- [x] Concurrency, replay, revocation covered by tests that can fail (5/5, 14/14, 4/4, 7/7, SIM, 14/14 live production).
- [x] Uncertain outcomes are a state, reconciled from source of truth (`reconcile()` + LND).
- [x] No model in the decision path; deterministic BigInt math.

**Proof**
- [x] One command reproduces the headline claim (`node engine/bin/adversarial-test.js`).
- [x] Evidence folder: claim → mechanism → artifact → command (`evidence/claims.json`, `manifest.json`).
- [x] Honesty table + known limits (`REAL_VS_MOCKED.md`, `THREAT_MODEL.md`).
- [x] Test counts match actual output (14/14 conformance, 4/4 production mutation, 7/7 authority, 5/5 concurrency, 14/14 live production, 18/18 verifier, 34 pipeline, 10 auditor).
- [x] Clean-clone reproduction of the live lab verified this session — three consecutive `down -v && up -d && lab/setup.sh` rebuilds produced synced nodes, active channels, and successful seed payments (G13 evidence).
- [x] Frozen verified run exists (`evidence/manifest.json` with self-checksum; artifacts committed).

**Presentation**
- [x] README opens with tagline, paragraph, links. Event line is UNCONFIRMED — **must fill before submitting** (R1).
- [x] 60-second verify block with expected output.
- [x] Architecture diagram with trust boundaries.
- [x] 8–12 engineering-decision bullets (`DECISIONS.md`, 10 decisions).
- [x] Demo video script: five acts, money moment, numbers match (no rendered video yet — R5).
- [x] JUDGES.md one-click run + attacks.
- [ ] Launch thread posted and linked — pending (pitch phase produces draft).
- [ ] Submission fields mapped to criteria — pending (pitch phase produces mapping).
- [ ] Hosted demo stays up through judging — no hosted demo (disclosed, R5).

**Unchecked boxes are R1 (event), launch thread, submission mapping, hosted demo.** All are either actions with an owner above or explicitly disclosed. The live-settlement and clean-clone boxes are now checked. Nothing hidden.

## 5. Decision

**Submit at 24/30, contingent on R1 (confirm event/sponsor) and the remaining unchecked checklist boxes.**
Do not add features inside the final 12 hours. The live settlement artifact (G13) is closed with a
committed, regenerable `bundle.json`; no disclosure about that axis remains.

## 6. Post-event note (template — fill after result)

- Which artifact actually moved the judge: _pending_
- What to reuse next time: invariant-first PRD, mutation harness, frozen manifest, honesty table.
