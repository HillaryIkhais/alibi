#!/usr/bin/env node
/**
 * REACH Evidence Recorder
 * 
 * Records the before/after state of a payment verification
 * as a tamper-evident JSONL file.
 */

import fs from 'fs';
import crypto from 'crypto';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';

const EVIDENCE_DIR = './evidence';
mkdirSync(EVIDENCE_DIR, { recursive: true });

function nowIso() { return new Date().toISOString(); }

function sha256Hex(str) {
  return createHash('sha256').update(str).update('|').digest('hex');
}

export class ReachEvidence {
  constructor(runId) {
    this.runId = runId;
    this.file = `${EVIDENCE_DIR}/reach-${runId}.jsonl`;
  }

  record(type, data) {
    const entry = {
      type,
      run_id: this.runId,
      recorded_at: nowIso(),
      data
    };
    const payload = JSON.stringify(entry);
    const hash = sha256Hex(payload);
    entry.chain_hash = hash;
    
    // Find previous hash
    const prevEntry = this._lastEntry();
    entry.prev_hash = prevEntry ? prevEntry.chain_hash : null;
    
    const line = JSON.stringify(entry);
    appendFileSync(this.file, line + '\n');
    return entry;
  }

  _lastEntry() {
    if (!existsSync(this.file)) return null;
    const content = readFileSync(this.file, 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  }

  verify() {
    if (!existsSync(this.file)) return { valid: true, events: 0 };
    const content = readFileSync(this.file, 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    
    let prevHash = null;
    for (let i = 0; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]);
      if (entry.prev_hash !== prevHash) {
        return { valid: false, reason: `Chain broken at event ${i + 1}`, index: i };
      }
      delete entry.prev_hash;
      delete entry.chain_hash;
      const actual = sha256Hex(JSON.stringify(entry));
      if (actual !== entry.chain_hash) {
        return { valid: false, reason: `Hash mismatch at event ${i + 1}`, index: i };
      }
    }
    return { valid: true, events: lines.length };
  }
}

// CLI
if (process.argv[1] === import.meta.url) {
  const [,, runId, action, ...args] = process.argv;
  
  if (!runId || !action) {
    console.error("Usage: node reach-evidence.mjs <run-id> <action>");
    console.error("Actions: verify, record-invoice, record-probe, record-payment");
    process.exit(1);
  }
  
  if (action === 'verify') {
    const ev = new ReachEvidence(runId);
    const result = ev.verify();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }
  
  console.error("CLI recording not implemented - use library API");
}