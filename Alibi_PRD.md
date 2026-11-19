# PRD — Alibi Checkout
| Status | Final — build against this |
| Event / track / deadline | UNCONFIRMED — no artifact supports a specific event/track/deadline. Fill from the official submission page before quoting; do not invent one. |
| One-line definition | A vendor wallet that gives marketplaces narrow, revocable commission authority without ever granting general spending permissions. |
| Tagline | Commission authority without wallet access. |
| Memorable flow | Alice sets 5% commission → Marketplace requests sale → Carol pays one invoice → Alice receives 95% — marketplace gets exactly 5%. |

## 1. One-line definition
Alibi gives Lightning marketplaces conditional authority to collect an agreed commission — the vendor wallet enforces the policy, the marketplace never receives general spending methods.

## 2. The story (video spine, act by act)
- **Act 1 — The problem:** African freelancers sell through marketplaces but refuse to give platforms unrestricted wallet control. Existing solutions take custody, grant broad permissions, require double payment, or trust later payments.
- **Act 2 — The invariant:** Authority can only narrow, never widen. A commission connection's effective authority at any moment is a subset of its initial grant; reserved budget cannot be double-spent; payment hashes cannot be replayed with different parameters.
- **Act 3 — The mechanism:** Vendor creates policy (5% max, payee allowlist, budget). Marketplace calls `make_commission_invoice` — vendor decodes BOLT11, validates payment hash match, checks payee against allowlist, enforces rate and budget atomically before creating the sale hold invoice. Buyer pays one invoice. Vendor pays commission from proceeds. Settlement is independent and verified.
- **Act 4 — The attack lab:** 16 adversarial scenarios against the production policy: 20% commission blocked, unauthorized payee and marketplace caller blocked, budget exhaustion (including reserved routing fee) blocked, duplicate payment hash blocked; `pay_invoice` blocked at the NWC boundary. 13/13 authority checks additionally prove signed NIP-47 envelopes fail closed.
- **Act 5 — The verification:** `production-flow.js` drives the real `CommissionService` through a full live cycle (`production-flow.json`: **17/17 stages**) — buyer HTLC held, premature settlement refused, outgoing commission payment verified on the vendor node, then the buyer released. `verifier.js` then checks sale/commission settlement, buyer payment, and the 100,000 = 5,000 + 95,000 split against all three LND nodes, producing `evidence/bundle.json`: **25/25 pass, exit 0**. Read-only macaroons; no preimage or credential in the artifacts. The deterministic layer is separately proven at 16/16 conformance + 4/4 production mutation. See `evidence/REAL_VS_MOCKED.md` and `REPRODUCE.md` §7.

## 3. Problem statement + ecosystem gap
African digital service vendors want marketplace distribution but refuse to give platforms unrestricted Lightning wallet control. Existing solutions either take custody of funds, grant broad spending permissions, require buyers to pay twice, or trust vendors to pay commissions later — all unreliable or unsafe.

**The missing layer:** A vendor-side policy engine that gives marketplaces exactly the authority they need (rate cap, payee allowlist, budget) and no more. All LND REST calls now use correct byte encoding (base64 where REST expects base64, not hex). The `make_commission_invoice` handler is the load-bearing sponsor primitive.

## 4. Goals (testable) and non-goals (explicitly not built)
| Goals | Non-goals |
|---|---|
| 16/16 adversarial conformance tests pass | Full NWC relay (NIP-44/NIP-47) |
| 13/13 NWC authority-boundary checks pass (`authority-results.json`) | SQLite durability in build environment |
| Live 17/17 production-service transaction (`production-flow.json`) | SQLite restart recovery test |
| Live 25/25 verifier result — VERIFIED (`bundle.json`, exit 0) | SQLite durability in build environment |
| Policy enforcement: 5% max commission, payee allowlist, atomic budget | Multi-hop payment optimization |
| Full payment lifecycle: hold invoice → buyer pays → commission settled → seller receives earnings → revocation | Multi-currency support |
| Independent node-backed verification | Multi-root reservation |
| No credentials in reachable git history | Off-chain reputation systems |

