# NWC Commission Payment — Lightning-native Marketplace Payments

**Commission rail for Nostr Wallet Connect marketplaces.**

Marketplace commissions in Bitcoin/Lightning require either custody, broad wallet permissions, trust, or two buyer payments. NWC Commission Payments lets the vendor enforce limits and approve destinations—ensuring the commission can only go to an approved marketplace, at an approved percentage, within an approved budget.

## The Gap

Paystack and SMESNG take 5-7.5% commissions using vendor-controlled subaccounts. Lightning marketplaces take an alternative: grant the platform broad wallet access (unsafe), or ask buyers to pay twice (bad UX), or trust the vendor to pay later (unreliable).

The NWC community has an open draft proposal for this mechanism: Commission Payments. It specifies a `make_commission_invoice` method and a `commission_policy`. No implementation exists yet.

## How It Works

1. **Vendor approves a policy**: max 5% commission, only specific payee allowed, 10,000 sat budget
2. **Marketplace requests a sale**: "100,000 sats item, take 5,000 commission"
3. **Vendor wallet validates**: Rejects 20% commission, unauthorized payee, budget overrun
4. **Buyer pays once**: Single 105,000 sat Lightning payment
5. **Commission splits**: 100,000 sats to vendor, 5,000 sats to marketplace (same payment hash)
6. **Outcome verified**: Both payments settle, evidence recorded

## Adversarial Defense

```
Marketplace attempts 20% commission → VENDOR WALLET BLOCKS
Marketplace attempts attacker payee → VENDOR WALLET BLOCKS  
Marketplace reuses payment hash → VENDOR WALLET BLOCKS
```

The vendor's wallet service enforces policy—not the marketplace. It only exposes commission methods, not general payment spending.

## Running the Demo

```bash
docker compose up -d        # Start regtest network
./lab/setup.sh              # Fund and connect nodes
./lab/run-commission-demo.sh  # Full commission flow demo
node engine/bin/nwc-commission.js  # Validator test
```

## Architecture

```
vendor-wallet/ (Alice)
    ├─ commission_policy.json  ← max %, allowed payee, budget
    ├─ validate_commission()   ← reject over-limit requests
    ├─ create_linked_invoice() ← sale + commission w/ shared hash
    └─ enforce_resolution()    ← release sale only after commission settles

marketplace/ (Bob)
    └─ make_commission_invoice request ← policy-compliant only

buyer/ (Carol)
    └─ single payment → both legs resolve
```

## Files

| Location | Purpose |
|----------|---------|
| `engine/bin/nwc-commission.js` | Policy validator, invoice manager |
| `lab/run-commission-demo.sh` | Demonstration script |
| `interface/public/index.html` | Brutalist commission UX |
| `COMMISSION_IMPLEMENTATION.md` | Technical documentation |

## Submission Checklist

- **Usefulness**: Marketplace commissions for African vendors
- **Security**: Vendor policy enforcement, no broad wallet access
- **UI**: Raw, uncompromising transaction flow
- **MVP**: Policy validation + adversarial demo
- **Technical**: HTLC coordination, payment hash linking
- **Wallet**: Real Lightning flow (needs integration)

> **Note**: This is an experimental implementation of the NWC Commission draft. Do not use in production without auditing.