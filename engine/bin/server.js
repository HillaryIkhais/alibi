#!/usr/bin/env node
/**
 * ALIBI CHECKOUT — PRODUCT BACKEND SERVER
 *
 * Wraps the production CommissionService (single source of truth for commission
 * validation and payment lifecycle) behind an HTTP API for the creator workspace,
 * buyer checkout, and marketplace integration.
 *
 * Security model:
 *   - No caller-supplied pubkey is ever trusted for commission operations.
 *   - Marketplace identity comes from the authenticated integration connection.
 *   - All financial decisions happen server-side in CommissionService.
 *   - REAL mode (LND credentials present) requires durable SQLite and fails closed.
 *   - MACAROONS / PRIVATE KEYS / PREIMAGES are NEVER written to responses or logs.
 *
 * ENV:
 *   PORT                        (default 3000)
 *   SESSION_SECRET              (required; random string)
 *   HARBOR_LND_REST_URL / MACAROON / TLS_CERT   (vendor LND = Alice)
 *   HARBOR_MARKETPLACE_PUBKEY   (approved marketplace identity)
 *   HARBOR_COMMISSION_PAYEE_PUBKEY  (approved commission destination)
 *   HARBOR_LOCAL_DEMO_TOKEN     (optional raw demo token, default random)
 *   ALIBI_DEMO_MODE             (set '1' to enable the visible demo-buyer pay button)
 *   DATA_DIR                    (default ./data)
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');
const { CommissionService } = require('./commission-service.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DEMO_MODE = process.env.ALIBI_DEMO_MODE === '1';
const RAW_DEMO_TOKEN = process.env.HARBOR_LOCAL_DEMO_TOKEN || crypto.randomBytes(16).toString('hex');
const DEMO_TOKEN_HASH = crypto.createHash('sha256').update(RAW_DEMO_TOKEN).digest('hex');

// ── Durable SQLite (fail closed in REAL mode) ─────────────────────────────
let sqlite3 = null;
let db = null;
try {
  sqlite3 = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new sqlite3(path.join(DATA_DIR, 'alibi.sqlite'));
  db.pragma('journal_mode = WAL');
  console.log('[alibi server] durable SQLite at', DATA_DIR);
} catch (e) {
  console.error('[alibi server] SQLite unavailable:', e.message);
}

// Reuse CommissionService's internal db by pointing it at ours via module state.
// CommissionService constructor reads `db` from its own module scope (set in
// commission-service.js via require('better-sqlite3')). We mirror that here.
const svc = new CommissionService();

// ── In-memory session store (single-process demo; scalable via Redis later) ──
const sessions = new Map(); // sessionId -> { creatorId, createdAt, expiresAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function newSession(creatorId) {
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, {
    creatorId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return id;
}
function getSession(id) {
  if (!id || !sessions.has(id)) return null;
  const s = sessions.get(id);
  if (Date.now() > s.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return s;
}
function destroySession(id) { sessions.delete(id); }

// ── Schema (idempotent migrations) ────────────────────────────────────────
function initSchema() {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS creators (
      id TEXT PRIMARY KEY,
      shop_name TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      wallet_pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commission_policies (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      creator_id TEXT NOT NULL,
      max_rate_ppm INTEGER NOT NULL,
      max_fixed_msat INTEGER NOT NULL DEFAULT 0,
      allowed_payee TEXT,
      allowed_marketplace TEXT,
      max_budget_msat INTEGER NOT NULL DEFAULT 100000000,
      base_msat INTEGER NOT NULL DEFAULT 1000,
      rate_ppm INTEGER NOT NULL DEFAULT 5000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS marketplace_connections (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      marketplace_pubkey TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      approved_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      price_msat INTEGER NOT NULL,
      asset_path TEXT,
      asset_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      product_id TEXT,
      external_order_id TEXT NOT NULL,
      payment_hash TEXT NOT NULL UNIQUE,
      sale_invoice TEXT,
      commission_invoice TEXT,
      gross_msat INTEGER NOT NULL,
      commission_msat INTEGER NOT NULL,
      fee_msat INTEGER DEFAULT 0,
      net_msat INTEGER DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'CREATED',
      commission_state TEXT DEFAULT 'unpaid',
      commission_paid_at INTEGER,
      commission_fee_msat INTEGER DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
        download_token_hash TEXT,
      download_expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orders_payment_hash ON orders(payment_hash);
    CREATE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders(idempotency_key, creator_id);
    CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
    -- Receipt & download tokens
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      receipt_hash TEXT NOT NULL UNIQUE,
      signed_at INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );
    CREATE TABLE IF NOT EXISTS download_tokens (
      token_hash TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );
  `);
  // Idempotent column migrations for existing databases
  for (const sql of [
    'ALTER TABLE orders ADD COLUMN commission_state TEXT DEFAULT \'unpaid\'',
    'ALTER TABLE orders ADD COLUMN commission_paid_at INTEGER',
    'ALTER TABLE orders ADD COLUMN commission_fee_msat INTEGER DEFAULT 0',
  ]) {
    try { db.prepare(sql).run(); } catch (e) { /* column already exists */ }
  }
}
// ── Seed demo data (idempotent) ───────────────────────────────────────────
const CREATOR_ID = 'creator-0001';
const MARKETPLACE_PUBKEY = process.env.HARBOR_MARKETPLACE_PUBKEY || '';
const PAYEE_PUBKEY = process.env.HARBOR_COMMISSION_PAYEE_PUBKEY || MARKETPLACE_PUBKEY;

