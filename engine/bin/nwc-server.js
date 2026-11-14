#!/usr/bin/env node
/**
 * Alibi NWC Server - Commission Payment Request Handler
 * Implements NWC Commission Payments draft as a reference wallet
 * 
 * This server:
 * 1. Validates NWC connections against allowed methods
 * 2. Handles make_commission_invoice requests
 * 3. Enforces vendor commission policy
 * 4. Returns BOLT11 sale invoices
 * 
 * RESTRICTED: Marketplace connections can ONLY:
 * - get_info
 * - lookup_invoice  
 * - make_commission_invoice
 * 
 * BLOCKED: pay_invoice, settle_hold_invoice, cancel_hold_invoice, etc.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const url = require('url');

// Environment configuration
const PORT = process.env.HARBOR_NWC_PORT || 8080;
const LND_REST_URL = process.env.HARBOR_LND_REST_URL || 'http://127.0.0.1:10039';
const LND_MACAROON = process.env.HARBOR_LND_MACAROON || '';
const TLS_CERT = process.env.HARBOR_LND_TLS_CERT || null;

// Import commission components
const { CommissionPolicy, NwcCommissionHandler } = require('./nwc-commission-handler.js');

// Commission Policy Configuration
const COMMISSION_POLICY = {
  maxPercent: 5,                           // Maximum 5% commission
  allowedPayee: process.env.HARBOR_MARKETPLACE_PUBKEY || '0225a72a6bee672de3e8dd80fcac4d0827546b761c6dbe552527b88157ac9facd5',
  budgetMsat: 100000000,                   // 100,000 sats budget
  maxRoutingFeePercent: 5000               // 0.5% max routing fee
};

// Allowed NWC methods for this restricted connection
const ALLOWED_METHODS = new Set([
  'get_info',
  'lookup_invoice',
  'make_commission_invoice'
]);

// Block list for dangerous methods
const BLOCKED_METHODS = new Set([
  'pay_invoice',
  'settle_hold_invoice',
  'cancel_hold_invoice',
  'create_connection',
  'close_connection',
  'list_connected_applications',
  'revoke_connection',
  'list_incoming_payments',
  'keysend'
]);

class NwcServer {
  constructor() {
    this.policy = new CommissionPolicy(COMMISSION_POLICY);
    this.commissionHandler = new NwcCommissionHandler(this.policy, null);
    this.connections = new Map(); // pubkey -> connection info
    this.approvedConnections = new Set(); // Approved NWC connection pubkeys
  }

  async handleRequest(req, res) {
    try {
      const contentType = req.headers['content-type'] || '';
      let body = '';
      
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = contentType.includes('application/nostr+json') || contentType.includes('application/json')
            ? JSON.parse(body)
            : null;

          if (!data) {
            this.sendError(res, 400, 'Invalid request');
            return;
          }

          // NIP-47 Request: kind 23194
          if (data.kind === 23194 && data.tags && data.tags.some(t => t[0] === 'e' && t[1].startsWith('nostr:')) {
            await this.handleNip47Request(data, res);
          } else if (data.method) {
            // Direct NWC method call
            await this.handleNwcMethod(data, res);
          } else {
            this.sendError(res, 400, 'Unknown request format');
          }
        } catch (e) {
          this.sendError(res, 500, 'Internal error', e.message);
        }
      });
    } catch (e) {
      this.sendError(res, 500, 'Request handling error', e.message);
    }
  }

  async handleNip47Request(data, res) {
    // NIP-47 request format
    const { method, params, connection_id } = data;
    
    if (BLOCKED_METHODS.has(method)) {
      this.sendError(res, 23194, 'METHOD_NOT_ALLOWED', 
        `Method ${method} is not permitted for commission-only connections`);
      return;
    }

    if (!ALLOWED_METHODS.has(method)) {
      this.sendError(res, 23194, 'METHOD_NOT_FOUND', 
        `Method ${method} is not supported`);
      return;
    }

    const result = await this.executeMethod(method, params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async handleNwcMethod(data, res) {
    const { method, params, pubkey } = data;
    
    // Validate method is allowed
    if (BLOCKED_METHODS.has(method)) {
      this.sendError(res, 403, 'METHOD_NOT_ALLOWED',
        `Method ${method} is restricted`);
      return;
    }
    
    if (!ALLOWED_METHODS.has(method)) {
      this.sendError(res, 404, 'METHOD_NOT_FOUND',
        `Method ${method} not found`);
      return;
    }

    const result = await this.executeMethod(method, params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async executeMethod(method, params = {}) {
    switch (method) {
      case 'get_info':
        return {
          result: 'success',
          data: {
            version: 'alibi-v1.0.0',
            supported_tiers: ['basic', 'pro'],
            commission_policy: {
              max_rate_ppm: COMMISSION_POLICY.maxPercent * 10000,
              payees: COMMISSION_POLICY.allowedPayee ? [COMMISSION_POLICY.allowedPayee] : [],
              max_routing_fee: {
                base_msat: 1000,
                rate_ppm: COMMISSION_POLICY.maxRoutingFeePercent
              },
              budget_msat: COMMISSION_POLICY.budgetMsat
            }
          }
        };

      case 'make_commission_invoice': {
        const { amount, payment_hash, commission_invoice, expiry } = params;
        
        if (!amount || !payment_hash || !commission_invoice) {
          return {
            result: 'error',
            error: {
              code: 'INVALID_PARAMS',
              message: 'Missing required parameters: amount, payment_hash, commission_invoice'
            }
          };
        }

        // Process commission request
        const result = await this.commissionHandler.handleMakeCommissionInvoice(
          this.policy.allowedPayee,
          commission_invoice,
          payment_hash,
          expiry || 3600
        );

        return result;
      }

      case 'lookup_invoice': {
        const { payment_hash } = params;
        if (!payment_hash) {
          return {
            result: 'error',
            error: { code: 'INVALID_PARAMS', message: 'Missing payment_hash' }
          };
        }

        // Check if this is a known commission sale
        const commission = this.commissionHandler.activeCommissions.get(payment_hash);
        if (!commission) {
          return {
            result: 'error',
            error: { code: 'NOT_FOUND', message: 'Invoice not found' }
          };
        }

        return {
          result: 'success',
          data: {
            payment_hash,
            amount_msat: commission.saleAmountMsat.toString(),
            is_confirmed: false,
            is_cancelled: false,
            is_expired: false,
            creation_date: Math.floor(commission.createdAt / 1000),
            expiry: expiry || 3600,
            metadata: commission
          }
        };
      }

      default:
        return {
          result: 'error',
          error: { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${method}` }
        };
    }
  }

  sendError(res, statusCode, code, message, details = null) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      result: 'error',
      error: { code, message, details }
    }));
  }

  start() {
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    server.listen(PORT, () => {
      console.log(`Alibi NWC Commission Server listening on port ${PORT}`);
      console.log(`Policy: max ${COMMISSION_POLICY.maxPercent}% commission`);
      console.log(`Budget: ${COMMISSION_POLICY.budgetMsat / 1000} sats`);
      console.log(`Allowed payee: ${COMMISSION_POLICY.allowedPayee?.slice(0, 20)}...`);
    });

    return server;
  }
}

// Start server if run directly
if (require.main === module) {
  const server = new NwcServer();
  server.start();
}

module.exports = { NwcServer, COMMISSION_POLICY };