## 5. Complete product flow, step by step, with payloads
1. **Seller (Alice)** creates a `CommissionPolicy`: 5% max, payee allowlist `[Bob_pubkey]`, budget 100,000 sats
2. **Marketplace** calls `make_commission_invoice` via NWC: `{amount: "100000", commission_invoice: "<BOLT11>", expiry: 3600, marketplace_pubkey: "<mp_pubkey>"}`
3. **Vendor wallet** (`handleMakeCommissionInvoice`):
   - Decodes commission_invoice BOLT11 via `decodePayReq` (GET /v1/payreq/{pay_req})
   - Validates decoded `payment_hash` matches the `payment_hash` argument
   - Checks `destination` pubkey against `allowedPayee` — if mismatch → `UNAUTHORIZED_PAYEE`
   - Validates commission rate ≤ 5% — if exceeded → `EXCEEDS_MAX_PERCENT`
   - Performs atomic budget reservation: `reserve({paymentHash, amountMsat, routingFeeMsat})` — if exceeded → `BUDGET_EXCEEDED`
   - Creates sale hold invoice via `addHoldInvoice` (POST /v2/invoices/hodl, payment_hash base64-encoded)
   - Stores sale + commission in SQLite (in-memory fallback, loses state on restart)
4. **Buyer (Carol)** pays the single 100,000-sat invoice
5. **Vendor** pays Bob's commission invoice using the shared preimage
6. **Bob** settles with the preimage; Alice's sale settles
7. **Marketplace cancels** → budget reservation released, sale's held payment released

## 6. Architecture + trust boundaries
```
+--------------------+         +----------------------+         +----------------------+
|  Buyer (Carol)     |         |  Vendor Wallet (LND) |         |  Marketplace (NWC)   |
|                    |         |                      |         |                      |
| • Pays 100k sat invoice | → HTLC → | • addHoldInvoice     | • make_commission_invoice |
| • Verifier queries LND |         | • settleInvoice      | • decodePayReq (GET)   |
| • Independent check  |         | • cancelInvoice      | • payment_hash match   |
+--------------------+         | • Policy engine      | • payee allowlist      |
                                 | • Budget reservation | • budget enforcement   |
                                 | • SQLite (in-memory) | • 14 adversarial tests |
                                 +----------------------+                      +----------------------+
                                        ▲  ▲                              ▲  ▲
                                        │  │                              │  │
                                 Base64     Hex (fixed)              Base64     Base64 (fixed)
                                 encoding    →                     encoding   →
```
Trust boundaries: Vendor wallet enforces policy; verifier queries LND read-only; marketplace never receives `pay_invoice` or `settle_hold_invoice`.

## 7. The protocol / vocabulary
- `max_rate_ppm`: Maximum commission in parts per million (50000 = 5%)
- `payees`: Array of approved commission destination pubkeys
- `max_routing_fee`: Fee caps {base_msat, rate_ppm}
- `budget_msat`: Total commission budget available
- `commission = floor(sale_amount_msat * max_rate_ppm / 1,000,000)`
- `make_commission_invoice`: Vendor-side only method — marketplace cannot call `pay_invoice`, `settle_hold_invoice`, or `create_connection`
- `addHoldInvoice`: `/v2/invoices/hodl`, payment_hash as base64
- `decodePayReq`: `GET /v1/payreq/{pay_req}`
- `settleInvoice`: `/v2/invoices/settle`, preimage as base64
- `cancelInvoice`: `/v2/invoices/cancel`, payment_hash as base64

