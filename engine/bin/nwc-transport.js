#!/usr/bin/env node
/**
 * ALIBI NWC TRANSPORT — genuine NIP-47 / NIP-44 signed-envelope relay transport
 *
 * Implements the NWC Commission Payments draft's authenticated transport for one
 * approved marketplace. The marketplace identity is established ONLY by a verified
 * BIP-340/Schnorr kind:23194 Nostr event, decrypted with NIP-44 v2. A caller-supplied
 * JSON pubkey is never trusted for commission operations.
 *
 * Event flow:
 *   Marketplace -> kind:23194 (signed request, NIP-44v2 encrypted, p=wallet)
 *   Wallet      -> kind:23195 (signed response, NIP-44v2 encrypted, p=marketplace, e=request)
 *
 * Wallet info is published as kind:13194.
 *
 * ENV:
 *   HARBOR_NWC_SECRET_KEY   hex Nsec for the wallet (generated if absent)
 *   HARBOR_NWC_RELAY        nostr relay URL (default wss://relay.damus.io)
 *   HARBOR_MARKETPLACE_PUBKEY hex npub of the single approved marketplace
 *   HARBOR_LND_REST_URL / HARBOR_LND_MACAROON / HARBOR_LND_TLS_CERT (vendor LND)
 *
 * The plain HTTP adapter (nwc-server.js handleMethod) is kept for local demo only
 * and is bound to loopback; it does NOT authenticate commission operations by a
 * caller-supplied pubkey.
 */

const crypto = require('crypto');
const http = require('http');
const {
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  finalizeEvent,
  kinds,
  Relay,
  SimplePool,
  nip44,
} = require('nostr-tools');

const RELAY_URL = process.env.HARBOR_NWC_RELAY || 'wss://relay.damus.io';
const MARKETPLACE_PUBKEY = process.env.HARBOR_MARKETPLACE_PUBKEY || '';
// generateSecretKey() returns Uint8Array; an env var (if set) is hex. Normalize.
function parseSecretKey(input) {
  if (input instanceof Uint8Array) return input;
  return Buffer.from(String(input), 'hex');
}
const WALLET_SECRET_KEY = parseSecretKey(process.env.HARBOR_NWC_SECRET_KEY || generateSecretKey());
const WALLET_PUBLIC_KEY = getPublicKey(WALLET_SECRET_KEY);

const ALLOWED_METHODS = new Set(['get_info', 'lookup_invoice', 'make_commission_invoice']);
const CONNECTION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory connection registry (would be persisted in production).
// pubkey -> { approved, createdAt, expiresAt, revoked }
const connections = new Map();

// Request-event deduplication: eventId -> true (recent window).
const seenEventIds = new Set();
const SEEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function now() { return Math.floor(Date.now() / 1000); }

function isApproved(pubkey) {
  if (!pubkey) return false;
  const c = connections.get(pubkey);
  return !!c && c.approved && !c.revoked && c.expiresAt > Date.now();
}

function approveConnection(pubkey) {
  connections.set(pubkey, {
    approved: true,
    createdAt: Date.now(),
    expiresAt: Date.now() + CONNECTION_TTL_MS,
    revoked: false,
  });
}

function revokeConnection(pubkey) {
  const c = connections.get(pubkey);
  if (c) c.revoked = true;
}

function isDuplicate(eventId) {
  return seenEventIds.has(eventId);
}
function markSeen(eventId) {
  seenEventIds.add(eventId);
  setTimeout(() => seenEventIds.delete(eventId), SEEN_TTL_MS);
}

function sharedSecret(theirPubkey) {
  return nip44.getConversationKey(WALLET_SECRET_KEY, theirPubkey);
}

// ── NWC request/response processing ───────────────────────────────────

/**
 * Process a verified, decrypted NWC request. Returns a response object shaped
 * per the NWC draft (result success/error). Never trusts caller-supplied identity.
 */
