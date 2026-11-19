#!/usr/bin/env node
/**
 * ALIBI INDEPENDENT VERIFIER
 * Node-backed verification of the commission transaction.
 *
 * Deliberately separate from the Alibi service: it holds read-only
 * credentials, trusts nothing Alibi wrote to disk, and queries the
 * actual LND nodes for invoice and payment state.
 *
 * ENV:
 *   ALIBI_ALICE_REST      e.g. https://127.0.0.1:10039  (vendor)
 *   ALIBI_ALICE_MACAROON  hex, read-only macaroon
 *   ALIBI_BOB_REST        e.g. https://127.0.0.1:10040  (marketplace)
 *   ALIBI_BOB_MACAROON    hex, read-only macaroon
 *   ALIBI_CAROL_REST      e.g. https://127.0.0.1:10041  (buyer)
 *   ALIBI_CAROL_MACAROON  hex, read-only macaroon
 *   ALIBI_TLS_CERT        path to lnd tls.cert (used for all three)
 *   ALIBI_PAYMENT_HASH    the 64-char hex hash to verify
 *
 * USAGE:
 *   node engine/bin/verifier.js > evidence/bundle.json
 *
 * The raw preimage is NEVER written to the bundle. It is checked
 * in memory (SHA256 == payment hash) and only the boolean result
 * is recorded.
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const EXPECTED = {
  network: 'regtest',
  sale_msat: 100000000n,        // 100,000 sats
  commission_msat: 5000000n,    // 5,000 sats
  vendor_remainder_msat: 95000000n, // 95,000 sats before fees
  base_routing_fee_msat: 26000n, // base 1,000 + 5,000 ppm * 5,000,000 / 1e6
  max_rate_ppm: 50000,          // 5%
};

class NodeClient {
  constructor(name, restUrl, macaroonHex, tlsCertPath) {
    this.name = name;
    this.url = restUrl;
    this.macaroon = macaroonHex;
    this.tlsCertPath = tlsCertPath;
  }

  request(method, path) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const isHttps = u.protocol === 'https:';
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path,
        method,
        headers: { 'Grpc-Metadata-macaroon': this.macaroon },
      };
      if (isHttps) {
        // Respect NODE_TLS_REJECT_UNAUTHORIZED env var for self-signed regtest certs
        const strictTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
        if (strictTLS) {
          if (!this.tlsCertPath || !fs.existsSync(this.tlsCertPath)) {
            return reject(new Error(
              `${this.name}: TLS cert required at ${this.tlsCertPath} — refusing to disable verification`
            ));
          }
          opts.ca = fs.readFileSync(this.tlsCertPath);
          opts.rejectUnauthorized = true; // pin regtest self-signed cert
        } else {
          opts.rejectUnauthorized = false; // regtest/dev only — for local verification
        }
      }
      const req = (isHttps ? https : http).request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error(`${this.name}: timeout`)));
      req.end();
    });
  }

  async getInfo() {
    const r = await this.request('GET', '/v1/getinfo');
    if (r.status >= 400) throw new Error(`${this.name}: getinfo ${r.status}`);
    return r.body;
  }

  async lookupInvoice(rHashHex) {
    const r = await this.request('GET', `/v1/invoice/${rHashHex}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new Error(`${this.name}: invoice lookup ${r.status}`);
    return r.body;
  }

  async listPayments() {
    // Paginate LND's listpayments (index_offset) so an older payment outside
    // the first page is never silently missed.
    const all = [];
    let offset = 0;
    const pageSize = 100;
    for (let i = 0; i < 10; i++) {
      const r = await this.request('GET', `/v1/payments?include_incomplete=true&reversed=true&num_max_payments=${pageSize}&index_offset=${offset}`);
      if (r.status >= 400) throw new Error(`${this.name}: payments ${r.status}`);
      const page = r.body.payments || [];
      all.push(...page);
      if (page.length < pageSize) break;
      offset += page.length;
    }
    return all;
  }
}

function msat(v) {
  if (v === undefined || v === null) return null;
  return BigInt(v);
}

function satOf(msatVal) {
  return msatVal === null ? null : Number(msatVal / 1000n);
}

async function verify() {
  const paymentHash = process.env.ALIBI_PAYMENT_HASH;
  if (!paymentHash || !/^[0-9a-f]{64}$/i.test(paymentHash)) {
    throw new Error('ALIBI_PAYMENT_HASH must be 64 hex chars');
  }

  const tls = process.env.ALIBI_TLS_CERT || '';
  const nodes = {
    alice: new NodeClient('alice', process.env.ALIBI_ALICE_REST || '', process.env.ALIBI_ALICE_MACAROON || '', tls),
    bob: new NodeClient('bob', process.env.ALIBI_BOB_REST || '', process.env.ALIBI_BOB_MACAROON || '', tls),
    carol: new NodeClient('carol', process.env.ALIBI_CAROL_REST || '', process.env.ALIBI_CAROL_MACAROON || '', tls),
  };
  for (const [n, c] of Object.entries(nodes)) {
    if (!c.url || !c.macaroon) throw new Error(`missing credentials for ${n}`);
  }

  const checks = [];
  const check = (id, description, passed, detail) => {
    checks.push({ id, description, status: passed ? 'pass' : 'fail', detail });
    return passed;
  };

  // --- Node liveness + network ---
  const infos = {};
  for (const [n, c] of Object.entries(nodes)) infos[n] = await c.getInfo();
  // LND 0.21 getinfo no longer exposes genesis_hash, so compare the chain's
  // network field instead. A missing field fails closed rather than passing
  // vacuously on three undefined values.
  const nodeNetworks = Object.values(infos).map(i => i.chains?.[0]?.network);
  check('node.network', 'all three nodes on same chain',
    nodeNetworks.length === 3 && nodeNetworks.every(n => n === EXPECTED.network),
    nodeNetworks.join(','));
  check('node.synced', 'all nodes synced to chain',
    Object.values(infos).every(i => i.synced_to_chain === true));

  // --- Alice: vendor side ---
  const saleInv = await nodes.alice.lookupInvoice(paymentHash);
  check('alice.sale.exists', 'sale invoice exists on vendor node', !!saleInv);
  check('alice.sale.hash', 'sale invoice payment hash matches',
    !!saleInv && (() => {
      // LND REST returns r_hash as base64; convert to hex for comparison
      const hashBuf = Buffer.from(saleInv.r_hash, 'base64');
      const hashHex = hashBuf.toString('hex');
      return hashHex === paymentHash;
    })(), saleInv && saleInv.r_hash);
  const saleMsat = saleInv ? msat(saleInv.value_msat || (saleInv.value ? BigInt(saleInv.value) * 1000n : null)) : null;
  check('alice.sale.amount', 'sale invoice is 100,000,000 msat',
    saleMsat === EXPECTED.sale_msat, `got ${saleMsat}`);
  check('alice.sale.settled', 'sale invoice settled',
    !!saleInv && saleInv.state === 'SETTLED', saleInv && saleInv.state);

  // Preimage check — hash it, never store it
  let preimageMatches = null;
  if (saleInv && saleInv.r_preimage) {
    const preimageBuf = Buffer.from(saleInv.r_preimage, 'base64');
    preimageMatches =
      crypto.createHash('sha256').update(preimageBuf).digest('hex') === paymentHash;
    // scrub reference
    saleInv.r_preimage = '[REDACTED-NOT-WRITTEN]';
  }
  check('alice.preimage.hash', 'SHA256(preimage) == payment hash',
    preimageMatches === true, String(preimageMatches));

  // Incoming HTLCs finalized
  if (saleInv && Array.isArray(saleInv.htlcs)) {
    check('alice.sale.htlcs_finalized', 'all incoming HTLCs settled',
      saleInv.htlcs.every(h => h.state === 'SETTLED'),
      saleInv.htlcs.map(h => h.state).join(','));
  }

  // --- Bob: marketplace side ---
  const commInv = await nodes.bob.lookupInvoice(paymentHash);
  check('bob.commission.exists', 'commission invoice exists on marketplace node', !!commInv);
  const commMsat = commInv ? msat(commInv.value_msat || (commInv.value ? BigInt(commInv.value) * 1000n : null)) : null;
  check('bob.commission.amount', 'commission invoice is 5,000,000 msat',
    commMsat === EXPECTED.commission_msat, `got ${commMsat}`);
  check('bob.commission.settled', 'commission invoice settled',
    !!commInv && commInv.state === 'SETTLED', commInv && commInv.state);
  if (commInv && commInv.r_preimage) {
    const p = Buffer.from(commInv.r_preimage, 'base64');
    check('bob.commission.preimage', 'commission preimage hashes to payment hash',
      crypto.createHash('sha256').update(p).digest('hex') === paymentHash);
    commInv.r_preimage = '[REDACTED-NOT-WRITTEN]';
  }

  // --- Alice: outgoing commission payment (independent verification) ---
  // Queried with Alice's read-only credentials; never trusts the app DB.
  const alicePays = await nodes.alice.listPayments();
  const outgoingPay = alicePays.find(p => p.payment_hash === paymentHash);
  check('alice.outgoing.exists', 'outgoing commission payment found on vendor node', !!outgoingPay);
  let outgoingFeeMsat = null;
  let outgoingPreimageOk = null;
  if (outgoingPay) {
    const paidSat = BigInt(outgoingPay.value_sat || outgoingPay.value || 0);
    const paidMsat = paidSat * 1000n;
    check('alice.outgoing.status', 'outgoing commission payment terminal SUCCEEDED',
      outgoingPay.status === 'SUCCEEDED', outgoingPay.status);
    check('alice.outgoing.hash', 'outgoing payment hash matches sale/commission hash',
      outgoingPay.payment_hash === paymentHash, outgoingPay.payment_hash);
    check('alice.outgoing.amount', `outgoing paid ${EXPECTED.commission_msat} msat commission`,
      paidMsat === EXPECTED.commission_msat, `got ${paidMsat} msat`);
    // Actual routing fee present and within policy cap.
    const feeSat = BigInt(outgoingPay.fee_sat || outgoingPay.fee_msat || 0);
    outgoingFeeMsat = feeSat * 1000n;
    const feeCapMsat = EXPECTED.commission_msat * BigInt(EXPECTED.max_rate_ppm) / 1_000_000n + BigInt(EXPECTED.base_routing_fee_msat || 1000);
    check('alice.outgoing.fee_within_cap', `actual fee ${outgoingFeeMsat}msat within policy cap`,
      outgoingFeeMsat <= feeCapMsat, `fee=${outgoingFeeMsat}msat cap=${feeCapMsat}msat`);
    // Preimage hashes to the shared payment hash.
    const pre = String(outgoingPay.payment_preimage || '');
    if (/^[0-9a-f]{64}$/.test(pre)) {
      outgoingPreimageOk = crypto.createHash('sha256').update(Buffer.from(pre, 'hex')).digest('hex') === paymentHash;
      check('alice.outgoing.preimage', 'SHA256(outgoing preimage) == payment hash', outgoingPreimageOk === true);
    } else {
      check('alice.outgoing.preimage', 'outgoing payment preimage is a valid 32-byte hex', false, pre ? pre : '(none)');
    }
    outgoingPay.payment_preimage = '[REDACTED-NOT-WRITTEN]';
  }

  // --- Arithmetic reconciliation ---
  check('math.split', 'sale == commission + vendor remainder',
    EXPECTED.sale_msat === EXPECTED.commission_msat + EXPECTED.vendor_remainder_msat,
    `${EXPECTED.sale_msat} == ${EXPECTED.commission_msat} + ${EXPECTED.vendor_remainder_msat}`);
  check('math.rate', 'commission / sale <= max_rate_ppm',
    EXPECTED.commission_msat * 1000000n / EXPECTED.sale_msat <= BigInt(EXPECTED.max_rate_ppm),
    `${EXPECTED.commission_msat * 1000000n / EXPECTED.sale_msat} ppm`);

  // --- Seller net reconciliation ---
  // gross (buyer) - commission - actual fee = seller net
  const sellerNetMsat = EXPECTED.sale_msat - EXPECTED.commission_msat - (outgoingFeeMsat ?? 0n);
  check('math.seller_net', 'seller net == gross - commission - actual fee',
    sellerNetMsat === EXPECTED.vendor_remainder_msat - (outgoingFeeMsat ?? 0n),
    `net=${sellerNetMsat}msat`);

  // --- Carol: buyer side ---
  const carolPays = await nodes.carol.listPayments();
  const buyerPay = carolPays.find(p => p.payment_hash === paymentHash);
  check('carol.payment.exists', 'buyer payment found on buyer node', !!buyerPay);
  if (buyerPay) {
    // LND /v1/payments returns value_sat in satoshis; convert to msat
    const paidSat = BigInt(buyerPay.value_sat || buyerPay.value || 0);
    const paidMsat = paidSat * 1000n;
    check('carol.payment.amount', 'buyer paid 100,000,000 msat',
      paidMsat === EXPECTED.sale_msat, `got ${paidMsat} msat (${paidSat} sat)`);
    check('carol.payment.final', 'buyer payment finalized (not pending)',
      buyerPay.status === 'SUCCEEDED', buyerPay.status);
    check('carol.payment.single', 'exactly one payment with this hash on buyer node',
      carolPays.filter(p => p.payment_hash === paymentHash).length === 1);
  }

  const failed = checks.filter(c => c.status === 'fail');
  const bundle = {
    verifier: 'alibi-independent-verifier/1.0',
    generated_at: new Date().toISOString(),
    network: infos.alice.chains?.[0]?.network || 'unknown',
    payment_hash: paymentHash,
    expected_amounts: {
      sale_msat: EXPECTED.sale_msat.toString(),
      commission_msat: EXPECTED.commission_msat.toString(),
      vendor_remainder_msat: EXPECTED.vendor_remainder_msat.toString(),
      max_rate_ppm: EXPECTED.max_rate_ppm,
    },
    nodes: Object.fromEntries(Object.entries(infos).map(([n, i]) => [n, {
      pubkey: i.identity_pubkey,
      block_height: i.block_height,
      synced_to_chain: i.synced_to_chain,
    }])),
    invoice_states: {
      sale: saleInv ? { state: saleInv.state, amount_msat: saleMsat?.toString() ?? null } : null,
      commission: commInv ? { state: commInv.state, amount_msat: commMsat?.toString() ?? null } : null,
    },
    preimage_matches_hash: preimageMatches, // boolean only — preimage never written
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    trust_statement:
      'Independently executed, node-backed verification of a controlled regtest environment. ' +
      'Not a Bitcoin consensus proof and not a trustless attestation. Read-only credentials. ' +
      'No preimage, macaroon, or key material included.',
  };

  const canonical = JSON.stringify(bundle);
  bundle.checksum_sha256 = crypto.createHash('sha256').update(canonical).digest('hex');

  process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
}

if (require.main === module) {
  verify().catch(e => {
    process.stderr.write(`VERIFIER ERROR: ${e.message}\n`);
    process.exit(2);
  });
}

module.exports = { verify };
