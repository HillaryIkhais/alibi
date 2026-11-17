#!/usr/bin/env node
/**
 * ALIBI EVIDENCE MANIFEST
 *
 * Produces a SHA-256 manifest of every proof artifact so claims are pinned
 * to exact bytes. Run after all suites to freeze a run.
 *
 * Run with: node engine/bin/evidence-manifest.js
 * Writes:   evidence/manifest.json
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(REPO, 'evidence');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(EVIDENCE)
  .filter(f => path.basename(f) !== 'manifest.json')
  .sort()
  .map(f => ({
    path: path.relative(REPO, f),
    bytes: fs.statSync(f).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
  }));

const manifest = {
  suite: 'alibi-evidence-manifest/1.0',
  frozen_at: new Date().toISOString(),
  artifact_count: files.length,
  artifacts: files,
};
manifest.sha256_of_manifest = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

fs.writeFileSync(path.join(EVIDENCE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Evidence manifest: ${files.length} artifacts frozen`);
files.forEach(f => console.log(`  ${f.sha256.slice(0, 16)}  ${f.path}`));
console.log(`manifest SHA-256: ${manifest.sha256_of_manifest}`);
