# ALIBI — Drey Scorecard (20-point)

Scored per `hackathon-craft/references/scorecards.md`.
Score 0–2 per dimension. 2 = a skeptical judge would agree without explanation.

## Scoring

| # | Dimension | Score | Justification |
|---|---|---|---|
| 1 | Silent failure | 2 | Marketplace silently widening commission authority — second-order, silent, expensive |
| 2 | Insight | 1 | NWC Commission Payments draft partially realized; vendor-side `make_commission_invoice` partially implemented |
| 3 | Invariant | 2 | "Authority can only narrow, never widen" — one sentence, testable |
| 4 | Architecture | 1 | Shared action contracts, deterministic BigInt policy, but NWC protocol not implemented; method blocklist inside HTTP server is not proof of NWC permission boundary |
| 5 | Completeness | 1 | Core flow incomplete: no verified seller→marketplace→buyer→seller earnings cycle; no independent commission-payment verification |
| 6 | Verification | 1 | Verifier queries node state for sale/commission/buyer payments but does NOT independently establish Alice's outgoing commission payment and actual routing fee |
| 7 | Evidence | 1 | Public state + digest available but verifier does not check the critical outgoing commission leg; adversarial suite tests policy logic, not production NWC request path |
| 8 | Sponsor fit | 1 | NWC API surface partially present (method allowlist/blocklist) but no signed Nostr/NIP-47 implementation; without it Alibi loses core value as a vendor-controlled checkout |
| 9 | Narrative | 1 | Problem → failure → proof pipeline not yet closed; product direction is clear but implementation gaps remain |
| 10 | Honesty | 2 | Specific limitations documented; no overclaiming; regtest labeled honestly; LEASH lesson applied |

**Total: 15/20**

## What changed from 20/20

| Dimension | Previous | Current | Reason |
|---|---|---|---|
| Silent failure | 2 | 2 | Still accurately articulated |
| Insight | 2 | 1 | Protocol not fully realized as shipped product |
| Architecture | 2 | 1 | NWC not implemented as specified; HTTP method blocklist ≠ NWC permission boundary |
| Completeness | 2 | 1 | Core checkout cycle not verified end-to-end |
| Verification | 2 | 1 | Verifier incomplete: missing outgoing commission leg |
| Evidence | 2 | 1 | Verifier does not check critical payment leg |
| Sponsor fit | 2 | 1 | No full NWC relay; value depends on protocol completion |
| Narrative | 2 | 1 | Gaps between documented product and implemented code |
| Honesty | 2 | 2 | Still accurately stated |

## What changed

| Dimension | Before | After | Evidence |
|---|---|---|---|
| Silent failure | 1 | 2 | Second-order failure clearly articulated |
| Insight | 1 | 2 | First implementation of NWC Commission Payments draft |
| Architecture | 1 | 1 | Action contracts + provenance; NWC protocol gap identified |
| Completeness | 1 | 1 | Full loop not yet verified on production path |
| Verification | 1 | 1 | Verifier queries nodes but misses outgoing commission leg |
| Evidence | 0 | 1 | Live verifier output + checksum; but verifier incomplete |
| Sponsor fit | 1 | 1 | NWC API surface; relay not implemented |
| Narrative | 1 | 1 | Problem → failure → proof not fully closed |
| Honesty | 1 | 2 | Specific limitations documented; no overclaiming |

## Cut list (still applies)

- Never cut: failure injection, deterministic check, evidence artifact, known-limitations section
- Cut first: extra integrations, settings/profiles/onboarding, secondary roles, visual polish, multi-tenant architecture

## Next actions

1. **Fix the NWC protocol implementation** — integrate with Nostr relays, NIP-44 encryption, signed-event verification
2. **Complete the payment lifecycle** — verify seller→marketplace→buyer→seller earnings cycle end-to-end on live regtest
3. **Update the verifier** — independently establish Alice's outgoing commission payment and routing fee
4. **Connect the UI to the backend** — revoke button, payment stages, live state
5. **Re-evaluate the Drey scorecard** — aim for 18-20/20 after fixes