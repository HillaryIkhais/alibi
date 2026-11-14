#!/usr/bin/env node
/**
 * HARBOR evidence recorder (VECT-aligned).
 *
 * Builds the verifiable before/after recovery record for one channel as an
 * append-only hash chain:
 *   - Each event links to the previous event's hash (sequence-numbered chain).
 *   - A signed final root anchors the complete chain.
 *
 * This makes the record tamper-evident: rewriting any event breaks every
 * subsequent hash in the chain. Described as tamper-evident evidence, not
 * tamper-proof (an attacker with file-write access could recompute the whole
 * chain — the signature root mitigates that when stored out-of-band).
 *
 * Events:
 *   EXPOSURE_SNAPSHOT   — channel state before intervention
 *   OPERATOR_DECISION   — plan id, approved path, approver
 *   INTERVENTION_OUTCOME — tx id, confirmation, sweep, status
 *   REAUDIT             — post-intervention independent auditor result
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export class EvidenceRecorder {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(channelId) {
    return path.join(this.dir, `channel-${channelId}.jsonl`);
  }

  // Read existing events to determine next sequence number and previous hash.
  _previous(channelId) {
    const file = this._file(channelId);
    if (!fs.existsSync(file)) return { seq: 0, prevHash: null };
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    if (!lines.length) return { seq: 0, prevHash: null };
    const last = JSON.parse(lines[lines.length - 1]);
    return { seq: last.sequence || 0, prevHash: last.chain_hash || null };
  }

  append(channelId, event) {
    const { seq, prevHash } = this._previous(channelId);
    const sequence = seq + 1;
    const payload = {
      ...event,
      sequence,
      previous_hash: prevHash,
      recorded_at: nowIso(),
    };
    const chainHash = sha256Hex(JSON.stringify(payload));
    const record = { ...payload, chain_hash: chainHash };
    const line = JSON.stringify(record);
    fs.appendFileSync(this._file(channelId), line + "\n");
    return record;
  }

  exposure(channelId, classification) {
    return this.append(channelId, {
      type: "EXPOSURE_SNAPSHOT",
      channel_point: classification.channel_point,
      chan_id: classification.chan_id,
      state: classification.state,
      reason: classification.reason,
      evidence: classification.evidence,
      rule: classification.rule,
      recovery_depends_on: classification.recovery_depends_on,
      recommended_action: classification.recommended_action,
    });
  }

  decision(channelId, plan, approver) {
    return this.append(channelId, {
      type: "OPERATOR_DECISION",
      plan_id: plan.plan_id,
      recommended_path: plan.recommended_path,
      recommendation_basis: plan.recommendation_basis,
      fee_estimate_sats: plan.paths.find(
        (p) => p.id === plan.recommended_path
      )?.on_chain_cost_sats || null,
      timelock_blocks: plan.paths.find(
        (p) => p.id === plan.recommended_path
      )?.csv_delay_blocks || null,
      approver,
      decision: "approved",
    });
  }

  intervention(channelId, outcome) {
    return this.append(channelId, {
      type: "INTERVENTION_OUTCOME",
      plan_id: outcome.plan_id,
      tx_id: outcome.tx_id,
      confirmation_block: outcome.confirmation_block || null,
      confirmation_tx: outcome.confirmation_tx || null,
      csv_maturity_block: outcome.csv_maturity_block || null,
      sweep_tx_id: outcome.sweep_tx_id || null,
      recovered_balance_sats: outcome.recovered_balance_sats || null,
      status: outcome.status,
    });
  }

  reaudit(channelId, postResult) {
    return this.append(channelId, {
      type: "REAUDIT",
      channel_point: postResult.channel_point,
      chan_id: postResult.chan_id,
      state: postResult.state,
      reason: postResult.reason,
      evidence: postResult.evidence || null,
      rule: postResult.rule || null,
      exposure: postResult.exposure || null,
    });
  }

  // Anchor the chain with a signed final root (caller provides the signature
  // from an out-of-band key). Returns the manifest to store alongside the file.
  anchor(channelId, signature) {
    const events = this.read(channelId);
    if (!events.length) fail(`no events to anchor for channel ${channelId}`);
    const last = events[events.length - 1];
    const manifest = {
      channel_id: channelId,
      event_count: events.length,
      final_sequence: last.sequence,
      final_chain_hash: last.chain_hash,
      anchored_at: nowIso(),
      signature,
    };
    fs.writeFileSync(
      path.join(this.dir, `channel-${channelId}.anchor.json`),
      JSON.stringify(manifest, null, 2)
    );
    return manifest;
  }

  read(channelId) {
    const file = this._file(channelId);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  // Verify the hash chain integrity for a channel.
  verify(channelId) {
    const events = this.read(channelId);
    if (!events.length) return { valid: true, events: 0 };
    let prevHash = null;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.sequence !== i + 1)
        return { valid: false, reason: `sequence mismatch at event ${i + 1}` };
      if (e.previous_hash !== prevHash)
        return {
          valid: false,
          reason: `chain broken at event ${i + 1}`,
        };
      // Recompute without chain_hash only — recorded_at and all other fields
      // are part of the signed payload, matching append logic.
      const payload = { ...e };
      delete payload.chain_hash;
      const actual = sha256Hex(JSON.stringify(payload));
      if (actual !== e.chain_hash)
        return { valid: false, reason: `hash mismatch at event ${i + 1}` };
      prevHash = e.chain_hash;
    }
    return { valid: true, events: events.length, final_hash: prevHash };
  }
}

if (process.argv[1] === import.meta.url) {
  const [dir, channelId, eventType] = process.argv.slice(2);
  if (!dir || !channelId || !eventType)
    fail(
      "Usage: node evidence-recorder.mjs <evidence-dir> <channel-id> <exposure|decision|intervention|reaudit|verify|anchor>"
    );
  const rec = new EvidenceRecorder(dir);
  if (eventType === "verify") {
    const result = rec.verify(channelId);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }
  if (eventType === "anchor") {
    const [signature] = process.argv.slice(4);
    const manifest = rec.anchor(channelId, signature || "UNSIGNED");
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(0);
  }
  const payload = JSON.parse(process.argv[4] || "{}");
  if (eventType === "exposure") rec.exposure(channelId, payload);
  else if (eventType === "decision")
    rec.decision(channelId, payload, process.argv[5] || "operator");
  else if (eventType === "intervention") rec.intervention(channelId, payload);
  else if (eventType === "reaudit") rec.reaudit(channelId, payload);
  else fail(`unknown event type: ${eventType}`);
}
