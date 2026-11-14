#!/usr/bin/env node
/**
 * HARBOR deterministic risk engine (VECT-aligned).
 *
 * Classifies each channel's recovery condition from auditor evidence plus
 * observed peer-reachability history. No AI classifies peers; no closures are
 * initiated. The engine only scores, explains, and plans.
 *
 * Classification states:
 *   BACKED_UP_PEER_RECENTLY_SEEN   SCB exists; peer was reachable at
 *                                  observation time.
 *   BACKED_UP_PEER_UNVERIFIED      SCB exists; recovery dependency is
 *                                  currently unverified (peer not recently
 *                                  observed).
 *   BACKUP_MISSING                 No channel entry in the inspected backup.
 *   AWAITING_FUNDING_CONFIRMATION  Channel not yet fully established;
 *                                  additional recovery considerations apply.
 *
 * Each classification carries the evidence observed and the rule that produced
 * it — no arbitrary scores, no misleading "protected" green label.
 *
 * Env:
 *   HARBOR_RECENT_OBSERVATION_WINDOW_HOURS  default 48
 *   HARBOR_PRIVATE_CHANNEL_LENIENCY_HOURS   default 168 (7 days)
 */

import fs from "node:fs";
import crypto from "node:crypto";

const RECENT_WINDOW_HOURS =
  Number(process.env.HARBOR_RECENT_OBSERVATION_WINDOW_HOURS) || 48;
const PRIVATE_LENIENCY_HOURS =
  Number(process.env.HARBOR_PRIVATE_CHANNEL_LENIENCY_HOURS) || 168;

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

// ---------- Evidence ingestion ----------

