#!/usr/bin/env node
/**
 * ALIBI MUTATION TEST HARNESS
 *
 * Proves the adversarial guards are load-bearing, not decorative.
 * For each policy guard, a throwaway copy of adversarial-test.js is created
 * with that single guard disabled. The suite MUST then report the correlated
 * test as FAIL. If a mutant still passes, the guard was dead code and the
 * corresponding README claim is false.
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
const SOURCE = path.join(__dirname, 'adversarial-test.js');
const sourceBytes = fs.readFileSync(SOURCE, 'utf8');
const sourceHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');

// Each mutation disables exactly one guard and expects one named test to fail.
const MUTATIONS = [
  {
    id: 'rate-cap',
    guard: 'EXCEEDS_MAX_PERCENT (5% rate cap)',
    find: '    if (commBigInt > maxComm) {',
    replace: '    if (false) { // MUTANT: rate-cap guard disabled',
    expectFail: '20% commission rejected',
  },
  {
    id: 'payee-allowlist',
    guard: 'UNAUTHORIZED_PAYEE (payee allowlist)',
    find: '      if (commissionPayeePubkey && commissionPayeePubkey !== this.allowedPayee) {',
    replace: '      if (false) { // MUTANT: payee-allowlist guard disabled',
    expectFail: 'Unauthorized commission payee rejected',
  },
  {
    id: 'budget-cap',
    guard: 'BUDGET_EXCEEDED (atomic budget)',
    find: '    if (commBigInt > remaining) {',
    replace: '    if (false) { // MUTANT: budget-cap guard disabled',
    expectFail: 'Budget exhaustion',
  },
  {
    id: 'duplicate-hash',
    guard: 'DUPLICATE_HASH (replay prevention)',
    find: '    // Duplicate hash\n    if (this._memReservations.has(paymentHash)) {',
    replace: '    // Duplicate hash\n    if (false) { // MUTANT: duplicate-hash guard disabled',
    expectFail: 'Duplicate hash rejected',
  },
];

// Redirect mutant evidence writes away from the real evidence file.
const OUT_FIND = "  const outDir = path.join(__dirname, '..', '..', 'evidence');";
const OUT_REPLACE =
  "  const outDir = process.env.MUTANT_OUT_DIR || path.join(__dirname, '..', '..', 'evidence');";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alibi-mutant-'));
const results = [];

function runMutant(mut, idx) {
  if (!sourceBytes.includes(mut.find)) {
    throw new Error(`mutation '${mut.id}': guard text not found in source`);
  }
  let mutantSrc = sourceBytes.replace(mut.find, mut.replace);
  if (!mutantSrc.includes(OUT_FIND)) {
    throw new Error(`mutation '${mut.id}': evidence out-dir text not found`);
  }
  mutantSrc = mutantSrc.replace(OUT_FIND, OUT_REPLACE);

  const mutantFile = path.join(__dirname, `__mutant_${idx}_${mut.id}.js`);
  fs.writeFileSync(mutantFile, mutantSrc);
  try {
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [mutantFile], {
        cwd: REPO,
        env: { ...process.env, MUTANT_OUT_DIR: tmpDir },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      stdout = (e.stdout || '') + (e.stderr || '');
      exitCode = e.status === undefined ? -1 : e.status;
    }

    // The correlated test must appear as FAIL in the mutant run.
    const failLine = stdout.split('\n').find(l => l.includes('FAIL') && l.includes(mut.expectFail));
    const guardWasLoadBearing = !!failLine && exitCode !== 0;

    results.push({
      id: mut.id,
      guard: mut.guard,
      mutation: `disabled: ${mut.find.trim().split('\n').pop()}`,
      expected_test_to_fail: mut.expectFail,
      observed_fail_line: failLine ? failLine.trim() : null,
      mutant_exit_code: exitCode,
      verdict: guardWasLoadBearing ? 'guard is load-bearing' : 'GUARD IS DEAD CODE (claim false)',
      passed: guardWasLoadBearing,
    });

    console.log(`  ${guardWasLoadBearing ? '✓' : '✗'} ${mut.id}: ${mut.guard}`);
    if (failLine) console.log(`      ${failLine.trim()}`);
  } finally {
    fs.unlinkSync(mutantFile);
  }
}

console.log('ALIBI MUTATION TEST');
console.log('===================\n');
console.log(`Source: ${path.relative(REPO, SOURCE)}`);
console.log(`Source SHA-256 before: ${sourceHash}\n`);

MUTATIONS.forEach((m, i) => runMutant(m, i));

const sourceHashAfter = crypto.createHash('sha256').update(fs.readFileSync(SOURCE, 'utf8')).digest('hex');
const restored = sourceHashAfter === sourceHash;
console.log(`\nSource SHA-256 after:  ${sourceHashAfter}`);
console.log(`Byte-identical restore: ${restored ? 'YES' : 'NO'}`);

fs.rmSync(tmpDir, { recursive: true, force: true });

const passed = results.filter(r => r.passed).length;
const bundle = {
  suite: 'alibi-mutation-test/1.0',
  generated_at: new Date().toISOString(),
  source_file: path.relative(REPO, SOURCE),
  source_sha256_before: sourceHash,
  source_sha256_after: sourceHashAfter,
  byte_identical_restore: restored,
  method: 'Each guard disabled in a throwaway copy; the correlated conformance test must fail.',
  results,
  summary: { total: results.length, load_bearing: passed, dead_guards: results.length - passed },
};
bundle.checksum_sha256 = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');

const outDir = path.join(REPO, 'evidence');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'mutation-results.json'), JSON.stringify(bundle, null, 2) + '\n');
console.log(`\nMutation results: ${passed}/${results.length} guards confirmed load-bearing`);
console.log('Evidence written: evidence/mutation-results.json');

if (!restored || passed !== results.length) process.exit(1);
