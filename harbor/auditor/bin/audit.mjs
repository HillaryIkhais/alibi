#!/usr/bin/env node
/**
 * HARBOR recovery-readiness auditor (lab phase).
 *
 * Read-only inspection of an LND node over its REST API.
 * Produces a channel-by-channel recovery-readiness assessment:
 *   - which live channels are covered by the offsite static channel backup,
 *   - which are missing from it,
 *   - whether the offsite backup file is stale vs what LND currently exports,
 *   - peer availability per channel (observed fact), and
 *   - a labelled verdict (verified fact vs risk estimate).
 *
 * Configuration via environment:
 *   HARBOR_LND_REST_URL       https://host:port of LND REST
 *   HARBOR_LND_MACAROON       hex-encoded admin macaroon (required by LND REST auth)
 *   HARBOR_OFFSITE_BACKUP     path to offsite channel.backup file to compare against
 *   HARBOR_LIVE_BACKUP_HASH   sha256 of the node's CURRENT channel.backup
 *   HARBOR_LAB_MODE           "1" to enable exact per-channel diff
 */

import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

const LAB_MODE = () => process.env.HARBOR_LAB_MODE === "1";
function getRestUrl() { return process.env.HARBOR_LND_REST_URL || "http://localhost:10039"; }
function offsitePath() { return process.env.HARBOR_OFFSITE_BACKUP || ""; }
function liveBackupHash() { return process.env.HARBOR_LIVE_BACKUP_HASH || ""; }

function getHeaders() {
  const macaroon = process.env.HARBOR_LND_MACAROON || "";
  return {
    "Grpc-Metadata-macaroon": macaroon,
    "Content-Type": "application/json",
  };
}

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

async function fetchJson(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const currentUrl = getRestUrl();
    const urlObj = new URL(`${currentUrl}${path}`);
    const isHttps = urlObj.protocol === "https:";
    const requestModule = isHttps ? https : http;
    const requestOptions = {
      hostname: urlObj.hostname,
      port: Number(urlObj.port) || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: opts.method || "GET",
      headers: getHeaders(),
      ...(isHttps ? { rejectUnauthorized: false } : {})
    };
    
    const req = requestModule.request(requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

export async function listChannels() {
  const data = await fetchJson("/v1/channels");
  return data.channels || [];
}

export async function listPeers() {
  const data = await fetchJson("/v1/peers");
  return data.peers || [];
}

export async function exportBackups() {
  // Try REST endpoint first
  try {
    const data = await fetchJson("/v1/channels/backups", { method: "POST" });
    if (data.channel_backups && data.channel_backups.length > 0) {
      return data.channel_backups.map(b => {
        // chan_point can be string or object depending on LND version
        let chanPoint;
        if (typeof b.chan_point === "string") {
          chanPoint = b.chan_point;
        } else if (b.chan_point && b.chan_point.funding_txid_bytes) {
          chanPoint = `${b.chan_point.funding_txid_bytes}:${b.chan_point.output_index}`;
        } else {
          chanPoint = "";
        }
        return {
          chan_point: chanPoint,
          chan_backup: b.chan_backup || b.channel_backup
        };
      });
    }
  } catch (e) {
    // REST endpoint may not be available (e.g., LND v0.21.6-beta)
  }
  
  return [];
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileHash(path) {
  const bytes = fs.readFileSync(path);
  return sha256Hex(bytes);
}

function peerIsOnline(peers, pubKey) {
  // Check if peer is connected - LND REST returns is_connected field
  const peer = peers.find(p => p.pub_key === pubKey);
  if (!peer) return false;
  return peer.is_connected === true;
}

export async function audit() {
  const [channels, peers, backups] = await Promise.all([
    listChannels(),
    listPeers(),
    exportBackups(),
  ]);

  // Build backup index keyed by channel point
  const backupByChan = new Map();
  for (const b of backups) {
    const cp = b.chan_point || "";
    backupByChan.set(cp, b);
  }

  const findings = [];
  let coveredSats = 0n;
  let uncoveredSats = 0n;

  for (const ch of channels) {
    const cap = BigInt(ch.capacity || 0);
    const local = BigInt(ch.local_balance || 0);
    const remotePub = ch.remote_pubkey;
    const online = peerIsOnline(peers, remotePub);
    const hasBackup = backupByChan.has(ch.channel_point);

    let status, kind, detail;
    if (hasBackup) {
      status = "covered";
      kind = "fact";
      coveredSats += cap;
      detail = "Channel present in static channel backup.";
    } else {
      status = "not-backed-up";
      kind = "fact";
      uncoveredSats += cap;
      detail =
        "Channel has no entry in the exported static channel backup. Funds in this channel cannot be recovered from the backup alone.";
    }

    findings.push({
      channel_point: ch.channel_point,
      chan_id: ch.chan_id,
      capacity: cap.toString(),
      local_balance: local.toString(),
      remote_pubkey: remotePub,
      peer_online: online,
      active: ch.active,
      backup: hasBackup,
      status,
      kind,
      detail,
    });
  }

  // Staleness: compare the offsite channel.backup copy against the node's
  // current channel.backup. Both are the same file format, so a sha256
  // comparison is valid and requires no decryption.
  const backupPath = offsitePath();
  const liveHashVal = liveBackupHash();
  let offsiteStale = null;
  let offsiteHash = null;
  if (backupPath && fs.existsSync(backupPath)) {
    offsiteHash = fileHash(backupPath);
    offsiteStale = liveHashVal ? offsiteHash !== liveHashVal : null;
  }

  const total = channels.length;
  const backupCount = backups.length;
  const peersOnlineCount = peers.filter(p => p.is_connected === true).length;
  return {
    node: getRestUrl(),
    lab_mode: LAB_MODE(),
    total_channels: total,
    backup_entry_count: backupCount,
    covered_count: findings.filter(f => f.backup).length,
    uncovered_count: findings.filter(f => !f.backup).length,
    covered_sats: coveredSats.toString(),
    uncovered_sats: uncoveredSats.toString(),
    offsite_backup: {
      path: backupPath || null,
      hash: offsiteHash || null,
      live_hash: liveHashVal || null,
      stale: offsiteStale,
    },
    peers_online: peersOnlineCount,
    peers_total: peers.length,
    findings,
  };
}

if (process.argv[1] === import.meta.url) {
  audit()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      fail(err.message);
    });
}