export function loadAuditorResult(path) {
  if (!fs.existsSync(path)) fail(`auditor result not found: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function loadPeerHistory(path) {
  if (!path || !fs.existsSync(path)) return [];
  const text = fs.readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Most recent observation for a peer, newest first.
function latestObservation(history, pubKey) {
  const sorted = [...history].filter(
    (e) => e.peer_pubkey === pubKey
  ).sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at));
  return sorted.length ? sorted[0] : null;
}

// Most recent time a peer was observed connected, newest first.
function lastConnectedAt(history, pubKey) {
  const sorted = [...history]
    .filter((e) => e.peer_pubkey === pubKey && e.is_connected === true)
    .sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at));
  return sorted.length ? new Date(sorted[0].observed_at) : null;
}

// Hours since the peer was last observed connected. null if never observed.
function hoursSinceLastConnection(history, pubKey, referenceTime) {
  const last = lastConnectedAt(history, pubKey);
  if (!last) return null;
  return (new Date(referenceTime).getTime() - last.getTime()) / (1000 * 60 * 60);
}

// Is the peer's connection pattern intermittent (private channel behavior)?
function isIntermittentPrivate(history, pubKey) {
  const entries = history.filter((e) => e.peer_pubkey === pubKey);
  if (entries.length < 3) return false;
  const connected = entries.filter((e) => e.is_connected === true).length;
  const ratio = connected / entries.length;
  return ratio > 0 && ratio < 0.7; // sometimes on, sometimes off
}

// ---------- Risk classification ----------

function channelAwaitingFunding(channel) {
  // Not yet fully established: pending_open, or active=false with no
  // local balance committed yet.
  return channel.active === false && (channel.local_balance || "0") === "0";
}

function isPrivateChannel(channel) {
  return channel.private === true || channel.public === false;
}

export function classifyChannel(channel, peerHistory, referenceTime) {
  const ref = new Date(referenceTime);
  const cap = BigInt(channel.capacity || 0);
  const hasBackup = channel.backup === true;
  const peerOnline = channel.peer_online === true;
  const channelActive = channel.active === true;
  const privateChan = isPrivateChannel(channel);
  const intermittent = isIntermittentPrivate(peerHistory, channel.remote_pubkey);

  const lastObs = latestObservation(peerHistory, channel.remote_pubkey);
  const hoursSinceConn = hoursSinceLastConnection(
    peerHistory,
    channel.remote_pubkey,
    referenceTime
  );

  // Choose the leniency window: intermittent private peers (mobile wallets
  // that connect every few days) get a longer window before their recovery
  // dependency is treated as unverified.
  const windowHours = privateChan && intermittent
    ? PRIVATE_LENIENCY_HOURS
    : RECENT_WINDOW_HOURS;

  const peerRecentlySeen =
    hoursSinceConn !== null && hoursSinceConn <= windowHours;

  let state, reason, evidence, rule, recoveryDependsOn, recommendedAction;

  // Rule 1: Channel not yet fully established.
  if (channelAwaitingFunding(channel)) {
    state = "AWAITING_FUNDING_CONFIRMATION";
    reason = "Channel is not yet fully established on-chain.";
    evidence = {
      active: channelActive,
      local_balance: channel.local_balance,
      last_observation: lastObs
        ? { observed_at: lastObs.observed_at, is_connected: lastObs.is_connected }
        : null,
    };
    rule = "active=false and local_balance=0 → channel awaiting funding confirmation";
    recoveryDependsOn = "On-chain confirmation of the funding transaction.";
    recommendedAction =
      "Wait for funding confirmation, then re-audit. No exit intervention yet.";
  }
  // Rule 2: No backup entry for this channel.
  else if (!hasBackup) {
    state = "BACKUP_MISSING";
    reason = "No channel entry in the offsite static channel backup.";
    evidence = {
      backup: false,
      last_observation: lastObs
        ? { observed_at: lastObs.observed_at, is_connected: lastObs.is_connected }
        : null,
    };
    rule = "channel.backup flag=false for this channel_point";
    recoveryDependsOn = "The offsite backup must be refreshed to include this channel.";
    recommendedAction =
      "Refresh the offsite backup immediately; re-audit after refresh.";
  }
  // Rule 3: Backup exists and peer was recently observed connected.
  else if (hasBackup && peerRecentlySeen) {
    state = "BACKED_UP_PEER_RECENTLY_SEEN";
    reason =
      "Backup covers the channel and the peer was recently observed connected.";
    evidence = {
      backup: true,
      peer_online: peerOnline,
      hours_since_last_connection: hoursSinceConn
        ? Math.round(hoursSinceConn * 10) / 10
        : null,
      last_observation: lastObs
        ? { observed_at: lastObs.observed_at, is_connected: lastObs.is_connected }
        : null,
      connection_pattern: intermittent ? "intermittent (private)" : "regular",
    };
    rule = `backup=true and peer last connected ${hoursSinceConn ? Math.round(hoursSinceConn) : "unknown"}h ago (window ${windowHours}h)`;
    recoveryDependsOn =
      "SCB recovery still depends on remote peer DLP cooperation after data loss — today's reachability does not guarantee future cooperation.";
    recommendedAction =
      "Continue routine backup refresh and peer monitoring. Record the observation as recovery evidence.";
  }
  // Rule 4: Backup exists but peer not recently observed — dependency unverified.
  else {
    state = "BACKED_UP_PEER_UNVERIFIED";
    reason =
      "Backup covers the channel but the peer has not been recently observed connected; recovery dependency is currently unverified.";
    evidence = {
      backup: true,
      peer_online: peerOnline,
      hours_since_last_connection: hoursSinceConn
        ? Math.round(hoursSinceConn * 10) / 10
        : null,
      last_observation: lastObs
        ? { observed_at: lastObs.observed_at, is_connected: lastObs.is_connected }
        : null,
      connection_pattern: intermittent ? "intermittent (private)" : "regular",
      window_hours: windowHours,
    };
    rule = `backup=true and peer last connected ${hoursSinceConn ? Math.round(hoursSinceConn) : "never"}h ago (window ${windowHours}h${intermittent ? ", intermittent private pattern" : ""})`;
    recoveryDependsOn =
      "If the node is lost while this peer remains unreachable, ordinary SCB recovery may not retrieve this channel's funds through DLP.";
    recommendedAction =
      "Continue observing peer availability. If unavailability persists beyond the window, prepare a safe-exit decision (cooperative or force close) before the node is lost.";
  }

  return {
    channel_point: channel.channel_point,
    chan_id: channel.chan_id,
    capacity: cap.toString(),
    local_balance: channel.local_balance,
    remote_pubkey: channel.remote_pubkey,
    peer_online: peerOnline,
    channel_active: channelActive,
    private: privateChan,
    connection_pattern: intermittent ? "intermittent" : "regular",
    hours_since_last_connection:
      hoursSinceConn !== null ? Math.round(hoursSinceConn * 10) / 10 : null,
    backup: hasBackup,
    state,
    reason,
    evidence,
    rule,
    recovery_depends_on: recoveryDependsOn,
    recommended_action: recommendedAction,
    assessed_at: nowIso(),
  };
}

// ---------- Engine entry ----------

export function assess(auditorResult, peerHistory, referenceTime = nowIso()) {
  const backupStale = auditorResult.offsite_backup?.stale === true;

  const classifications = auditorResult.findings.map((f) =>
    classifyChannel(f, peerHistory, referenceTime)
  );

  const byState = {};
  for (const c of classifications) {
    byState[c.state] = (byState[c.state] || 0) + 1;
  }

  const totalCapacity = classifications.reduce(
    (acc, c) => acc + BigInt(c.capacity),
    0n
  );
  // Channels whose recovery position is not honestly established.
  const unverifiedCapacity = classifications
    .filter(
      (c) =>
        c.state === "BACKUP_MISSING" || c.state === "BACKED_UP_PEER_UNVERIFIED"
    )
    .reduce((acc, c) => acc + BigInt(c.capacity), 0n);

  return {
    assessed_at: referenceTime,
    recent_observation_window_hours: RECENT_WINDOW_HOURS,
    private_channel_leniency_hours: PRIVATE_LENIENCY_HOURS,
    offsite_backup_stale: backupStale,
    total_channels: classifications.length,
    total_capacity: totalCapacity.toString(),
    unverified_capacity: unverifiedCapacity.toString(),
    state_counts: byState,
    classifications,
    summary: {
      backed_up_peer_recently_seen: classifications.filter(
        (c) => c.state === "BACKED_UP_PEER_RECENTLY_SEEN"
      ).length,
      backed_up_peer_unverified: classifications.filter(
        (c) => c.state === "BACKED_UP_PEER_UNVERIFIED"
      ).length,
      backup_missing: classifications.filter(
        (c) => c.state === "BACKUP_MISSING"
      ).length,
      awaiting_funding_confirmation: classifications.filter(
        (c) => c.state === "AWAITING_FUNDING_CONFIRMATION"
      ).length,
    },
  };
}

if (process.argv[1] === import.meta.url) {
  const [auditorPath, peerHistoryPath] = process.argv.slice(2);
  if (!auditorPath)
    fail("Usage: node risk-engine.mjs <auditor-result.json> [peer-history.jsonl]");
  const auditor = loadAuditorResult(auditorPath);
  const history = loadPeerHistory(peerHistoryPath);
  const result = assess(auditor, history);
  console.log(JSON.stringify(result, null, 2));
}
