#!/usr/bin/env node
import http from "node:http";

import { solanaGraduationAuthorizationV1 } from "../../frontend/api/dev-fix/solana-graduation-authorization-v1.js";

const host = "127.0.0.1";
const port = Number(process.env.SOLANA_DEVNET_GRADUATION_AUTH_PORT || 43101);

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

required("SOLANA_RPC_URL");
required("SOLANA_LAUNCHPAD_PROGRAM_ID");
required("SOLANA_ROUTE_SIGNER_PUBLIC_KEY");
required("SOLANA_ROUTE_SIGNER_SECRET_KEY");
process.env.SOLANA_GRADUATION_AUTH_ENABLED = "true";

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, network: "solana-devnet" }));
      return;
    }
    if (req.url === "/api/solana/graduation-authorize") {
      await solanaGraduationAuthorizationV1(req, res);
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    console.error("[devnet-graduation-auth] request failed", error instanceof Error ? error.message : String(error));
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.listen(port, host, () => {
  console.log(`devnet_graduation_auth=http://${host}:${port}/api/solana/graduation-authorize`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
