# ALIBI — Hackathon Scorecard

Scored against the official Dakar Bitcoin Hack 2026 rules
(usefulness/social impact, security by design, UX/UI, working MVP, clear pitch).
Run on 2026-11-14. Re-run after each gate closes.

## Status labels (claim discipline)

| Label | Meaning |
|---|---|
| **VERIFIED** | Executed here, with asserted output |
| **IMPLEMENTED** | Code exists and runs, but not proven against a real wallet/relay |
| **SIMULATED** | In-memory / fixture-backed only |
| **MISSING** | Not built |
| **FUTURE** | Documented as out of scope |

---

## Scorecard

### 1. Working MVP (the gate that matters most)

| # | Point | Status | Evidence |
|---|---|---|---|
| 1 | Three-node regtest runs | MISSING | Docker unavailable in build env; `docker-compose.yml` ready |
| 2 | One real sale payment (Carol → Alice, 100,000 sats) | MISSING | Requires #1 |
| 3 | Real commission payment (Alice → Bob, 5,000 sats) | MISSING | Requires #1 |
| 4 | Linked invoices share one payment hash | IMPLEMENTED | `commission-flow-simulator.js`, in-memory |
| 5 | Preimage release settles the sale | SIMULATED | Hash check simplified; real flow needs `SettleInvoice` |
| 6 | Independent verifier queries actual nodes | IMPLEMENTED | `engine/bin/verifier.js`, needs #1 to execute |
| 7 | Restart / lost-response recovery | MISSING | Highest-risk untested path |
| 8 | Marketplace cancellation scenario | MISSING | Required by failure demo |

**MVP subtotal: 0 VERIFIED, 3 IMPLEMENTED, 1 SIMULATED, 4 MISSING**

### 2. Security by design

| # | Point | Status | Evidence |
|---|---|---|---|
| 9 | Policy enforced wallet-side, not UI-side | VERIFIED | `adversarial-test.js` 8/8 pass |
| 10 | 20% commission blocked | VERIFIED | Test 1 |
| 11 | Unauthorized payee blocked | VERIFIED | Test 3 |
| 12 | Budget exhaustion blocked | VERIFIED | Test 5 |
| 13 | Duplicate payment-hash blocked | VERIFIED | Test 6 |
| 14 | No `pay_invoice` on marketplace connection | IMPLEMENTED | Blocklist in `nwc-server.js`, not exercised over relay |
| 15 | No committed credentials in history | VERIFIED | History rewritten; `git log` clean; `.gitignore` denies `*.macaroon *.seed *.key *.cert` |
| 16 | Integer (BigInt) money math, no floats | VERIFIED | Policy uses BigInt comparisons |
| 17 | TLS verification not disabled by default | VERIFIED | Cert-file load path; no blanket `rejectUnauthorized:false` in current code |
| 18 | Durable state (SQLite), atomic reservation | MISSING | In-memory Maps only — restart loses budget |

**Security subtotal: 8 VERIFIED, 2 IMPLEMENTED, 1 MISSING**

### 3. Usefulness / social impact

| # | Point | Status | Evidence |
|---|---|---|---|
| 19 | Concrete African user problem stated | VERIFIED | README: Nigerian designer, marketplace fee |
| 20 | Scenario labeled illustrative, no invented adoption claims | VERIFIED | README disclaimer |
| 21 | Differentiated from Paystack/PSP splits | VERIFIED | README explicitly concedes PSPs can split |
| 22 | Non-technical buyer copy exists | MISSING | UI shows sats only |

**Usefulness subtotal: 3 VERIFIED, 1 MISSING**

### 4. UX/UI

| # | Point | Status | Evidence |
|---|---|---|---|
| 23 | Transaction Room UI wired to backend state | SIMULATED | `interface/public/index.html` static |
| 24 | Rejected 20% and approved 5% in one story | IMPLEMENTED | Console output exists; not in UI |
| 25 | No hardcoded success labels | MISSING | UI not connected |
| 26 | Mobile-legible, distinctive visual direction | MISSING | Not built this session |

**UX subtotal: 0 VERIFIED, 1 IMPLEMENTED, 1 SIMULATED, 2 MISSING**

### 5. Clear pitch

| # | Point | Status | Evidence |
|---|---|---|---|
| 27 | One-sentence invariant above the fold | VERIFIED | README line 1 area |
| 28 | Evidence table with status labels | VERIFIED | README |
| 29 | 2–3 minute video script | VERIFIED | `docs/demo-script.md` |
| 30 | Video recorded | MISSING | Needs running regtest |

**Pitch subtotal: 3 VERIFIED, 1 MISSING**

---

## Totals

| Status | Count |
|---|---|
| VERIFIED | 14 |
| IMPLEMENTED | 6 |
| SIMULATED | 3 |
| MISSING | 8 |
| FUTURE | 0 |

## The three cheapest gaps (in order)

1. **MVP gaps #1–#6, #7, #8** — everything else is downstream of one real
   regtest transaction. No README polish substitutes for it.
2. **Durability gap #18** — SQLite budget reservation; without it the
   "atomic + durable" security claim is false.
3. **Video #30** — record only after #1 passes. A video of a simulated
   flow is negative evidence with a camera.

## The failure sentence

> "We shipped a correct policy engine and a convincing simulation, but never
> executed the two-hop Lightning transaction the draft exists to coordinate."

This is the sentence the scorecard is designed to make untrue before Nov 20.

## Re-run rule

Re-run this scorecard after Gate 1 (real transaction) and Gate 3 (recovery).
Do not edit statuses by hand — update only with a command output attached.
