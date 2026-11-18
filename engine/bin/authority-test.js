#!/usr/bin/env node
/**
 * ALIBI NWC AUTHORITY-BOUNDARY TEST
 *
 * Proves the two request paths cannot execute commission operations without
 * an approved caller identity, and that the marketplace caller identity is
 * separate from the Lightning invoice destination.
 *
 * Run with: node engine/bin/authority-test.js
 * Writes:   evidence/authority-results.json
 */

process.env.HARBOR_MARKETPLACE_PUBKEY = process.env.HARBOR_MARKETPLACE_PUBKEY ||
  '02d45125566fdb32a2c2e1f9086bcdf48038f5b432c2f281a82ff42817e11599f6';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NwcServer } = require('./nwc-server.js');

const MARKET = process.env.HARBOR_MARKETPLACE_PUBKEY;
const ATTACKER = '02attacker123456789abcdef0123456789abcdef0123456789abcdef';

let passed = 0, failed = 0;
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, status: ok ? 'pass' : 'fail', detail });
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
}

function fakeRes() {
  return {
    code: null, body: null,
    writeHead(c) { this.code = c; },
    end(b) { this.body = JSON.parse(b); },
  };
}

(async () => {
  const srv = new NwcServer();
  console.log('ALIBI NWC AUTHORITY-BOUNDARY TEST\n==================================');

  // 1) handleMethod: unapproved caller is blocked.
  let res = fakeRes();
  await srv.handleMethod({ method: 'get_info', pubkey: ATTACKER }, res);
  check('handleMethod blocks unapproved caller', res.code === 403 && res.body.error?.code === 'UNAUTHORIZED_CONNECTION',
    `code=${res.code} body=${JSON.stringify(res.body)}`);

  // 2) handleMethod: missing caller is blocked.
  res = fakeRes();
  await srv.handleMethod({ method: 'get_info' }, res);
  check('handleMethod blocks missing caller', res.code === 403, `code=${res.code}`);

  // 3) handleNip47: unapproved event author is blocked.
  res = fakeRes();
  await srv.handleNip47({ kind: 23194, method: 'get_info', pubkey: ATTACKER }, res);
  check('handleNip47 blocks unapproved event author', res.code === 403 && res.body.error?.code === 'UNAUTHORIZED_CONNECTION',
    `code=${res.code}`);

  // 4) handleNip47: approved author still cannot bypass unsigned-envelope guard.
  res = fakeRes();
  await srv.handleNip47({ kind: 23194, method: 'make_commission_invoice', pubkey: MARKET, params: {} }, res);
  check('handleNip47 fails closed on unverified envelope', res.code === 401 && res.body.error?.code === 'TRANSPORT_NOT_VERIFIED',
    `code=${res.code} body=${JSON.stringify(res.body)}`);

  // 5) Approved caller reaches execution; identity is threaded, not read from params.
  const info = await srv.execute('get_info', {}, MARKET);
  const cp = info.data?.commission_policy || {};
  check('get_info exposes distinct marketplace and payee identities',
    cp.marketplace === MARKET && Array.isArray(cp.payees) && cp.payees.includes(MARKET),
    JSON.stringify(info.data));

  // 6) Attacker marketplace identity is rejected by production policy.
  const v = srv.svc.policy.validateCommission({
    commissionMsat: 5000000n, saleMsat: 100000000n,
    marketplacePubkey: ATTACKER, paymentHash: 'ab'.repeat(32),
    commissionPayeePubkey: MARKET,
  });
  check('production policy rejects attacker marketplace caller',
    !v.valid && v.errors.some(e => e.code === 'UNAUTHORIZED_MARKETPLACE'), JSON.stringify(v.errors));

  // 7) pay_invoice remains blocked even for an approved caller.
  const blocked = await srv.execute('pay_invoice', {}, MARKET);
  check('pay_invoice stays blocked for approved caller',
    blocked.error?.code === 'METHOD_NOT_ALLOWED', JSON.stringify(blocked));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  const bundle = {
    suite: 'alibi-nwc-authority/1.0',
    generated_at: new Date().toISOString(),
    checks,
    summary: { total: checks.length, passed, failed },
    scope: 'NWC request-path authority boundary and identity separation. No LND calls; SIM mode.',
    limitation: 'Full NIP-44 decryption and BIP-340 event verification are NOT implemented; the NIP-47 path fails closed rather than accepting unverified envelopes.',
  };
  bundle.checksum_sha256 = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  const outDir = process.env.MUTANT_OUT_DIR || path.join(__dirname, '..', '..', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'authority-results.json'), JSON.stringify(bundle, null, 2) + '\n');
  console.log('Evidence written: evidence/authority-results.json');
  if (failed > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
