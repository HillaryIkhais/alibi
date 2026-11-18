#!/usr/bin/env node
/**
 * ALIBI MUTATION TEST HARNESS
 *
 * Proves the PRODUCTION policy guards are load-bearing, not decorative.
 * A throwaway copy of commission-service.js is created with one guard disabled,
 * and the conformance suite is run against that mutant. The correlated test
 * MUST fail. If a mutant still passes, the guard was dead code.
 *
 * The authoritative source file is never modified. Its SHA-256 is recorded
 * before and after to prove byte-identical restoration.
 *
 * Run with: node engine/bin/mutation-test.js
 * Writes:   evidence/mutation-results.json
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVICE = path.join(__dirname, 'commission-service.js');
const TEST = path.join(__dirname, 'adversarial-test.js');
const serviceBytes = fs.readFileSync(SERVICE, 'utf8');
const testBytes = fs.readFileSync(TEST, 'utf8');
const sourceHash = crypto.createHash('sha256').update(serviceBytes).digest('hex');

// Each mutation disables exactly one production guard (all occurrences) and
// expects one named conformance test to fail.
const MUTATIONS = [
  {
    id: 'rate-cap',
    guard: 'EXCEEDS_MAX_PERCENT (5% rate cap)',
    find: 'if (commBigInt > maxComm) {',
    replace: 'if (false) { // MUTANT: rate-cap guard disabled',
    expectFail: '20% commission rejected',
  },
  {
    id: 'payee-allowlist',
    guard: 'UNAUTHORIZED_PAYEE (invoice destination allowlist)',
    find: 'this.allowedPayee && commissionPayeePubkey && commissionPayeePubkey !== this.allowedPayee',
    replace: 'false /* MUTANT: payee-allowlist guard disabled */',
    expectFail: 'Unauthorized commission payee rejected',
  },
  {
    id: 'budget-cap',
    guard: 'BUDGET_EXCEEDED (atomic budget incl. routing fee)',
    find: 'if (commBigInt > remaining) {',
    replace: 'if (false) { // MUTANT: budget-cap guard disabled',
    expectFail: 'Budget exhaustion',
  },
  {
    id: 'duplicate-hash',
    guard: 'DUPLICATE_HASH (replay prevention)',
    find: "errors.push({ code: 'DUPLICATE_HASH', reason: 'Payment hash already reserved' })",
    replace: "void 0 /* MUTANT: duplicate-hash guard disabled */",
    expectFail: 'Duplicate hash rejected',
  },
];

const results = [];

function runMutant(mut, idx) {
  if (!serviceBytes.includes(mut.find)) {
    throw new Error(`mutation '${mut.id}': production guard text not found in commission-service.js`);
  }
  // Copy both files into a private temp dir so the test's `require('./commission-service.js')`
  // resolves to the MUTATED production module, never to the real one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alibi-mutant-'));
  const mutatedService = serviceBytes.split(mut.find).join(mut.replace);
  fs.writeFileSync(path.join(dir, 'commission-service.js'), mutatedService);
  fs.writeFileSync(path.join(dir, 'adversarial-test.js'), testBytes);

  try {
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [path.join(dir, 'adversarial-test.js')], {
        cwd: REPO,
        env: { ...process.env, MUTANT_OUT_DIR: dir },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      stdout = (e.stdout || '') + (e.stderr || '');
      exitCode = e.status === undefined ? -1 : e.status;
    }

    const failLine = stdout.split('\n').find(l => l.includes('FAIL') && l.includes(mut.expectFail));
    const guardWasLoadBearing = !!failLine && exitCode !== 0;

    results.push({
      id: mut.id,
      guard: mut.guard,
      production_file: path.relative(REPO, SERVICE),
      mutation: `disabled: ${mut.find}`,
      expected_test_to_fail: mut.expectFail,
      observed_fail_line: failLine ? failLine.trim() : null,
      mutant_exit_code: exitCode,
      verdict: guardWasLoadBearing ? 'production guard is load-bearing' : 'PRODUCTION GUARD IS DEAD CODE (claim false)',
      passed: guardWasLoadBearing,
    });

    console.log(`  ${guardWasLoadBearing ? '✓' : '✗'} ${mut.id}: ${mut.guard}`);
    if (failLine) console.log(`      ${failLine.trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('ALIBI MUTATION TEST (production source)');
console.log('=======================================\n');
console.log(`Source: ${path.relative(REPO, SERVICE)}`);
console.log(`Source SHA-256 before: ${sourceHash}\n`);

MUTATIONS.forEach((m, i) => runMutant(m, i));

const sourceHashAfter = crypto.createHash('sha256').update(fs.readFileSync(SERVICE, 'utf8')).digest('hex');
const restored = sourceHashAfter === sourceHash;
console.log(`\nSource SHA-256 after:  ${sourceHashAfter}`);
console.log(`Byte-identical restore: ${restored ? 'YES' : 'NO'}`);

const passed = results.filter(r => r.passed).length;
const bundle = {
  suite: 'alibi-mutation-test/2.0 (production source)',
  generated_at: new Date().toISOString(),
  source_file: path.relative(REPO, SERVICE),
  source_sha256_before: sourceHash,
  source_sha256_after: sourceHashAfter,
  byte_identical_restore: restored,
  method: 'Each PRODUCTION guard disabled in a throwaway module; the correlated conformance test must fail.',
  results,
  summary: { total: results.length, load_bearing: passed, dead_guards: results.length - passed },
};
bundle.checksum_sha256 = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');

const outDir = process.env.MUTANT_OUT_DIR || path.join(REPO, 'evidence');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'mutation-results.json'), JSON.stringify(bundle, null, 2) + '\n');
console.log(`\nMutation results: ${passed}/${results.length} production guards confirmed load-bearing`);
console.log('Evidence written: evidence/mutation-results.json');

if (!restored || passed !== results.length) process.exit(1);