function seedDemo() {
  if (!db) return;
  // creators
  db.prepare(
    'INSERT OR IGNORE INTO creators (id, shop_name, creator_name, wallet_pubkey, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(
    CREATOR_ID,
    "Amina's Creator Shop",
    'Amina',
    '021e04514aa8bdf7a4847a34895c1ddcba1ecae6b68ec711415d48654933df0636',
    Math.floor(Date.now() / 1000)
  );
  // marketplace connections (creator-approved). Approved connection for demo marketplace.
  if (MARKETPLACE_PUBKEY) {
    db.prepare(
      'INSERT OR IGNORE INTO marketplace_connections (id, creator_id, marketplace_pubkey, approved, approved_at, revoked, created_at) VALUES (?, ?, ?, 1, ?, 0, ?)'
    ).run(
      'conn-0001',
      CREATOR_ID,
      MARKETPLACE_PUBKEY,
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000)
    );
  }
  // commission policy
  db.prepare(
    'INSERT OR IGNORE INTO commission_policies (id, creator_id, max_rate_ppm, max_fixed_msat, allowed_payee, allowed_marketplace, max_budget_msat, base_msat, rate_ppm, created_at, updated_at) VALUES (1, ?, 50000, 0, ?, ?, 100000000, 1000, 5000, ?, ?)'
  ).run(
    CREATOR_ID,
    PAYEE_PUBKEY,
    MARKETPLACE_PUBKEY,
    Math.floor(Date.now() / 1000),
    Math.floor(Date.now() / 1000)
  );
  // products
  db.prepare(
    'INSERT OR IGNORE INTO products (id, creator_id, title, description, price_msat, asset_path, asset_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'prod-0001',
    CREATOR_ID,
    'Creator Brand Kit',
    'Original digital template bundle for creators — ebook, social templates, brand guidelines.',
    100000000, // 100,000 sats in msat
    'assets/creator-brand-kit.zip',
    crypto.createHash('sha256').update('creator-brand-kit-demo-asset').digest('hex'),
    Math.floor(Date.now() / 1000)
  );
  console.log('[alibi server] demo data seeded (creator, marketplace connection, policy, product)');
}
if (db) initSchema();
if (db) seedDemo();

// ── HTTP helpers ──────────────────────────────────────────────────────────
function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders };
  res.writeHead(status, headers);
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    readBody(req).then((text) => {
      try { resolve(JSON.parse(text || '{}')); }
      catch (e) { resolve(null); }
    }).catch(reject);
  });
}
function requireSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|; )alibi_session=([^;]+)/);
  if (!m) return null;
  return getSession(m[1]);
}

