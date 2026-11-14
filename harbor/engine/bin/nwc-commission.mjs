#!/usr/bin/env node
/**
 * NWC Commission Payment Validator
 * 
 * Implements the draft NWC commission payment mechanism:
 * - Policy validation (max commission %, allowed payee, budget)
 * - Commission bound sale invoice creation
 * - Payment hash coordination between sale and commission
 * - Adversarial rejection detection
 */

import crypto from 'crypto';

export class CommissionPolicy {
  constructor({ maxPercent = 5, allowedPayee, budgetSats, requirePreimage = false }) {
    this.maxPercent = maxPercent; // Max commission percentage
    this.allowedPayee = allowedPayee; // Pubkey of allowed marketplace
    this.budgetSats = budgetSats; // Maximum commission budget
    this.requirePreimage = requirePreimage; // Must know preimage for trustless
    this.spentSats = 0n; // Lifetime spent counter
    this.activeRequests = new Map(); // For duplicate detection
  }

  validateCommissionRequest({ requestedAmount, saleAmount, marketplacePubkey, paymentHash }) {
    const errors = [];
    
    // Check percentage limit
    const percent = (requestedAmount / saleAmount) * 100;
    if (percent > this.maxPercent) {
      errors.push({
        code: 'EXCEEDS_MAX_PERCENT',
        reason: `Requested ${percent.toFixed(1)}% exceeds maximum ${this.maxPercent}%`,
        maxAllowed: requestedAmount / (this.maxPercent / 100)
      });
    }
    
    // Check allowed payee
    if (this.allowedPayee && marketplacePubkey !== this.allowedPayee) {
      errors.push({
        code: 'UNAUTHORIZED_PAYEE',
        reason: 'Marketplace not in allowlist',
        expected: this.allowedPayee,
        received: marketplacePubkey
      });
    }
    
    // Check budget
    const remainingBudget = this.budgetSats - Number(this.spentSats);
    if (requestedAmount > remainingBudget) {
      errors.push({
        code: 'BUDGET_EXCEEDED',
        reason: 'Commission request exceeds remaining budget',
        requested: requestedAmount,
        remaining: remainingBudget
      });
    }
    
    // Check for duplicate payment hash (replay attack)
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
      feeSat: Math.ceil(requestedAmount * 0.001), // Estimated routing fee
      approvedAmount: errors.length === 0 ? requestedAmount : 0
    };
  }

  approveRequest(requestId, amountSats, paymentHash) {
    if (!this.validateCommissionRequest(this.extractRequestData(requestId))) {
      return false;
    }
    this.activeRequests.set(paymentHash, {
      requestId,
      amountSats,
      createdAt: Date.now()
    });
    return true;
  }

  recordCommission(paymentHash, wasSuccessful) {
    const request = this.activeRequests.get(paymentHash);
    if (request && wasSuccessful) {
      this.spentSats += BigInt(request.amountSats);
    }
    this.activeRequests.delete(paymentHash);
    return wasSuccessful;
  }

  extractRequestData(requestId) {
    // In production, this extracts from the NWC request structure
    return {
      requestedAmount: 5000,
      saleAmount: 100000,
      marketplacePubkey: '02...',
      paymentHash: requestId
    };
  }
}

/**
 * Commission Bound Invoice Generator
 * Creates invoices that link a sale to its commission
 */
export class CommissionInvoiceManager {
  constructor(vendorPubkey, commissionPubkey, policy) {
    this.vendorPubkey = vendorPubkey;
    this.commissionPubkey = commissionPubkey;
    this.policy = policy;
    this.activeInvoices = new Map();
  }

