#!/usr/bin/env node
/**
 * Offline validation of the HARBOR pipeline (no Docker, no internet):
 *
 *   auditor result -> risk engine -> exit planner -> evidence recorder
 *
 * Alice scenario (fixtures):
 *   Alice–Bob:   backup exists, Bob offline 112h, not recently seen
 *                -> BACKED_UP_PEER_UNVERIFIED, force_close defensible
 *   Alice–Carol: backup exists, Carol online, recently seen
 *                -> BACKED_UP_PEER_RECENTLY_SEEN, wait and reconnect
 *   Alice–Dave:  not in offsite backup
 *                -> BACKUP_MISSING, refresh backup first
 *
 * Expectations:
 *   - Honest classifications (no misleading PROTECTED label)
 *   - Exit planner compares paths; force-close never auto-wins
 *   - Evidence lifecycle: exposure -> decision -> intervention -> reaudit
 *   - Hash chain verifies
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assess } from "../bin/risk-engine.mjs";
import { planExit } from "../bin/exit-planner.mjs";
import { EvidenceRecorder } from "../bin/evidence-recorder.mjs";

const REFERENCE_TIME = "2026-11-15T00:00:00Z";

let failures = 0;
function check(name, cond, extra = "") {
  const ok = cond === true;
  console.log(`${ok ? "PASS" : "FAIL"} :: ${name} ${extra}`);
  if (!ok) failures++;
}

async function main() {
  const auditor = JSON.parse(
    fs.readFileSync("../fixtures/alice-auditor-result.json", "utf8")
  );
  const history = fs
    .readFileSync("../fixtures/alice-peer-history.jsonl", "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const result = assess(auditor, history, REFERENCE_TIME);

  // Top-level
  check("total_channels === 3", result.total_channels === 3);
  check("summary.backup_missing === 1", result.summary.backup_missing === 1);
  check(
    "summary.backed_up_peer_unverified === 1",
    result.summary.backed_up_peer_unverified === 1
  );
  check(
    "summary.backed_up_peer_recently_seen === 1",
    result.summary.backed_up_peer_recently_seen === 1
  );

  // Per-channel
  const bob = result.classifications.find((c) => c.chan_id === "100000000000001");
  const carol = result.classifications.find((c) => c.chan_id === "100000000000002");
  const dave = result.classifications.find((c) => c.chan_id === "100000000000003");

  check("Bob state === BACKED_UP_PEER_UNVERIFIED", bob.state === "BACKED_UP_PEER_UNVERIFIED", `(${bob.state})`);
  check("Bob hours_since_last_connection > 72", (bob.hours_since_last_connection || 0) > 72, `(${bob.hours_since_last_connection})`);
  check("Bob evidence has rule", typeof bob.rule === "string" && bob.rule.length > 0);
  check("Bob recovery_depends_on mentions DLP", bob.recovery_depends_on.includes("DLP"));

  check("Carol state === BACKED_UP_PEER_RECENTLY_SEEN", carol.state === "BACKED_UP_PEER_RECENTLY_SEEN", `(${carol.state})`);
  check("Carol rule mentions backup=true", carol.rule.includes("backup=true"));

  check("Dave state === BACKUP_MISSING", dave.state === "BACKUP_MISSING", `(${dave.state})`);

  // Exit plans — force-close never auto-wins
  const bobPlan = planExit(bob, { peerReachable: false, pendingHtlcs: 0 });
  check("Bob recommended_path = force_close", bobPlan.recommended_path === "force_close", `(${bobPlan.recommended_path})`);
  check("Bob recommendation_basis present", typeof bobPlan.recommendation_basis === "string" && bobPlan.recommendation_basis.length > 0);
  check("Bob plan requires approval", bobPlan.requires_operator_approval === true);
  check("Bob plan has 3 paths", bobPlan.paths.length === 3);
  check("Bob paths include wait_and_reconnect", bobPlan.paths.some((p) => p.id === "wait_and_reconnect"));
  check("Bob paths include cooperative_close", bobPlan.paths.some((p) => p.id === "cooperative_close"));
  check("Bob paths include force_close", bobPlan.paths.some((p) => p.id === "force_close"));
  check("Bob force_close not available (peer unreachable)", bobPlan.paths.find((p) => p.id === "cooperative_close").available === false);
  check("Bob force_close has csv_delay", Number(bobPlan.paths.find((p) => p.id === "force_close").csv_delay_blocks) > 0);

  const carolPlan = planExit(carol, { peerReachable: true });
  check("Carol recommended_path = wait_and_reconnect", carolPlan.recommended_path === "wait_and_reconnect", `(${carolPlan.recommended_path})`);
  check("Carol cooperative path available", carolPlan.paths.find((p) => p.id === "cooperative_close").available === true);

  const davePlan = planExit(dave, { peerReachable: true });
  check("Dave recommended_path is null (backup missing)", davePlan.recommended_path === null, `(${davePlan.recommended_path})`);
  check("Dave recommendation_basis mentions backup", davePlan.recommendation_basis.includes("backup"));

  // Evidence lifecycle with hash chain
  const evDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-evidence-"));
  const rec = new EvidenceRecorder(evDir);

  rec.exposure("100000000000001", bob);
  rec.decision("100000000000001", bobPlan, "alice-operator");
  rec.intervention("100000000000001", {
    plan_id: bobPlan.plan_id,
    tx_id: "tx-forceclose-bob-001",
    confirmation_block: 42,
    confirmation_tx: "tx-confirm-bob-001",
    csv_maturity_block: 186,
    sweep_tx_id: "tx-sweep-bob-002",
    recovered_balance_sats: "1200000",
    status: "verified",
  });
  rec.reaudit("100000000000001", {
    channel_point: bob.channel_point,
    chan_id: bob.chan_id,
    state: "BACKED_UP_PEER_RECENTLY_SEEN",
    reason: "Channel closed; funds swept to on-chain wallet. Backup refreshed.",
    evidence: { backup: true, peer_online: true },
    rule: "post-intervention re-audit: channel closed, funds recovered",
    exposure: "No active recovery dependency identified.",
  });

  const events = rec.read("100000000000001");
  check("evidence has 4 events", events.length === 4, `(${events.length})`);
  check("event[0] = EXPOSURE_SNAPSHOT", events[0].type === "EXPOSURE_SNAPSHOT");
  check("event[1] = OPERATOR_DECISION", events[1].type === "OPERATOR_DECISION");
  check("event[2] = INTERVENTION_OUTCOME", events[2].type === "INTERVENTION_OUTCOME");
  check("event[3] = REAUDIT", events[3].type === "REAUDIT");
  check("sequences are 1..4", events.every((e, i) => e.sequence === i + 1));
  check("each event links to previous hash", events.every((e, i) => i === 0 ? e.previous_hash === null : e.previous_hash === events[i - 1].chain_hash));
  check("hash chain verifies", rec.verify("100000000000001").valid === true);

  // Anchor with a signature
  const manifest = rec.anchor("100000000000001", "sig-alice-operator-001");
  check("anchor has final_chain_hash", typeof manifest.final_chain_hash === "string" && manifest.final_chain_hash.length > 0);
  check("anchor has signature", manifest.signature === "sig-alice-operator-001");

  fs.rmSync(evDir, { recursive: true, force: true });

  console.log(
    failures === 0 ? "\nALL PIPELINE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PIPELINE TEST ERROR:", err);
  process.exit(2);
});
