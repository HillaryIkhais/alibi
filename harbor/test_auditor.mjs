import fs from "node:fs";
import https from "node:https";
import crypto from "node:crypto";

const MACAROON = process.env.HARBOR_LND_MACAROON || "";
const LAB_MODE = process.env.HARBOR_LAB_MODE === "1";

function offsitePath() { return process.env.HARBOR_OFFSITE_BACKUP || ""; }
function liveBackupHash() { return process.env.HARBOR_LIVE_BACKUP_HASH || ""; }

const HEADERS = {
  "Grpc-Metadata-macaroon": MACAROON,
  "Content-Type": "application/json",
};

function baseUrl() {
  return process.env.HARBOR_LND_REST_URL || "http://localhost:10039";
}

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

async function fetchJson(path, opts = {}) {
  const url = new URL(`${baseUrl()}${path}`);
  let fetchOpts = { headers: HEADERS, ...opts };
  
  if (url.protocol === 'https:') {
    const agent = new https.Agent({ rejectUnauthorized: false });
    fetchOpts.agent = agent;
  }
  
  const res = await fetch(url.toString(), fetchOpts);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LND REST ${path} -> ${res.status}: ${body}`);
  }
  return res.json();
}

async function audit() {
  const [channels, peers, backups] = await Promise.all([
    fetchJson("/v1/channels").then(d => d.channels || []),
    fetchJson("/v1/peers").then(d => d.peers || []),
    exportBackups(),
  ]);
  
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
    const remotePub = ch.remote_pubkey;
    const online = peers.some(p => p.pub_key === remotePub && p.is_connected);
    const hasBackup = backupByChan.has(ch.channel_point);
    
    const status = hasBackup ? "covered" : "not-backed-up";
    if (hasBackup) coveredSats += cap; else uncoveredSats += cap;
    
    findings.push({
      channel_point: ch.channel_point,
      chan_id: ch.chan_id,
      capacity: cap.toString(),
      remote_pubkey: remotePub,
      peer_online: online,
      active: ch.active,
      backup: hasBackup,
      status,
    });
  }
  
  const path = offsitePath();
  const liveHash = liveBackupHash();
  let offsiteStale = null;
  let offsiteHash = null;
  if (path && fs.existsSync(path)) {
    offsiteHash = crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
    offsiteStale = liveHash ? offsiteHash !== liveHash : null;
  }
  
  return {
    total_channels: channels.length,
    backup_entry_count: backups.length,
    covered_count: findings.filter(f => f.backup).length,
    uncovered_count: findings.filter(f => !f.backup).length,
    offsite_backup: { path, hash: offsiteHash, live_hash: liveHash, stale: offsiteStale },
    findings,
  };
}

async function exportBackups() {
  try {
    const data = await fetchJson("/v1/channels/backups", { method: "POST" });
    if (data.channel_backups && data.channel_backups.length > 0) {
      return data.channel_backups.map(b => ({
        chan_point: `${b.chan_point.funding_txid_bytes}:${b.chan_point.output_index}`,
      }));
    }
  } catch (e) {}
  
  const backupPath = "/root/.lnd/data/chain/bitcoin/regtest/channel.backup";
  if (fs.existsSync(backupPath)) {
    // Return empty array - we'll use offsite comparison for staleness
    return [];
  }
  return [];
}

audit()
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(err => fail(err.message));
