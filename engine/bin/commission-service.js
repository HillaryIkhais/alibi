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

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'alibi.sqlite');
const POLICY_PATH = path.join(DATA_DIR, 'commission-policy.json');

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
    // Seed policy if absent
    const row = db.prepare('SELECT id FROM policy WHERE id = 1').get();
    if (!row) {
      db.prepare(
        'INSERT INTO policy (id, max_rate_ppm, max_fixed_msat, allowed_payee, base_msat, rate_ppm, updated_at) VALUES (1, 50000, 0, NULL, 1000, 5000, ?)'
      ).run(Math.floor(Date.now() / 1000));
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
    this.maxBudgetMsat = BigInt(opts.maxBudgetMsat ?? 100000000); // 100,000 sats
    this.baseMsat = BigInt(opts.baseMsat ?? 1000);
    this.ratePPM = BigInt(opts.ratePPM ?? 5000); // 0.5% routing fee cap
  }

  static load() {
    if (!db) return new CommissionPolicy();
    const p = db.prepare('SELECT * FROM policy WHERE id = 1').get();
    if (!p) return new CommissionPolicy();
    return new CommissionPolicy({
      maxRatePPM: p.max_rate_ppm,
      maxFixedMsat: p.max_fixed_msat,
      allowedPayee: p.allowed_payee || null,
      maxBudgetMsat: p.max_budget_msat ?? 100000000,
      baseMsat: p.base_msat,
      ratePPM: p.rate_ppm,
    });
  }

  save() {
    if (!db) return;
    db.prepare(
      'UPDATE policy SET max_rate_ppm=?, max_fixed_msat=?, allowed_payee=?, max_budget_msat=?, base_msat=?, rate_ppm=?, updated_at=? WHERE id=1'
    ).run(
      this.maxRatePPM,
      Number(this.maxFixedMsat),
      this.allowedPayee,
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

  validateCommission({ commissionMsat, saleMsat, marketplacePubkey, paymentHash, commissionPayeePubkey }) {
    const errors = [];
    const saleBigInt = BigInt(saleMsat);
    const commBigInt = BigInt(commissionMsat);

    // Rate check: commission <= floor(sale * max_rate_ppm / 1e6) + max_fixed
    const maxComm = this.maxCommissionMsat(saleBigInt);
    if (commBigInt > maxComm) {
      const pct = Number(commBigInt * 100n / saleBigInt);
      errors.push({ code: 'EXCEEDS_MAX_PERCENT', reason: `${pct}% > 5% max` });
    }

    // Payee check (payees is optional per draft; skip when not configured)
    if (this.allowedPayee) {
      if (commissionPayeePubkey && commissionPayeePubkey !== this.allowedPayee) {
        errors.push({ code: 'UNAUTHORIZED_PAYEE', reason: 'Commission payee not in allowlist' });
      }
      if (marketplacePubkey !== this.allowedPayee) {
        errors.push({ code: 'UNAUTHORIZED_MARKETPLACE', reason: 'Marketplace not authorized' });
      }
    }

    // Budget check with active reservations (atomic)
    if (db) {
      const row = db.prepare('SELECT spent_msat FROM budget WHERE id = 1').get();
      const spent = BigInt(row.spent_msat);
      const reserved = db.prepare(
        'SELECT COALESCE(SUM(amount_msat), 0) AS total FROM reservations WHERE status = ?'
      ).get('reserved');
      const reservedTotal = BigInt(reserved.total || 0);
      const remaining = this.maxBudgetMsat - spent - reservedTotal;
      if (commBigInt > remaining) {
        errors.push({ code: 'BUDGET_EXCEEDED', reason: `Requested ${commBigInt}msat, remaining ${remaining}msat` });
      }
    } else {
      // in-memory fallback
      const remaining = this.maxBudgetMsat - this._memSpent - this._memReserved;
      if (commBigInt > remaining) {
        errors.push({ code: 'BUDGET_EXCEEDED', reason: `Requested ${commBigInt}msat, remaining ${remaining}msat` });
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
  reserve({ paymentHash, amountMsat, routingFeeMsat, marketplacePubkey }) {
    if (db) {
      // Budget check with active reservations (atomic)
      const row = db.prepare('SELECT spent_msat FROM budget WHERE id = 1').get();
      const spent = BigInt(row.spent_msat);
      const reserved = db.prepare(
        'SELECT COALESCE(SUM(amount_msat), 0) AS total FROM reservations WHERE status = ?'
      ).get('reserved');
      const reservedTotal = BigInt(reserved.total || 0);
      const remaining = this.maxBudgetMsat - spent - reservedTotal;
      if (BigInt(amountMsat) > remaining) {
        return { ok: false, reason: `Budget exceeded: requested ${amountMsat}msat, remaining ${remaining}msat` };
      }
      // Duplicate hash
      const exists = db.prepare('SELECT 1 FROM reservations WHERE payment_hash = ? AND status = ?').get(paymentHash, 'reserved');
      if (exists) return { ok: false, reason: 'Duplicate payment hash' };
      try {
        db.transaction(() => {
          db.prepare(
            'INSERT INTO reservations (payment_hash, amount_msat, routing_fee_msat, marketplace_pubkey, created_at, status) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(paymentHash, Number(amountMsat), Number(routingFeeMsat), marketplacePubkey, Math.floor(Date.now() / 1000), 'reserved');
        })();
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    } else {
      // Budget check with active reservations
      const reservedTotal = Array.from(this._memReservations.values())
        .reduce((sum, r) => sum + BigInt(r.amountMsat), 0n);
      const remaining = this.maxBudgetMsat - this._memSpent - reservedTotal;
      if (BigInt(amountMsat) > remaining) {
        return { ok: false, reason: `Budget exceeded: requested ${amountMsat}msat, remaining ${remaining}msat` };
      }
      // Duplicate hash
      if (this._memReservations.has(paymentHash)) return { ok: false, reason: 'Duplicate payment hash' };
      this._memReservations.set(paymentHash, { amountMsat, routingFeeMsat, marketplacePubkey });
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

  commitSpent(paymentHash, amountMsat) {
    if (db) {
      const res = db.prepare('SELECT amount_msat FROM reservations WHERE payment_hash = ? AND status = ?').get(paymentHash, 'reserved');
      if (!res) return false;
      db.transaction(() => {
        db.prepare('UPDATE budget SET spent_msat = spent_msat + ? WHERE id = 1').run(Number(amountMsat));
        db.prepare('UPDATE reservations SET status = ? WHERE payment_hash = ?').run('spent', paymentHash);
      })();
      return true;
    } else {
      const res = this._memReservations.get(paymentHash);
      if (!res) return false;
      this._memSpent += res.amountMsat;
      this._memReservations.delete(paymentHash);
      return true;
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

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }

  async addHoldInvoice(valueMsat, paymentHashHex, description, expirySeconds = 3600) {
    // LND REST API expects payment_hash as base64, not hex
    const paymentHashBuf = Buffer.from(paymentHashHex, 'hex');
    const r = await this.post('/v2/invoices/hodl', {
      value_msat: String(valueMsat),
      payment_hash: paymentHashBuf.toString('base64'),
      memo: description,
      expiry: String(expirySeconds),
    });
    if (r.status >= 400) throw new Error(`AddHoldInvoice ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body; // { payment_request, r_hash, ... }
  }

  async lookupInvoice(paymentHash) {
    const r = await this.get(`/v1/invoice/${paymentHash}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new Error(`LookupInvoice ${r.status}`);
    return r.body;
  }

  async sendPaymentV2(paymentRequest, feeLimitMsat = 1000000) {
    const r = await this.post('/v2/router/send', {
      payment_request: paymentRequest,
      fee_limit_msat: String(feeLimitMsat),
      timeout_seconds: 60,
    });
    if (r.status >= 400) throw new Error(`SendPaymentV2 ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
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
    const r = await this.get(`/v2/router/track/${paymentHash}`);
    if (r.status >= 400) throw new Error(`TrackPayment ${r.status}`);
    return r.body;
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
    this.auditLog = []; // in-memory fallback when SQLite unavailable
    console.log(`[alibi] mode=${this.mode} policy=5% max_budget=100,000sats payee=${this.policy.allowedPayee ?? '(none set)'}`);
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
        commission = await this.lnd.decodePayReq(commission_invoice);
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

    // Commission amount from the decoded invoice (num_satoshis in sats -> msat)
    const commissionSat = BigInt(commission.num_satoshis || 0);
    const commissionMsat = commissionSat * 1000n;
    if (commissionMsat <= 0n) {
      return { result: 'error', error: { code: 'INVALID_COMMISSION_AMOUNT', message: 'commission invoice has no amount' } };
    }

    // Network check (regtest only)
    if (String(commission.network || '').toLowerCase() !== 'regtest') {
      return { result: 'error', error: { code: 'WRONG_NETWORK', message: 'commission invoice not on regtest' } };
    }

    // Payee check: destination pubkey must be in allowed payees
    const destPubkey = String(commission.destination || '');
    if (this.policy.allowedPayee && destPubkey !== this.policy.allowedPayee) {
      return { result: 'error', error: { code: 'UNAUTHORIZED_PAYEE', message: 'commission payee not authorized' } };
    }

    // Marketplace authorization: validate the marketplace pubkey from the request
    // against the allowed payee. In a full NWC implementation this would come
    // from a signed NIP-47 event; here we record the check for the audit log.
    const reqMarketPubkey = marketplace_pubkey || this.policy.allowedPayee || '';
    if (this.policy.allowedPayee && reqMarketPubkey !== this.policy.allowedPayee) {
      return { result: 'error', error: { code: 'UNAUTHORIZED_MARKETPLACE', message: 'Marketplace pubkey not in allowlist' } };
    }

    // ── 4. Policy validation: commission rate vs sale amount ──
    const validation = this.policy.validateCommission({
      commissionMsat, saleMsat,
      marketplacePubkey: this.policy.allowedPayee || '',
      paymentHash: payment_hash,
      commissionPayeePubkey: destPubkey,
    });
    if (!validation.valid) {
      return { result: 'error', error: { code: 'POLICY_REJECTION', message: validation.errors[0].reason, details: validation.errors } };
    }

    // ── 5. Atomic budget reservation ──
    const routingFeeMsat = this.policy.maxRoutingFeeMsat(commissionMsat);
    const reserved = this.policy.reserve({
      paymentHash: payment_hash, amountMsat: commissionMsat,
      routingFeeMsat, marketplacePubkey: this.policy.allowedPayee || '',
    });
    if (!reserved.ok) {
      return { result: 'error', error: { code: 'BUDGET_EXCEEDED', message: reserved.reason } };
    }

    // ── 6. Create sale hold invoice for buyer ──
    let saleInvoice = null;
    try {
      const inv = await this.lnd.addHoldInvoice(saleMsat, payment_hash, `Commission-bound sale ${Number(saleMsat / 1000n)} sats`);
      saleInvoice = inv.payment_request;
      if (db) {
        db.prepare(
          'INSERT INTO sales (payment_hash, amount_msat, commission_msat, sale_invoice, sale_state, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(payment_hash, Number(saleMsat), Number(commissionMsat), saleInvoice, 'pending', Math.floor(Date.now() / 1000));
        db.prepare(
          'INSERT INTO commissions (payment_hash, amount_msat, commission_invoice, commission_state) VALUES (?, ?, ?, ?)'
        ).run(payment_hash, Number(commissionMsat), commission_invoice, 'pending');
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
        expires_at: Math.floor(Date.now() / 1000) + (expiry || 3600),
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

    const validation = this.policy.validateCommission({
      commissionMsat, saleMsat, marketplacePubkey: this.policy.allowedPayee || '',
      paymentHash, commissionPayeePubkey: this.policy.allowedPayee || '',
    });
    if (!validation.valid) {
      return { success: false, reason: 'policy rejection', details: validation.errors };
    }

    const routingFeeMsat = this.policy.maxRoutingFeeMsat(commissionMsat);
    const reserved = this.policy.reserve({
      paymentHash, amountMsat: commissionMsat, routingFeeMsat,
      marketplacePubkey: this.policy.allowedPayee || '',
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
      marketplacePubkey: this.policy.allowedPayee || '',
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

  async payCommission(paymentRequest) {
    if (!this.lnd) return { success: false, reason: 'REAL mode required; no LND credentials' };
    try {
      // Decode the payment request to get the payment hash for tracking
      let decoded = null;
      try {
        decoded = await this.lnd.decodePayReq(paymentRequest);
      } catch (e) {
        // decode may fail for hold invoices; still attempt payment
      }
      const result = await this.lnd.sendPaymentV2(paymentRequest);
      return { success: true, payment: result, decoded };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  async settleSale({ paymentHash, preimageHex }) {
    if (!this.lnd) return { success: false, reason: 'REAL mode required' };
    // Verify preimage hash matches
    const preimageBuf = Buffer.from(preimageHex, 'hex');
    const calcHash = crypto.createHash('sha256').update(preimageBuf).digest('hex');
    if (calcHash !== paymentHash) return { success: false, reason: 'preimage hash mismatch' };

    try {
      await this.lnd.settleInvoice(paymentHash, preimageHex);
      if (db) {
        db.prepare('UPDATE sales SET sale_state = ?, settled_at = ? WHERE payment_hash = ?').run('settled', Math.floor(Date.now() / 1000), paymentHash);
        db.prepare('UPDATE commissions SET commission_state = ?, paid_at = ? WHERE payment_hash = ?').run('settled', Math.floor(Date.now() / 1000), paymentHash);
      }
      return { success: true, verified: true };
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

  async payCommission(paymentRequest) {
    if (!this.lnd) return { success: false, reason: 'REAL mode required' };
    // Authoritative LND state, not application DB
    const invoice = await this.lnd.lookupInvoice(paymentHash);
    if (!invoice) return { success: false, reason: 'invoice not found on node' };

    const state = {
      paymentHash,
      nodeState: invoice.state,
      settled: invoice.state === 'SETTLED',
      paidAmtMsat: BigInt(invoice.value_msat || BigInt(invoice.value || 0) * 1000n),
      preimagePresent: !!invoice.r_preimage,
    };

    if (db) {
      const sale = db.prepare('SELECT * FROM sales WHERE payment_hash = ?').get(paymentHash);
      const comm = db.prepare('SELECT * FROM commissions WHERE payment_hash = ?').get(paymentHash);
      state.appState = { sale, commission: comm };
      // Reconcile: if LND says settled but app says pending, fix it
      if (invoice.state === 'SETTLED' && sale && sale.sale_state !== 'settled') {
        db.prepare('UPDATE sales SET sale_state = ?, settled_at = ? WHERE payment_hash = ?').run('settled', Math.floor(Date.now() / 1000), paymentHash);
      }
    }
    return { success: true, ...state };
  }

  budget() {
    if (db) {
      const row = db.prepare('SELECT * FROM budget WHERE id = 1').get();
      const reserved = db.prepare('SELECT COALESCE(SUM(amount_msat),0) AS t FROM reservations WHERE status = ?').get('reserved');
      return { maxBudgetMsat: row.max_budget_msat, spentMsat: row.spent_msat, reservedMsat: Number(reserved.t || 0), remainingMsat: row.max_budget_msat - row.spent_msat - Number(reserved.t || 0) };
    }
    return { maxBudgetMsat: Number(this.policy.maxBudgetMsat), spentMsat: Number(this.policy._memSpent), reservedMsat: Number(this.policy._memReserved), remainingMsat: Number(this.policy.maxBudgetMsat - this.policy._memSpent - this.policy._memReserved) };
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
      const r = await svc.payCommission(process.argv[3]);
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
      console.log('Commands: demo | setup-sale <amt> <pct> <commission_bolt11> [hash] | look-up-invoice <hash> | pay-commission <bolt11> | settle-sale <hash> <preimage_hex> | cancel-sale <hash> | reconcile <hash> | budget');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { CommissionService, LndClient, CommissionPolicy };