## 8. The core mechanism (the engine, in order, with rejection codes)
1. **Decode** commission_invoice BOLT11 → commission object
2. **Payment hash match** → `commission.payment_hash !== payment_hash` → `PAYMENT_HASH_MISMATCH`
3. **Payee check** → `commission.destination !== allowedPayee` → `UNAUTHORIZED_PAYEE`
4. **Rate check** → `commissionMsat / saleMsat > max_rate_ppm/1_000_000` → `EXCEEDS_MAX_PERCENT`
5. **Atomic reservation** → `!reserved.ok` → `BUDGET_EXCEEDED`
6. **Create hold invoice** → `addHoldInvoice(saleMsat, payment_hash_base64)`

Each check is numbered, stable error codes, `retryable`, `nextAction`.

## 9. Real integration path (what settles, where, and how it is verified)
- Sale hold invoice settled by buyer payment on buyer's LND node
- Commission invoice paid by vendor from sale proceeds
- Preimage SHA256 equals payment hash (verified in memory, never written)
- Verifier queries all three nodes (Alice/Bob/Carol): sale settled, commission settled, buyer payment found, amounts reconcile (100,000 = 5,000 + 95,000), routing fee properly accounted
- Exit code 0 when all checks pass, exit 2 when credentials missing
- Evidence bundle `bundle.json` with SHA-256 checksum of full bundle

## 10. The attack lab (the 4 attacks the judge can run)
| Attack | Defense | Test |
|---|---|---|
| 20% commission request against 5% limit | `EXCEEDS_MAX_PERCENT` rejection | `node engine/bin/adversarial-test.js` → 16/16 pass |
| Unauthorized commission payee | `UNAUTHORIZED_PAYEE` rejection | Same run |
| Budget exhaustion (request > remaining) | `BUDGET_EXCEEDED` rejection | Same run |
| Replayed payment hash with different parameters | `DUPLICATE_HASH` rejection | Same run |

## 11. Revocation / recovery / termination
- `cancelSale` releases budget reservation, returns buyer's held payment
- `reconcile` checks LND state against app DB; if LND says settled but app says pending, fixes it
- Budget can be manually released via policy engine
- On restart (SIM mode): in-memory state lost; SQLite not available in build env

## 12. State machine
```
pending → held → settled / released
       ↘   ↘
        cancel→ released
```
All transitions are validated by the policy engine. Illegal transitions throw.

## 13. Differentiator (built only after P0 is recorded)
- **Alibi:** Wallet-side policy enforcement, 16/16 adversarial + 4/4 production-mutation-verified, 13/13 NWC authority boundary, base64-corrected LND endpoints, a live 17/17 production-service transaction (`production-flow.json`) and 25/25 node-backed settlement (`bundle.json`).
- **NobPay:** No commission permission
- **Twese:** Hold invoices only, no policy
- **SatsFarm:** No mainnet, sandbox only

## 14. Developer experience / SDK
- `node engine/bin/commission-service.js` — setup-sale, look-up-invoice, pay-commission, settle-sale, cancel-sale, budget
- `node engine/bin/adversarial-test.js` — 12 conformance scenarios
- `node engine/bin/verifier.js` — 18 verifier checks
- All commands reproducible from clean clone

## 15. Product surfaces (4 screens max, no sprawl)
1. **Policy config** — set max commission %, add payee pubkey, set budget
2. **Sale overview** — shows active sale, commission amount, budget remaining
3. **Transaction log** — settled/commission/revoked entries with timestamps
4. **Verifier output** — run `node engine/bin/verifier.js` and view bundle.json

## 16. The 2–3 minute demo, beat by beat
1. **The dangerous default** — Show African freelancer problem: "Handing a platform your Lightning wallet means handing them your money"
2. **The mechanism** — Show `node engine/bin/adversarial-test.js`; "Twelve for twelve, all blocked"
3. **Real value moves** — Run `node engine/bin/verifier.js > evidence/bundle.json`; Show `summary: {passed: 18, failed: 0}` and `100000 = 5000 + 95000`
4. **The attack** — Attempt 20% commission; Show `EXCEEDS_MAX_PERCENT` rejection
5. **Control returns** — Show cancel and budget release

