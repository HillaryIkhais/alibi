# ALIBI — Sponsor-Native Integration Brief (NWC)

## Sponsor + Primitive

| Field | Value |
|-------|-------|
| Sponsor | Nostr Wallet Connect (NWC) |
| Primitive/rail | Commission Payments draft (nwc#8) |
| Method | `make_commission_invoice` |
| Extension | Experimental (placeholder identifier `XX`) |

## What it uniquely enables

A marketplace can request a commission-bound sale from a vendor wallet through
a restricted NWC connection, without receiving `pay_invoice`, `settle_hold_invoice`,
`cancel_hold_invoice`, or any broad spending method. The vendor wallet enforces
the commission policy — not the marketplace UI.

## What the sponsor lacks a reference for

No reference implementation of the Commission Payments draft exists. Alibi is
the first vendor-side implementation of `make_commission_invoice` with:
- Policy enforcement (max rate, payee allowlist, budget)
- Hold invoice coordination (sale + commission share one payment hash)
- Failure/recovery (cancellation, restart reconciliation)
- Independent verification (read-only node queries)

## Our workflow

```
Marketplace (Bob)          Vendor Wallet (Alice)          Buyer (Carol)
      │                              │                         │
      │── make_commission_invoice ───┼─┐                       │
      │  (commission invoice BOLT11) │ │                       │
      │                              │ ├─ validate policy       │
      │                              │ ├─ reserve budget        │
      │                              │ ├─ create hold sale inv  │
      │◄── sale invoice BOLT11 ──────┼─┘                       │
      │                              │                         │
      │                              │◄── Carol pays 100k sats │
      │                              │                         │
      │                              │─ pay commission 5k sats ──┐
      │                              │                         │
      │◄── commission settled ───────┼─┘                       │
      │                              │                         │
      │                              │─ settle sale via preimage│
      │                              │                         │
```

## Where the primitive is load-bearing

The `make_commission_invoice` method IS the product. Remove it and Alibi loses
its core value — there is no decorative panel. The NWC connection's restricted
method set (`get_info`, `lookup_invoice`, `make_commission_invoice`) is the
security boundary.

## Remove-the-API test

Remove NWC → Alibi cannot exist. The commission policy, hold invoices, and
preimage coordination all flow through the NWC method. L3 integration.

## Inspectability surface

Inside the product, a judge can see:
- Underlying records: sale invoice, commission invoice, payment hash
- Source and timestamp: from LND node queries (verifier.js)
- Links to the source: node-backed, not app-claimed
- Sample size: 16/16 adversarial tests
- Confidence: deterministic BigInt policy, no floats
- Refresh policy: verifier queries live node state
- What was inferred vs observed: all observed from node state
- What the human decided, and why: vendor set policy, marketplace requested

## Evidence + timestamps + limits

| Evidence | Source | Timestamp | Limit |
|----------|--------|-----------|-------|
| Adversarial results | `evidence/adversarial-results.json` | generated_at | 16/16 pass |
| Verifier bundle | `evidence/bundle.json` (live nodes) | generated_at | read-only |
| Code hash | git commit | commit date | SHA-256 |
| Policy limits | commission-service.js | N/A | 5% max, 100k sats budget |

## Authority boundary (what the primitive must never decide)

The NWC commission connection must never:
- `pay_invoice` — general spending
- `settle_hold_invoice` — invoice control
- `cancel_hold_invoice` — invoice control
- `create_connection` — new connections
- Change the commission percentage or payee

## Fallback behavior

- LND unavailable → SIM mode, explicitly labeled, never misrepresented as verified
- No credentials → verifier fails closed (exit 2), no false positives
- Budget exhausted → `BUDGET_EXCEEDED` rejection, no partial approval

## Track fit / judge legibility

- Sponsor primitive is central to value (L3)
- Judge can recognize deep integration (NWC method + hold invoices)
- Rubric rewards inspectable evidence (verifier.js, evidence bundles)
- Sponsor lacks reference workflow (first Commission Payments implementation)
- Loop closes in time available (simulator + adversarial tests complete)

## Non-claims

- Not mainnet (regtest only)
- Not trustless (marketplace knows preimage before buyer pays)
- Not a production bank (experimental draft implementation)
- Not "safer than Paystack" (different problem: self-custodial NWC permission)

## Demo scene

The 2-3 minute video shows:
1. Vendor sets 5% max + Bob as allowed payee
2. Marketplace requests 20% commission → BLOCKED
3. Marketplace requests 5% → ACCEPTED, real BOLT11 sale invoice
4. Carol pays 100,000 sats (one invoice)
5. Alice pays Bob 5,000 sats commission
6. Bob settles with preimage; Alice releases sale
7. Independent verifier confirms all three node states
