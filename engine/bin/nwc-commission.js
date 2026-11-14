#!/usr/bin/env node
/**
 * NWC Commission Payment Validator
 * CJS version for reliable execution
 */

const crypto = require('crypto');

class CommissionPolicy {
  constructor({ maxPercent = 5, allowedPayee, budgetSats, requirePreimage = false }) {
    this.maxPercent = maxPercent;
    this.allowedPayee = allowedPayee;
    this.budgetSats = budgetSats;
    this.requirePreimage = requirePreimage;
    this.spentSats = 0n;
    this.activeRequests = new Map();
  }

  validateCommissionRequest({ requestedAmount, saleAmount, marketplacePubkey, paymentHash }) {
    const errors = [];
    
    const percent = (requestedAmount / saleAmount) * 100;
    if (percent > this.maxPercent) {
      errors.push({
        code: 'EXCEEDS_MAX_PERCENT',
        reason: `Requested ${percent.toFixed(1)}% exceeds maximum ${this.maxPercent}%`,
        maxAllowed: requestedAmount / (this.maxPercent / 100)
      });
    }
    
    if (this.allowedPayee && marketplacePubkey !== this.allowedPayee) {
      errors.push({
        code: 'UNAUTHORIZED_PAYEE',
        reason: 'Marketplace not in allowlist',
        expected: this.allowedPayee,
        received: marketplacePubkey
      });
    }
    
    const remainingBudget = this.budgetSats - Number(this.spentSats);
    if (requestedAmount > remainingBudget) {
      errors.push({
        code: 'BUDGET_EXCEEDED',
        reason: 'Commission request exceeds remaining budget',
        requested: requestedAmount,
        remaining: remainingBudget
      });
    }
    
    if (this.activeRequests.has(paymentHash)) {
      errors.push({
        code: 'DUPLICATE_PAYMENT_HASH',
        reason: 'Payment hash already in use for active request',
        usedBy: this.activeRequests.get(paymentHash)
      });
    }
    
    return {
      valid: errors.length === 0,
      errors,
      feeSat: Math.ceil(requestedAmount * 0.001),
      approvedAmount: errors.length === 0 ? requestedAmount : 0
    };
  }

  recordCommission(paymentHash, wasSuccessful) {
    const request = this.activeRequests.get(paymentHash);
    if (request && wasSuccessful) {
      this.spentSats += BigInt(request.amountSats);
    }
    this.activeRequests.delete(paymentHash);
    return wasSuccessful;
  }
}

class CommissionInvoiceManager {
  constructor(vendorPubkey, commissionPubkey, policy) {
    this.vendorPubkey = vendorPubkey;
    this.commissionPubkey = commissionPubkey;
    this.policy = policy;
    this.activeInvoices = new Map();
  }

  createCommissionBoundSale({ saleAmountSats, commissionPercent = 5, allowlistedPayee, budgetSats }) {
    const commissionAmount = Math.floor(saleAmountSats * (commissionPercent / 100));
    const paymentHash = crypto.randomBytes(32).toString('hex');
    
    const validation = this.policy.validateCommissionRequest({
      requestedAmount: commissionAmount,
      saleAmount: saleAmountSats,
      marketplacePubkey: allowlistedPayee,
      paymentHash
    });
    
    if (!validation.valid) {
      return {
        success: false,
        validation,
        reason: 'Commission request rejected by vendor policy'
      };
    }
    
    this.activeInvoices.set(paymentHash, {
      commissionAmount,
      saleAmount: saleAmountSats,
      payee: allowlistedPayee,
      createdAt: Date.now()
    });
    
    return {
      success: true,
      paymentHash,
      saleInvoice: { payment_hash: paymentHash, amount_sats: saleAmountSats },
      commissionInvoice: { payment_hash: paymentHash, amount_sats: commissionAmount },
      totalBuyerPays: saleAmountSats + commissionAmount,
      vendorReceives: saleAmountSats,
      marketplaceReceives: commissionAmount,
      validation
    };
  }

  recordCommissionResolution(paymentHash, success) {
    if (this.activeInvoices.has(paymentHash)) {
      this.policy.recordCommission(paymentHash, success);
      const invoice = this.activeInvoices.get(paymentHash);
      this.activeInvoices.delete(paymentHash);
      return { resolved: true, success, ...invoice };
    }
    return { resolved: false, reason: 'Invoice not found or already resolved' };
  }
}

// MAIN DEMO
console.log('NWC COMMISSION PAYMENT VALIDATOR');
console.log('====================================\n');

const policy = new CommissionPolicy({
  maxPercent: 5,
  allowedPayee: '0225a72a6bee672de3e8dd80fcac4d0827546b761c6dbe552527b88157ac9facd5',
  budgetSats: 10000
});

const manager = new CommissionInvoiceManager(
  '03042a9655ba75aef3dbd9f67fcd67840c9c4c7444c1579dcb3569feefecb8719b',
  policy.allowedPayee,
  policy
);

console.log('[1] Legitimate request: 5% commission on 100,000 sats sale');
const legit = manager.createCommissionBoundSale({
  saleAmountSats: 100000,
  commissionPercent: 5,
  allowlistedPayee: policy.allowedPayee,
  budgetSats: policy.budgetSats
});

console.log(`  Result: ${legit.success ? 'APPROVED' : 'REJECTED'}`);
if (legit.success) {
  console.log(`  Total buyer pays: ${legit.totalBuyerPays} sats`);
  console.log(`  Vendor receives: ${legit.vendorReceives} sats`);
  console.log(`  Marketplace receives: ${legit.marketplaceReceives} sats`);
  console.log(`  Payment hash: ${legit.paymentHash.slice(0, 20)}...`);
}
console.log('');

console.log('=== ADVERSARIAL COMMISSION TESTS ===\n');

const tests = [
  { name: 'Over-limit commission (20%)', commissionAmount: 20000, marketplacePubkey: '02marketplace...' },
  { name: 'Unauthorized payee', commissionAmount: 5000, marketplacePubkey: '02attacker...' },
  { name: 'Budget exhaustion', commissionAmount: 1000000, marketplacePubkey: '02marketplace...' }
];

for (const test of tests) {
  const result = policy.validateCommissionRequest({
    requestedAmount: test.commissionAmount,
    saleAmount: 100000,
    marketplacePubkey: test.marketplacePubkey,
    paymentHash: crypto.randomBytes(32).toString('hex')
  });
  
  console.log(`Test: ${test.name}`);
  console.log(`  Valid: ${result.valid}`);
  if (!result.valid) {
    console.log(`  Rejection: ${result.errors[0]?.reason}`);
  }
  console.log('');
}

if (legit.success) {
  console.log('[2] Commission payment resolved successfully');
  manager.recordCommissionResolution(legit.paymentHash, true);
  console.log(`  Budget spent: ${policy.spentSats} / ${policy.budgetSats} sats`);
}

console.log('\n====================================');
console.log('DEMONSTRATION COMPLETE');
console.log('====================================');