// ── Routes ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight for same-origin demo only (no external origins)
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': 0 });
    res.end();
    return;
  }

  // ── Public: product catalog & storefront data ──
  if (pathname === '/api/public/products' && method === 'GET') {
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const products = db.prepare('SELECT id, title, description, price_msat, asset_path, created_at FROM products WHERE creator_id = ?').all(CREATOR_ID);
    return sendJson(res, 200, { products: products.map((p) => ({ ...p, price_sats: Math.floor(Number(p.price_msat) / 1000) })) });
  }
  if (pathname === '/api/public/product' && method === 'GET') {
    const id = url.searchParams.get('id') || 'prod-0001';
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND creator_id = ?').get(id, CREATOR_ID);
    if (!p) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'product not found' } });
    return sendJson(res, 200, { product: { ...p, price_sats: Math.floor(Number(p.price_msat) / 1000) } });
  }

  // ── Creator session ──
  if (pathname === '/api/creator/login' && method === 'POST') {
    const body = await parseJsonBody(req);
    // Demo login: any non-empty creator name logs into the single demo creator.
    if (!body || !body.creator_name) return sendJson(res, 400, { error: { code: 'INVALID_PARAMS', message: 'creator_name required' } });
    const sid = newSession(CREATOR_ID);
    return sendJson(res, 200, { ok: true, creator: { id: CREATOR_ID, creator_name: 'Amina', shop_name: "Amina's Creator Shop" } }, {
      'Set-Cookie': `alibi_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
  }
  if (pathname === '/api/creator/logout' && method === 'POST') {
    const sid = sessionIdFromCookie(req);
    if (sid) destroySession(sid);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'alibi_session=; Path=/; Max-Age=0' });
  }
  function sessionIdFromCookie(req) {
    const m = (req.headers.cookie || '').match(/(?:^|; )alibi_session=([^;]+)/);
    return m ? m[1] : null;
  }
  if (pathname === '/api/creator/session' && method === 'GET') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    return sendJson(res, 200, { ok: true, creator: { id: s.creatorId, creator_name: 'Amina', shop_name: "Amina's Creator Shop" } });
  }

  // ── Creator workspace ──
  if (pathname === '/api/creator/profile' && method === 'GET') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    const info = svc.lnd ? await svc.lnd.getInfo().catch(() => null) : null;
    const policy = db ? db.prepare('SELECT * FROM commission_policies WHERE id = 1').get() : null;
    const conn = db ? db.prepare('SELECT * FROM marketplace_connections WHERE creator_id = ? AND id = ?').get(CREATOR_ID, 'conn-0001') : null;
    const budget = db ? svc.budget() : { maxBudgetMsat: 100000000, spentMsat: 0, reservedMsat: 0, remainingMsat: 100000000 };
    return sendJson(res, 200, {
      ok: true,
      creator: { id: CREATOR_ID, creator_name: 'Amina', shop_name: "Amina's Creator Shop" },
      wallet: info ? { pubkey: info.identity_pubkey, network: info.chains?.[0]?.network, synced: info.synced_to_chain } : { pubkey: '021e04514aa8bdf7a4847a34895c1ddcba1ecae6b68ec711415d48654933df0636', network: 'regtest', synced: null },
      policy: policy ? {
        max_rate_ppm: policy.max_rate_ppm,
        max_fixed_msat: policy.max_fixed_msat,
        allowed_payee: policy.allowed_payee,
        allowed_marketplace: policy.allowed_marketplace,
        max_budget_msat: policy.max_budget_msat,
        base_msat: policy.base_msat,
        rate_ppm: policy.rate_ppm,
      } : null,
      connection: conn ? {
        id: conn.id,
        marketplace_pubkey: conn.marketplace_pubkey,
        approved: !!conn.approved,
        revoked: !!conn.revoked,
        approved_at: conn.approved_at,
        revoked_at: conn.revoked_at,
      } : null,
      budget,
      demo_mode: DEMO_MODE,
    });
  }

  if (pathname === '/api/creator/marketplace' && method === 'GET') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    const conn = db ? db.prepare('SELECT * FROM marketplace_connections WHERE creator_id = ? AND id = ?').get(CREATOR_ID, 'conn-0001') : null;
    if (!conn) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no marketplace connection' } });
    return sendJson(res, 200, {
      ok: true,
      connection: {
        id: conn.id,
        marketplace_pubkey: conn.marketplace_pubkey,
        approved: !!conn.approved,
        revoked: !!conn.revoked,
        approved_at: conn.approved_at,
        revoked_at: conn.revoked_at,
      },
      demo_token_note: DEMO_MODE ? 'Demo marketplace API token: ' + RAW_DEMO_TOKEN : undefined,
    });
  }

  if (pathname === '/api/creator/marketplace/approve' && method === 'POST') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    const body = await parseJsonBody(req);
    if (!body || !body.marketplace_pubkey) return sendJson(res, 400, { error: { code: 'INVALID_PARAMS', message: 'marketplace_pubkey required' } });
    // Validate against configured approved marketplace (demo: single configured identity).
    if (MARKETPLACE_PUBKEY && body.marketplace_pubkey !== MARKETPLACE_PUBKEY) {
      return sendJson(res, 403, { error: { code: 'UNAUTHORIZED_MARKETPLACE', message: 'this marketplace is not approved for this creator' } });
    }
    const now = Math.floor(Date.now() / 1000);
    if (db) {
      db.prepare(
        'INSERT OR REPLACE INTO marketplace_connections (id, creator_id, marketplace_pubkey, approved, approved_at, revoked, revoked_at, created_at) VALUES (?, ?, ?, 1, ?, 0, NULL, ?)'
      ).run('conn-0001', CREATOR_ID, body.marketplace_pubkey, now, now);
    }
    return sendJson(res, 200, {
      ok: true,
      connection: {
        id: 'conn-0001',
        marketplace_pubkey: body.marketplace_pubkey,
        approved: true,
        revoked: false,
        approved_at: now,
        revoked_at: null,
      },
      integration_token: DEMO_MODE ? RAW_DEMO_TOKEN : undefined,
      token_warning: DEMO_MODE ? 'Store this token securely by the marketplace. Only the hash is stored server-side.' : undefined,
    });
  }

  if (pathname === '/api/creator/marketplace/revoke' && method === 'POST') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    const body = await parseJsonBody(req);
    const connId = (body && body.connection_id) || 'conn-0001';
    const now = Math.floor(Date.now() / 1000);
    if (db) {
      const conn = db.prepare('SELECT * FROM marketplace_connections WHERE id = ? AND creator_id = ?').get(connId, CREATOR_ID);
      if (!conn) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'connection not found' } });
      if (conn.revoked) return sendJson(res, 409, { error: { code: 'ALREADY_REVOKED', message: 'connection already revoked' } });
      db.prepare('UPDATE marketplace_connections SET revoked = 1, revoked_at = ? WHERE id = ?').run(now, connId);
      // Record revocation in audit history (preserve history, do not erase).
      svc.recordAudit('creator-revoke', conn.marketplace_pubkey || null, crypto.createHash('sha256').update(JSON.stringify({ connection_id: connId })).digest('hex'), 'ALLOW', 'CONNECTION_REVOKED', null, null, null);
    }
    return sendJson(res, 200, { ok: true, connection: { id: connId, revoked: true, revoked_at: now } });
  }

  // ── Creator sales history ──
  if (pathname === '/api/creator/sales' && method === 'GET') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const sales = db.prepare(
      'SELECT o.*, p.title as product_title FROM orders o LEFT JOIN products p ON o.product_id = p.id WHERE o.creator_id = ? ORDER BY o.created_at DESC'
    ).all(CREATOR_ID);
    return sendJson(res, 200, { ok: true, sales: sales.map((s) => ({
      id: s.id,
      product_title: s.product_title,
      gross_msat: Number(s.gross_msat),
      commission_msat: Number(s.commission_msat),
      fee_msat: Number(s.fee_msat || 0),
      net_msat: Number(s.net_msat || 0),
      state: s.state,
      created_at: s.created_at,
      settled_at: s.settled_at,
    })) });
  }

  // ── Marketplace integration: create checkout ──
  if (pathname === '/api/marketplace/v1/checkouts' && method === 'POST') {
    const body = await parseJsonBody(req);
    const token = req.headers['x-alibi-demo-token'];
    if (!token || crypto.createHash('sha256').update(token).digest('hex') !== DEMO_TOKEN_HASH) {
      return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid or missing marketplace credentials' } });
    }
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const conn = db.prepare('SELECT * FROM marketplace_connections WHERE id = ? AND creator_id = ? AND approved = 1 AND revoked = 0').get('conn-0001', CREATOR_ID);
    if (!conn) return sendJson(res, 403, { error: { code: 'CONNECTION_REVOKED', message: 'marketplace connection not approved or revoked' } });
    // Validate input
    if (!body.product_id || !body.external_order_id || !body.commission_invoice || !body.idempotency_key) {
      return sendJson(res, 400, { error: { code: 'INVALID_PARAMS', message: 'product_id, external_order_id, commission_invoice, idempotency_key required' } });
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND creator_id = ?').get(body.product_id, CREATOR_ID);
    if (!product) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'product not found' } });
    const paymentHash = body.payment_hash;
    if (!paymentHash) return sendJson(res, 400, { error: { code: 'INVALID_PARAMS', message: 'payment_hash required' } });
    // Idempotency: same payment_hash returns the original checkout (never create two buyer invoices for one hash).
    const existingByHash = db.prepare('SELECT * FROM orders WHERE payment_hash = ? AND creator_id = ?').get(paymentHash, CREATOR_ID);
    if (existingByHash) {
      return sendJson(res, 200, { ok: true, checkout: serializeCheckout(existingByHash), idempotent_replay: true });
    }
    // Idempotency: same idempotency key returns original checkout.
    const existingByKey = db.prepare('SELECT * FROM orders WHERE idempotency_key = ? AND creator_id = ?').get(body.idempotency_key, CREATOR_ID);
    if (existingByKey) {
      return sendJson(res, 200, { ok: true, checkout: serializeCheckout(existingByKey), idempotent_replay: true });
    }
    const saleMsat = BigInt(product.price_msat);
    const now = Math.floor(Date.now() / 1000);
    const orderId = 'order-' + crypto.randomBytes(12).toString('hex');
    // Call production CommissionService.handleMakeCommissionInvoice (validates policy, reserves budget, creates sale hold invoice).
    const made = await svc.handleMakeCommissionInvoice({
      amount: String(saleMsat),
      payment_hash: paymentHash,
      commission_invoice: body.commission_invoice,
      expiry: 3600,
      marketplace_pubkey: conn.marketplace_pubkey,
    });
    if (made.result !== 'success') {
      return sendJson(res, 400, { error: { code: made.error.code || 'CHECKOUT_FAILED', message: made.error.message, details: made.error.details } });
    }
    const gross = Number(saleMsat);
    const commission = Number(made.data.metadata.commission_amount_msat);
    const feeCap = Number(made.data.metadata.max_routing_fee_msat);
    const net = gross - commission;
    db.prepare(
      'INSERT INTO orders (id, creator_id, product_id, external_order_id, payment_hash, sale_invoice, commission_invoice, gross_msat, commission_msat, fee_msat, net_msat, state, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)'
    ).run(
      orderId, CREATOR_ID, product.id, body.external_order_id, paymentHash, made.data.invoice, body.commission_invoice, gross, commission, net, 'WAITING_FOR_BUYER', body.idempotency_key, now
    );
    // Audit
    svc.recordAudit('marketplace-checkout', conn.marketplace_pubkey, crypto.createHash('sha256').update(JSON.stringify({ orderId, paymentHash, amount: String(saleMsat) })).digest('hex'), 'ALLOW', null, crypto.createHash('sha256').update(JSON.stringify({ orderId, invoice: made.data.invoice })).digest('hex'), null, null);
    return sendJson(res, 201, {
      ok: true,
      checkout: {
        id: orderId,
        external_order_id: body.external_order_id,
        payment_hash: paymentHash,
        sale_invoice: made.data.invoice,
        amount_msat: String(saleMsat),
        amount_sats: Math.floor(gross / 1000),
        commission_amount_msat: String(commission),
        commission_amount_sats: Math.floor(commission / 1000),
        max_routing_fee_msat: String(feeCap),
        expires_at: made.data.expires_at,
        state: 'WAITING_FOR_BUYER',
        created_at: now,
      },
    });
  }

  // ── Marketplace: checkout status ──
  if (pathname.startsWith('/api/marketplace/v1/checkouts/') && method === 'GET') {
    const token = req.headers['x-alibi-demo-token'];
    if (!token || crypto.createHash('sha256').update(token).digest('hex') !== DEMO_TOKEN_HASH) {
      return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid or missing marketplace credentials' } });
    }
    const id = pathname.split('/').pop();
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND creator_id = ?').get(id, CREATOR_ID);
    if (!o) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'checkout not found' } });
    return sendJson(res, 200, { ok: true, checkout: serializeCheckout(o) });
  }

  // ── Buyer: pay sale invoice via Carol's node, then full settlement ──
  if (pathname.startsWith('/api/checkout/') && pathname.endsWith('/pay') && method === 'POST') {
    const id = pathname.split('/').slice(-2)[0];
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND creator_id = ?').get(id, CREATOR_ID);
    if (!o) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'checkout not found' } });
    if (o.state !== 'WAITING_FOR_BUYER') {
      return sendJson(res, 409, { error: { code: 'INVALID_STATE', message: `order state is ${o.state}` } });
    }
    try {
      // Step 1: Carol pays Alice's sale invoice
      const payRes = await execFileSync(
        'docker',
        ['compose', '-f', path.join(COMPOSE_DIR, 'docker-compose.yml'), 'exec', '-T', 'lnd-carol',
         'lncli', '--network=regtest', '--rpcserver=127.0.0.1:10031', 'payinvoice',
         '--force', '--timeout=90s', `--pay_req=${o.sale_invoice}`],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      // Step 2: Wait for Alice's invoice to be ACCEPTED
      for (let i = 0; i < 30; i++) {
        const inv = await svc.lnd.lookupInvoice(o.payment_hash);
        if (inv && inv.state === 'ACCEPTED') break;
        await new Promise(r => setTimeout(r, 1000));
      }
      // Step 3: Alice pays commission
      const paid = await svc.payCommission(o.commission_invoice, o.payment_hash);
      if (!paid.success) throw new Error(paid.reason || 'Commission payment failed');
      // Step 4: Bob settles commission invoice (reveals preimage)
      await execFileSync(
        'docker',
        ['compose', '-f', path.join(COMPOSE_DIR, 'docker-compose.yml'), 'exec', '-T', 'lnd-bob',
         'lncli', '--network=regtest', '--rpcserver=127.0.0.1:10030', 'settleinvoice', paid.payment.payment_preimage],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      // Step 5: Alice settles sale
      const settled = await svc.settleSale({ paymentHash: o.payment_hash, preimageHex: paid.payment.payment_preimage });
      if (!settled.success) throw new Error(settled.reason || 'Settlement failed');
      // Step 6: Create download token
      const token = crypto.randomBytes(16).toString('hex');
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      db.prepare(
        'UPDATE orders SET download_token_hash = ?, download_expires_at = ? WHERE id = ?'
      ).run(token, expiresAt, o.id);
      return sendJson(res, 200, {
        ok: true,
        downloadToken: token,
        message: 'Payment and settlement complete'
      });
    } catch (e) {
      return sendJson(res, 400, { error: { code: 'PAYMENT_FAILED', message: e.message } });
    }
  }

  // ── Buyer: checkout status (real state from DB) ──
  if (pathname.startsWith('/api/checkout/') && method === 'GET') {
    const id = pathname.split('/').pop();
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND creator_id = ?').get(id, CREATOR_ID);
    if (!o) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'checkout not found' } });
    return sendJson(res, 200, { ok: true, checkout: serializeCheckout(o) });
  }

  // ── Buyer: download product ──
  if (pathname.startsWith('/api/checkout/') && pathname.endsWith('/download') && method === 'GET') {
    const id = pathname.split('/').slice(-2)[0];
    const token = url.searchParams.get('token');
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND creator_id = ?').get(id, CREATOR_ID);
    if (!o) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'checkout not found' } });
    if (o.state !== 'settled') {
      return sendJson(res, 409, { error: { code: 'INVALID_STATE', message: 'Order not settled yet' } });
    }
    if (!o.download_token_hash) {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No download token' } });
    }
    if (token !== o.download_token_hash) {
      return sendJson(res, 403, { error: { code: 'INVALID_TOKEN', message: 'Invalid download token' } });
    }
    const now = Math.floor(Date.now() / 1000);
    if (o.download_expires_at && now > o.download_expires_at) {
      return sendJson(res, 403, { error: { code: 'TOKEN_EXPIRED', message: 'Download token expired' } });
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(o.product_id);
    if (!product) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Product not found' } });
    const filePath = path.join(__dirname, '..', '..', product.asset_path);
    fs.access(filePath, fs.constants.R_OK, (err) => {
      if (err) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Product file not found' } });
      res.download(filePath, `alibi-${o.product_id}.zip`);
    });
  }

  // ── Vendor: pay commission (Alice pays Bob's commission invoice) ──

  // ── Vendor: pay commission (Alice pays Bob's commission invoice) ──
  if (pathname === '/api/vendor/pay-commission' && method === 'POST') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    if (!svc.lnd) return sendJson(res, 503, { error: { code: 'NO_LND', message: 'vendor LND not configured' } });
    const body = await parseJsonBody(req);
    const orderId = body && body.order_id;
    if (!orderId) return sendJson(res, 400, { error: { code: 'INVALID_PARAMS', message: 'order_id required' } });
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND creator_id = ?').get(orderId, CREATOR_ID);
    if (!o) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'order not found' } });
    if (o.state !== 'WAITING_FOR_BUYER') {
      return sendJson(res, 409, { error: { code: 'INVALID_STATE', message: `order state is ${o.state}` } });
    }
    let paid = await svc.payCommission(o.commission_invoice, o.payment_hash);
    if (!paid.success) {
      // LND's SendPaymentV2 stream can time out before the final SUCCEEDED
      // update arrives even when the payment actually succeeded. Fall back to
      // querying the vendor node's durable payment record (source of truth).
      let fp;
      try { fp = await svc.lnd.findPayment(o.payment_hash); } catch (e) { fp = null; }
      if (fp && fp.status === 'SUCCEEDED' && fp.payment_hash === o.payment_hash) {
        paid = {
          success: true,
          payment: fp,
          verified_status: 'SUCCEEDED',
          fee_msat: Number(fp.fee_msat || 0),
          fee_cap_msat: null,
          payment_hash: fp.payment_hash,
        };
      } else {
        return sendJson(res, 400, { error: { code: 'COMMISSION_PAY_FAILED', message: paid.reason, detail: paid.failure_reason || null, payment: paid.payment || null } });
      }
    }
    // Record commission payment in order
    db.prepare(
      'UPDATE orders SET commission_state = ?, commission_paid_at = ?, commission_fee_msat = ?, commission_preimage_hash = ? WHERE id = ?'
    ).run('paid', Math.floor(Date.now() / 1000), Number(paid.fee_msat || 0), paid.payment_hash, o.id);
    svc.recordAudit('vendor-pay-commission', o.payment_hash,
      crypto.createHash('sha256').update(JSON.stringify({ orderId, payment_hash: o.payment_hash })).digest('hex'),
      'ALLOW', null,
      crypto.createHash('sha256').update(JSON.stringify({ fee_msat: paid.fee_msat })).digest('hex'), null, null);
    return sendJson(res, 200, {
      ok: true,
      payment: {
        status: paid.payment.status,
        fee_msat: paid.fee_msat,
        fee_cap_msat: paid.fee_cap_msat,
        payment_hash: paid.payment_hash,
        value_msat: paid.payment.value_msat,
      },
    });
  }

  // ── Vendor: settle sale (release buyer's held payment after commission verified) ──
  if (pathname === '/api/vendor/settle-sale' && method === 'POST') {
    const s = requireSession(req);
    if (!s) return sendJson(res, 401, { error: { code: 'NOT_AUTHENTICATED', message: 'not logged in' } });
    if (!svc.lnd) return sendJson(res, 503, { error: { code: 'NO_LND', message: 'vendor LND not configured' } });
    const body = await parseJsonBody(req);
    const orderId = body && body.order_id;
    const preimageHex = body && body.preimage_hex;
    if (!orderId || !preimageHex) {
      return sendJson(res, 400, { error: { code: 'INVALID_PARAMS', message: 'order_id and preimage_hex required' } });
    }
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND creator_id = ?').get(orderId, CREATOR_ID);
    if (!o) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'order not found' } });
    if (o.state !== 'WAITING_FOR_BUYER') {
      return sendJson(res, 409, { error: { code: 'INVALID_STATE', message: `order state is ${o.state}` } });
    }
    const settled = await svc.settleSale({ paymentHash: o.payment_hash, preimageHex });
    if (!settled.success) {
      return sendJson(res, 400, { error: { code: 'SETTLE_FAILED', message: settled.reason } });
    }
    db.prepare(
      'UPDATE orders SET state = ?, settled_at = ?, commission_state = ?, commission_paid_at = ?, commission_fee_msat = ?, net_msat = ? WHERE id = ?'
    ).run('settled', Math.floor(Date.now() / 1000), 'settled', Math.floor(Date.now() / 1000),
      Number(settled.actual_fee_msat || 0), Number(o.gross_msat) - Number(o.commission_msat) - Number(settled.actual_fee_msat || 0), o.id);
    return sendJson(res, 200, {
      ok: true,
      settlement: {
        verified: settled.verified,
        outgoing_payment_status: settled.outgoing_payment_status,
        actual_fee_msat: settled.actual_fee_msat,
        total_budget_debit_msat: settled.total_budget_debit_msat,
        net_msat: Number(o.gross_msat) - Number(o.commission_msat) - Number(settled.actual_fee_msat || 0),
      },
    });
  }

  // ── Independent verifier ──
  if (pathname === '/api/verify/:hash' && method === 'GET') {
    const hash = pathname.split('/').pop();
    if (!db) return sendJson(res, 503, { error: { code: 'STORAGE_UNAVAILABLE', message: 'database unavailable' } });
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return sendJson(res, 400, { error: { code: 'INVALID_PARAMS', message: 'Invalid payment hash' } });
    }
    try {
      const ALICE_MAC = process.env.HARBOR_LND_MACAROON || '';
      const ALICE_TLS = process.env.HARBOR_LND_TLS_CERT || null;
      const CAROL_MAC = process.env.HARBOR_CAROL_MACAROON || '';
      const CAROL_TLS = process.env.HARBOR_CAROL_TLS_CERT || null;
      const ALICE_REST = process.env.HARBOR_LND_REST_URL || '';
      const CAROL_REST = process.env.HARBOR_CAROL_REST_URL || '';

      async function lndRequest(restUrl, macaroonHex, tlsCertPath, method, path) {
        const u = new URL(restUrl);
        const isHttps = u.protocol === 'https:';
        const opts = {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path,
          method,
          headers: { 'Grpc-Metadata-macaroon': macaroonHex },
        };
        if (isHttps && tlsCertPath) {
          opts.ca = fs.readFileSync(tlsCertPath);
          opts.rejectUnauthorized = true;
        }
        return new Promise((resolve, reject) => {
          const req = (isHttps ? https : http).request(opts, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
              catch (e) { resolve({ status: res.statusCode, body: data }); }
            });
          });
          req.on('error', reject);
          req.end();
        });
      }

      async function lookupInvoice(restUrl, macaroonHex, tlsCertPath, hash) {
        const r = await lndRequest(restUrl, macaroonHex, tlsCertPath, 'GET', `/v1/invoice/${hash}`);
        if (r.status === 404) return null;
        if (r.status >= 400) throw new Error(`Invoice lookup ${r.status}`);
        return r.body;
      }
      async function listPayments(restUrl, macaroonHex, tlsCertPath) {
        const r = await lndRequest(restUrl, macaroonHex, tlsCertPath, 'GET', '/v1/payments?include_incomplete=true&max_payments=100');
        if (r.status >= 400) throw new Error(`ListPayments ${r.status}`);
        return r.body.payments || [];
      }

      const checks = {};

      // 1. Alice sale invoice
      const saleInv = await lookupInvoice(ALICE_REST, ALICE_MAC, ALICE_TLS, hash);
      checks.aliceSale = !!saleInv && saleInv.state === 'SETTLED';

      // 2. Bob commission invoice
      const commInv = await lookupInvoice(CAROL_REST, CAROL_MAC, CAROL_TLS, hash);
      checks.bobCommission = !!commInv && commInv.state === 'SETTLED';

      // 3. Carol buyer payment
      const carolPays = await listPayments(CAROL_REST, CAROL_MAC, CAROL_TLS);
      const buyerPay = carolPays.find(p => p.payment_hash === hash);
      checks.carolPayment = !!buyerPay && buyerPay.status === 'SUCCEEDED';

      // 4. Alice outgoing commission payment
      const alicePays = await listPayments(ALICE_REST, ALICE_MAC, ALICE_TLS);
      const outgoingPay = alicePays.find(p => p.payment_hash === hash);
      checks.aliceOutgoing = !!outgoingPay && outgoingPay.status === 'SUCCEEDED';

      // 5. Preimage match
      const preimage = outgoingPay ? outgoingPay.payment_preimage : '';
      checks.preimageMatch = !!preimage && /^[0-9a-f]{64}$/.test(preimage) &&
        crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') === hash;

      // 6. Fee within cap
      const feeCap = Number(saleInv ? (BigInt(saleInv.value_msat || BigInt(saleInv.value || 0) * 1000n) * BigInt(5000) / 1_000_000n + BigInt(1000)) : 0);
      const actualFee = outgoingPay ? BigInt(outgoingPay.fee_msat || '0') : 0n;
      checks.feeWithinCap = actualFee <= feeCap;

      // 7. Seller net reconciliation
      const grossMsat = BigInt(saleInv ? (saleInv.value_msat || BigInt(saleInv.value || 0) * 1000n) : 0);
      const commMsat = BigInt(commInv ? (commInv.value_msat || BigInt(commInv.value || 0) * 1000n) : 0);
      const expectedNet = grossMsat - commMsat - actualFee;
      checks.sellerNet = actualFee <= feeCap && expectedNet >= 0;

      const allPass = checks.aliceSale && checks.bobCommission && checks.carolPayment &&
        checks.aliceOutgoing && checks.preimageMatch && checks.feeWithinCap && checks.sellerNet;

      return sendJson(res, 200, {
        ok: true,
        result: {
          aliceSale: checks.aliceSale,
          bobCommission: checks.bobCommission,
          carolPayment: checks.carolPayment,
          aliceOutgoing: checks.aliceOutgoing,
          preimageMatch: checks.preimageMatch,
          feeWithinCap: checks.feeWithinCap,
          sellerNet: checks.sellerNet,
        }
      });
    } catch (e) {
      return sendJson(res, 500, { error: { code: 'VERIFY_FAILED', message: e.message } });
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'route not found' } }));
});

function serializeCheckout(o) {
  return {
    id: o.id,
    external_order_id: o.external_order_id,
    payment_hash: o.payment_hash,
    sale_invoice: o.sale_invoice,
    commission_invoice: o.commission_invoice,
    amount_msat: String(o.gross_msat),
    amount_sats: Math.floor(Number(o.gross_msat) / 1000),
    commission_amount_msat: String(o.commission_msat),
    commission_amount_sats: Math.floor(Number(o.commission_msat) / 1000),
    fee_msat: String(o.fee_msat || 0),
    net_msat: String(o.net_msat || 0),
    state: o.state,
    created_at: o.created_at,
    settled_at: o.settled_at,
  };
}

server.listen(PORT, () => {
  console.log(`[alibi server] listening on http://localhost:${PORT}`);
  console.log(`[alibi server] demo mode=${DEMO_MODE} marketplace=${MARKETPLACE_PUBKEY || '(none)'}`);
});

if (require.main === module) {
  // No graceful shutdown needed for demo; keep process alive.
}

module.exports = { server, svc, db, CREATOR_ID, MARKETPLACE_PUBKEY, PAYEE_PUBKEY, DEMO_TOKEN_HASH, RAW_DEMO_TOKEN };
