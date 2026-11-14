#!/usr/bin/env node
/**
 * Offline validation of the HARBOR auditor against an in-process mock LND REST
 * server. No Docker, no internet, no secrets, no child processes.
 *
 * Fixtures: 5 live channels, backups for 3 of them.
 * Expectations:
 *   - covered_count == 3
 *   - uncovered_count == 2
 *   - uncovered_sats == "1100000"  (700000 + 400000)
 *   - offsite_stale toggles with HARBOR_LIVE_BACKUP_HASH
 *   - every finding labelled kind == "fact"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { audit } from "../bin/audit.mjs";

const PORT = 19876;
const REST_URL = `http://127.0.0.1:${PORT}`;
const FIX = (name) => JSON.parse(fs.readFileSync(`test/fixtures/${name}.json`, "utf8"));

const routes = {
  "/v1/channels": FIX("channels"),
  "/v1/peers": FIX("peers"),
};

let failures = 0;
function check(name, cond, extra = "") {
  const ok = cond === true;
  console.log(`${ok ? "PASS" : "FAIL"} :: ${name} ${extra}`);
  if (!ok) failures++;
}

async function waitForServer(retries = 80, delayMs = 100) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${REST_URL}/v1/channels`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`mock server not ready: ${lastErr && lastErr.message}`);
}

async function main() {
  // In-process mock LND REST server.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/v1/channels/backups" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FIX("backups")));
      return;
    }
    const data = routes[url.pathname];
    if (data === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  });

  await new Promise((res) => server.listen(PORT, "127.0.0.1", res));
  console.error("mock LND REST listening on", REST_URL);

  await waitForServer();

  process.env.HARBOR_LND_REST_URL = REST_URL;
  process.env.HARBOR_LND_MACAROON = "deadbeef";
  process.env.HARBOR_LAB_MODE = "1";

  const offsite = path.join(os.tmpdir(), `harbor-offsite-${Date.now()}.backup`);
  fs.writeFileSync(offsite, "stale-offsite-backup-bytes");
  const offsiteHash = crypto.createHash("sha256").update(fs.readFileSync(offsite)).digest("hex");
  const mismatchedHash = "0000000000000000000000000000000000000000000000000000000000000000";

  // Case A: live hash mismatches offsite => stale.
  process.env.HARBOR_OFFSITE_BACKUP = offsite;
  process.env.HARBOR_LIVE_BACKUP_HASH = mismatchedHash;
  const a = await audit();
  check("case A offsite_stale === true", a.offsite_backup.stale === true, `(${a.offsite_backup.stale})`);
  check("case A total_channels === 5", a.total_channels === 5, `(${a.total_channels})`);
  check("case A covered_count === 3", a.covered_count === 3, `(${a.covered_count})`);
  check("case A uncovered_count === 2", a.uncovered_count === 2, `(${a.uncovered_count})`);
  check("case A uncovered_sats === 1100000", a.uncovered_sats === "1100000", `(${a.uncovered_sats})`);
  check("case A all findings kind === fact", a.findings.every((f) => f.kind === "fact"));
  check("case A peers_online === 2", a.peers_online === 2, `(${a.peers_online})`);

  const uncovered = a.findings.filter((f) => !f.backup);
  check("case A uncovered are chans 4 & 5", uncovered.length === 2
    && uncovered.every((f) => f.chan_id === "100000000000004" || f.chan_id === "100000000000005"));

  const chan3 = a.findings.find((f) => f.chan_id === "100000000000003");
  check("case A chan 3 covered but peer offline (deferred)", chan3.backup === true && chan3.peer_online === false);

  // Case B: live hash matches offsite => not stale.
  process.env.HARBOR_LIVE_BACKUP_HASH = offsiteHash;
  const b = await audit();
  check("case B offsite_stale === false", b.offsite_backup.stale === false, `(${b.offsite_backup.stale}) live=${b.offsite_backup.live_hash} offsite=${b.offsite_backup.hash}`);

  server.close();
  fs.unlinkSync(offsite);

  console.log(failures === 0 ? "\nALL OFFLINE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("OFFLINE TEST ERROR:", err);
  process.exit(2);
});