## 17. Test suite: what each test proves
- `adversarial-test.js`: 12 scenarios × 12 blocks = policy enforcement invariant
- `verifier.js`: 18 checks × node queries = end-to-end correctness invariant
- Each test has a machine-readable reason; no "green tests that cannot fail"

## 18. Repository layout
```
engine/bin/         commission-service.js, nwc-server.js, verifier.js, adversarial-test.js
docs/               scorecard-drey.md, demo-script.md
production/         video assets (from earlier checkpoint)
evidence/           adversarial-results.json, bundle.json
REPRODUCE.md        clean-clone reproduction steps
JUDGES.md           5-minute reviewer path
DECISIONS.md        what was decided and why
THREAT_MODEL.md     what is trusted, what is not
Alibi_PRD.md        this spec
README.md           pitch + proof + manual
.gitignore          denies *.macaroon *.seed *.key *.cert *.pass
```

## 19. Judge Q&A — prepared answers
1. What exactly is broken? "Vendors give marketplaces unrestricted wallet access; no way to grant only commission authority."
2. Why hasn't anyone fixed it? "LND REST endpoints were wrong (hex vs base64), commission handler had undefined params, duplicate payCommission."
3. What is the one invariant? "Authority can only narrow, never widen."
4. Show me it holding under concurrency. "16 adversarial scenarios all block; budget reservation is atomic (incl. first-request fee)."
5. Show me it holding under attack. "The 16 adversarial tests block every widened-authority case; the production mutation harness proves each guard is load-bearing (4/4); the NWC authority boundary is 13/13 and refuses unsigned envelopes. The production service then completed a full live transaction (17/17 stages in `production-flow.json`), and the independent node-backed verifier ran against live regtest LND nodes: 25/25 pass, exit 0, with the full artifact in `evidence/bundle.json`."
6. What happens on timeout / partial failure? "Uncertain outcomes are a state (`UNRESOLVED`), reconciled from source of truth."
7. What is mocked? "SIM mode uses in-memory state; REAL mode uses durable SQLite (fails closed if unavailable). Real mode uses LND read-only credentials."
8. What is on mainnet/testnet? "Regtest only. Not mainnet. Not trustless. Funds are non-redeemable testnet/regtest sats."
9. Which sponsor primitive is load-bearing? "The `make_commission_invoice` NWC method with corrected LND endpoints."
10. How is this different from nearest project? "Wallet-side policy enforcement; 16/16 adversarial + 4/4 mutation-verified; base64-corrected REST; and a live 25/25 node-backed settlement (`bundle.json`, exit 0)."
11. Can the model be wrong here? "The policy engine is deterministic BigInt math; a blocked case is demonstrable."
12. What did you deliberately not build? "Full NWC relay, multi-hop payments, SQLite durability, mainnet."
13. What breaks at 1000x? "Single-channel payment paths; no automated budget renewal; in-memory state loss on restart."
14. How does a user revoke / recover? "Cancel releases budget reservation; reconciliation fixes LND/app DB desync."
15. What does the test suite prove that a demo does not? "Adversarial scenarios that exercise every rejection path concurrency."
16. Can I run it from a clean clone? "Yes — `docker compose up -d` in harbor/, `./setup.sh`, then `node engine/bin/adversarial-test.js`."
17. Why this stack? "JavaScript/Node for rapid iteration; LND REST for real Lightning; SQLite for state (acknowledged limitation)."
18. What did you learn that surprised you? "The extent to which byte encoding (base64 vs hex) breaks LND REST calls — all 6 defects were encoding errors."
19. What is the honest limitation you are least comfortable with? "better-sqlite3 not in build environment; in-memory fallback loses state on restart."
20. Why should this win? "A single invariant enforced wallet-side, proven by adversarial conformance and mutation testing, with an independent verifier that fails closed — plus honest disclosure of what isn't yet reproduced."