async function processRequest({ method, params, connectionPubkey }) {
  // Strict method allowlist — pay_invoice, settle_hold_invoice, etc. are
  // never exposed to the marketplace.
  if (!method || !ALLOWED_METHODS.has(method)) {
    return { result: 'error', error: { code: 'METHOD_NOT_ALLOWED', message: `${method || 'unknown'} is not permitted on commission connections` } };
  }

  switch (method) {
    case 'get_info':
      return {
        result: 'success',
        data: {
          version: 'alibi-v1.0.0',
          supported_tiers: ['basic'],
          commission_policy: {
            max_rate_ppm: 50000,
            max_fixed_msat: 0,
            payees: MARKETPLACE_PUBKEY ? [MARKETPLACE_PUBKEY] : [],
            marketplace: null, // caller identity is the verified event author, not advertised here
          },
          supported_methods: Array.from(ALLOWED_METHODS),
        },
      };

    case 'lookup_invoice': {
      // Connection scoping: a commission connection may only inspect its own sales.
      const { payment_hash } = params || {};
      if (!payment_hash) {
        return { result: 'error', error: { code: 'INVALID_PARAMS', message: 'payment_hash required' } };
      }
      return { result: 'error', error: { code: 'NO_LND', message: 'lookup_invoice requires LND wiring (local demo only)' } };
    }

    case 'make_commission_invoice': {
      // Delegated to the production CommissionService. The caller identity is the
      // verified event author (connectionPubkey), never a request param.
      const { CommissionService } = require('./commission-service.js');
      const svc = new CommissionService();
      return await svc.handleMakeCommissionInvoice({
        amount: params.amount,
        payment_hash: params.payment_hash,
        commission_invoice: params.commission_invoice,
        expiry: params.expiry,
        marketplace_pubkey: connectionPubkey,
      });
    }

    default:
      return { result: 'error', error: { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${method}` } };
  }
}

/**
 * Verify, decrypt, and process an incoming kind:23194 NWC request event.
 * Returns { ok, responseEvent } or { ok: false, reason }.
 */
async function handleRequestEvent(event) {
  // 1. Must be a kind:23194 NWC wallet request.
  if (event.kind !== kinds.NWCWalletRequest) {
    return { ok: false, reason: 'unexpected event kind' };
  }

  // 2. BIP-340/Schnorr signature verification (establishes the author's identity).
  if (!verifyEvent(event)) {
    return { ok: false, reason: 'invalid BIP-340 signature on request event' };
  }

  const author = event.pubkey;

  // 3. Author must be the single approved marketplace (verified identity, never a
  //    caller-supplied JSON field).
  if (!MARKETPLACE_PUBKEY || author !== MARKETPLACE_PUBKEY) {
    return { ok: false, reason: 'request author is not the approved marketplace' };
  }
  if (!isApproved(author)) {
    return { ok: false, reason: 'marketplace connection not approved or expired' };
  }

  // 4. Request-event deduplication.
  if (isDuplicate(event.id)) {
    return { ok: false, reason: 'duplicate request event id' };
  }
  markSeen(event.id);

  // 5. The `p` tag must address this wallet.
  const pTag = event.tags.find(t => t[0] === 'p');
  if (!pTag || pTag[1] !== WALLET_PUBLIC_KEY) {
    return { ok: false, reason: 'request not addressed to this wallet (p tag missing/wrong)' };
  }

  // 6. Event must be recent (within tolerance).
  const nowTs = now();
  if (Math.abs(nowTs - event.created_at) > 3600) {
    return { ok: false, reason: 'request event timestamp outside tolerance' };
  }

  // 7. Decrypt NIP-44 v2 payload.
  let request;
  try {
    const secret = sharedSecret(author);
    const decrypted = nip44.decrypt(event.content, secret);
    request = JSON.parse(decrypted);
  } catch (e) {
    return { ok: false, reason: `NIP-44 decryption failed: ${e.message}` };
  }

  // 8. Process the request (method allowlist enforced inside).
  const response = await processRequest({
    method: request.method,
    params: request.params,
    connectionPubkey: author,
  });

  // 9. Encrypt response with NIP-44 v2 and build kind:23195 response event.
  let encrypted;
  try {
    const secret = sharedSecret(author);
    encrypted = nip44.encrypt(JSON.stringify(response), secret);
  } catch (e) {
    return { ok: false, reason: `NIP-44 response encryption failed: ${e.message}` };
  }

  const responseEvent = {
    kind: kinds.NWCWalletResponse,
    created_at: nowTs,
    tags: [
      ['p', author],
      ['encrypted', 'nostr-tools/nip44-v2'],
      ['e', event.id],
    ],
    content: encrypted,
    pubkey: WALLET_PUBLIC_KEY,
  };
  finalizeEvent(responseEvent, WALLET_SECRET_KEY);

  return { ok: true, responseEvent, request };
}

// ── Wallet info event (kind:13194) ────────────────────────────────────

function walletInfoEvent() {
  const event = {
    kind: kinds.NWCWalletInfo,
    created_at: now(),
    tags: [
      ['name', 'Alibi Commission Wallet'],
      ['description', 'Vendor-side NWC commission authority. Approved marketplace only.'],
      ['pubkey', WALLET_PUBLIC_KEY],
    ],
    content: JSON.stringify({
      methods: Array.from(ALLOWED_METHODS),
      payees: MARKETPLACE_PUBKEY ? [MARKETPLACE_PUBKEY] : [],
      note: 'Experimental NWC Commission Payments draft (nwc#8). Regtest only.',
    }),
    pubkey: WALLET_PUBLIC_KEY,
  };
  finalizeEvent(event, WALLET_SECRET_KEY);
  return event;
}

// ── Relay publishing / subscription ───────────────────────────────────

let pool = null;
let sub = null;

async function startRelay() {
  if (!MARKETPLACE_PUBKEY) {
    console.warn('[nwc-transport] HARBOR_MARKETPLACE_PUBKEY not set; transport will not accept requests');
  }
  console.log(`[nwc-transport] wallet pubkey: ${WALLET_PUBLIC_KEY}`);
  console.log(`[nwc-transport] approved marketplace: ${MARKETPLACE_PUBKEY || '(none)'}`);
  console.log(`[nwc-transport] relay: ${RELAY_URL}`);

  pool = new SimplePool();
  // Publish wallet info event so the marketplace can discover this wallet.
  try {
    const info = walletInfoEvent();
    await pool.publish(RELAY_URL, info);
    console.log('[nwc-transport] published kind:13194 wallet info event', info.id);
  } catch (e) {
    console.warn('[nwc-transport] could not publish wallet info:', e.message);
  }

  // Subscribe to kind:23194 requests addressed to this wallet from the marketplace.
  const filter = {
    kinds: [kinds.NWCWalletRequest],
    authors: MARKETPLACE_PUBKEY ? [MARKETPLACE_PUBKEY] : [],
    '#p': WALLET_PUBLIC_KEY,
    since: now() - 3600,
  };
  sub = pool.subscribeMany(
    [RELAY_URL],
    [filter],
    (event) => {
      // eslint-disable-next-line no-console
      handleRequestEvent(event).then(({ ok, responseEvent, reason }) => {
        if (!ok) {
          console.log(`[nwc-transport] request rejected: ${reason}`);
          return;
        }
        pool.publish(RELAY_URL, responseEvent).then(() => {
          console.log(`[nwc-transport] published kind:23195 response for request ${event.id}`);
        }).catch(e => console.warn('[nwc-transport] publish failed:', e.message));
      }).catch(e => console.warn('[nwc-transport] handler error:', e.message));
    }
  );
}

async function stopRelay() {
  try { if (sub) sub.close(); } catch (e) {}
  try { if (pool) pool.close(); } catch (e) {}
}

module.exports = {
  WALLET_PUBLIC_KEY,
  WALLET_SECRET_KEY,
  MARKETPLACE_PUBKEY,
  ALLOWED_METHODS,
  connections,
  isApproved,
  approveConnection,
  revokeConnection,
  handleRequestEvent,
  processRequest,
  walletInfoEvent,
  startRelay,
  stopRelay,
  sharedSecret,
};
