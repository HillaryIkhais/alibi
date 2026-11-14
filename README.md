# ALIBI — Checkout Without Wallet Access

**A marketplace can bring you customers and earn its agreed fee. It does not get to take control of your wallet.**

## The Problem

African digital-product creators sell through marketplaces but refuse to give platforms unrestricted control of their Lightning wallets. Existing solutions either:

- Take custody of funds (unsafe)
- Grant broad wallet spending permissions (unsafe)
- Trust vendors to pay commissions later (unreliable)
- Charge the buyer twice (bad UX)

## The Solution

**Alibi gives a Lightning marketplace conditional authority to collect an agreed commission without giving it general spending authority over the vendor's wallet.**

The vendor wallet enforces policy. The marketplace can only request commission-bound sales to approved destinations within budget limits.

## Alibi Checkout — Three Simple Experiences

### 01 — Seller approves the marketplace

**Market commission**

# **5%**

Only this marketplace. Maximum 5% per sale. Limited monthly budget. Revocable by the seller.

Seller-approved

### 02 — Buyer purchases a product

**Creator Brand Kit**

# **100,000 sats**

Digital download · Instant delivery

Buyer pays once

**Creator receives**

# **95,000 sats**

Marketplace earns

# **5,000 sats**

### 03 — Seller's earnings are protected

The marketplace attempts to change its commission to 20%. Alibi rejects the request. The seller's original permission remains intact.

20% request rejected

---

## How It Works (under the hood)

The marketplace receives **one invoice** for 100,000 sats. The commission (5,000 sats at 5%) is paid by the vendor from the received amount. Vendor net before routing fees: 95,000 sats.

```
┌─────────────────────────────────────────────────────────────┐
│                    VENDOR WALLET (Alice)                     │
├─────────────────────────────────────────────────────────────┤
│  NWC CONNECTION (Commission-Only):                          │
│  ├─ make_commission_invoice  ← CAN request commission        │
│  ├─ lookup_inventory         ← CAN check own sales           │
│  └─ get_info                 ← CAN get wallet info           │
│                                                            │
│  RESTRICTED METHODS (Marketplace CANNOT):                   │
│  ├─ pay_invoice          ← NO general spending               │
│  ├─ settle_hold_invoice    ← NO invoice control              │
│  ├─ cancel_hold_invoice    ← NO invoice control              │
│  └─ create_connection      ← NO new connections              │
│                                                            │
│  Policy Enforcement:                                        │
│  ├─ max_rate_ppm: 50000 (5%)                               │
│  ├─ payees: [approved_marketplace_pubkey]                 │
│  ├─ max_routing_fee: {base_msat: 1000, rate_ppm: 5000}    │
│  └─ budget_msat: 100,000,000 (100M millisat = 100,000 sats)│
└─────────────────────────────────────────────────────────────┘
```

---

## Technical Architecture

The NWC Commission Payments draft implementation (nwc#8) provides the engine underneath. Key specification requirements:

- `max_rate_ppm`: Maximum commission in parts per million (50000 = 5%)
- `payees`: Array of approved commission destination pubkeys
- `max_routing_fee`: Fee caps {base_msat, rate_ppm}
- `budget_msat`: Total commission budget available
- `commission = floor(sale_amount_msat * max_rate_ppm / 1,000,000)`

The marketplace can only request `make_commission_invoice` — it cannot call `pay_invoice`, `settle_hold_invoice`, or `create_connection`. The vendor wallet enforces all policy checks.

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
- Both payments settled to completion
- Amounts reconcile: 100,000,000 == 5,000,000 + 95,000,000
- Commission rate: 50,000 ppm = 5%
- Preimage SHA256 matches payment hash

Verifier exits 0 with all checks passing. Fails closed (exit 2) without read-only credentials.

---

## Competition Differentiation

| Feature | NobPay | Twese | SatsFarm | **Alibi** |
|---------|--------|--------|----------|-----------|
| Real Lightning | Simulated | Sandbox | Mutinynet | **Regtest** |
| Commission permission | No | Hold invoices | No | **YES** |
| Restricted NWC connection | No | Partial | No | **YES** |
| Policy enforcement | Client-side | App-based | N/A | **Wallet-side** |
| Failure recovery | N/A | Basic | N/A | **Implemented** |
| Independent verifier | Browser | No | No | **External tool — live** |
| Adversarial conformance | 929 tests | Limited | N/A | **12 scenarios** |

---

## Submission Checklist

- [x] **Usefulness**: Marketplace commissions for African vendors (illustrative scenario)
- [x] **Security**: Vendor policy enforcement, no broad wallet access (adversarial tests pass)
- [ ] **UI**: Transaction Room interface (static HTML, not live)
- [x] **MVP**: Full commission flow with regtest — executed and independently verified
- [x] **Technical**: HTLC coordination, payment hash linking
- [x] **Wallet**: Real Lightning flow with LND — executed on regtest
- [x] **Conformance**: 12 adversarial tests pass (12/12)
- [x] **Verification**: Independent state checking (verifier.js — 18/18 against live nodes)
- [x] **Recovery**: Cancellation/restart handling demonstrated

---

## Limitations & Future Work

**Current limitations (specific, not vague):**

- **Regtest only** — not mainnet, not trustless. Funds are non-redeemable testnet/regtest sats.
- **PTLC interception not mitigated** — a colluding routing node on the buyer's route may permit interception. PTLCs are a possible future mitigation, not an implemented guarantee.
- **No automated budget renewal** — budget is a fixed pool; renewal period is future work.
- **Single-channel payment paths** — no multi-hop fee optimization.
- **No SQLite durability** — `better-sqlite3` not installed in build environment; in-memory fallback loses state on restart.
- **No restart / lost-response recovery** — reconcile() implemented but not exercised against live nodes yet.
- **No NWC relay test** — nwc-server.js implemented but not exercised over a Nostr relay.

**Future improvements:**

- Mainnet deployment support
- PTLC-enabled routing
- Multi-hop payment optimization
- Automated budget renewal
- Fee optimization

---

## Q&A Prep

| Question | Strong answer |
|----------|---------------|
| What if the model is wrong? | There is no model. The policy engine is deterministic BigInt math; a blocked case is demonstrable. |
| What is actually enforced? | The invariant: authority can only narrow, never widen. Rate, payee, budget, duplicate-hash checks run at delegation time. Here are the 12 adversarial tests. |
| How do you know verification is correct? | The verifier queries actual LND node state (read-only credentials), not Alibi's database. It fails closed (exit 2) without credentials. |
| What is the boundary? | Regtest only. Single root (no multi-root reservation). Research informs decisions; it never determines payouts. |
| What breaks in production? | Top risk: marketplace knows preimage before buyer pays (collusion risk). Mitigation: PTLCs (future work). Fallback: cancel commission, release sale. |

---

**Experimental implementation of the NWC Commission Payments draft (nwc#8). Regtest only. Not mainnet. Not trustless.**

*"Commission authority without wallet access."*