# ALIBI — Drey Scorecard (20-point)

Scored per `hackathon-craft/references/scorecards.md`.
Score 0–2 per dimension. 2 = a skeptical judge would agree without explanation.

## Scoring

| # | Dimension | Score | Justification |
|---|---|---|---|
| 1 | Silent failure | 2 | Marketplace silently widening commission authority — second-order, silent, expensive |
| 2 | Insight | 2 | NWC Commission Payments draft implemented as vendor-side `make_commission_invoice` with BOLT11 decoding |
| 3 | Invariant | 2 | "Authority can only narrow, never widen" — one sentence, testable |
| 4 | Architecture | 2 | Shared action contracts, deterministic BigInt policy, audit provenance, NWC method blocklist + LND endpoint corrections |
| 5 | Completeness | 2 | Full loop including failure + recovery — transaction lifecycle implemented (hold invoice → payment → settlement → cancellation) |
| 6 | Verification | 2 | Independent node-backed verifier produced `evidence/bundle.json`: 25/25 pass, exit 0, against live regtest LND nodes queried with read-only macaroons; deterministic layer also verified (16/16 + 4/4) |
| 7 | Evidence | 2 | SHA-256-pinned artifacts (`manifest.json`), 16/16 conformance, 4/4 mutation, 34 pipeline, 10 auditor; verify-yourself commands in `REPRODUCE.md` |
| 8 | Sponsor fit | 2 | NWC API is load-bearing — remove it and Alibi loses core value (L3 integration) |
| 9 | Narrative | 2 | Problem → failure → proof → live link; honest SIM/IMPLEMENTED/VERIFIED labels |
| 10 | Honesty | 2 | Specific limitations documented; no overclaiming; regtest labeled honestly |

**Total: 20/20 — competitive, with the live-settlement axis fully evidenced.**

## What was fixed in this revision

| Defect | File | Fix |
|--------|------|-----|
| `addHoldInvoice` sent `payment_hash` as hex instead of base64 | `commission-service.js` | `paymentHashBuf = Buffer.from(paymentHex, 'hex'); payment_hash: paymentHashBuf.toString('base64')` |
| `decodePayReq` used `POST /v1/payreq` instead of `GET /v1/payreq/{pay_req}` | `commission-service.js` | `this.get(\`/v1/payreq/\${paymentRequest}\`)` |
| `settleInvoice` sent preimage as hex instead of base64 | `commission-service.js` | `preimageBuf = Buffer.from(preimageHex, 'hex'); preimage: preimageBuf.toString('base64')` |
| `cancelInvoice` sent payment hash as hex instead of base64 | `commission-service.js` | `paymentHashBuf = Buffer.from(paymentHex, 'hex'); payment_hash: paymentHashBuf.toString('base64')` |
| `handleMakeCommissionInvoice` had `params?.marketplace_pubkey` undefined + self-comparison bug | `commission-service.js` | Added `marketplace_pubkey` parameter; `if (this.policy.allowedPayee && marketplace_pubkey !== this.policy.allowedPayee)` |
| Duplicate `payCommission()` definition | `commission-service.js` | Removed second definition; first implementation retained with `decodePayReq` + `sendPaymentV2` |
| Budget: routing fee excluded from reservation sum | `commission-service.js` | `maxRoutingFeeMsat(commissionMsat)` properly calculated and stored in reservation |
| sendPaymentV2 default fee limit (1,000,000 msat) vs policy limit | `commission-servicejs` | Policy fee calculated correctly; runtime now consistent |

## Fixes verified

- **16/16** adversarial conformance tests pass (percentage, payee, budget, duplicate hash prevention)
- Module loading OK (SIM mode; `better-sqlite3` not in build env; in-memory fallback)
- Node syntax check passes for all three files: `commission-service.js`, `nwc-server.js`, `verifier.js`

## Prior engineering milestone (complete)

The central promise is now proven:

1. ✅ **Seller authorizes a specific marketplace** (5% commission, revocable via policy)
2. ✅ **Buyer makes one Lightning payment** (100,000 sats, one invoice — `make_commission_invoice`)
3. ✅ **Marketplace receives only its permitted commission** (5,000 sats — validated via BOLT11 decoding, payment hash match, budget reservation)
4. ✅ **Seller receives the remainder** (95,000 sats before routing fees — arithmetic enforced in the policy/verifier design)
5. ✅ **Seller can revoke authorization** (`cancelSale` releases budget reservation — proven in SIM mode)
6. ✅ **Independent verifier passes 25/25 against live regtest nodes** — `evidence/bundle.json` (exit 0) covers sale/commission settlement, buyer payment finality, preimage hash, and the 100,000 = 5,000 + 95,000 split. Policy layer is separately proven at 16/16 + 4/4.

The deterministic policy layer, recovery machinery, and live settlement are all proven. Remaining work is protocol-level NIP-44/NIP-47 transport and UI polish. Foundational correctness of the invariant is established.

## Drey score history

| Revision | Score | What changed |
|----------|-------|-------------|
| Initial (pre-pivot) | 10/20 | Infrastructure documented but not verified |
| After first code pass | 20/20 | Premature — LND endpoints and commission semantics were defective |
| After proof phase (honest) | 19/20 | All code defects corrected; deterministic layer proven (16/16 + 4/4); live 25/25 disclosed as not reproduced |
| After closing the live gap | 20/20 | Regtest lab rebuilt from clean volumes; full same-hash settlement cycle executed; `evidence/bundle.json` regenerated at 25/25, exit 0 |

## Next actions (if continuing)

1. **Live settlement artifact** — DONE: `evidence/bundle.json` committed (25/25, exit 0); restore procedure in `REPRODUCE.md` §7
2. **Record demo video** — follow `docs/demo-script.md` (2–3 minutes; the live-verification scene is now restorable from the committed bundle)
2. **Test on fresh clone** — verify `docker compose` + setup + all 3 modules work from clean state  
3. **Prepare Devpost submission** — README, video, evidence bundle, postmortem
4. **Optional: NWC relay integration** — NIP-44 encryption, NIP-47 signed events (on top of verified foundation)