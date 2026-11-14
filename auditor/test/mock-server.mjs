#!/usr/bin/env node
/**
 * Minimal mock LND REST server for offline auditor validation.
 * Serves fixture JSON on the LND REST paths the auditor calls.
 */
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.HARBOR_MOCK_PORT || 19876);
const FIX = (name) => JSON.parse(fs.readFileSync(`test/fixtures/${name}.json`, "utf8"));

const routes = {
  "/v1/channels": FIX("channels"),
  "/v1/peers": FIX("peers"),
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
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
    } catch (err) {
      console.error("mock request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    }
  });
  req.on("error", (err) => console.error("mock req stream error:", err));
});

server.listen(PORT, () => {
  console.error(`mock LND REST listening on :${PORT}`);
});
