# Alibi - Voiceover Script

## Opening
Some African digital-product creators sell through marketplaces but refuse to give platforms unrestricted control of their Lightning wallets. Existing solutions either take custody of funds, grant broad spending permissions, or trust vendors to pay commissions later.

## The Problem Solved
Alibi gives a Lightning marketplace conditional authority to collect an agreed commission — without general spending authority over the vendor's wallet.

## How It Works
The vendor wallet enforces policy. The marketplace can only request commission-bound sales to approved destinations within budget limits.

### Checkout Example
Consider a buyer purchasing a digital product for 100,000 satoshis. The marketplace may request a commission invoice — but only up to 5 percent, only to an approved payee, only within a budget the seller has set. The commission, five thousand sats, is paid by the vendor from the received amount. The vendor net before routing fees: 95,000 sats.

### Policy Enforcement
But what if the marketplace tries to change its commission to twenty percent? Alibi rejects the request. The seller's original permission remains intact. Policy enforcement checks: max rate, approved payees, routing fee caps, budget limits. Duplicate payment hashes are blocked. Unauthorized payees are rejected. Budget exhaustion is rejected.

## The REACH Solution
Now consider the REACH engine — a payment reliability verification layer.

- A valid invoice does not mean a payable invoice
- A channel exists does not mean sufficient liquidity in the payment direction
- A node online does not mean payment can succeed

REACH solves this with a prepay probe. It tests routes before the customer attempts payment. It diagnoses liquidity gaps, not just "payment failed." It suggests repair options: a new channel, an intermediary, rebalancing. And it verifies payment settled with on-chain evidence.

## The User Benefit
The intersection between the product's strongest technical capability and the user's most meaningful benefit: checkout that actually works. The customer sees a clear result. The merchant gets paid. The marketplace collects its commission — properly, transparently, within bounds.

## Closing
This is not a technical experiment. This is a product built to address a real problem, with a meaningful user experience and a reason to exist.
