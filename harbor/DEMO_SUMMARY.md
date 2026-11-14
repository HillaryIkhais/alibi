# REACH Demo Summary

## What Works Now

### 1. Lab Infrastructure ✓
- **Bitcoind regtest** running on port 18443
- **Alice (Merchant)** LND on port 10029/10039
- **Bob (Prober/Peer)** LND on port 10030/10040  
- **Carol (Customer)** LND on port 10031/10041
- All nodes synced to block 230+
- Channels established between all nodes

### 2. REACH Engine ✓
- `engine/bin/reach-probe.mjs` - Prepay probe implementation
- `engine/bin/reach-evidence.mjs` - Tamper-evident evidence recording
- Uses LND REST API for route verification

### 3. Demo Script ✓
- `lab/reach-full.sh` - Complete demo workflow
- Demonstrates: invoice creation → probe → diagnosis → payment → verification
- Shows actual Lightning payments settling on-chain

### 4. Evidence Output ✓
```
Invoice created for 100k sats
Probe from Carol: FAIL - insufficient liquidity (0 outbound)
Probe from Bob: SUCCESS - route found
Payment confirmed: txid 70403587f80d42b6...
CONCLUSION: Checkout is PAYABLE
```

## Key Demonstration Points

### The Problem REACH Solves
1. Valid invoice ≠ payable invoice
2. Channel exists ≠ sufficient liquidity in payment direction
3. Node online ≠ payment can succeed

### The REACH Solution
1. **Prepay probe** tests routes before customer attempts payment
2. **Diagnosis** identifies liquidity gaps, not just "payment failed"
3. **Repair options** suggested (new channel, intermediary, rebalancing)
4. **Verification** confirms payment settled with on-chain evidence

### Competitive Differentiation
- **Twese**: Savings circles with payment holding
- **SunuSats**: Merchant wallet UI
- **SatsFlow**: L402 payment routing
- **REACH**: **Payment reliability verification layer** - proves checkout is payable before customer pays

## Files Created/Modified

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Lab topology (Alice, Bob, Carol LND nodes) |
| `engine/bin/reach-probe.mjs` | Prepay probe using router/findroute |
| `engine/bin/reach-evidence.mjs` | JSONL evidence chain |
| `lab/reach-full.sh` | End-to-end demo script |
| `lab/reach-demo.sh` | Simplified demo output |
| `README.md` | Updated to REACH branding |
| `DEMO_SUMMARY.md` | This file |

## Running the Demo

```bash
# Ensure lab is running
docker compose ps

# Run the REACH demonstration
./lab/reach-full.sh

# Verify evidence chain
node engine/bin/reach-evidence.mjs <run-id> verify
```

## Submission Fit Checklist

| Criteria | Status |
|----------|--------|
| Real wallet interaction | ✓ LND CLI, invoice creation, payments |
| Regtest environment | ✓ Bitcoind + 3 LND nodes |
| Actual payments | ✓ 100k sat payment sent and confirmed |
| On-chain evidence | ✓ Transaction IDs and block heights |
| Local usefulness | ✓ Payment reliability for African merchants |
| Security | ✓ No seed transmission, operator approval |
| UX | ✓ Clear diagnosis and repair recommendations |
| Technicality | ✓ Route probing, liquidity analysis |
| Originality | ✓ Payment verification layer (not wallet/payment app) |

## Next Steps for Hackathon

1. **Build minimal UI**: Single-page HTML showing invoice, probe result, payment status
2. **Add Nostr support**: Independent probe attestations from multiple sources
3. **Record evidence**: Create tamper-evident recovery record
4. **Test failure cases**: Demonstrate more edge cases (offline peer, insufficient fee)

## Technical Notes

- Using LND v0.21.6-beta REST API
- Prepay probe via `/v1/router/findroute` endpoint
- Payment via `sendpayment` or `payinvoice`
- Evidence via `/v1/channels`, `/v1/walletbalance`, transaction data