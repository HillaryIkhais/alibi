#!/usr/bin/env node
/**
 * Alibi NWC Commission Handler
 * Implements NWC Commission Payments draft request handler
 * 
 * This is the vendor-side NWC endpoint that handles:
 * - make_commission_invoice request
 * - Returns sale invoice with linked payment hash
 * - Enforces commission policy (percentage, payee, budget)
 * 
 * The marketplace connection is RESTRICTED:
 * - CAN: get_info, lookup_invoice, make_commission_invoice
 * - CANNOT: pay_invoice, settle_hold_invoice, cancel_hold_invoice
 */

const crypto = require('crypto');

// Commission Policy - implements NWC draft commission_policy
class CommissionPolicy {
  constructor({ maxPercent = 5, allowedPayee, budgetMsat = 50000000, maxRoutingFeePercent = 5000 }) {
    this.maxPercent = maxPercent; // maximum commission as percentage
    this.allowedPayee = allowedPayee; // allowed marketplace pubkey
    this.budgetMsat = budgetMsat; // total budget in millisatoshis
    this.maxRoutingFeePercent = maxRoutingFeePercent; // max routing fee as ppm (5000 = 0.5%)
    this.spentMsat = 0n;
    this.activeRequests = new Map();
  }

  validateCommissionRequest({ requestedAmountMsat, saleAmountMsat, marketplacePubkey, paymentHash, commissionPayeePubkey }) {
    const errors = [];
    
    // Calculate percentage using integer arithmetic
    const percentPpm = requestedAmountMsat * 10000n / BigInt(saleAmountMsat); // parts per million
    const percent = Number(percentPpm) / 100;
    
    if (percent > this.maxPercent) {
      errors.push({ 
        code: 'EXCEEDS_MAX_PERCENT', 
        reason: `Requested ${percent.toFixed(1)}% exceeds maximum ${this.maxPercent}%` 
      });
    }
    
    // Verify payee matches allowed marketplace
    if (commissionPayeePubkey && commissionPayeePubkey !== this.allowedPayee) {
      errors.push({ 
        code: 'UNAUTHORIZED_PAYEE', 
        reason: 'Commission payee not in allowlist' 
      });
    }
    
    // Verify marketplace pubkey matches
    if (marketplacePubkey !== this.allowedPayee) {
      errors.push({ 
        code: 'UNAUTHORIZED_MARKTPPLACE', 
        reason: 'Marketplace not authorized' 
      });
    }
    
    // Check budget
    const remainingBudget = this.budgetMsat - Number(this.spentMsat);
    if (requestedAmountMsat > BigInt(remainingBudget)) {
      errors.push({ 
        code: 'BUDGET_EXCEEDED', 
        reason: 'Commission request exceeds remaining budget' 
      });
    }
    
    // Check for duplicate payment hash
    if (this.activeRequests.has(paymentHash)) {
      errors.push({ 
        code: 'DUPLICATE_HASH', 
        reason: 'Payment hash already in use for active request' 
      });
    }
    
    return {
      valid: errors.length === 0,
      errors,
      feeSat: Math.ceil(Number(requestedAmountMsat) * 0.001),
      approvedAmountMsat: errors.length === 0 ? requestedAmountMsat : 0n
    };
  }

  recordCommission(paymentHash, wasSuccessful) {
    const request = this.activeRequests.get(paymentHash);
    if (request && wasSuccessful) {
      this.spentMsat += BigInt(request.amountMsat);
    }
    this.activeRequests.delete(paymentHash);
    return wasSuccessful;
  }

  reserveRequest(paymentHash, amountMsat) {
    this.activeRequests.set(paymentHash, { amountMsat, createdAt: Date.now() });
  }
}

/**
 * NWC Request Handler for make_commission_invoice
 * 
 * Request format (NWC draft):
 * {
 *   "method": "make_commission_invoice",
 *   "params": {
 *     "amount": <commission amount in millisatoshis>,
 *     "payment_hash": "<64-char-hex>",
 *     "commission_invoice": "<BOLT11 commission invoice>",
 *     "expiry": <seconds until expiry>,
 *     "description": "<optional description>",
 *     "metadata": {}
 *   }
 * }
 * 
 * Response format:
 * {
 *   "result": "success" | "error",
 *   "data": {
 *     "payment_hash": "<64-char-hex>",
 *     "invoice": "<BOLT11 sale invoice>",
 *     "amount": <sale amount in millisatoshis>,
 *     "expires_at": <unix timestamp>,
 *     "metadata": {}
 *   }
 * }
 */
class NwcCommissionHandler {
  constructor(policy, lndClient = null) {
    this.policy = policy;
    this.lnd = lndClient;
    this.activeCommissions = new Map();
  }