  /**
   * Create a commission-bound sale invoice
   * Returns both sale and commission invoice data
   */
  createCommissionBoundSale({ 
    saleAmountSats, 
    commissionPercent = 5,
    allowlistedPayee,
    budgetSats 
  }) {
    const commissionAmount = Math.floor(saleAmountSats * (commissionPercent / 100));
    const paymentHash = crypto.randomBytes(32).toString('hex');
    
    // Validate against policy
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
    
    const saleInvoice = {
      payment_hash: paymentHash,
      amount_sats: saleAmountSats,
      description: `Sale item - ${saleAmountSats} sats`,
      expiry: 3600, // 1 hour
      metadata: {
        type: 'sale_invoice',
        linked_commission: commissionAmount
      }
    };
    
    const commissionInvoice = {
      payment_hash: paymentHash,
      amount_sats: commissionAmount,
      description: `Marketplace commission - ${commissionPercent}%`,
      expiry: 3600,
      metadata: {
        type: 'commission_invoice',
        allowed_payee: allowlistedPayee,
        sale_amount: saleAmountSats
      }
    };
    
    this.activeInvoices.set(paymentHash, {
      saleInvoice,
      commissionInvoice,
      commissionAmount,
      saleAmount: saleAmountSats,
      payee: allowlistedPayee,
      createdAt: Date.now()
    });
    
    return {
      success: true,
      paymentHash,
      saleInvoice,
      commissionInvoice,
      totalBuyerPays: saleAmountSats + commissionAmount,
      vendorReceives: saleAmountSats,
      marketplaceReceives: commissionAmount,
      validation: validation
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

/**
 * Adversarial Test Simulator
 * Tests policy enforcement against malicious marketplace attempts
 */
export class AdversarialTester {
  static testOverreach(policy, baseAmount = 100000, legitimatePercent = 5) {
    console.log('\n=== ADVERSARIAL COMMISION TESTS ===\n');
    
    const tests = [
      {
        name: 'Over-limit commission (20%)',
        commissionAmount: Math.floor(baseAmount * 0.20),
        marketplacePubkey: '02marketplace...'
      },
      {
        name: 'Unauthorized payee',
        commissionAmount: Math.floor(baseAmount * 0.05),
        marketplacePubkey: '02attacker...'
      },
      {
        name: 'Budget exhaustion',
        commissionAmount: 1000000, // 1M sats
        marketplacePubkey: '02marketplace...',
        useExistingBudget: true
      },
      {
        name: 'Duplicate payment hash',
        commissionAmount: Math.floor(baseAmount * 0.05),
        marketplacePubkey: '02marketplace...',
        useExistingHash: true
      }
    ];
    
    const results = [];
    const paymentHash = crypto.randomBytes(32).toString('hex');
    
    for (const test of tests) {
      const result = policy.validateCommissionRequest({
        requestedAmount: test.commissionAmount,
        saleAmount: baseAmount,
        marketplacePubkey: test.marketplacePubkey,
        paymentHash: test.useExistingHash ? paymentHash : crypto.randomBytes(32).toString('hex')
      });
      
      console.log(`Test: ${test.name}`);
      console.log(`  Valid: ${result.valid}`);
      if (!result.valid) {
        console.log(`  Rejection: ${result.errors[0]?.reason}`);
      }
      console.log('');
      
      results.push({
        test: test.name,
        valid: result.valid,
        rejected: !result.valid,
        reason: result.errors[0]?.reason
      });
    }
    
    return results;
  }
}

// CLI entry point for demo
if (process.argv[1] === import.meta.url) {
  console.log('NWC Commission Payment Validator');
  console.log('====================================\n');
  
  // Create policy: 5% max, Bob as allowed payee, 10,000 sat budget
  const policy = new CommissionPolicy({
    maxPercent: 5,
    allowedPayee: '0225a72a6bee672de3e8dd80fcac4d0827546b761c6dbe552527b88157ac9facd5', // Bob
    budgetSats: 10000
  });
  
  const manager = new CommissionInvoiceManager(
    '03042a9655ba75aef3dbd9f67fcd67840c9c4c7444c1579dcb3569feefecb8719b', // Alice
    policy.allowedPayee,
    policy
  );
  
  // Test 1: Legitimate commission request
  console.log('[1] Legitimate request: 5% commission on 100,000 sats sale');
  const legit = manager.createCommissionBoundSale({
    saleAmountSats: 100000,
    commissionPercent: 5,
    allowlistedPayee: policy.allowedPayee,
    budgetSats: policy.budgetSats
  });
  console.log(`  Result: ${legit.success ? 'APPROVED' : 'REJECTED'}`);
  console.log(`  Total buyer pays: ${legit.totalBuyerPays} sats`);
  console.log(`  Vendor receives: ${legit.vendorReceives} sats`);
  console.log(`  Marketplace receives: ${legit.marketplaceReceives} sats`);
  console.log('');
  
  // Test 2: Adversarial attempts
  AdversarialTester.testOverreach(policy);
  
  // Test 3: Record success
  if (legit.success) {
    console.log('[2] Commission payment resolved successfully');
    const resolved = manager.recordCommissionResolution(legit.paymentHash, true);
    console.log(`  Budget spent: ${policy.spentSats} / ${policy.budgetSats} sats`);
  }
  
  console.log('\n====================================');
  console.log('DEMONSTRATION COMPLETE');
  console.log('====================================');
}