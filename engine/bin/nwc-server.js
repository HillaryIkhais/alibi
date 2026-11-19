#!/usr/bin/env node
/**
 * ALIBI NWC SERVER — Commission Payment Request Handler (NIP-47 transport)
 *
 * Vendor-side NWC endpoint. A marketplace connection may ONLY call:
 *   get_info, lookup_invoice, make_commission_invoice
 * Blocked: pay_invoice, settle_hold_invoice, cancel_hold_invoice, create_connection, etc.
 *
 * Authentication is via verified BIP-340/Schnorr kind:23194 Nostr events
 * (NIP-47) with NIP-44 v2 encryption. The marketplace identity comes from the
 * verified signed event — NEVER from a caller-supplied JSON field.
 *
 * The plain HTTP adapter remains for LOCAL DEMO only: bound to loopback,
 * no commission spending methods, no caller-supplied pubkey authentication.
 *
 * ENV:
 *   HARBOR_NWC_PORT       (default 8080, loopback-only local demo)
 *   HARBOR_NWC_RELAY      nostr relay for NIP-47 (default wss://relay.damus.io)
 *   HARBOR_NWC_SECRET_KEY wallet nsec (generated if absent)
 *   HARBOR_MARKETPLACE_PUBKEY approved marketplace npub
 *   HARBOR_LND_REST_URL   Alice's vendor LND REST endpoint
 *   HARBOR_LND_MACAROON   Alice's read-only macaroon (hex)
 *   HARBOR_LND_TLS_CERT   path to Alice's tls.cert
 */

const http = require('http');
const crypto = require('crypto');
const { CommissionService } = require('./commission-service.js');
const {
  WALLET_PUBLIC_KEY,
  MARKETPLACE_PUBKEY,
  ALLOWED_METHODS,
  isApproved,
  approveConnection,
  revokeConnection,
  handleRequestEvent,
  startRelay,
  stopRelay,
} = require('./nwc-transport.js');

const PORT = parseInt(process.env.HARBOR_NWC_PORT || '8080', 10);
const LOCAL_DEMO_TOKEN = process.env.HARBOR_LOCAL_DEMO_TOKEN || 'alibi-local-demo';

const BLOCKED_METHODS = new Set([
  'pay_invoice', 'settle_hold_invoice', 'cancel_hold_invoice',
  'create_connection', 'close_connection', 'list_connected_applications',
  'revoke_connection', 'list_incoming_payments', 'keysend',
  'send_payment', 'pay_invoice_sync',
]);

class NwcServer {
  constructor() {
    this.svc = new CommissionService();
    // Approve the configured marketplace connection at startup.
    if (MARKETPLACE_PUBKEY) approveConnection(MARKETPLACE_PUBKEY);
    this.relayStarted = false;
  }

  _send(res, statusCode, obj) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  async handle(req, res) {
    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};

        // NIP-47 signed request event (kind:23194) — the REAL transport.
        if (data.kind === 23194) {
          const result = await handleRequestEvent(data);
          if (!result.ok) {
            return this._send(res, 401, {
              result: 'error',
              error: { code: 'TRANSPORT_NOT_VERIFIED', message: result.reason },
            });
          }
          // Response is published to the relay by the transport; acknowledge here.
          return this._send(res, 200, {
            result: 'success',
            message: 'request processed and response published to relay',
            response_event_id: result.responseEvent ? result.responseEvent.id : null,
          });
        }

        // Plain HTTP method call — LOCAL DEMO ONLY. Commission operations are
        // NOT authenticated here by a caller-supplied pubkey.
        if (data.method) {
          return await this.handleMethod(data, res, req);
        }

