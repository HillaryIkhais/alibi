#!/usr/bin/env node
/**
 * ALIBI ADVERSARIAL CONFORMANCE TEST SUITE
 *
 * Tests the PRODUCTION CommissionPolicy exported by commission-service.js.
 * There is deliberately no local copy of the policy logic: a duplicated class
 * can pass its own tests while the shipped service stays broken.
 *
 * Run with: node adversarial-test.js
 * Writes evidence to evidence/adversarial-results.json
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CommissionPolicy } = require('./commission-service.js');

const MARKETPLACE_PUBKEY = '0225a72a6bee672de3e8dd80fcac4d0827546b761c6dbe552527b88157ac9facd5';
const ATTACKER_PUBKEY = '02attacker123456789abcdef0123456789abcdef0123456789abcdef';

// Always construct the real production class with both identities configured.
function productionPolicy(opts = {}) {
  return new CommissionPolicy({
    maxRatePPM: 50000,
    allowedPayee: MARKETPLACE_PUBKEY,        // Lightning invoice destination
    allowedMarketplace: MARKETPLACE_PUBKEY,  // NWC caller identity
    maxBudgetMsat: 100000000,
    ...opts,
  });
}

// Test assertions
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, testName, details = '') {
  const entry = { test: testName, status: condition ? 'pass' : 'fail' };
  if (!condition && details) entry.detail = details;
  results.push(entry);
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${testName}${details ? ' - ' + details : ''}`);
    failed++;
  }
}

function validate(policy, overrides = {}) {
  return policy.validateCommission({
    commissionMsat: 5000n * 1000n,
    saleMsat: 100000n * 1000n,
    marketplacePubkey: MARKETPLACE_PUBKEY,
    paymentHash: crypto.randomBytes(32).toString('hex'),
    commissionPayeePubkey: MARKETPLACE_PUBKEY,
    ...overrides,
  });
}

async function runTests() {
  console.log('ALIBI ADVERSARIAL CONFORMANCE TEST SUITE');
  console.log('=========================================');
  console.log('policy under test: production CommissionPolicy (commission-service.js)\n');

  console.log('[1] Commission Percentage Tests');
  console.log('--------------------------------');
  const policy = productionPolicy();

  const t1 = validate(policy, { commissionMsat: 20000n * 1000n });
  assert(!t1.valid && t1.errors.some(e => e.code === 'EXCEEDS_MAX_PERCENT'),
    '20% commission rejected');

  const t2 = validate(policy);
  assert(t2.valid, '5% commission (boundary) accepted',
    t2.valid ? '' : t2.errors.map(e => e.reason).join(', '));

  const t3 = validate(policy, { commissionMsat: 5001n * 1000n });
  assert(!t3.valid && t3.errors.some(e => e.code === 'EXCEEDS_MAX_PERCENT'),
    '5.01% commission rejected');

  console.log('\n[2] Payee & Caller Authorization Tests');
  console.log('--------------------------------------');

  const t4 = validate(policy, { marketplacePubkey: ATTACKER_PUBKEY });
  assert(!t4.valid && t4.errors.some(e => e.code === 'UNAUTHORIZED_MARKETPLACE'),
    'Unauthorized marketplace caller rejected');

  const t5 = validate(policy, { commissionPayeePubkey: ATTACKER_PUBKEY });
  assert(!t5.valid && t5.errors.some(e => e.code === 'UNAUTHORIZED_PAYEE'),
    'Unauthorized commission payee rejected');

  const t6 = validate(policy);
  assert(t6.valid, 'Authorized marketplace + payee accepted');

  console.log('\n[3] Budget Enforcement Tests (routing fee reserved)');
  console.log('---------------------------------------------------');

  const policyBudget = productionPolicy({ maxBudgetMsat: 3000000 });
  const t7a = validate(policyBudget);
  assert(!t7a.valid && t7a.errors.some(e => e.code === 'BUDGET_EXCEEDED'),
    'Budget exhaustion: 5,000 sats request > 3,000 sats budget');

  const policyBudget2 = productionPolicy({ maxBudgetMsat: 8000000 });
  const hashFirst = crypto.randomBytes(32).toString('hex');
  const t7b1 = validate(policyBudget2, { paymentHash: hashFirst });
  assert(t7b1.valid, 'First request (5,000 of 8,000) accepted');
  if (t7b1.valid) policyBudget2.reserve({
    paymentHash: hashFirst, amountMsat: 5000n * 1000n,
    routingFeeMsat: 0n, marketplacePubkey: MARKETPLACE_PUBKEY,
  });
  const t7b2 = validate(policyBudget2, { commissionMsat: 4000n * 1000n });
  assert(!t7b2.valid && t7b2.errors.some(e => e.code === 'BUDGET_EXCEEDED'),
    'Second request (4,000 sats > 3,000 sats remaining) rejected');

  const t7b3 = validate(policyBudget2, { commissionMsat: 3000n * 1000n });
  assert(t7b3.valid, 'Third request (3,000 sats fits exactly) accepted');

  // The stored routing-fee allowance MUST count against the budget.
  const policyFee = productionPolicy({ maxBudgetMsat: 5_100_000 });
  const t7c = validate(policyFee);
  assert(t7c.valid, '5,000 sats request fits 5,100 sats budget before fee reserve');
  if (t7c.valid) policyFee.reserve({
    paymentHash: crypto.randomBytes(32).toString('hex'),
    amountMsat: 5000n * 1000n,
    routingFeeMsat: 26_000n,
    marketplacePubkey: MARKETPLACE_PUBKEY,
  });
  const t7d = validate(policyFee);
  assert(!t7d.valid && t7d.errors.some(e => e.code === 'BUDGET_EXCEEDED'),
    'Reserved routing fee counted against budget (second request blocked)');

  // MANDATORY: the first reservation must be checked against its OWN fee
  // allowance, not just subsequent requests. commissionMsat + routingFeeMsat
  // <= remainingBudget.
  //   5,000,000 + 26,000 = 5,026,000
  //   remaining 5,010,000 -> 5,026,000 > 5,010,000 -> REJECTED
  //   remaining 5,026,000 -> 5,026,000 <= 5,026,000 -> ACCEPTED (exact fit)
  const policyFirstFee = productionPolicy({ maxBudgetMsat: 5_010_000 });
  const t7e = policyFirstFee.validateCommission({
    commissionMsat: 5000n * 1000n,
    saleMsat: 100000n * 1000n,
    marketplacePubkey: MARKETPLACE_PUBKEY,
    paymentHash: crypto.randomBytes(32).toString('hex'),
    commissionPayeePubkey: MARKETPLACE_PUBKEY,
    routingFeeMsat: 26_000n,
  });
  assert(!t7e.valid && t7e.errors.some(e => e.code === 'BUDGET_EXCEEDED'),
    'First request (5,000,000 + 26,000 fee) rejected at 5,010,000 remaining');

  const policyFirstFee2 = productionPolicy({ maxBudgetMsat: 5_026_000 });
  const t7f = policyFirstFee2.validateCommission({
    commissionMsat: 5000n * 1000n,
    saleMsat: 100000n * 1000n,
    marketplacePubkey: MARKETPLACE_PUBKEY,
    paymentHash: crypto.randomBytes(32).toString('hex'),
    commissionPayeePubkey: MARKETPLACE_PUBKEY,
    routingFeeMsat: 26_000n,
  });
  assert(t7f.valid, 'First request (5,000,000 + 26,000 fee) accepted at 5,026,000 remaining (exact fit)',
    t7f.valid ? '' : t7f.errors.map(e => e.reason).join(', '));

  console.log('\n[4] Duplicate Payment Hash Tests');
  console.log('--------------------------------');

  const policyDup = productionPolicy();
  const sharedHash = crypto.randomBytes(32).toString('hex');

  const t9a = validate(policyDup, { paymentHash: sharedHash });
  assert(t9a.valid, 'First request with unique hash accepted');
  if (t9a.valid) policyDup.reserve({
    paymentHash: sharedHash, amountMsat: 5000n * 1000n,
    routingFeeMsat: 0n, marketplacePubkey: MARKETPLACE_PUBKEY,
  });

  const t9b = validate(policyDup, { paymentHash: sharedHash });
  assert(!t9b.valid && t9b.errors.some(e => e.code === 'DUPLICATE_HASH'),
    'Duplicate hash rejected');

  console.log('\n=========================================');
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log('=========================================');

  const bundle = {
    suite: 'alibi-adversarial-conformance/2.0',
    generated_at: new Date().toISOString(),
    policy_under_test: 'production:engine/bin/commission-service.js::CommissionPolicy',
    checks: results,
    summary: { total: results.length, passed, failed },
    claim_scope:
      'Production policy-layer enforcement only. No LND nodes involved in this run. ' +
      'Live wallet-level verification is the node-backed verifier (verifier.js).',
  };
  bundle.checksum_sha256 = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');

  const outDir = process.env.MUTANT_OUT_DIR || path.join(__dirname, '..', '..', 'evidence');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'adversarial-results.json'),
      JSON.stringify(bundle, null, 2) + '\n'
    );
    console.log('Evidence written: evidence/adversarial-results.json');
  } catch (e) {
    console.error('Could not write evidence bundle:', e.message);
  }

  if (failed > 0) process.exit(1);

  console.log('\nVENDOR POLICY ENFORCEMENT: VERIFIED (production code)');
  console.log('All adversarial scenarios blocked correctly.');
}

runTests().catch((e) => { console.error(e); process.exit(1); });
