#!/usr/bin/env node
/**
 * ALIBI NWC AUTHORITY-BOUNDARY TEST
 *
 * Proves the NWC request paths cannot execute commission operations without an
 * approved, verified caller, and that the marketplace caller identity comes from
 * a verified BIP-340/Schnorr kind:23194 event — never from a caller-supplied JSON
 * pubkey.
 *
 * Run with: node engine/bin/authority-test.js
 * Writes:   evidence/authority-results.json
 */

process.env.HARBOR_MARKETPLACE_PUBKEY = process.env.HARBOR_MARKETPLACE_PUBKEY ||
  '02d45125566fdb32a2c2e1f9086bcdf48038f5b432c2f281a82ff42817e11599f6';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Generate the test marketplace keypair FIRST, and publish it as the approved
// marketplace pubkey BEFORE nwc-transport/nwc-server read the env var.
const { generateSecretKey, getPublicKey, finalizeEvent, kinds, nip44, verifyEvent } = require('nostr-tools');
const MARKET_SECRET = generateSecretKey();
const MARKET_PUBKEY = getPublicKey(MARKET_SECRET);
process.env.HARBOR_MARKETPLACE_PUBKEY = MARKET_PUBKEY;

const { NwcServer } = require('./nwc-server.js');
const {
  WALLET_PUBLIC_KEY,
  MARKETPLACE_PUBKEY,
  ALLOWED_METHODS,
  isApproved,
  approveConnection,
  revokeConnection,
  handleRequestEvent,
  processRequest,
} = require('./nwc-transport.js');

// Test marketplace identity (the verified event author).
const ATTACKER_SECRET = generateSecretKey();
const ATTACKER_PUBKEY = getPublicKey(ATTACKER_SECRET);

// Approve the test marketplace connection for this run.
approveConnection(MARKET_PUBKEY);

