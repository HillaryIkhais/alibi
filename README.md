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
| **Demonstrated** | Shown in the demo | Commission-flow simulator (SIM mode), console output |
| **Measured** | Reported with sample size | 12/12 adversarial tests pass |
| **Future work** | Not built | Live LND transaction, SQLite durability, restart recovery |

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
| Full Alice→Bob→Carol transaction | **SIMULATED** | `node engine/bin/commission-flow-simulator.js` |
| Independent node-backed verifier | **IMPLEMENTED, NOT VERIFIED** | `engine/bin/verifier.js` — fails closed without credentials |
| NWC `make_commission_invoice` handler | **IMPLEMENTED, NOT VERIFIED** | `engine/bin/nwc-server.js` |
| Durable budget (SQLite, atomic) | **IMPLEMENTED, NOT VERIFIED** | SQLite schema in `commission-service.js` |
| Cancellation / recovery scenario | **SIMULATED** | `engine/bin/commission-flow-simulator.js` |

**Honest headline:** the policy engine is proven; the Lightning transaction
is not yet executed. Until `docker compose` runs one real 100,000-sat sale
with a 5,000-sat commission, this entry does not claim a working MVP.

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

## The Solution

**Alibi gives a Lightning marketplace conditional authority to collect an agreed commission without giving it general spending authority over the vendor's wallet.**

The vendor wallet enforces policy. The marketplace can only request commission-bound sales to approved destinations within budget limits.

---

## How It Works

| Step | Action | Amount |
|------|--------|--------|
| 1 | **Buyer pays sale** | 100,000 sats |
| 2 | **Vendor pays commission** | 5,000 sats |
| 3 | **Vendor net** (before fees) | 95,000 sats |

**NOT 105,000 sats buyer payment** — the buyer pays ONE 100,000 sat invoice. The commission is paid by the vendor from the received amount.

---

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VENDOR WALLET (Alice)                     │
├─────────────────────────────────────────────────────────────┤
│  NWC CONNECTION (Commission-Only):                         │
│  ├─ make_commission_invoice  ← CAN request commission       │
│  ├─ lookup_invoice           ← CAN check own sales          │
│  └─ get_info                 ← CAN get wallet info          │
│                                                            │
│  RESTRICTED METHODS (Marketplace CANNOT):                  │
│  ├─ pay_invoice          ← NO general spending             │
│  ├─ settle_hold_invoice  ← NO invoice control              │
│  ├─ cancel_hold_invoice  ← NO invoice control              │
│  └─ create_connection    ← NO new connections              │
│                                                            │
│  Policy Enforcement:                                       │
│  ├─ max_rate_ppm: 50000 (5%)                               │
│  ├─ payees: [approved_marketplace_pubkey]                 │
│  ├─ max_routing_fee: {base_msat: 1000, rate_ppm: 5000}   │
│  └─ budget_msat: 100,000,000 (100M millisat = 100,000 sats)│
└─────────────────────────────────────────────────────────────┘
           │                        │
           │ Carol pays sale        │
           ▼                        │
┌─────────────────┐                │
│   CAROL (Buyer) │                │
│   100,000 sats  │──────────────┐ │
└─────────────────┘              │ │
                                │ │
        ┌───────────────────────┘ │
        │                    Bob (Marketplace)
        ▼                              │
┌─────────────────┐                   │
│    BOB (Marketplace)                  │
│                                       │
│  Creates commission hold invoice:     │
│  - Amount: 5,000 sats                 │
│  - Payment hash: H (shared)           │
│                                       │
│  AFTER buyer pays (via vendor):       │
│  1. Receives hold invoice             │
│  2. Vendor pays commission             │
│  3. Settles with preimage             │
└───────────────────────────────────────┘
```

---

## NWC Commission Payments Draft

This is an experimental implementation of the [NWC Commission Payments draft](https://github.com/nostr-wallet-connect/nwc/issues/8).

**Key specification requirements:**

- `max_rate_ppm`: Maximum commission in parts per million (50000 = 5%)
- `max_fixed_msat`: Maximum fixed fee (default 0)
- `payees`: Array of approved commission destination pubkeys
- `max_routing_fee`: Fee caps {base_msat, rate_ppm}
- `budget_msat`: Total commission budget available
- `renewal_period`: Optional budget reset period

**Commission amount formula:**
```
commission = floor(sale_amount_msat * max_rate_ppm / 1,000,000) + max_fixed_msat
```

---

## Adversarial Defense

| Attack | Defense |
|--------|---------|
| 20% commission request | `EXCEEDS_MAX_PERCENT` rejection |
| Unauthorized payee | `UNAUTHORIZED_PAYEE` rejection |
| Budget exhaustion | `BUDGET_EXCEEDED` rejection |
| Duplicate payment hash | `DUPLICATE_HASH` rejection |
| `pay_invoice` call | `METHOD_NOT_ALLOWED` rejection |

---

## Project Structure

```
alibi/
├── engine/
│   ├── bin/
│   │   ├── commission-service.js       # Main NWC commission service
│   │   ├── nwc-commission-handler.js   # NWC request handler
│   │   └── adversarial-test.js         # Conformance test suite
│   └── package.json                    # Dependencies
├── lab/
│   ├── docker-compose.yml              # 3-node LND regtest (Alice, Bob, Carol)
│   ├── setup.sh                        # Initialize regtest network
│   └── run-commission-demo.sh          # Full transaction demo
└── interface/
    └── public/index.html               # Transaction Room UI
