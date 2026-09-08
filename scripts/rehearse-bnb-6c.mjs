#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  ALLOW_LOCAL_BNB_PROTOCOL_STAGE: "true",
  BNB_6C_STAGE_DEPLOYMENT_FILE: path.join(root, ".tmp/bnb-testnet-stage.local.json"),
  BNB_6C_ACCEPTANCE_ENABLE_LIVE: "true",
  BNB_6C_ACCEPTANCE_SIGNER: "true",
  BNB_6C_ACCEPTANCE_RESULT_FILE: path.join(root, ".tmp/bnb-testnet-lifecycle.local.json"),
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function waitForRpc() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const json = await res.json();
      if (json.result === "0x7a69") return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("hardhat node did not become ready on 127.0.0.1:8545");
}

fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
const log = fs.openSync(path.join(root, ".tmp/bnb-6c-hardhat-node.log"), "w");
const node = spawn("npx", ["hardhat", "node"], { cwd: root, env, stdio: ["ignore", log, log] });
try {
  await waitForRpc();
  await run("npx", ["hardhat", "run", "scripts/deploy-bnb-testnet-stage.ts", "--network", "localhost"]);
  await run("npx", ["hardhat", "run", "scripts/verify-bnb-testnet-stage.ts", "--network", "localhost"]);
  await run("npx", ["hardhat", "run", "scripts/test-bnb-testnet-lifecycle.ts", "--network", "localhost"]);
  const result = JSON.parse(fs.readFileSync(env.BNB_6C_ACCEPTANCE_RESULT_FILE, "utf8"));
  if (result.rehearsalPassed !== true) throw new Error("rehearsalPassed must be true");
  if (result.accepted !== false) throw new Error("accepted must be false on Hardhat");
  if (result.chainId !== 31337) throw new Error("rehearsal chainId must be 31337");
  console.log("BNB 6C local rehearsal passed", {
    factory: result.factory,
    rehearsalPassed: result.rehearsalPassed,
    accepted: result.accepted,
    realTopazCompatibility: result.realTopazCompatibility,
  });
} finally {
  node.kill("SIGTERM");
}