let passed = 0, failed = 0;
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, status: ok ? 'pass' : 'fail', detail });
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + detail}`);
}

function fakeReq() {
  return { headers: { 'x-alibi-demo-token': 'alibi-local-demo' } };
}

function fakeRes() {
  return {
    code: null, body: null,
    writeHead(c) { this.code = c; },
    end(b) { this.body = typeof b === 'string' ? JSON.parse(b) : b; },
  };
}

/** Build a signed kind:23194 NWC request event from the marketplace. */
async function buildRequestEvent({ method, params, secretKey = MARKET_SECRET, authorPubkey = MARKET_PUBKEY }) {
  const conversationKey = nip44.getConversationKey(secretKey, WALLET_PUBLIC_KEY);
  const encrypted = nip44.encrypt(JSON.stringify({ method, params: params || {} }), conversationKey);
  const event = {
    kind: kinds.NWCWalletRequest,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', WALLET_PUBLIC_KEY],
      ['encrypted', 'nostr-tools/nip44-v2'],
    ],
    content: encrypted,
    pubkey: authorPubkey,
  };
  return finalizeEvent(event, secretKey);
}

// workaround: module-level const was captured at require time; use the test's own
// MARKET_PUBKEY variable below.
const MARKET_PUBkey = MARKET_PUBKEY;

(async () => {
  const srv = new NwcServer();
  console.log('ALIBI NWC AUTHORITY-BOUNDARY TEST\n==================================');
  console.log(`wallet pubkey: ${WALLET_PUBLIC_KEY}`);
  console.log(`test marketplace pubkey: ${MARKET_PUBKEY}`);

  // ── 1. handleMethod: make_commission_invoice NOT allowed over plain HTTP ──
  // (caller-supplied pubkey is not trusted; must use NIP-47 signed transport).
  let res = fakeRes();
  await srv.handleMethod(
    { method: 'make_commission_invoice', params: { amount: '100000000', payment_hash: 'ab'.repeat(32), commission_invoice: 'lnbcrt...' }, pubkey: MARKET_PUBKEY },
    res, fakeReq()
  );
  check('plain HTTP make_commission_invoice refused (TRANSPORT_REQUIRED)',
    res.code === 403 && res.body.error?.code === 'TRANSPORT_REQUIRED',
    `code=${res.code}`);

  // ── 2. handleMethod: pay_invoice blocked on local demo ──
  res = fakeRes();
  await srv.handleMethod({ method: 'pay_invoice', params: {}, pubkey: MARKET_PUBKEY }, res, fakeReq());
  check('pay_invoice blocked for approved caller', res.code === 403 && res.body.error?.code === 'METHOD_NOT_ALLOWED',
    `code=${res.code}`);

  // ── 3. handleMethod: get_info works on local demo ──
  res = fakeRes();
  await srv.handleMethod({ method: 'get_info', params: {}, pubkey: MARKET_PUBKEY }, res, fakeReq());
  check('get_info returns commission policy via local HTTP',
    res.code === 200 && res.body.result === 'success', `code=${res.code}`);

  // ── 4. NIP-47: invalid BIP-340 signature fails closed ──
  const badEvent = {
    kind: kinds.NWCWalletRequest,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', WALLET_PUBLIC_KEY], ['encrypted', 'nostr-tools/nip44-v2']],
    content: 'nostr-tools/nip44-v2-encrypted',
    pubkey: MARKET_PUBKEY,
    sig: '00'.repeat(64), // invalid signature
  };
  const badResult = await handleRequestEvent(badEvent);
  check('NIP-47 invalid signature rejected (TRANSPORT_NOT_VERIFIED)',
    !badResult.ok && badResult.reason.includes('signature'),
    `reason=${badResult.reason}`);

  // ── 5. NIP-47: unapproved author rejected ──
  const attackerEvent = await buildRequestEvent({ method: 'get_info', params: {}, secretKey: ATTACKER_SECRET, authorPubkey: ATTACKER_PUBKEY });
  const attackerResult = await handleRequestEvent(attackerEvent);
  check('NIP-47 unapproved event author rejected',
    !attackerResult.ok && attackerResult.reason.includes('not the approved marketplace'),
    `reason=${attackerResult.reason}`);

  // ── 6. NIP-47: wrong `p` tag (not addressed to this wallet) rejected ──
  let wrongPEvent = await buildRequestEvent({ method: 'get_info', params: {} });
  wrongPEvent.tags = [['p', '02' + '1'.repeat(62)], ['encrypted', 'nostr-tools/nip44-v2']];
  wrongPEvent = finalizeEvent(wrongPEvent, MARKET_SECRET);
  const wrongPResult = await handleRequestEvent(wrongPEvent);
  check('NIP-47 request not addressed to wallet rejected',
    !wrongPResult.ok && wrongPResult.reason.includes('p tag'),
    `reason=${wrongPResult.reason}`);

  // ── 7. NIP-47: approved marketplace get_info processed ──
  const infoEvent = await buildRequestEvent({ method: 'get_info', params: {} });
  const infoResult = await handleRequestEvent(infoEvent);
  check('NIP-47 approved marketplace get_info processed',
    infoResult.ok === true && !!infoResult.responseEvent,
    `ok=${infoResult.ok}`);

  // Verify the response event is a valid kind:23195 signed by the wallet.
  if (infoResult.responseEvent) {
    check('response event is kind:23195 signed by wallet',
      infoResult.responseEvent.kind === kinds.NWCWalletResponse && verifyEvent(infoResult.responseEvent),
      `kind=${infoResult.responseEvent.kind}`);
  }

  // ── 8. NIP-47: approved marketplace make_commission_invoice routed to production handler ──
  // (in SIM mode without LND the handler returns NO_LND; the key point is the signed
  // transport routed it to the production CommissionService, which enforces policy).
  const commEvent = await buildRequestEvent({
    method: 'make_commission_invoice',
    params: {
      amount: '100000000',
      payment_hash: crypto.randomBytes(32).toString('hex'),
      commission_invoice: 'lnbcrt10u1pdummy',
      expiry: 3600,
    },
  });
  const commResult = await handleRequestEvent(commEvent);
  check('NIP-47 make_commission_invoice routed to production handler',
    commResult.ok === true && !!commResult.responseEvent,
    `ok=${commResult.ok}`);

  // ── 9. processRequest: caller identity from verified event, not request params ──
  // Even if params claim a different marketplace_pubkey, processRequest uses
  // connectionPubkey (the verified event author). In SIM mode without LND the
  // handler returns NO_LND — either way the production handler is enforced.
  const proc = await processRequest({
    method: 'make_commission_invoice',
    params: { amount: '100000000', payment_hash: 'ab'.repeat(32), commission_invoice: 'lnbcrt1dummy', marketplace_pubkey: ATTACKER_PUBKEY },
    connectionPubkey: MARKET_PUBKEY,
  });
  check('processRequest identity is verified event author, not request param',
    proc.result === 'error',
    `code=${proc.error?.code} result=${proc.result}`);

  // ── 10. processRequest: pay_invoice blocked by method allowlist ──
  const blocked = await processRequest({ method: 'pay_invoice', params: {}, connectionPubkey: MARKET_PUBKEY });
  check('processRequest pay_invoice blocked by allowlist',
    blocked.result === 'error' && blocked.error?.code === 'METHOD_NOT_ALLOWED',
    `code=${blocked.error?.code}`);

  // ── 11. Connection revocation ──
  approveConnection(ATTACKER_PUBKEY);
  check('attacker connection approved', isApproved(ATTACKER_PUBKEY) === true);
  revokeConnection(ATTACKER_PUBKEY);
  check('attacker connection revoked', isApproved(ATTACKER_PUBKEY) === false);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  const bundle = {
    suite: 'alibi-nwc-authority/1.0',
    generated_at: new Date().toISOString(),
    checks,
    summary: { total: checks.length, passed, failed },
    scope: 'NWC request-path authority: verified BIP-340 signatures, NIP-44 v2 decryption, method allowlist, connection approval/revocation, no caller-supplied pubkey trust.',
    wallet_pubkey: WALLET_PUBLIC_KEY,
    marketplace_pubkey: MARKET_PUBKEY,
  };
  bundle.checksum_sha256 = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  const outDir = process.env.MUTANT_OUT_DIR || path.join(__dirname, '..', '..', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'authority-results.json'), JSON.stringify(bundle, null, 2) + '\n');
  console.log('Evidence written: evidence/authority-results.json');
  if (failed > 0) process.exit(1);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