  /**
   * Handle make_commission_invoice NWC request
   * @param {string} connectionPubkey - The marketplace's NWC connection pubkey
   * @param {string} commissionInvoiceBlt11 - The marketplace's commission BOLT11 invoice
   * @param {string} paymentHash - Shared payment hash for linking invoices
   * @param {number} expirySeconds - Requested expiry time
   * @returns {Promise<object>} - Sale invoice or error
   */
  async handleMakeCommissionInvoice(connectionPubkey, commissionInvoiceBlt11, paymentHash, expirySeconds = 3600) {
    // 1. Validate connection is authorized
    if (connectionPubkey !== this.policy.allowedPayee) {
      return {
        result: 'error',
        error: {
          code: 'UNAUTHORIZED_CONNECTON',
          message: 'Connection not authorized for commission operations'
        }
      };
    }
    
    // 2. Parse the commission BOLT11 invoice to extract amount and payee
    let commissionAmountMsat;
    let commissionPayeePubkey;
    try {
      const parsed = this.parseBolt11(commissionInvoiceBlt11);
      commissionAmountMsat = BigInt(parsed.amountMsat || 0);
      commissionPayeePubkey = parsed.payee;
      if (!parsed.amountMsat) {
        return {
          result: 'error',
          error: {
            code: 'INVALID_INVOICE',
            message: 'Could not parse commission invoice amount'
          }
        };
      }
    } catch (e) {
      return {
        result: 'error',
        error: {
          code: 'INVALID_INVOICE',
          message: `Failed to parse commission invoice: ${e.message}`
        }
      };
    }
    
    // 3. Calculate sale amount = commission / percent
    const saleAmountMsat = commissionAmountMsat * 100n / BigInt(this.policy.maxPercent);
    
    // 4. Validate commission request against policy
    const validation = this.policy.validateCommissionRequest({
      requestedAmountMsat: commissionAmountMsat,
      saleAmountMsat: saleAmountMsat,
      marketplacePubkey: connectionPubkey,
      paymentHash: paymentHash,
      commissionPayeePubkey
    });
    
    if (!validation.valid) {
      return {
        result: 'error',
        error: {
          code: 'POLICY_REJECTION',
          message: validation.errors[0]?.reason || 'Policy rejection',
          details: validation.errors
        }
      };
    }
    
    // 5. Reserve budget
    this.policy.reserveRequest(paymentHash, commissionAmountMsat);
    
    // 6. Create linked sale invoice with same payment hash
    let saleInvoice = null;
    if (this.lnd) {
      try {
        const saleInvoiceResult = await this.createSaleInvoice(saleAmountMsat, paymentHash);
        saleInvoice = saleInvoiceResult.payment_request;
      } catch (e) {
        return {
          result: 'error',
          error: {
            code: 'INVOICE_CREATION_FAILED',
            message: e.message
          }
        };
      }
    }
    
    // Store commission request for later reconciliation
    this.activeCommissions.set(paymentHash, {
      commissionAmountMsat,
      saleAmountMsat,
      connectionPubkey,
      commissionPayeePubkey,
      createdAt: Date.now(),
      expiry: expirySeconds
    });
    
    return {
      result: 'success',
      data: {
        payment_hash: paymentHash,
        invoice: saleInvoice,
        amount_msat: saleAmountMsat.toString(),
        expires_at: Math.floor(Date.now() / 1000) + expirySeconds,
        metadata: {
          commission_amount_msat: commissionAmountMsat.toString(),
          commission_payee: commissionPayeePubkey
        }
      }
    };
  }

  /**
   * Parse a BOLT11 invoice (simplified implementation)
   * In production, use a proper BOLT11 parsing library
   */
  parseBolt11(invoice) {
    // This is a simplified BOLT11 parser
    // In production, use bolt11 library: npm install bolt11
    
    // Extract payment hash from invoice (between 'lnbc' and '1' or 'm' or 'u')
    // This is a mock - real implementation would use proper parsing
    
    // For demo purposes, return a mock structure
    // Real implementation would decode the BOLT11 string
    
    // Basic BOLT11 format: lnbc<amount><unit><payment_hash><expiry><signature>
    // We'll extract what we can
    
    if (!invoice.startsWith('lnbc')) {
      throw new Error('Not a valid BOLT11 invoice');
    }
    
    // Mock parsing - in reality you'd use bolt11.decode()
    return {
      amountMsat: 5000000, // 5,000 sats in millisatoshis
      payee: '02marketplace123456789abcdef',
      paymentHash: crypto.randomBytes(32).toString('hex'),
      expiry: 3600,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Create a sale hold invoice
   */
  async createSaleInvoice(saleAmountMsat, paymentHash) {
    // In production, call LND REST API:
    // POST /v1/invoice with { value_msat, payment_hash, description }
    
    // For now, return a mock BOLT11 invoice
    const amountSats = saleAmountMsat / 1000n;
    const mockInvoice = `lntb${amountSats}0n1p${paymentHash.slice(0, 90)}...`.replace('0n1p', '1p');
    
    return {
      payment_request: mockInvoice,
      r_hash: crypto.createHash('sha256').update(paymentHash).digest('hex'),
      payment_hash: paymentHash
    };
  }

  /**
   * Record that commission was settled
   */
  async recordCommissionSettlement(paymentHash, preimage) {
    const commission = this.activeCommissions.get(paymentHash);
    if (!commission) {
      return { success: false, reason: 'Commission not found' };
    }
    
    // Verify preimage matches payment hash
    const calculatedHash = crypto.createHash('sha256').update(preimage).digest('hex');
    if (calculatedHash !== paymentHash) {
      return { success: false, reason: 'Preimage does not match payment hash' };
    }
    
    // Record settlement
    this.policy.recordCommission(paymentHash, true);
    
    return { 
      success: true, 
      commission,
      preimage
    };
  }
}

// Export for use in other modules
module.exports = {
  CommissionPolicy,
  NwcCommissionHandler
};

// CLI for testing
if (require.main === module) {
  console.log('NWC Commission Handler');
  console.log('Usage:');
  console.log('  const { NwcCommissionHandler } = require("./nwc-commission-handler.js")');
}