# ALIBI — Commission Authority Without Wallet Access

**Experimental NWC Commission Payments implementation | Vendor-controlled | Lightning-native**

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
| Failure recovery | N/A | Basic | N/A | **Implemented** |
| Independent verifier | Browser | No | No | **External tool** |
| Adversarial conformance | 929 tests | Limited | N/A | **20+ scenarios** |

---

## Submission Checklist

- [x] **Usefulness**: Marketplace commissions for African vendors
- [x] **Security**: Vendor policy enforcement, no broad wallet access
- [x] **UI**: Transaction Room interface
- [x] **MVP**: Full commission flow with regtest
- [x] **Technical**: HTLC coordination, payment hash linking
- [x] **Wallet**: Real Lightning flow with LND
- [x] **Conformance**: 20+ adversarial tests
- [x] **Verification**: Independent state checking
- [x] **Recovery**: Cancellation/restart handling

---

## Limitations & Future Work

**Current limitations:**
- Regtest implementation (not mainnet)
- PTLC interception not mitigated
- No automated budget renewal
- Single-channel payment paths

**Future improvements:**
- Mainnet deployment support
- PTLC-enabled routing
- Multi-hop payment optimization
- Automated budget renewal
- Fee optimization

---

## License

Experimental - Not for production use. Implements a draft NWC specification.

---

*"Commission authority without wallet access."*