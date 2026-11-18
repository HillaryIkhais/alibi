#!/usr/bin/env node
/**
 * ALIBI PRODUCTION SERVICE — LIVE END-TO-END SETTLEMENT TEST
 *
 * Drives the real CommissionService (not a duplicated policy class) through a
 * complete Alice/Bob/Carol hold-invoice cycle on live regtest LND nodes:
 *
 *   1. Bob creates the 5,000-sat commission hold invoice with a fresh hash.
 *   2. The production handler creates the 100,000-sat sale hold invoice.
 *   3. Carol pays the sale; Alice holds the HTLC (ACCEPTED, not settled).
 *   4. NEGATIVE: settleSale() must REFUSE while no outgoing payment exists.
 *   5. The production payCommission() pays the commission and requires
 *      SUCCEEDED status, matching hash, and an in-policy routing fee.
 *   6. Bob settles the commission invoice with the shared preimage.
 *   7. settleSale() re-queries NODE state, verifies the outgoing payment, and
 *      only then releases the buyer's held payment.
 *   8. All three nodes are checked for final state.
 *
 * Requires live regtest nodes and credentials. See REPRODUCE.md.
 * Writes: evidence/production-flow.json (contains no preimage or credentials).
 *
 * ENV:
 *   HARBOR_LND_REST_URL, HARBOR_LND_MACAROON, HARBOR_LND_TLS_CERT   (Alice REST)
 *   HARBOR_MARKETPLACE_PUBKEY, HARBOR_COMMISSION_PAYEE_PUBKEY
 *   HARBOR_COMPOSE_DIR        (default: <repo>/harbor)
 *   HARBOR_ALICE_PORT / BOB_PORT / CAROL_PORT   (defaults: 10029/10030/10031)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const REPO = path.join(__dirname, '..', '..');
const COMPOSE_DIR = process.env.HARBOR_COMPOSE_DIR || path.join(REPO, 'harbor');
const PORTS = {
  alice: process.env.HARBOR_ALICE_PORT || '10029',
  bob: process.env.HARBOR_BOB_PORT || '10030',
  carol: process.env.HARBOR_CAROL_PORT || '10031',
};
const MARKETPLACE_PUBKEY = process.env.HARBOR_MARKETPLACE_PUBKEY || '';
const SALE_MSAT = '100000000';
const COMMISSION_SATS = '5000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lncli(node, args) {
  return execFileP('docker', ['compose', 'exec', '-T', `lnd-${node}`, 'lncli',
    '--network=regtest', `--rpcserver=127.0.0.1:${PORTS[node]}`, ...args],
    { cwd: COMPOSE_DIR, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
}

function lncliBg(node, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', `lnd-${node}`, 'lncli',
      '--network=regtest', `--rpcserver=127.0.0.1:${PORTS[node]}`, ...args],
      { cwd: COMPOSE_DIR });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`${node} lncli exit ${code}: ${err.slice(0, 300)}`)));
  });
}

function jout(stdout) { return JSON.parse(stdout); }

(async () => {
  const { CommissionService } = require('./commission-service.js');
  const svc = new CommissionService();
  const stages = [];
  const stage = (id, pass, detail = '') => {
    stages.push({ id, status: pass ? 'pass' : 'fail', detail });
    console.log(`  ${pass ? '✓' : '✗'} ${id}${detail ? ' — ' + detail : ''}`);
    if (!pass) throw new Error(id + (detail ? ': ' + detail : ''));
  };

  console.log('ALIBI PRODUCTION SERVICE — LIVE SETTLEMENT');
  console.log('============================================');
  console.log(`mode=${svc.mode} marketplace=${svc.policy.allowedMarketplace} payee=${svc.policy.allowedPayee}`);
  stage('production_service_real_mode', svc.mode === 'REAL', `mode=${svc.mode}`);
  stage('marketplace_identity_configured', !!svc.policy.allowedMarketplace);

  const preimage = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  console.log(`payment_hash=${hash}`);

  // 1) Bob's commission hold invoice.
  const bobInv = jout((await lncli('bob', ['addholdinvoice', '--amt', COMMISSION_SATS, hash])).stdout);
  const commissionInvoice = bobInv.payment_request;
  stage('commission_hold_invoice_created_on_bob', !!commissionInvoice);

  // 2) Production handler creates the sale hold invoice on Alice.
  const made = await svc.handleMakeCommissionInvoice({
    amount: SALE_MSAT,
    payment_hash: hash,
    commission_invoice: commissionInvoice,
    expiry: 3600,
    marketplace_pubkey: MARKETPLACE_PUBKEY,
  });
  stage('sale_hold_invoice_created_by_production_handler', made.result === 'success',
    made.error ? JSON.stringify(made.error) : '');
  const saleInvoice = made.data.invoice;

  // 3) Carol pays the sale; Alice holds the HTLC.
  const buyerPay = lncliBg('carol', ['payinvoice', '--force', `--pay_req=${saleInvoice}`]);
  await sleep(4000);
  const accepted = jout((await lncli('alice', ['lookupinvoice', hash])).stdout);
  stage('buyer_htlc_held_not_settled', accepted.state === 'ACCEPTED', `state=${accepted.state}`);

  // 4) NEGATIVE: settlement must be refused before the outgoing payment exists.
  const premature = await svc.settleSale({ paymentHash: hash, preimageHex: preimage });
  stage('settlement_refused_before_outgoing_payment', premature.success === false,
    premature.reason || 'settlement unexpectedly succeeded');

  // 5) Alice pays commission through production code.
  const alicePay = svc.payCommission(commissionInvoice, hash);
  await sleep(3000);

  // 6) Bob settles the commission invoice.
  await lncli('bob', ['settleinvoice', preimage]);
  stage('commission_invoice_settled_on_bob', true);

  // 7) Production payment verification + sale settlement.
  const paid = await alicePay;
  stage('commission_payment_verified_succeeded', paid.success === true && paid.verified_status === 'SUCCEEDED',
    `status=${paid.payment?.status || paid.verified_status} fee=${paid.fee_msat}msat cap=${paid.fee_cap_msat}msat`);
  stage('commission_fee_within_policy_cap',
    paid.fee_msat !== undefined && paid.fee_cap_msat !== undefined && paid.fee_msat <= paid.fee_cap_msat,
    `fee=${paid.fee_msat}msat cap=${paid.fee_cap_msat}msat`);

  const settled = await svc.settleSale({ paymentHash: hash, preimageHex: preimage });
  stage('sale_settled_only_after_outgoing_verification',
    settled.success === true && settled.verified === true && settled.outgoing_payment_status === 'SUCCEEDED',
    `outgoing=${settled.outgoing_payment_status} debit=${settled.total_budget_debit_msat}msat`);

  await buyerPay;
  const finalSale = jout((await lncli('alice', ['lookupinvoice', hash])).stdout);
  const finalComm = jout((await lncli('bob', ['lookupinvoice', hash])).stdout);
  const buyerList = jout((await lncli('carol', ['listpayments'])).stdout);
  const buyer = buyerList.payments.find((p) => p.payment_hash === hash);

  stage('sale_invoice_settled_on_alice', finalSale.state === 'SETTLED', `state=${finalSale.state}`);
  stage('commission_invoice_settled_on_bob', finalComm.state === 'SETTLED', `state=${finalComm.state}`);
  stage('shared_preimage_settles_both_invoices',
    finalSale.r_preimage === finalComm.r_preimage &&
    crypto.createHash('sha256').update(Buffer.from(finalSale.r_preimage, 'hex')).digest('hex') === hash,
    'sha256(preimage) === payment_hash on Alice and Bob');
  stage('buyer_payment_finalized_on_carol', buyer?.status === 'SUCCEEDED',
    `status=${buyer?.status} fee=${buyer?.fee_msat}msat`);

  const passed = stages.filter((s) => s.status === 'pass').length;
  const bundle = {
    suite: 'alibi-production-flow/1.0',
    generated_at: new Date().toISOString(),
    service_under_test: 'production:engine/bin/commission-service.js::CommissionService',
    mode: svc.mode,
    network: 'regtest',
    payment_hash: hash,
    stages,
    summary: { total: stages.length, passed, failed: stages.length - passed },
    observed: {
      commission_payment_status: paid.payment?.status || paid.verified_status,
      commission_fee_msat: paid.fee_msat,
      commission_fee_cap_msat: paid.fee_cap_msat,
      sale_actual_fee_msat: settled.actual_fee_msat,
      total_budget_debit_msat: settled.total_budget_debit_msat,
      buyer_payment_fee_msat: buyer?.fee_msat,
      alice_sale_state: finalSale.state,
      bob_commission_state: finalComm.state,
      carol_payment_status: buyer?.status,
    },
    limitations: [
      'SQLite/better-sqlite3 is unavailable in this environment: production code ran its in-memory fallback; durable restart recovery is NOT proven by this artifact.',
      'Full NIP-44/NIP-47 signed-envelope verification is not implemented; the NWC NIP-47 path fails closed.',
      'Live regtest node state only; not a Bitcoin consensus or mainnet proof.',
    ],
    secret_hygiene: 'No preimage, macaroon, TLS key, or credential appears in this artifact. The preimage is used in-process only.',
  };
  bundle.checksum_sha256 = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');

  const outPath = path.join(REPO, 'evidence', 'production-flow.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2) + '\n');

  console.log(`\nRESULT: ${passed}/${stages.length} production stages passed`);
  console.log('Evidence written: evidence/production-flow.json');
  console.log(`payment_hash=${hash}`);
  if (passed !== stages.length) process.exit(1);
})().catch((e) => { console.error('PRODUCTION FLOW: FAIL —', e.message); process.exit(1); });
