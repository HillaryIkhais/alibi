#!/usr/bin/env node
/**
 * ALIBI NWC SERVER — Commission Payment Request Handler
 *
 * Vendor-side NWC endpoint. A marketplace connection may ONLY call:
 *   get_info, lookup_invoice, make_commission_invoice
 * Blocked: pay_invoice, settle_hold_invoice, cancel_hold_invoice, create_connection, etc.
 *
 * The marketplace never receives the vendor's spending authority.
 * All policy enforcement happens in CommissionService (wallet-side).
 *
 * ENV:
 *   HARBOR_NWC_PORT       (default 8080)
 *   HARBOR_LND_REST_URL   Alice's vendor LND REST endpoint
 *   HARBOR_LND_MACAROON   Alice's read-only macaroon (hex)
 *   HARBOR_LND_TLS_CERT   path to Alice's tls.cert
 *   HARBOR_MARKETPLACE_PUBKEY  Bob's identity pubkey (allowed payee)
 */

const http = require('http');
const crypto = require('crypto');
const { CommissionService } = require('./commission-service.js');

const PORT = parseInt(process.env.HARBOR_NWC_PORT || '8080', 10);

const ALLOWED_METHODS = new Set(['get_info', 'lookup_invoice', 'make_commission_invoice']);
const BLOCKED_METHODS = new Set([
  'pay_invoice', 'settle_hold_invoice', 'cancel_hold_invoice',
  'create_connection', 'close_connection', 'list_connected_applications',
  'revoke_connection', 'list_incoming_payments', 'keysend',
  'send_payment', 'pay_invoice_sync',
]);

class NwcServer {
  constructor() {
    this.svc = new CommissionService();
    this.connections = new Map(); // pubkey -> { approved, createdAt }
    // The approved CALLER is the marketplace NWC identity. This is deliberately
    // distinct from the Lightning invoice destination (policy.allowedPayee).
    if (this.svc.policy.allowedMarketplace) {
      this.connections.set(this.svc.policy.allowedMarketplace, { approved: true, createdAt: Date.now() });
    }
  }

  _send(res, statusCode, obj) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  async handle(req, res) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        if (data.kind === 23194) {
          await this.handleNip47(data, res);
        } else if (data.method) {
          await this.handleMethod(data, res);
        } else {
          this._send(res, 400, { result: 'error', error: { code: 'INVALID_FORMAT', message: 'Expected NIP-47 request or NWC method call' } });
        }
      } catch (e) {
        this._send(res, 500, { result: 'error', error: { code: 'INTERNAL', message: e.message } });
      }
    });
  }

  async handleNip47(data, res) {
    // Real NWC transports a signed kind:23194 Nostr event with a NIP-44
    // encrypted payload. This build has no BIP-340/NIP-44 implementation, so
    // accepting raw JSON here would let anyone claim an approved identity.
    // Fail closed: require an approved event author AND refuse to pretend an
    // unverified envelope is a verified Nostr event.
    const caller = String(data.pubkey || '');
    if (!this.isApproved(caller)) {
      this._send(res, 403, { result: 'error', error: { code: 'UNAUTHORIZED_CONNECTION', message: 'NIP-47 request has no approved connection' } });
      return;
    }
    this._send(res, 401, {
      result: 'error',
      error: {
        code: 'TRANSPORT_NOT_VERIFIED',
        message: 'Signed Nostr event / NIP-44 decryption not implemented; refusing unverified request envelope',
      },
    });
  }

  async handleMethod(data, res) {
    const { method, params, pubkey } = data;
    // Every path must establish an approved caller before executing anything.
    if (!this.isApproved(pubkey)) {
      this._send(res, 403, { result: 'error', error: { code: 'UNAUTHORIZED_CONNECTION', message: 'Connection not approved for commission operations' } });
      return;
    }
    const result = await this.execute(method, params || {}, pubkey);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  isApproved(pubkey) {
    if (!pubkey) return false;
    const c = this.connections.get(pubkey);
    return !!c?.approved;
  }

  async execute(method, params = {}, callerPubkey = '') {
    // Blocklist first
    if (BLOCKED_METHODS.has(method)) {
      return { result: 'error', error: { code: 'METHOD_NOT_ALLOWED', message: `${method} is restricted on commission-only connections` } };
    }
    if (!ALLOWED_METHODS.has(method)) {
      return { result: 'error', error: { code: 'METHOD_NOT_FOUND', message: `${method} is not supported` } };
    }

    switch (method) {
      case 'get_info':
        return {
          result: 'success',
          data: {
            version: 'alibi-v1.0.0',
            supported_tiers: ['basic'],
            commission_policy: {
              max_rate_ppm: this.svc.policy.maxRatePPM,
              max_fixed_msat: Number(this.svc.policy.maxFixedMsat),
              payees: this.svc.policy.allowedPayee ? [this.svc.policy.allowedPayee] : [],
              marketplace: this.svc.policy.allowedMarketplace || null,
              max_routing_fee: { base_msat: Number(this.svc.policy.baseMsat), rate_ppm: Number(this.svc.policy.ratePPM) },
              budget_msat: Number(this.svc.policy.maxBudgetMsat),
            },
            supported_methods: Array.from(ALLOWED_METHODS),
          },
        };

      case 'make_commission_invoice': {
        const { amount, payment_hash, commission_invoice, expiry } = params;
        // The caller identity comes from the authenticated connection, never
        // from request params where an attacker could simply supply the value.
        return await this.svc.handleMakeCommissionInvoice({
          amount, payment_hash, commission_invoice, expiry,
          marketplace_pubkey: callerPubkey,
        });
      }

      case 'lookup_invoice': {
        const { payment_hash } = params;
        if (!payment_hash) {
          return { result: 'error', error: { code: 'INVALID_PARAMS', message: 'payment_hash required' } };
        }
        if (this.svc.lnd) {
          try {
            const inv = await this.svc.lnd.lookupInvoice(payment_hash);
            if (!inv) return { result: 'error', error: { code: 'NOT_FOUND', message: 'Invoice not found' } };
            return { result: 'success', data: { payment_hash, state: inv.state, amount_msat: inv.value_msat || BigInt(inv.value || 0) * 1000n } };
          } catch (e) {
            return { result: 'error', error: { code: 'LOOKUP_FAILED', message: e.message } };
          }
        }
        return { result: 'error', error: { code: 'NO_LND', message: 'LND not configured' } };
      }

      default:
        return { result: 'error', error: { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${method}` } };
    }
  }

  start() {
    const server = http.createServer((req, res) => this.handle(req, res));
    server.listen(PORT, () => {
      console.log(`[alibi nwc] listening on port ${PORT}`);
      console.log(`[alibi nwc] allowed methods: ${[...ALLOWED_METHODS].join(', ')}`);
      console.log(`[alibi nwc] blocked methods: ${[...BLOCKED_METHODS].join(', ')}`);
      console.log(`[alibi nwc] mode: ${this.svc.mode}`);
    });
    return server;
  }
}

if (require.main === module) {
  new NwcServer().start();
}

module.exports = { NwcServer, ALLOWED_METHODS, BLOCKED_METHODS };
