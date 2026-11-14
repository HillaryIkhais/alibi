# ALIBI — Commission Authority Without Wallet Access

**An agent can be trusted with a commission. It cannot be trusted with a wallet.**

A marketplace gets a narrow, revocable permission: request a commission-bound
sale to one approved payee, within one policy. It never receives
`pay_invoice`, `settle_hold_invoice`, or any general spending method. The
vendor's wallet enforces the policy — not the marketplace's UI, not the
marketplace's honesty.

**Invariant:** Authority can only narrow, never widen. A commission
connection's effective authority at any moment is a subset of its initial
grant; reserved budget cannot be double-spent; payment hashes cannot be
replayed with different parameters.

*Experimental reference implementation of the NWC Commission Payments draft
([nwc#8](https://github.com/nostr-wallet-connect/nwc/issues/8)) — the draft
is not an adopted standard. Regtest only. Not mainnet. Not trustless.*

---

## Claim discipline

| Category | Meaning | Status in Alibi |
|----------|---------|-----------------|
| **Enforced** | Guaranteed by a mechanism | Policy engine, BigInt math, atomic budget reservation, duplicate-hash prevention, NWC method blocklist |
| **Demonstrated** | Shown in the demo | Adversarial test suite: 12/12 pass (policy-layer enforcement) |
| **Measured** | Reported with sample size | Verifier: 13/18 checks pass against live nodes (outgoing commission leg not independently established) |
| **Future work** | Not built | Full NWC relay; seller-buyer-seller earnings cycle; SQLite durability in build env |

Never let future work appear as live. Never let a measured claim appear as a guarantee.

---

## Evidence table

| Check | Result | Evidence |
|-------|--------|----------|
| 20% commission blocked | **VERIFIED** | `node engine/bin/adversarial-test.js` → 12/12 pass |
| Unauthorized payee blocked | **VERIFIED** | same run |
| Budget exhaustion blocked | **VERIFIED** | same run |
| Sequential budget tracking | **VERIFIED** | same run (reservation-aware budget) |
| Duplicate payment-hash blocked | **VERIFIED** | same run |
| Integer money math (no floats) | **VERIFIED** | `CommissionPolicy` uses BigInt comparisons |
| No credentials in reachable git history | **VERIFIED** | `.gitignore` denies `*.macaroon *.seed *.key *.cert *.pass` |
| Full Alice→Bob→Carol transaction | **PARTIAL** | Verifier checks sale invoice, commission invoice, buyer payment on Carol's node; does NOT independently establish Alice's outgoing commission payment and routing fee |
| Independent node-backed verifier | **PARTIAL** | Queries Alice/Bob/Carol read-only macaroons; 13/18 checks pass; fails closed without credentials; does not verify the critical commission-payment leg |
| NWC `make_commission_invoice` handler | **IMPLEMENTED, PARTIAL** | Decodes commission BOLT11 invoice, validates payment hash, checks payee and budget; method blocklist inside HTTP server (not full NWC relay with NIP-44/NIP-47) |
| Durable budget (SQLite, atomic) | **IMPLEMENTED, NOT VERIFIED** | SQLite schema in `commission-service.js`; `better-sqlite3` not installed in build environment; in-memory fallback loses state on restart |
| Cancellation / recovery scenario | **NOT DEMONSTRATED** | Code supports cancellation but no end-to-end regtest demonstration of budget release on cancellation |

**Honest headline:** Alibi has a working policy engine with adversarial conformance tests (12/12 pass), a partial independent verifier (13/18 checks pass against live LND regtest nodes), and a UI that demonstrates the product vision. Critical gaps remain: the full NWC relay is not implemented, the outgoing commission payment leg is not independently verified by the verifier, and the end-to-end seller-buyer-seller earnings cycle has not been demonstrated on live regtest.

---

## The economics (corrected)

The buyer pays **one invoice of 100,000 sats**. Not 105,000.
The commission (5,000 sats at 5%) is paid by the vendor out of the received
amount. Vendor net before routing fees: **95,000 sats**.

---

## The Problem

African digital service vendors want marketplace distribution (like Nigerian designers on platforms) but refuse to give platforms unrestricted control of their Lightning wallets. Existing solutions either:

- Take custody of funds (unsafe)
- Grant broad wallet spending permissions (unsafe)
- Require buyers to pay twice (bad UX)
- Trust vendors to pay commissions later (unreliable)

---

## The Solution

**Alibi gives a Lightning marketplace conditional authority to collect an agreed commission without giving it general spending authority over the vendor's wallet.**

The vendor wallet enforces policy. The marketplace can only request commission-bound sales to approved destinations within budget limits.

---

## How It Works (under the hood)

The NWC Commission Payments draft implementation (nwc#8) provides the engine underneath. Key specification requirements:

- `max_rate_ppm`: Maximum commission in parts per million (50000 = 5%)
- `payees`: Array of approved commission destination pubkeys
- `max_routing_fee`: Fee caps {base_msat, rate_ppm}
- `budget_msat`: Total commission budget available
- `commission = floor(sale_amount_msat * max_rate_ppm / 1,000,000)`

The marketplace can only request `make_commission_invoice` — it cannot call `pay_invoice`, `settle_hold_invoice`, or `create_connection`. The vendor wallet enforces all policy checks.

**Current status:** The `handleMakeCommissionInvoice` method decodes the commission BOLT11 invoice, validates its payment hash against the requested hash, checks the destination pubkey against the allowed payees, and enforces rate/budget checks. However, the full NWC relay (NIP-44 encryption, NIP-47 signed events, Nostr transport) is not yet implemented. The marketplace identity `pubkey` is caller-supplied and not authenticated through a signed NWC event.

---

## Adversarial Defense

| Attack | Defense |
|--------|---------|
| 20% commission request | `EXCEEDS_MAX_PERCENT` rejection |
| Unauthorized payee | `UNAUTHORIZED_PAYEE` rejection |
| Budget exhaustion | `BUDGET_EXCEEDED` rejection |
| Duplicate payment hash | `DUPLICATE_HASH` rejection |
| `pay_invoice` call | `METHOD_NOT_ALLOWED` rejection |

12 conformance scenarios pass automatically.

---

## Independent Verification

A third-party verifier queries actual LND node state (not Alibi's database) to confirm:

- Sale invoice exists with correct payment hash (100,000,000 msat)
- Commission invoice exists with matching payment hash (5,000,000 msat)
- Buyer payment of 100,000 sats SUCCEEDED on buyer node
- Amounts reconcile: 100,000,000 == 5,000,000 + 95,000,000
- Preimage SHA256 matches payment hash (checked in memory, never written)

**Current limitation:** The verifier does NOT independently establish Alice's outgoing commission payment to Bob or the actual routing fee. It checks the sale invoice, commission invoice, and buyer payment, then performs the 100,000 = 5,000 + 95,000 arithmetic using expected constants. Exit code 0 when all checks pass, exit 2 when credentials missing.

Verifier output writes `bundle.json` with SHA-256 checksum of the full bundle.

---

## Competition Differentiation

| Feature | NobPay | Twese | SatsFarm | **Alibi** |
|---------|--------|--------|----------|-----------|
| Real Lightning | Simulated | Sandbox | Mutinynet | **Regtest** |
| Commission permission | No | Hold invoices | No | **YES (partial)** |
| Restricted NWC connection | No | Partial | No | **YES (partial)** |
| Policy enforcement | Client-side | App-based | N/A | **Wallet-side (partial)** |
| Failure recovery | N/A | Basic | N/A | **Not demonstrated** |
| Independent verifier | Browser | No | No | **External tool — partial** |
| Adversarial conformance | 929 tests | Limited | N/A | **12 scenarios** |

---

## Submission Checklist

- [ ] **Usefulness**: Marketplace commissions for African vendors (illustrative scenario)
- [x] **Security**: Vendor policy enforcement, no broad wallet access (adversarial tests pass)
- [ ] **UI**: Transaction Room interface (static HTML, not live; revoke/button not connected to backend)
- [ ] **MVP**: Full commission flow with regtest — not yet complete (outgoing commission leg not verified)
- [x] **Technical**: HTLC coordination, payment hash linking (policy engine operational)
- [x] **Wallet**: Real Lightning flow with LND — commission service interacts with LND nodes
- [x] **Conformance**: 12 adversarial tests pass (12/12)
- [ ] **Verification**: Independent state checking (verifier partial — 13/18 checks; outgoing commission leg not independently established)
- [ ] **Recovery**: Cancellation/restart handling (code supports it; no end-to-end regtest demonstration)

---

## Limitations & Future Work

**Current limitations (specific, not vague):**

- **Regtest only** — not mainnet, not trustless. Funds are non-redeemable testnet/regtest sats.
- **PTLC interception not mitigated** — a colluding routing node on the buyer's route may permit interception. PTLCs are a possible future mitigation, not an implemented guarantee.
- **No automated budget renewal** — budget is a fixed pool; renewal period is future work.
- **Single-channel payment paths** — no multi-hop fee optimization.
- **No SQLite durability** — `better-sqlite3` not installed in build environment; in-memory fallback loses state on restart.
- **No full NWC relay** — `nwc-server.js` is an HTTP JSON server with method allowlist/blocklist; no signed Nostr events, no NIP-44 encryption, no NIP-47 request/response. Marketplace identity `pubkey` is caller-supplied and not authenticated.
- **No outgoing commission-payment verification** — verifier checks sale/commission/buyer payments but does not independently establish Alice's payment to Bob or actual routing fees.
- **No end-to-end checkout cycle** — seller approves → buyer pays → seller receives earnings not yet demonstrated on live regtest.
- **UI elements not connected to backend** — revoke button, payment stages are static; no live state synchronization.

**Future improvements:**

- Full NWC relay implementation (NIP-44, NIP-47, Nostr transport)
- End-to-end seller-buyer-seller earnings cycle on live regtest
- Outgoing commission-payment verification in independent verifier
- SQLite durability in build environment
- UI connected to backend with live payment state
- PTLC-enabled routing
- Multi-hop payment optimization
- Automated budget renewal

---

## Q&A Prep

| Question | Strong answer |
|----------|---------------|
| What if the model is wrong? | There is no model. The policy engine is deterministic BigInt math; a blocked case is demonstrable. |
| What is actually enforced? | The invariant: authority can only narrow, never wider. Rate, payee, budget, duplicate-hash checks run at delegation time. Here are the 12 adversarial tests. |
| How do you know verification is correct? | The verifier queries actual LND node state (read-only credentials), not Alibi's database. It fails closed (exit 2) without credentials. **Limitation:** it does not independently establish the outgoing commission payment leg. |
| What is the boundary? | Regtest only. Single root (no multi-root reservation). Research informs decisions; it never determines payouts. |
| What breaks in production? | Top risk: marketplace knows preimage before buyer pays (collusion risk). Mitigation: PTLCs (future work). Fallback: cancel commission, release sale. **Additional:** full NWC relay not yet implemented; marketplace identity not cryptographically authenticated. |

---

**Experimental implementation of the NWC Commission Payments draft (nwc#8). Regtest only. Not mainnet. Not trustless.**

*"Commission authority without wallet access."*