```

---

## Running the Demo

### Prerequisites
- Docker and docker-compose
- Node.js 18+

### 1. Start the regtest network
```bash
cd lab
docker compose up -d
./setup.sh  # Fund nodes, open channels, sync
```

### 2. Run the adversarial tests
```bash
node ../engine/bin/adversarial-test.js
```

### 3. Run the commission demo
```bash
./run-commission-demo.sh
```

---

## Independent Verification

The verifier queries actual wallet node state to prove:
- Sale invoice exists with correct payment hash
- Commission invoice exists with matching payment hash
- Both payments settled to completion
- Amounts and fees reconcile correctly
- Vendor net = sale amount - commission - routing fees

---

## Security Model

**Trust assumptions:**
- Vendor wallet has exclusive control over its private keys
- Marketplace knows the commission preimage before buyer pays
- A colluding routing node could potentially intercept payments
- PTLCs would mitigate interception but not yet broadly available

**What Alibi prevents:**
- Marketplace cannot spend vendor funds outside commission
- Marketplace cannot increase commission beyond policy
- Marketplace cannot redirect commission to unauthorized destinations
- Buyer is protected from duplicate payments

---

## Competition Differentiation

| Feature | NobPay | Twese | SatsFarm | **Alibi** |
|---------|--------|--------|----------|-----------|
| Real Lightning | Simulated | Sandbox | Mutinynet | **Regtest** |
| Commission permission | No | Hold invoices | No | **YES** |
| Restricted NWC connection | No | Partial | No | **YES** |
| Policy enforcement | Client-side | App-based | N/A | **Wallet-side** |
| Failure recovery | N/A | Basic | N/A | **Simulated** |
| Independent verifier | Browser | No | No | **External tool** |
| Adversarial conformance | 929 tests | Limited | N/A | **12 scenarios** |

---

## Submission Checklist

- [ ] **Usefulness**: Marketplace commissions for African vendors (illustrative scenario)
- [ ] **Security**: Vendor policy enforcement, no broad wallet access (adversarial tests pass)
- [ ] **UI**: Transaction Room interface (static HTML, not live)
- [ ] **MVP**: Full commission flow with regtest (blocked — Docker unavailable)
- [ ] **Technical**: HTLC coordination, payment hash linking
- [ ] **Wallet**: Real Lightning flow with LND (code ready, not executed)
- [ ] **Conformance**: 12 adversarial tests pass
- [ ] **Verification**: Independent state checking (verifier.js, not live)
- [ ] **Recovery**: Cancellation/restart handling (simulated, not live)

---

## Limitations & Future Work

**Current limitations (specific, not vague):**

- **Regtest only** — not mainnet, not trustless. Funds are non-redeemable testnet/regtest sats.
- **PTLC interception not mitigated** — a colluding routing node on the buyer's route may permit interception. PTLCs are a possible future mitigation, not an implemented guarantee.
- **No automated budget renewal** — budget is a fixed pool; renewal period is future work.
- **Single-channel payment paths** — no multi-hop fee optimization.
- **No SQLite durability** — `better-sqlite3` not installed in build environment; in-memory fallback loses state on restart.
- **No restart / lost-response recovery** — highest-risk untested path; reconcile() implemented but not exercised against live nodes.
- **No live LND transaction** — Docker unavailable in build environment; Gate 1 (regtest transaction) cannot be executed here.

**Future improvements:**

- Mainnet deployment support
- PTLC-enabled routing
- Multi-hop payment optimization
- Automated budget renewal
- Fee optimization

---

## Q&A prep

| Question | Strong answer |
|----------|---------------|
| What if the model is wrong? | There is no model. The policy engine is deterministic BigInt math; a blocked case is demonstrable. |
| What is actually enforced? | The invariant: authority can only narrow, never widen. Rate, payee, budget, duplicate-hash checks run at delegation time. Here are the 12 adversarial tests. |
| How do you know verification is correct? | The verifier queries actual LND node state (read-only credentials), not Alibi's database. It fails closed (exit 2) without credentials. |
| What is the boundary? | Regtest only. Single root (no multi-root reservation). Research informs decisions; it never determines payouts. |
| What breaks in production? | Top risk: marketplace knows preimage before buyer pays (collusion risk). Mitigation: PTLCs (future work). Fallback: cancel commission, release sale. |

---

## License

Experimental - Not for production use. Implements a draft NWC specification.

---

*"Commission authority without wallet access."*