        this._send(res, 400, { result: 'error', error: { code: 'INVALID_FORMAT', message: 'Expected NIP-47 request or NWC method call' } });
      } catch (e) {
        this._send(res, 500, { result: 'error', error: { code: 'INTERNAL', message: e.message } });
      }
    });
  }

  async handleMethod(data, res, req) {
    const { method, params } = data;

    // Local-demo gate: only loopback and a demo token may use the plain HTTP
    // adapter. Commission spending methods are NOT authenticated here by a
    // caller-supplied pubkey.
    const headers = req ? req.headers : {};
    const forwarded = reqForwardedHost(req);
    if (forwarded !== '127.0.0.1' && forwarded !== 'localhost') {
      return this._send(res, 403, {
        result: 'error',
        error: { code: 'UNAUTHORIZED_CONNECTION', message: 'plain HTTP adapter is loopback-only' },
      });
    }
    const token = headers['x-alibi-demo-token'];
    if (token !== LOCAL_DEMO_TOKEN) {
      return this._send(res, 401, {
        result: 'error',
        error: { code: 'UNAUTHORIZED', message: 'local demo token required' },
      });
    }

    // Blocklist first.
    if (BLOCKED_METHODS.has(method)) {
      return this._send(res, 403, {
        result: 'error',
        error: { code: 'METHOD_NOT_ALLOWED', message: `${method} is restricted on commission-only connections` },
      });
    }
    if (!ALLOWED_METHODS.has(method)) {
      return this._send(res, 404, {
        result: 'error',
        error: { code: 'METHOD_NOT_FOUND', message: `${method} is not supported` },
      });
    }

    switch (method) {
      case 'get_info':
        return this._send(res, 200, {
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
            supported_methods: ['get_info', 'lookup_invoice'],
            note: 'make_commission_invoice requires the NIP-47 signed transport',
          },
        });

      case 'lookup_invoice': {
        const { payment_hash } = params || {};
        if (!payment_hash) {
          return this._send(res, 400, { result: 'error', error: { code: 'INVALID_PARAMS', message: 'payment_hash required' } });
        }
        if (this.svc.lnd) {
          try {
            const inv = await this.svc.lnd.lookupInvoice(payment_hash);
            if (!inv) return this._send(res, 404, { result: 'error', error: { code: 'NOT_FOUND', message: 'Invoice not found' } });
            return this._send(res, 200, {
              result: 'success',
              data: { payment_hash, state: inv.state, amount_msat: inv.value_msat || BigInt(inv.value || 0) * 1000n },
            });
          } catch (e) {
            return this._send(res, 500, { result: 'error', error: { code: 'LOOKUP_FAILED', message: e.message } });
          }
        }
        return this._send(res, 503, { result: 'error', error: { code: 'NO_LND', message: 'LND not configured' } });
      }

      case 'make_commission_invoice':
        // Must use the NIP-47 signed transport; plain HTTP does not authenticate
        // the marketplace caller and would let anyone claim an approved pubkey.
        return this._send(res, 403, {
          result: 'error',
          error: {
            code: 'TRANSPORT_REQUIRED',
            message: 'make_commission_invoice requires a verified NIP-47 signed event; plain HTTP caller-supplied pubkey is not trusted',
          },
        });

      default:
        return this._send(res, 404, { result: 'error', error: { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${method}` } });
    }
  }

  async start() {
    const server = http.createServer((req, res) => this.handle(req, res));
    // Bind to loopback only for the local-demo HTTP adapter.
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[alibi nwc] local HTTP (demo only) on 127.0.0.1:${PORT}`);
      console.log(`[alibi nwc] allowed methods (NIP-47): ${[...ALLOWED_METHODS].join(', ')}`);
      console.log(`[alibi nwc] blocked methods: ${[...BLOCKED_METHODS].join(', ')}`);
      console.log(`[alibi nwc] wallet pubkey: ${WALLET_PUBLIC_KEY}`);
      console.log(`[alibi nwc] approved marketplace: ${MARKETPLACE_PUBKEY || '(none)'}`);
      console.log(`[alibi nwc] mode: ${this.svc.mode}`);
    });
    // Start the NIP-47 relay transport (signed events).
    if (!this.relayStarted) {
      this.relayStarted = true;
      startRelay().catch(e => console.warn('[nwc-server] relay start failed:', e.message));
    }
    return server;
  }

  async stop() {
    await stopRelay();
  }
}

function reqForwardedHost(req) {
  if (!req) return '127.0.0.1'; // direct test invocation: treat as local
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  const conn = req.socket;
  const addr = conn ? (conn.remoteAddress || '') : '';
  return addr || '127.0.0.1'; // direct local connection: treat as loopback
}

if (require.main === module) {
  new NwcServer().start();
}

module.exports = { NwcServer, ALLOWED_METHODS, BLOCKED_METHODS, WALLET_PUBLIC_KEY, MARKETPLACE_PUBKEY, handleRequestEvent };
