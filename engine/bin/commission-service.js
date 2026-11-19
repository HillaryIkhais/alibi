#!/usr/bin/env node
/**
 * ALIBI COMMISSION SERVICE — COMPLETE INTEGRATION
 *
 * Vendor-side NWC Commission Payments implementation.
 * Connects policy enforcement with real LND operations.
 *
 * MODES:
 *   REAL     — HARBOR_LND_REST_URL + HARBOR_LND_MACAROON set
 *              Calls actual LND: AddHoldInvoice, SendPaymentV2,
 *              LookupInvoiceV2, SettleInvoice, CancelInvoice.
 *   SIM      — Credentials absent. Policy + math verified in memory.
 *              Explicitly labeled; never misrepresented as verified.
 *
 * COMMANDS:
 *   demo                              Policy + math verification (SIM)
 *   validate-amt <amt> <sale> <pubkey> <hash>   Commission math check
 *   setup-sale <amt_sats> <pct> <commission_invoice_bt11> <hash>   [REAL]
 *   look-up-invoice <hash>            [REAL]
 *   pay-commission <bolt11_invoice>   [REAL]
 *   settle-sale <hash> <preimage_hex> [REAL]
 *   cancel-sale <hash>                [REAL]
 *   reconcile <hash>                  [REAL] recover lost-response state
 *   budget                            Show current durable budget
 *
 * DURABLE STATE: SQLite at data/alibi.sqlite. Atomic budget reservation.
 * No commission is issued unless commission_msat + max_routing_fee_msat
 * are atomically reserved before the sale hold invoice is created.
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'alibi.sqlite');
const POLICY_PATH = path.join(DATA_DIR, 'commission-policy.json');
const COMPOSE_DIR = process.env.HARBOR_COMPOSE_DIR || path.join(__dirname, '..', '..', 'harbor');
const ALICE_CONTAINER = 'lnd-alice';

let sqlite3 = null;
let db = null;

// ── Durable SQLite state ──────────────────────────────────────────────────

function openDb() {
  try {
    sqlite3 = require('better-sqlite3');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new sqlite3(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS budget (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        max_budget_msat INTEGER NOT NULL,
        spent_msat INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS reservations (
        payment_hash TEXT PRIMARY KEY,
        amount_msat INTEGER NOT NULL,
        routing_fee_msat INTEGER NOT NULL DEFAULT 0,
        marketplace_pubkey TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved'
      );
      CREATE TABLE IF NOT EXISTS sales (
        payment_hash TEXT PRIMARY KEY,
        amount_msat INTEGER NOT NULL,
        commission_msat INTEGER NOT NULL,
        sale_invoice TEXT,
        preimage TEXT,
        sale_state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS commissions (
        payment_hash TEXT PRIMARY KEY,
        amount_msat INTEGER NOT NULL,
        commission_invoice TEXT,
        commission_state TEXT NOT NULL DEFAULT 'pending',
        paid_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        fingerprint TEXT PRIMARY KEY,
        payment_hash TEXT NOT NULL,
        request_params TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idem_hash ON idempotency_keys(payment_hash);
      CREATE TABLE IF NOT EXISTS policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        max_rate_ppm INTEGER NOT NULL,
        max_fixed_msat INTEGER NOT NULL DEFAULT 0,
        allowed_payee TEXT,
        base_msat INTEGER NOT NULL DEFAULT 1000,
        rate_ppm INTEGER NOT NULL DEFAULT 5000,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        authority_ref TEXT,
        input_hash TEXT,
        decision TEXT NOT NULL,
        reason_code TEXT,
        output_hash TEXT,
        timestamp INTEGER NOT NULL,
        version TEXT NOT NULL,
        parent_action TEXT,
        rail_receipt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_hash ON audit(input_hash);
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(timestamp);
    `);
    // Forward migrations for state created before the two-identity split and
    // the verified-payment accounting columns.
    try { db.exec('ALTER TABLE policy ADD COLUMN allowed_marketplace TEXT'); } catch (e) {}
    try { db.exec('ALTER TABLE policy ADD COLUMN max_budget_msat INTEGER NOT NULL DEFAULT 100000000'); } catch (e) {}
    try { db.exec('ALTER TABLE commissions ADD COLUMN fee_msat INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
    try { db.exec('ALTER TABLE commissions ADD COLUMN payment_preimage TEXT'); } catch (e) {}
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          fingerprint TEXT PRIMARY KEY,
          payment_hash TEXT NOT NULL,
          request_params TEXT NOT NULL,
          result TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_idem_hash ON idempotency_keys(payment_hash);
      `);
    } catch (e) {}

    // Seed policy if absent. The marketplace caller identity and the Lightning
    // invoice destination are DISTINCT identities with separate policy fields.
    const marketplace = process.env.HARBOR_MARKETPLACE_PUBKEY || null;
    const payee = process.env.HARBOR_COMMISSION_PAYEE_PUBKEY || marketplace;
    const row = db.prepare('SELECT id FROM policy WHERE id = 1').get();
    if (!row) {
      db.prepare(
        'INSERT INTO policy (id, max_rate_ppm, max_fixed_msat, allowed_payee, allowed_marketplace, base_msat, rate_ppm, updated_at) VALUES (1, 50000, 0, ?, ?, 1000, 5000, ?)'
      ).run(payee, marketplace, Math.floor(Date.now() / 1000));
    } else if (marketplace || process.env.HARBOR_COMMISSION_PAYEE_PUBKEY) {
      // Documented env vars are authoritative when set.
      db.prepare(
        'UPDATE policy SET allowed_marketplace = COALESCE(?, allowed_marketplace), allowed_payee = COALESCE(?, allowed_payee) WHERE id = 1'
      ).run(marketplace, process.env.HARBOR_COMMISSION_PAYEE_PUBKEY || null);
    }
    // Seed budget if absent
    const bro = db.prepare('SELECT id FROM budget WHERE id = 1').get();
    if (!bro) {
      db.prepare('INSERT INTO budget (id, max_budget_msat, spent_msat) VALUES (1, 100000000, 0)').run();
    }
  } catch (e) {
    console.error(`[alibi] SQLite unavailable (${e.message}); falling back to in-memory state`);
    db = null;
  }
}
openDb();

// ── Commission Policy (NWC draft: max_rate_ppm, payees, budget_msat) ─────

class CommissionPolicy {
  constructor(opts = {}) {
    this.maxRatePPM = opts.maxRatePPM ?? 50000;   // 5%
    this.maxFixedMsat = BigInt(opts.maxFixedMsat ?? 0);
    this.allowedPayee = opts.allowedPayee ?? null;
    // Distinct from allowedPayee: who may CALL make_commission_invoice vs where
    // the Lightning commission invoice actually pays.
    this.allowedMarketplace = opts.allowedMarketplace ?? null;
    this.maxBudgetMsat = BigInt(opts.maxBudgetMsat ?? 100000000); // 100,000 sats
    this.baseMsat = BigInt(opts.baseMsat ?? 1000);
    this.ratePPM = BigInt(opts.ratePPM ?? 5000); // 0.5% routing fee cap
  }

  static load() {
    // The documented env vars must configure the allowlist even when SQLite is
    // unavailable. Otherwise the in-memory fallback silently disables every
    // payee/marketplace check by leaving both identities null.
    if (!db) return new CommissionPolicy({
      allowedPayee: process.env.HARBOR_COMMISSION_PAYEE_PUBKEY || process.env.HARBOR_MARKETPLACE_PUBKEY || null,
      allowedMarketplace: process.env.HARBOR_MARKETPLACE_PUBKEY || null,
    });
    const p = db.prepare('SELECT * FROM policy WHERE id = 1').get();
    if (!p) return new CommissionPolicy();
    return new CommissionPolicy({
      maxRatePPM: p.max_rate_ppm,
      maxFixedMsat: p.max_fixed_msat,
      allowedPayee: p.allowed_payee || null,
      allowedMarketplace: p.allowed_marketplace || null,
      maxBudgetMsat: p.max_budget_msat ?? 100000000,
      baseMsat: p.base_msat,
      ratePPM: p.rate_ppm,
    });
  }

  save() {
    if (!db) return;
    db.prepare(
      'UPDATE policy SET max_rate_ppm=?, max_fixed_msat=?, allowed_payee=?, allowed_marketplace=?, max_budget_msat=?, base_msat=?, rate_ppm=?, updated_at=? WHERE id=1'
    ).run(
      this.maxRatePPM,
      Number(this.maxFixedMsat),
      this.allowedPayee,
      this.allowedMarketplace,
      Number(this.maxBudgetMsat),
      Number(this.baseMsat),
      Number(this.ratePPM),
      Math.floor(Date.now() / 1000)
    );
  }

  // commission amount from sale: floor(sale_msat * max_rate_ppm / 1e6) + max_fixed_msat
  maxCommissionMsat(saleMsat) {
    return (BigInt(saleMsat) * BigInt(this.maxRatePPM) / 1_000_000n) + this.maxFixedMsat;
  }

  maxRoutingFeeMsat(commissionMsat) {
    return this.baseMsat + (BigInt(commissionMsat) * this.ratePPM / 1_000_000n);
  }

  validateCommission({ commissionMsat, saleMsat, marketplacePubkey, paymentHash, commissionPayeePubkey, routingFeeMsat = 0n }) {
    const errors = [];
    const saleBigInt = BigInt(saleMsat);
    const commBigInt = BigInt(commissionMsat);
    const feeBigInt = BigInt(routingFeeMsat || 0n);
    // The full commitment is commission plus its maximum permitted routing fee.
    const totalCommitment = commBigInt + feeBigInt;

    // Rate check: commission <= floor(sale * max_rate_ppm / 1e6) + max_fixed
    const maxComm = this.maxCommissionMsat(saleBigInt);
    if (commBigInt > maxComm) {
      const pct = Number(commBigInt * 100n / saleBigInt);
      errors.push({ code: 'EXCEEDS_MAX_PERCENT', reason: `${pct}% > 5% max` });
    }

    // Two DISTINCT identities: where the funds go vs who may request it.
    if (this.allowedPayee && commissionPayeePubkey && commissionPayeePubkey !== this.allowedPayee) {
      errors.push({ code: 'UNAUTHORIZED_PAYEE', reason: 'Commission payee not in allowlist' });
    }
    if (this.allowedMarketplace && marketplacePubkey !== this.allowedMarketplace) {
      errors.push({ code: 'UNAUTHORIZED_MARKETPLACE', reason: 'Marketplace not authorized' });
    }

    // Budget check with active reservations (atomic)
    if (db) {
      const row = db.prepare('SELECT spent_msat FROM budget WHERE id = 1').get();
      const spent = BigInt(row.spent_msat);
      const reserved = db.prepare(
        'SELECT COALESCE(SUM(amount_msat + routing_fee_msat), 0) AS total FROM reservations WHERE status = ?'
      ).get('reserved');
      const reservedTotal = BigInt(reserved.total || 0);
      const remaining = this.maxBudgetMsat - spent - reservedTotal;
      if (totalCommitment > remaining) {
        errors.push({ code: 'BUDGET_EXCEEDED', reason: `Requested ${commBigInt}msat + ${feeBigInt}msat fee = ${totalCommitment}msat, remaining ${remaining}msat` });
      }
    } else {
      // in-memory fallback: derive reservations from live state, never from a
      // stale counter (the old `_memReserved` was never updated by reserve()).
      const reservedTotal = Array.from(this._memReservations.values())
        .reduce((sum, r) => sum + BigInt(r.amountMsat) + BigInt(r.routingFeeMsat || 0), 0n);
      const remaining = this.maxBudgetMsat - this._memSpent - reservedTotal;
      if (totalCommitment > remaining) {
        errors.push({ code: 'BUDGET_EXCEEDED', reason: `Requested ${commBigInt}msat + ${feeBigInt}msat fee = ${totalCommitment}msat, remaining ${remaining}msat` });
      }
    }

    // Duplicate hash
    if (db) {
      const exists = db.prepare('SELECT 1 FROM reservations WHERE payment_hash = ? AND status = ?').get(paymentHash, 'reserved');
      if (exists) errors.push({ code: 'DUPLICATE_HASH', reason: 'Payment hash already reserved' });
    } else {
      if (this._memReservations.has(paymentHash)) errors.push({ code: 'DUPLICATE_HASH', reason: 'Payment hash already reserved' });
    }

    return { valid: errors.length === 0, errors, maxCommissionMsat: Number(maxComm) };
  }

  // Atomic reservation: returns true only if budget sufficient and hash free
  // Rate/payee validation must be done BEFORE calling reserve (validateCommission).
  // The full commitment checked is amountMsat + routingFeeMsat <= remaining, so
  // the first reservation cannot exceed the budget by its own fee allowance.
  reserve({ paymentHash, amountMsat, routingFeeMsat = 0n, marketplacePubkey }) {
    const amt = BigInt(amountMsat);
    const fee = BigInt(routingFeeMsat || 0n);
    const commitment = amt + fee;
    if (db) {
      // Serialize budget check + duplicate check + insert in one immediate
      // transaction so separate service processes cannot both approve against
      // the same stale remaining balance.
      try {
        const txn = db.transaction(() => {
          const row = db.prepare('SELECT spent_msat FROM budget WHERE id = 1').get();
          const spent = BigInt(row.spent_msat);
          const reserved = db.prepare(
            'SELECT COALESCE(SUM(amount_msat + routing_fee_msat), 0) AS total FROM reservations WHERE status = ?'
          ).get('reserved');
          const reservedTotal = BigInt(reserved.total || 0);
          const remaining = this.maxBudgetMsat - spent - reservedTotal;
          if (commitment > remaining) {
            return { ok: false, reason: `Budget exceeded: requested ${commitment}msat (incl. fee), remaining ${remaining}msat` };
          }
          // Duplicate hash
          const exists = db.prepare('SELECT 1 FROM reservations WHERE payment_hash = ? AND status = ?').get(paymentHash, 'reserved');
          if (exists) return { ok: false, reason: 'Duplicate payment hash' };
          db.prepare(
            'INSERT INTO reservations (payment_hash, amount_msat, routing_fee_msat, marketplace_pubkey, created_at, status) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(paymentHash, Number(amt), Number(fee), marketplacePubkey, Math.floor(Date.now() / 1000), 'reserved');
          return { ok: true };
        });
        return txn();
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    } else {
      // Budget check with active reservations
      const reservedTotal = Array.from(this._memReservations.values())
        .reduce((sum, r) => sum + BigInt(r.amountMsat) + BigInt(r.routingFeeMsat || 0), 0n);
      const remaining = this.maxBudgetMsat - this._memSpent - reservedTotal;
      if (commitment > remaining) {
        return { ok: false, reason: `Budget exceeded: requested ${commitment}msat (incl. fee), remaining ${remaining}msat` };
      }
      // Duplicate hash
      if (this._memReservations.has(paymentHash)) return { ok: false, reason: 'Duplicate payment hash' };
      this._memReservations.set(paymentHash, { amountMsat: amt, routingFeeMsat: fee, marketplacePubkey });
      return { ok: true };
    }
  }

  release(paymentHash) {
    if (db) {
      db.prepare('DELETE FROM reservations WHERE payment_hash = ? AND status = ?').run(paymentHash, 'reserved');
    } else {
      this._memReservations.delete(paymentHash);
    }
  }

  // Commit the reserved commission plus the ACTUAL routing fee paid. The fee
  // is part of the reserved budget and must be debited, not silently absorbed.
  commitSpent(paymentHash, actualFeeMsat = 0) {
    const fee = BigInt(actualFeeMsat || 0);
    if (db) {
      const res = db.prepare('SELECT amount_msat FROM reservations WHERE payment_hash = ? AND status = ?').get(paymentHash, 'reserved');
      if (!res) return false;
      const total = BigInt(res.amount_msat) + fee;
      db.transaction(() => {
        db.prepare('UPDATE budget SET spent_msat = spent_msat + ? WHERE id = 1').run(Number(total));
        db.prepare('UPDATE reservations SET status = ?, routing_fee_msat = ? WHERE payment_hash = ?').run('spent', Number(fee), paymentHash);
      })();
      return Number(total);
    } else {
      const res = this._memReservations.get(paymentHash);
      if (!res) return false;
      const total = BigInt(res.amountMsat) + fee;
      this._memSpent += total;
      this._memReservations.delete(paymentHash);
      return Number(total);
    }
  }

  _memSpent = 0n;
  _memReserved = 0n;
  _memReservations = new Map();
}

// ── LND REST Client ───────────────────────────────────────────────────────

class LndClient {
  constructor(restUrl, macaroonHex, tlsCertPath = null) {
    this.restUrl = restUrl;
    this.macaroon = macaroonHex;
    this.tlsCertPath = tlsCertPath;
  }

  _opts(path, method) {
    const u = new URL(this.restUrl);
    const isHttps = u.protocol === 'https:';
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path,
      method,
      headers: { 'Grpc-Metadata-macaroon': this.macaroon },
    };
    if (isHttps) {
      if (!this.tlsCertPath || !fs.existsSync(this.tlsCertPath)) {
        throw new Error(`TLS cert required at ${this.tlsCertPath}; refusing to disable verification`);
      }
      opts.ca = fs.readFileSync(this.tlsCertPath);
      opts.rejectUnauthorized = true; // pin regtest self-signed cert
    }
    return opts;
  }

  request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const opts = this._opts(path, method);
      const req = (this.restUrl.startsWith('https') ? https : http).request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('LND timeout')));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // LND streaming endpoints (/v2/router/send, /v2/router/track/{hash}) return
  // newline-delimited JSON objects, not one JSON document. Buffering the whole
  // body and calling JSON.parse once throws as soon as a second update arrives.
  // Verified against live regtest: a single pay produced IN_FLIGHT + FAILED lines.
  requestStream(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const opts = this._opts(path, method);
      const updates = [];
      let buf = '';
      const pushLine = (line) => {
        const t = line.trim();
        if (!t) return;
        try { updates.push(JSON.parse(t)); } catch (e) { /* skip malformed line */ }
      };
      const req = (this.restUrl.startsWith('https') ? https : http).request(opts, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            pushLine(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        });
        res.on('end', () => {
          pushLine(buf);
          if (res.statusCode >= 400) {
            const msg = updates.map(u => u.error?.message || '').filter(Boolean).join('; ');
            reject(new Error(`LND ${res.statusCode}${msg ? ': ' + msg : ''}`));
          } else {
            resolve({ status: res.statusCode, updates });
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(90000, () => req.destroy(new Error('LND stream timeout')));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }

  async addHoldInvoice(valueMsat, paymentHashHex, description, expirySeconds = 3600, cltvExpiry = null) {
    // LND REST AddHoldInvoice expects the hash field named `hash`, base64-encoded
    // bytes. Verified on live regtest: `payment_hash` -> "unknown field" 400,
    // `hash` -> 200 with a payment_request.
    const paymentHashBuf = Buffer.from(paymentHashHex, 'hex');
    const body = {
      value_msat: String(valueMsat),
      hash: paymentHashBuf.toString('base64'),
      memo: description,
      expiry: String(expirySeconds),
    };
    // cltv_expiry sets the minimum final CLTV delta for incoming HTLCs (NWC
    // draft timing: sale CLTV >= R_max + M + T = 328 blocks).
    if (cltvExpiry != null) body.cltv_expiry = String(cltvExpiry);
    const r = await this.post('/v2/invoices/hodl', body);
    if (r.status >= 400) throw new Error(`AddHoldInvoice ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body; // { payment_request, r_hash, ... }
  }

  async lookupInvoice(paymentHash) {
    const r = await this.get(`/v1/invoice/${paymentHash}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new Error(`LookupInvoice ${r.status}`);
    return r.body;
  }

  async sendPaymentV2(paymentRequest, feeLimitMsat = 1000000, cltvLimit = null) {
    const body = {
      payment_request: paymentRequest,
      fee_limit_msat: String(feeLimitMsat),
      timeout_seconds: 60,
    };
    // Enforce the calculated total CLTV limit (L = min(E_in - M - current_height, R_max)).
    // Never use LND's unrestricted/default fee or CLTV setting.
    if (cltvLimit != null) body.cltv_limit = String(cltvLimit);
    const { updates } = await this.requestStream('POST', '/v2/router/send', body);
    const results = updates.map(u => u.result).filter(Boolean);
    if (!results.length) throw new Error('SendPaymentV2 returned no payment updates');
    // The final update is authoritative. Callers MUST check status === SUCCEEDED.
    const final = results[results.length - 1];
    return {
      status: final.status,
      failure_reason: final.failure_reason,
      fee_msat: final.fee_msat,
      payment_preimage: final.payment_preimage,
      payment_hash: final.payment_hash,
      value_msat: final.value_msat,
      updates: results.length,
    };
  }

  async settleInvoice(paymentHash, preimageHex) {
    // LND REST API expects preimage as base64
    const preimageBuf = Buffer.from(preimageHex, 'hex');
    const r = await this.post('/v2/invoices/settle', { preimage: preimageBuf.toString('base64') });
    if (r.status >= 400) throw new Error(`SettleInvoice ${r.status}`);
    return r.body;
  }

  async cancelInvoice(paymentHashHex) {
    // LND REST API expects payment_hash as base64
    const paymentHashBuf = Buffer.from(paymentHashHex, 'hex');
    const r = await this.post('/v2/invoices/cancel', { payment_hash: paymentHashBuf.toString('base64') });
    if (r.status >= 400) throw new Error(`CancelInvoice ${r.status}`);
    return r.body;
  }

  async getInfo() {
    const r = await this.get('/v1/getinfo');
    if (r.status >= 400) throw new Error(`GetInfo ${r.status}`);
    return r.body;
  }

  async trackPayment(paymentHash) {
    // Also a server-streaming endpoint: parse the NDJSON updates and return the
    // last (terminal) one. The path parameter is base64 bytes, NOT hex —
    // passing hex makes LND decode 64 chars as 48 bytes and reject it.
    const hashB64 = Buffer.from(paymentHash, 'hex').toString('base64');
    const { updates } = await this.requestStream('GET', `/v2/router/track/${encodeURIComponent(hashB64)}`);
    const results = updates.map(u => u.result).filter(Boolean);
    if (!results.length) throw new Error('TrackPayment returned no updates');
    return results[results.length - 1];
  }

  // TrackPaymentV2 only serves payments still in the router's control tower:
  // completed payments return 404. ListPayments is the authoritative durable
  // record of an outgoing payment (verified on live regtest LND 0.21).
  async findPayment(paymentHash) {
    const r = await this.get('/v1/payments?include_incomplete=true&reversed=true&num_max_payments=100');
    if (r.status >= 400) throw new Error(`ListPayments ${r.status}`);
    const payments = r.body?.payments || [];
    return payments.find(p => p.payment_hash === paymentHash) || null;
  }

  async decodePayReq(paymentRequest) {
    // LND: GET /v1/payreq/{pay_req}
    const r = await this.get(`/v1/payreq/${paymentRequest}`);
    if (r.status >= 400) throw new Error(`DecodePayReq ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

// ── Action Contracts (Agent-Native Architecture) ──────────────────────────

/**
 * Shared action contract: every action (UI, agent, SDK, test) goes through
 * the same authorize/execute/audit schema. Authorization is separate from
 * execution; the decision is data (ALLOW | BLOCK | APPROVAL_REQUIRED).
 */
class ActionContract {
  constructor({ name, input, authorize, execute, audit, reversible, requiresApproval }) {
    this.name = name;
    this.input = input;
    this.authorize = authorize;
    this.execute = execute;
    this.audit = audit;
    this.reversible = reversible ?? false;
    this.requiresApproval = requiresApproval ?? false;
  }

  async call(actor, input, state, version = '1.0.0') {
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

    // Step 1: Authorize (deterministic, not prompt-based)
    const decision = await this.authorize(actor, input, state);
    const decisionData = typeof decision === 'string' ? { status: decision } : decision;

    // Step 2: Execute only if ALLOWED
    let result;
    if (decisionData.status === 'ALLOW') {
      result = await this.execute(input, state);
    } else if (decisionData.status === 'APPROVAL_REQUIRED') {
      return {
        status: 'APPROVAL_REQUIRED',
        reason: decisionData.reason || 'Human approval required',
        inputHash,
        contract: this.name,
      };
    } else {
      return {
        status: 'BLOCKED',
        reason: decisionData.reason || 'Action not authorized',
        inputHash,
        contract: this.name,
      };
    }

    // Step 3: Audit (part of the contract, not a side effect)
    const outputHash = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
    const auditRecord = {
      actor,
      authority_ref: state?.authorityRef || null,
      input_hash: inputHash,
      decision: decisionData.status,
      reason_code: decisionData.reason || null,
      output_hash: outputHash,
      timestamp: Math.floor(Date.now() / 1000),
      version,
      parent_action: state?.parentAction || null,
      rail_receipt: result?.railReceipt || null,
    };

    if (this.audit) {
      this.audit(auditRecord);
    }

    return { status: decisionData.status, result, inputHash, outputHash, audit: auditRecord };
  }
}

// ── Service ───────────────────────────────────────────────────────────────

class CommissionService {
  constructor() {
    this.policy = CommissionPolicy.load();
    this.restUrl = process.env.HARBOR_LND_REST_URL || '';
    this.macaroon = process.env.HARBOR_LND_MACAROON || '';
    this.tlsCert = process.env.HARBOR_LND_TLS_CERT || null;
    this.lnd = (this.restUrl && this.macaroon) ? new LndClient(this.restUrl, this.macaroon, this.tlsCert) : null;
    this.mode = this.lnd ? 'REAL' : 'SIM';
    this.auditLog = []; // in-memory fallback when SQLite unavailable (SIM mode only)
    // Verified fee caps for outgoing payments when SQLite is unavailable.
    this.paymentCaps = new Map();
    // REAL mode requires durable storage. Fail closed rather than silently
    // falling back to ephemeral in-memory state for held payments and budget.
    if (this.mode === 'REAL' && !db) {
      throw new Error('REAL mode requires durable SQLite storage; better-sqlite3 unavailable or data dir not writable');
    }
    console.log(`[alibi] mode=${this.mode} policy=5% max_budget=100,000sats`);
    console.log(`[alibi] marketplace=${this.policy.allowedMarketplace ?? '(none set)'} payee=${this.policy.allowedPayee ?? '(none set)'}`);
  }

  // ── LND decodePayReq via lncli (inside Alice's container) ────────────────
  //
  // LND's REST DecodePayReq endpoint expects the pay_req as hex-encoded bytes in
  // the URL path, but there is a version-specific issue where it fails to parse
  // the hex string correctly. We fall back to lncli inside Alice's container,
  // which accepts the raw BOLT11 invoice string.
  decodePayReqViaLncli(paymentRequest) {
    try {
      const out = execFileSync(
        'docker',
        ['compose', '-f', path.join(COMPOSE_DIR, 'docker-compose.yml'), 'exec', '-T', 'lnd-alice',
         'lncli', '--network=regtest', '--rpcserver=127.0.0.1:10029', 'decodepayreq', paymentRequest],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      return JSON.parse(out);
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      throw new Error(`lncli decodepayreq failed: ${stderr || e.message}`);
    }
  }

  // ── Provenance / audit ──────────────────────────────────────────────

  recordAudit(actor, authorityRef, inputHash, decision, reasonCode, outputHash, parentAction, railReceipt) {
    const record = {
      actor,
      authority_ref: authorityRef || null,
      input_hash: inputHash,
      decision,
      reason_code: reasonCode || null,
      output_hash: outputHash || null,
      timestamp: Math.floor(Date.now() / 1000),
      version: '1.0.0',
      parent_action: parentAction || null,
      rail_receipt: railReceipt || null,
    };
    if (db) {
      db.prepare(
        'INSERT INTO audit (actor, authority_ref, input_hash, decision, reason_code, output_hash, timestamp, version, parent_action, rail_receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        record.actor, record.authority_ref, record.input_hash, record.decision,
        record.reason_code, record.output_hash, record.timestamp, record.version,
        record.parent_action, record.rail_receipt
      );
    } else {
      this.auditLog.push(record);
    }
    return record;
  }

  // ── NWC make_commission_invoice handler ──────────────────────────────
  //
  // NWC draft semantics:
  //   amount        = sale amount in millisatoshis (what buyer pays)
  //   commission_invoice = BOLT11 hold invoice created by marketplace
  //                        its decoded amount = commission the marketplace requests
  //   payment_hash  = shared hash linking sale + commission invoices
  //
  // The wallet decodes commission_invoice, validates policy, then creates
  // a sale hold invoice for the buyer to pay. The commission is settled
  // separately (wallet pays commission invoice) using the shared preimage.
  //
  // NWC draft pre-creation validation (every check enforced here):
  //  1. payment hash exactly matches the requested sale hash
  //  2. commission invoice carries a positive amount (num_msat exact, num_satoshis fallback)
  //  3. commission + max routing fee strictly less than sale amount
  //  4. commission within rate and fixed-amount limits
  //  5. destination is an explicitly permitted payee
  //  6. marketplace caller is separately authorized
  //  7. commission invoice expiry >= sale invoice expiry + 300s
  //  8. commission invoice network matches vendor node chain
  //  9. payment hash not previously used (idempotent retry allowed)
  // 10. commission + fee commitment fits remaining budget
  //
  async handleMakeCommissionInvoice({ amount, payment_hash, commission_invoice, expiry, marketplace_pubkey }) {
    if (!amount || !payment_hash || !commission_invoice) {
      return { result: 'error', error: { code: 'INVALID_PARAMS', message: 'amount, payment_hash, commission_invoice required' } };
    }

    // ── 1. amount = sale amount in msat (per NWC draft) ──
    const saleMsat = BigInt(amount);

    // ── 2. Decode commission_invoice BOLT11 to extract commission details ──
    let commission;
    if (this.lnd) {
      try {
        commission = await this.decodePayReqViaLncli(commission_invoice);
      } catch (e) {
        return { result: 'error', error: { code: 'INVALID_COMMISSION_INVOICE', message: e.message } };
      }
    } else {
      return { result: 'error', error: { code: 'NO_LND', message: 'LND required to decode commission invoice' } };
    }

    // ── 3. Validate decoded commission invoice ──
    const commissionHash = String(commission.payment_hash || '');
    if (commissionHash !== payment_hash) {
      return { result: 'error', error: { code: 'PAYMENT_HASH_MISMATCH', message: 'commission invoice payment hash does not match' } };
    }

    // Exact commission amount: num_msat is preferred (no truncation). num_satoshis
    // is only a fallback where exact millisatoshis are unavailable, and the
    // resulting precision loss is acceptable only for display, never for policy.
    const commissionMsat = BigInt(commission.num_msat || (BigInt(commission.num_satoshis || 0) * 1000n) || 0n);
    if (commissionMsat <= 0n) {
      return { result: 'error', error: { code: 'INVALID_COMMISSION_AMOUNT', message: 'commission invoice has no amount' } };
    }

    // Commission plus its maximum routing fee must be strictly less than the
    // sale amount — the vendor must always keep a remainder.
    const routingFeeMsat = this.policy.maxRoutingFeeMsat(commissionMsat);
    if (commissionMsat + routingFeeMsat >= saleMsat) {
      return { result: 'error', error: { code: 'COMMISSION_EXCEEDS_SALE', message: 'commission plus routing fee must be strictly less than sale amount' } };
    }

    // Network: DecodePayReq has NO `network` field (verified against live LND
    // 0.21). Establish the chain from the node itself, and independently decode
    // the BOLT11 prefix so a mainnet invoice cannot be slipped past a regtest node.
    let nodeNetwork = '';
    try {
      const info = await this.lnd.getInfo();
      nodeNetwork = String(info.chains?.[0]?.network || '').toLowerCase();
    } catch (e) {
      return { result: 'error', error: { code: 'NODE_INFO_FAILED', message: e.message } };
    }
    if (nodeNetwork !== 'regtest') {
      return { result: 'error', error: { code: 'WRONG_NETWORK', message: `node network is ${nodeNetwork || 'unknown'}, not regtest` } };
    }
    // The decoded invoice has no payment_request field; inspect the input BOLT11
    // string's prefix to establish its network.
    const boltPrefix = String(commission_invoice || '').slice(0, 6).toLowerCase();
    const boltNetwork = boltPrefix === 'lnbcrt' ? 'regtest' :
                        boltPrefix === 'lnbc' ? 'mainnet' :
                        boltPrefix === 'lntb' ? 'testnet' :
                        boltPrefix === 'lntbs' ? 'signet' : 'unknown';
    if (boltNetwork !== nodeNetwork) {
      return { result: 'error', error: { code: 'BOLT11_NETWORK_MISMATCH', message: `BOLT11 prefix ${boltPrefix || '(empty)'} implies ${boltNetwork}, node is ${nodeNetwork}` } };
    }

    // Expiry: commission invoice must outlive the sale invoice by at least 300s
    // so the buyer's held HTLC can be settled after the commission pays.
    const saleExpiry = Number(expiry || 3600);
    const commissionExpiry = Number(commission.expiry || 0);
    if (commissionExpiry > 0 && commissionExpiry < saleExpiry + 300) {
      return { result: 'error', error: { code: 'COMMISSION_EXPIRY_TOO_SHORT', message: `commission expiry ${commissionExpiry}s must be >= sale expiry ${saleExpiry}s + 300s` } };
    }

    // Payee check: destination pubkey must be in allowed payees
    const destPubkey = String(commission.destination || '');
    if (this.policy.allowedPayee && destPubkey !== this.policy.allowedPayee) {
      return { result: 'error', error: { code: 'UNAUTHORIZED_PAYEE', message: 'commission payee not authorized' } };
    }

    // Marketplace caller identity is SEPARATE from the Lightning invoice payee.
    // The caller must be the configured marketplace, and must actually present
    // an identity — falling back to the configured value would authenticate
    // every anonymous request as the marketplace.
    const reqMarketPubkey = String(marketplace_pubkey || '');
    if (this.policy.allowedMarketplace) {
      if (!reqMarketPubkey) {
        return { result: 'error', error: { code: 'MISSING_MARKETPLACE_IDENTITY', message: 'marketplace identity not supplied by caller' } };
      }
      if (reqMarketPubkey !== this.policy.allowedMarketplace) {
        return { result: 'error', error: { code: 'UNAUTHORIZED_MARKETPLACE', message: 'Marketplace caller not in allowlist' } };
      }
    }

    // ── 9. Idempotency: identical retry returns the original result ──
    const fingerprint = crypto.createHash('sha256').update(
      JSON.stringify({ caller: reqMarketPubkey, payment_hash, amount, commission_invoice, expiry })
    ).digest('hex');
    if (db) {
      const prior = db.prepare('SELECT payment_hash, request_params, result FROM idempotency_keys WHERE fingerprint = ?').get(fingerprint);
      if (prior) {
        const sameParams = prior.request_params === JSON.stringify({ amount, payment_hash, commission_invoice, expiry, marketplace_pubkey: reqMarketPubkey });
        if (!sameParams) {
          return { result: 'error', error: { code: 'IDEMPOTENCY_CONFLICT', message: 'same hash used with different parameters; replay rejected' } };
        }
        // Same connection + same hash + identical parameters: return original result.
        return JSON.parse(prior.result);
      }
    }

    // ── 4/10. Policy validation: commission rate vs sale amount, with fee-aware budget ──
    const validation = this.policy.validateCommission({
      commissionMsat, saleMsat,
      marketplacePubkey: reqMarketPubkey,
      paymentHash: payment_hash,
      commissionPayeePubkey: destPubkey,
      routingFeeMsat,
    });
    if (!validation.valid) {
      return { result: 'error', error: { code: 'POLICY_REJECTION', message: validation.errors[0].reason, details: validation.errors } };
    }

    // ── 5/10. Atomic budget reservation (includes routing fee) ──
    const reserved = this.policy.reserve({
      paymentHash: payment_hash, amountMsat: commissionMsat,
      routingFeeMsat, marketplacePubkey: reqMarketPubkey,
    });
    if (!reserved.ok) {
      return { result: 'error', error: { code: 'BUDGET_EXCEEDED', message: reserved.reason } };
    }

    // ── 6. Create sale hold invoice for buyer with protocol CLTV ──
    // Sale hold invoice minimum final CLTV delta = R_max + M + T = 244 + 80 + 4 = 328 blocks.
    const SALE_MIN_CLTV = 328;
    let saleInvoice = null;
    try {
      const inv = await this.lnd.addHoldInvoice(saleMsat, payment_hash, `Commission-bound sale ${Number(saleMsat / 1000n)} sats`, saleExpiry, SALE_MIN_CLTV);
      saleInvoice = inv.payment_request;
      // Verify the created invoice carries the required CLTV before returning it.
      const created = await this.decodePayReqViaLncli(saleInvoice);
      const createdCltv = Number(created.cltv_expiry || 0);
      if (createdCltv < SALE_MIN_CLTV) {
        await this.lnd.cancelInvoice(payment_hash);
        this.policy.release(payment_hash);
        return { result: 'error', error: { code: 'CLTV_INSUFFICIENT', message: `created sale invoice CLTV ${createdCltv} < required ${SALE_MIN_CLTV}` } };
      }
      if (db) {
        db.prepare(
          'INSERT INTO sales (payment_hash, amount_msat, commission_msat, sale_invoice, sale_state, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(payment_hash, Number(saleMsat), Number(commissionMsat), saleInvoice, 'pending', Math.floor(Date.now() / 1000));
        db.prepare(
          'INSERT INTO commissions (payment_hash, amount_msat, commission_invoice, commission_state) VALUES (?, ?, ?, ?)'
        ).run(payment_hash, Number(commissionMsat), commission_invoice, 'pending');
        // Persist idempotency key so an identical retry returns this result.
        db.prepare(
          'INSERT INTO idempotency_keys (fingerprint, payment_hash, request_params, result, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(fingerprint, payment_hash, JSON.stringify({ amount, payment_hash, commission_invoice, expiry, marketplace_pubkey: reqMarketPubkey }), JSON.stringify({ result: 'success', data: { payment_hash, invoice: saleInvoice, amount_msat: String(saleMsat), expires_at: Math.floor(Date.now() / 1000) + saleExpiry, metadata: { commission_amount_msat: String(commissionMsat), max_routing_fee_msat: String(routingFeeMsat), commission_payee: destPubkey } } }), Math.floor(Date.now() / 1000));
      }
    } catch (e) {
      this.policy.release(payment_hash);
      return { result: 'error', error: { code: 'INVOICE_CREATION_FAILED', message: e.message } };
    }

    return {
      result: 'success',
      data: {
        payment_hash,
        invoice: saleInvoice,
        amount_msat: String(saleMsat),
        expires_at: Math.floor(Date.now() / 1000) + saleExpiry,
        metadata: {
          commission_amount_msat: String(commissionMsat),
          max_routing_fee_msat: String(routingFeeMsat),
          commission_payee: destPubkey,
        },
      },
    };
  }

  // ── Audit-friendly wrapper for make_commission_invoice ──
  async recordCommissionInvoiceAudit({ amount, payment_hash, commission_invoice, expiry, marketplacePubkey }) {
    const inputHash = crypto.createHash('sha256').update(
      JSON.stringify({ amount, payment_hash, commission_invoice, expiry, marketplacePubkey })
    ).digest('hex');
    const outputHash = crypto.createHash('sha256').update(
      JSON.stringify({ payment_hash, amount_msat: String(amount) })
    ).digest('hex');

    const validation = this.policy.validateCommission({
      commissionMsat: BigInt(amount),
      saleMsat: (BigInt(amount) * 1_000_000n) / BigInt(this.policy.maxRatePPM),
      marketplacePubkey: this.policy.allowedPayee || '',
      paymentHash: payment_hash,
      commissionPayeePubkey: this.policy.allowedPayee || '',
    });

    const decision = validation.valid ? 'ALLOW' : 'BLOCKED';
    this.recordAudit(
      marketplacePubkey || 'unknown',
      this.policy.allowedPayee || null,
      inputHash,
      decision,
      validation.valid ? null : validation.errors[0]?.code,
      outputHash,
      null,
      null
    );
    return { decision, validation };
  }

  // ── CLI flow commands ──────────────────────────────────────────────────

  async setupSale({ saleAmtSats, commissionPct, commissionInvoice, paymentHash }) {
    if (!paymentHash) paymentHash = crypto.randomBytes(32).toString('hex');
    const saleMsat = BigInt(saleAmtSats) * 1000n;
    const commissionMsat = (saleMsat * BigInt(commissionPct)) / 100n;

    // CLI path: the calling marketplace and the invoice destination are still
    // distinct policy identities. Default the caller to the configured
    // marketplace, never silently to the payee.
    const caller = this.policy.allowedMarketplace || this.policy.allowedPayee || '';
    const routingFeeMsat = this.policy.maxRoutingFeeMsat(commissionMsat);
    const validation = this.policy.validateCommission({
      commissionMsat, saleMsat, marketplacePubkey: caller,
      paymentHash, commissionPayeePubkey: this.policy.allowedPayee || '',
      routingFeeMsat,
    });
    if (!validation.valid) {
      return { success: false, reason: 'policy rejection', details: validation.errors };
    }
    const reserved = this.policy.reserve({
      paymentHash, amountMsat: commissionMsat, routingFeeMsat,
      marketplacePubkey: caller,
    });
    if (!reserved.ok) return { success: false, reason: reserved.reason };

    let saleInvoice = null;
    if (this.lnd) {
      try {
        const inv = await this.lnd.addHoldInvoice(saleMsat, paymentHash, `Sale ${saleAmtSats} sats + ${commissionPct}% commission`);
        saleInvoice = inv.payment_request;
        if (db) {
          db.prepare(
            'INSERT INTO sales (payment_hash, amount_msat, commission_msat, sale_invoice, sale_state, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(paymentHash, Number(saleMsat), Number(commissionMsat), saleInvoice, 'pending', Math.floor(Date.now() / 1000));
          db.prepare(
            'INSERT INTO commissions (payment_hash, amount_msat, commission_invoice, commission_state) VALUES (?, ?, ?, ?)'
          ).run(paymentHash, Number(commissionMsat), commissionInvoice, 'pending');
        }
      } catch (e) {
        this.policy.release(paymentHash);
        return { success: false, reason: e.message };
      }
    }

    return {
      success: true,
      paymentHash,
      saleInvoice,
      saleAmtSats,
      commissionAmtSats: Number(commissionMsat / 1000n),
      vendorNetBeforeFees: Number((saleMsat - commissionMsat) / 1000n),
      mode: this.mode,
    };
  }

  // ── Audit wrapper for setupSale ──
  async recordSetupSaleAudit({ saleAmtSats, commissionPct, commissionInvoice, paymentHash, marketplacePubkey }) {
    const saleMsat = BigInt(saleAmtSats) * 1000n;
    const commissionMsat = (saleMsat * BigInt(commissionPct)) / 100n;
    const inputHash = crypto.createHash('sha256').update(
      JSON.stringify({ saleAmtSats, commissionPct, commissionInvoice, paymentHash, marketplacePubkey })
    ).digest('hex');
    const outputHash = crypto.createHash('sha256').update(
      JSON.stringify({ paymentHash, saleAmtSats, commissionAmtSats: Number(commissionMsat / 1000n) })
    ).digest('hex');

    const validation = this.policy.validateCommission({
      commissionMsat, saleMsat,
      marketplacePubkey: this.policy.allowedMarketplace || this.policy.allowedPayee || '',
      paymentHash,
      commissionPayeePubkey: this.policy.allowedPayee || '',
    });

    const decision = validation.valid ? 'ALLOW' : 'BLOCKED';
    this.recordAudit(
      marketplacePubkey || 'unknown',
      this.policy.allowedPayee || null,
      inputHash,
      decision,
      validation.valid ? null : validation.errors[0]?.code,
      outputHash,
      null,
      null
    );
    return { decision, validation };
  }

  async payCommission(paymentRequest, expectedPaymentHash = null) {
    if (!this.lnd) return { success: false, reason: 'REAL mode required; no LND credentials' };
    try {
      // ── PREFLIGHT (before any spend) ──
      // Decode the commission invoice and validate every policy requirement
      // before invoking SendPaymentV2. A wrong invoice must never be paid.
      let decoded;
      try {
        decoded = await this.decodePayReqViaLncli(paymentRequest);
      } catch (e) {
        return { success: false, reason: `cannot decode commission invoice: ${e.message}` };
      }

      // Verify the expected payment hash BEFORE sending — never pay a wrong
      // invoice and only discover the mismatch afterward.
      const decodedHash = String(decoded.payment_hash || '');
      if (expectedPaymentHash && decodedHash !== expectedPaymentHash) {
        return { success: false, reason: 'commission invoice payment hash does not match expected sale hash', decoded };
      }

      // Exact commission amount: num_msat preferred, num_satoshis fallback.
      const commMsat = BigInt(decoded.num_msat || (BigInt(decoded.num_satoshis || 0) * 1000n) || 0n);
      if (commMsat <= 0n) {
        return { success: false, reason: 'commission invoice has no payable amount', decoded };
      }

      // Fee cap from the actual exact commission amount (not LND's default).
      const cap = this.policy.maxRoutingFeeMsat(commMsat);
      if (cap <= 0n) return { success: false, reason: 'cannot determine commission fee cap', decoded };

      // Network: commission invoice must be on the vendor's chain.
      let nodeNetwork = '';
      try {
        const info = await this.lnd.getInfo();
        nodeNetwork = String(info.chains?.[0]?.network || '').toLowerCase();
      } catch (e) {
        return { success: false, reason: `cannot determine node network: ${e.message}`, decoded };
      }
      if (nodeNetwork !== 'regtest') {
        return { success: false, reason: `node network is ${nodeNetwork || 'unknown'}, not regtest`, decoded };
      }
      const boltPrefix = String(paymentRequest || '').slice(0, 6).toLowerCase();
      const boltNetwork = boltPrefix === 'lnbcrt' ? 'regtest' :
                          boltPrefix === 'lnbc' ? 'mainnet' :
                          boltPrefix === 'lntb' ? 'testnet' :
                          boltPrefix === 'lntbs' ? 'signet' : 'unknown';
      if (boltNetwork !== nodeNetwork) {
        return { success: false, reason: `BOLT11 prefix ${boltPrefix} implies ${boltNetwork}, node is ${nodeNetwork}`, decoded };
      }

      // Payee: destination must be the approved commission payee.
      const destPubkey = String(decoded.destination || '');
      if (this.policy.allowedPayee && destPubkey !== this.policy.allowedPayee) {
        return { success: false, reason: 'commission payee not authorized', decoded };
      }

      // Expiry: commission invoice must not be dust-stale.
      const commExpiry = Number(decoded.expiry || 0);
      if (commExpiry > 0 && commExpiry < 300) {
        return { success: false, reason: `commission invoice expiry ${commExpiry}s too short`, decoded };
      }

      // ── Send the commission payment through the production service ──
      const result = await this.lnd.sendPaymentV2(paymentRequest, Number(cap));
      if (result.status !== 'SUCCEEDED') {
        return { success: false, reason: `commission payment ${result.status}`, failure_reason: result.failure_reason, payment: result, decoded };
      }

      // ── Verify the actual outgoing payment on the vendor node ──
      // Terminal SUCCEEDED, exact hash, exact amount, valid preimage,
      // SHA256(preimage) == expectedPaymentHash, actual fee within cap.
      if (result.payment_hash && expectedPaymentHash && result.payment_hash !== expectedPaymentHash) {
        return { success: false, reason: 'paid payment hash does not match expected sale hash', payment: result, decoded };
      }
      if (result.value_msat && BigInt(result.value_msat) !== commMsat) {
        return { success: false, reason: `paid amount ${result.value_msat}msat does not match commission invoice ${commMsat}msat`, payment: result, decoded };
      }
      const preimageHex = String(result.payment_preimage || '');
      if (!/^[0-9a-f]{64}$/.test(preimageHex)) {
        return { success: false, reason: 'payment preimage is not a valid 32-byte hex value', payment: result, decoded };
      }
      if (crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex') !== (expectedPaymentHash || decodedHash)) {
        return { success: false, reason: 'SHA256(preimage) does not match payment hash', payment: result, decoded };
      }
      const feeMsat = BigInt(result.fee_msat || '0');
      if (feeMsat > cap) {
        return { success: false, reason: `routing fee ${feeMsat}msat exceeds cap ${cap}msat`, payment: result, decoded };
      }

      this.paymentCaps.set(result.payment_hash, Number(cap));
      if (db) {
        db.prepare(
          'UPDATE commissions SET commission_state=?, paid_at=?, fee_msat=?, payment_preimage=? WHERE payment_hash=?'
        ).run('paid', Math.floor(Date.now() / 1000), Number(feeMsat), preimageHex, result.payment_hash);
      }
      return {
        success: true,
        payment: result,
        decoded,
        fee_msat: Number(feeMsat),
        fee_cap_msat: Number(cap),
        payment_hash: result.payment_hash,
        verified_status: result.status,
        preimage_hex: preimageHex,
      };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  async settleSale({ paymentHash, preimageHex }) {
    if (!this.lnd) return { success: false, reason: 'REAL mode required' };
    const preimageBuf = Buffer.from(preimageHex, 'hex');
    const calcHash = crypto.createHash('sha256').update(preimageBuf).digest('hex');
    if (calcHash !== paymentHash) return { success: false, reason: 'preimage hash mismatch' };

    // INVARIANT: possessing the preimage is NOT proof the vendor paid the
    // marketplace. Query the vendor node's own outgoing payment state and
    // require a terminal SUCCEEDED result before releasing the buyer's HTLC.
    let pay;
    try {
      pay = await this.lnd.findPayment(paymentHash);
    } catch (e) {
      return { success: false, reason: `outgoing commission payment not verifiable: ${e.message}` };
    }
    if (!pay) {
      return { success: false, reason: 'outgoing commission payment not found on vendor node' };
    }
    if (pay.status !== 'SUCCEEDED') {
      return { success: false, reason: `outgoing commission payment not SUCCEEDED (${pay?.status || 'unknown'})` };
    }
    if (pay.payment_hash && pay.payment_hash !== paymentHash) {
      return { success: false, reason: 'verified payment hash does not match sale hash' };
    }
    if (pay.payment_preimage && pay.payment_preimage !== preimageHex) {
      return { success: false, reason: 'verified payment preimage does not match supplied preimage' };
    }

    // Enforce the reserved routing-fee cap against the ACTUAL fee paid.
    let reservedFeeCap = null;
    if (db) {
      const r = db.prepare('SELECT routing_fee_msat FROM reservations WHERE payment_hash = ?').get(paymentHash);
      if (r) reservedFeeCap = BigInt(r.routing_fee_msat || 0);
    }
    if (reservedFeeCap === null && this.paymentCaps?.has(paymentHash)) {
      reservedFeeCap = BigInt(this.paymentCaps.get(paymentHash));
    }
    if (reservedFeeCap === null && pay.value_msat) {
      // Last resort: derive the cap from policy against the verified commission
      // amount, so the fee is never left unchecked in in-memory mode.
      reservedFeeCap = this.policy.maxRoutingFeeMsat(BigInt(pay.value_msat));
    }
    const feeMsat = BigInt(pay.fee_msat || '0');
    if (reservedFeeCap !== null && feeMsat > reservedFeeCap) {
      return { success: false, reason: `actual fee ${feeMsat}msat exceeds reserved cap ${reservedFeeCap}msat` };
    }

    try {
      await this.lnd.settleInvoice(paymentHash, preimageHex);
      const totalCommitted = this.policy.commitSpent(paymentHash, feeMsat);
      if (db) {
        db.prepare('UPDATE sales SET sale_state = ?, settled_at = ? WHERE payment_hash = ?').run('settled', Math.floor(Date.now() / 1000), paymentHash);
        db.prepare(
          'UPDATE commissions SET commission_state=?, paid_at=?, fee_msat=?, payment_preimage=? WHERE payment_hash=?'
        ).run('settled', Math.floor(Date.now() / 1000), Number(feeMsat), preimageHex, paymentHash);
      }
      this.recordAudit(
        'settle-sale', paymentHash,
        crypto.createHash('sha256').update(JSON.stringify({ paymentHash, preimageHex })).digest('hex'),
        'ALLOW', 'OUTGOING_PAYMENT_VERIFIED',
        crypto.createHash('sha256').update(JSON.stringify({ paymentHash, feeMsat: Number(feeMsat) })).digest('hex'),
        null, null
      );
      return {
        success: true, verified: true,
        outgoing_payment_status: pay.status,
        actual_fee_msat: Number(feeMsat),
        reserved_fee_cap_msat: reservedFeeCap === null ? null : Number(reservedFeeCap),
        total_budget_debit_msat: totalCommitted,
      };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  async recordSettleSaleAudit({ paymentHash, preimageHex, marketplacePubkey }) {
    const inputHash = crypto.createHash('sha256').update(
      JSON.stringify({ paymentHash, preimageHex })
    ).digest('hex');
    const preimageBuf = Buffer.from(preimageHex, 'hex');
    const calcHash = crypto.createHash('sha256').update(preimageBuf).digest('hex');
    if (calcHash !== paymentHash) {
      this.recordAudit(
        marketplacePubkey || 'unknown',
        this.policy.allowedPayee || null,
        inputHash,
        'BLOCKED',
        'PREIMAGE_HASH_MISMATCH',
        null,
        null,
        null
      );
      return { success: false, reason: 'preimage hash mismatch' };
    }
    const outputHash = crypto.createHash('sha256').update(
      JSON.stringify({ paymentHash, settled: true })
    ).digest('hex');
    this.recordAudit(
      marketplacePubkey || 'unknown',
      this.policy.allowedPayee || null,
      inputHash,
      'ALLOW',
      null,
      outputHash,
      null,
      null
    );
    return { success: true, verified: true };
  }

  async cancelSale({ paymentHash }) {
    if (!this.lnd) return { success: false, reason: 'REAL mode required' };
    try {
      await this.lnd.cancelInvoice(paymentHash);
      if (db) {
        db.prepare('UPDATE sales SET sale_state = ? WHERE payment_hash = ?').run('canceled', paymentHash);
        db.prepare('UPDATE commissions SET commission_state = ? WHERE payment_hash = ?').run('canceled', paymentHash);
      }
      this.policy.release(paymentHash);
      return { success: true };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  async recordCancelSaleAudit({ paymentHash, marketplacePubkey }) {
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ paymentHash })).digest('hex');
    const outputHash = crypto.createHash('sha256').update(
      JSON.stringify({ paymentHash, canceled: true })
    ).digest('hex');
    this.recordAudit(
      marketplacePubkey || 'unknown',
      this.policy.allowedPayee || null,
      inputHash,
      'ALLOW',
      null,
      outputHash,
      null,
      null
    );
    return { success: true };
  }

  async reconcile({ paymentHash }) {
    if (!this.lnd) return { success: false, reason: 'REAL mode required' };

    // Authoritative LND state, not the application DB. Both legs are checked:
    // the incoming sale hold invoice and the outgoing commission payment.
    const invoice = await this.lnd.lookupInvoice(paymentHash);
    if (!invoice) return { success: false, reason: 'sale invoice not found on node' };

    let outgoing = null;
    try { outgoing = await this.lnd.findPayment(paymentHash); } catch (e) { /* no outgoing payment yet */ }

    const state = {
      paymentHash,
      nodeState: invoice.state,
      settled: invoice.state === 'SETTLED',
      paidAmtMsat: BigInt(invoice.value_msat || BigInt(invoice.value || 0) * 1000n),
      preimagePresent: !!invoice.r_preimage,
      outgoingPayment: outgoing ? {
        status: outgoing.status,
        failure_reason: outgoing.failure_reason,
        fee_msat: outgoing.fee_msat,
        preimage: outgoing.payment_preimage,
      } : null,
      // The buyer's held payment may only be released when BOTH legs are final.
      safeToSettle: invoice.state === 'ACCEPTED' && outgoing?.status === 'SUCCEEDED',
      recoveryActions: [],
    };

    if (db) {
      const sale = db.prepare('SELECT * FROM sales WHERE payment_hash = ?').get(paymentHash);
      const comm = db.prepare('SELECT * FROM commissions WHERE payment_hash = ?').get(paymentHash);
      state.appState = { sale, commission: comm };

      // Repair state drift using the node as the source of truth.
      if (invoice.state === 'SETTLED' && sale && sale.sale_state !== 'settled') {
        db.prepare('UPDATE sales SET sale_state = ?, settled_at = ? WHERE payment_hash = ?').run('settled', Math.floor(Date.now() / 1000), paymentHash);
        state.recoveryActions.push('sale_marked_settled_from_node');
      }
      if (outgoing?.status === 'SUCCEEDED' && comm && comm.commission_state !== 'settled' && comm.commission_state !== 'paid') {
        db.prepare(
          'UPDATE commissions SET commission_state=?, paid_at=?, fee_msat=?, payment_preimage=? WHERE payment_hash=?'
        ).run('paid', Math.floor(Date.now() / 1000), Number(outgoing.fee_msat || 0), outgoing.payment_preimage, paymentHash);
        state.recoveryActions.push('commission_marked_paid_from_node');
      }
      if (outgoing?.status === 'FAILED' && comm && comm.commission_state === 'pending') {
        db.prepare('UPDATE commissions SET commission_state = ? WHERE payment_hash = ?').run('failed', paymentHash);
        state.recoveryActions.push('commission_marked_failed_from_node');
      }
      // An expired/canceled invoice must release the reservation so the budget
      // is not permanently locked after a restart.
      if ((invoice.state === 'CANCELED' || invoice.state === 'EXPIRED') && sale && sale.sale_state !== 'canceled') {
        this.policy.release(paymentHash);
        db.prepare('UPDATE sales SET sale_state = ? WHERE payment_hash = ?').run('canceled', paymentHash);
        db.prepare("UPDATE commissions SET commission_state = 'canceled' WHERE payment_hash = ?").run(paymentHash);
        state.recoveryActions.push('reservation_released_after_cancel');
      }
    }
    return { success: true, ...state };
  }

  budget() {
    if (db) {
      const row = db.prepare('SELECT * FROM budget WHERE id = 1').get();
      const reserved = db.prepare('SELECT COALESCE(SUM(amount_msat + routing_fee_msat),0) AS t FROM reservations WHERE status = ?').get('reserved');
      return { maxBudgetMsat: row.max_budget_msat, spentMsat: row.spent_msat, reservedMsat: Number(reserved.t || 0), remainingMsat: row.max_budget_msat - row.spent_msat - Number(reserved.t || 0) };
    }
    const memReserved = Array.from(this.policy._memReservations.values())
      .reduce((sum, r) => sum + BigInt(r.amountMsat) + BigInt(r.routingFeeMsat || 0), 0n);
    return {
      maxBudgetMsat: Number(this.policy.maxBudgetMsat),
      spentMsat: Number(this.policy._memSpent),
      reservedMsat: Number(memReserved),
      remainingMsat: Number(this.policy.maxBudgetMsat - this.policy._memSpent - memReserved),
    };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

const svc = new CommissionService();
const cmd = process.argv[2];

async function main() {
  switch (cmd) {
    case 'demo': {
      console.log('=== ALIBI ADVERSARIAL POLICY VERIFICATION ===');
      const tests = [
        { amt: 20000, sale: 100000, desc: '20% commission' },
        { amt: 5000, sale: 100000, desc: '5% boundary' },
        { amt: 5001, sale: 100000, desc: '5.01% over' },
      ];
      for (const t of tests) {
        const v = svc.policy.validateCommission({
          commissionMsat: BigInt(t.amt) * 1000n, saleMsat: BigInt(t.sale) * 1000n,
          marketplacePubkey: svc.policy.allowedPayee || 'x',
          paymentHash: crypto.randomBytes(32).toString('hex'),
          commissionPayeePubkey: svc.policy.allowedPayee || 'x',
        });
        console.log(`${t.desc}: ${v.valid ? 'ACCEPTED' : 'REJECTED'} ${v.errors.map(e=>e.reason).join(', ')}`);
      }
      console.log('Budget:', JSON.stringify(svc.budget()));
      break;
    }
    case 'setup-sale': {
      const [, , amt, pct, commInv, hash] = process.argv;
      const r = await svc.setupSale({ saleAmtSats: parseInt(amt), commissionPct: parseInt(pct), commissionInvoice: commInv, paymentHash: hash });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'look-up-invoice': {
      const r = await svc.reconcile({ paymentHash: process.argv[3] });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'pay-commission': {
      const r = await svc.payCommission(process.argv[3], process.argv[4] || null);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'settle-sale': {
      const r = await svc.settleSale({ paymentHash: process.argv[3], preimageHex: process.argv[4] });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'cancel-sale': {
      const r = await svc.cancelSale({ paymentHash: process.argv[3] });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'reconcile': {
      const r = await svc.reconcile({ paymentHash: process.argv[3] });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'budget': {
      console.log(JSON.stringify(svc.budget(), null, 2));
      break;
    }
    default:
      console.log('Alibi Commission Service — mode:', svc.mode);
      console.log('Commands: demo | setup-sale <amt> <pct> <commission_bolt11> [hash] | look-up-invoice <hash> | pay-commission <bolt11> [expected_hash] | settle-sale <hash> <preimage_hex> | cancel-sale <hash> | reconcile <hash> | budget');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { CommissionService, LndClient, CommissionPolicy };
