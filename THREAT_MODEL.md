# Threat model — what Alibi trusts and what it does not

## The one invariant

**A commission connection's authority can only narrow, never widen.** At every moment the effective
authority granted to a marketplace is a subset of the initial vendor policy: capped rate, allowed
payee(s), remaining budget, single-use payment hash. The vendor wallet enforces this; the
marketplace's honesty is never an input.

## Actors

| Actor | Goal | Trusted? |
|---|---|---|
| Vendor (Alice) | Sell via marketplace, keep 95% | Owns the policy; defines the allowlist and budget |
| Marketplace (Bob) | Collect agreed commission | NOT trusted with wallet access; can only request `make_commission_invoice` |
| Buyer (Carol) | Pay one invoice once | Untrusted; may replay, underpay, or collude |
| LND nodes | Hold/settle HTLCs | Source of truth for settlement state (queried read-only by verifier) |

## Trust boundaries

- **Vendor wallet is the enforcement point.** Rate, payee, budget, and duplicate-hash checks run at
  delegation time, inside `CommissionPolicy.validateCommission()` / `reserve()`, before any hold
  invoice is created.
- **Marketplace has a narrow method set.** `nwc-server.js` allows only `get_info`, `lookup_invoice`,
  `make_commission_invoice`; `pay_invoice`, `settle_hold_invoice`, `cancel_hold_invoice`,
  `create_connection`, etc. are blocked. The marketplace cannot move vendor funds directly.
- **Verifier trusts nothing Alibi wrote.** It queries the three LND nodes with read-only macaroons and
  fails closed (exit 2) without credentials. It never reads the app database.

## Attacks considered and defences

| Attack | Defence | Evidence |
|---|---|---|
| Request >5% commission | BigInt `EXCEEDS_MAX_PERCENT` | adversarial C01 + mutation |
| Request at 5.01% | same (boundary is exactly 5%) | adversarial C01 |
| Pay commission to attacker pubkey | `UNAUTHORIZED_PAYEE` | adversarial C02 + mutation |
| Impersonate marketplace | `UNAUTHORIZED_MARKETPLACE` | adversarial C02 |
| Exhaust budget across sales | atomic reservation from remaining pool | adversarial C03 + mutation |
| Replay a payment hash | `DUPLICATE_HASH` | adversarial C04 + mutation |
| Underpay / wrong amount | verifier checks exact msat on all three nodes | verifier.js (NOT currently reproducible) |
| Call `pay_invoice` via NWC | method blocklist | nwc-server.js (code) |
| Tamper with evidence | SHA-256 checksums + frozen manifest | `adversarial-results.json`, `mutation-results.json`, `manifest.json` |

## Known gaps (state them, do not hide them)

- **Preimage visibility / collusion.** The marketplace knows the commission invoice's preimage before
  the buyer pays; a malicious marketplace could settle early in collusion. This is a property of the
  shared-preimage draft design. Mitigation is future work (PTLCs); present fallback is cancel-and-release.
- **Single-process atomicity.** Budget reservation is atomic in one process only. Multi-root /
  distributed reservation is not built.
- **In-memory state fallback.** `better-sqlite3` is unavailable in the build environment; the service
  falls back to in-memory state that is lost on restart. Durability is implemented in code but not
  verified in this environment.
- **Live settlement is regtest node-state verification only.** `evidence/bundle.json` (25/25, exit 0)
  proves invoice/payment state on three controlled LND nodes with read-only credentials. It is not a
  Bitcoin consensus proof or a trustless attestation (claim C10).
- **Regtest only.** No mainnet/testnet deployment; funds are non-redeemable test sats.

## What the model never decides

There is no ML model in the payout path. Commission amounts are integer arithmetic; authorization is a
deterministic allowlist and cap check. An LLM could at most propose a demo script or documentation —
it never computes or approves a payment.
