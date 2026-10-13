/**
 * Write the unsigned Safe batches for one chain from that chain's deploy record.
 * No network. No signature. Refuses a predicted deployer and nonce.
 *
 *   node scripts/gen8/deploy/write-gen8-mainnet-batches.mjs --chain 56
 *   node scripts/gen8/deploy/write-gen8-mainnet-batches.mjs --chain 4663
 *
 * The record is deployments/{bsc,robinhood}/mainnet.gen8.json, written only after
 * the real deploy. Predicted addresses are not accepted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chainById, writeSigningBatches } from "./gen8-mainnet-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
};

try {
  if (args.includes("--deployer") || args.includes("--nonce")) {
    throw new Error("refusing --deployer and --nonce. Signing batches are read from deployments/<chain>/mainnet.gen8.json after the real deploy.");
  }
  const chain = chainById(opt("--chain"));
  const recordPath = path.join(ROOT, "deployments", chain.dir, "mainnet.gen8.json");
  if (!fs.existsSync(recordPath)) {
    throw new Error(`missing ${recordPath}. Deploy first. Do not predict addresses.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (Number(record.chainId) !== chain.id) {
    throw new Error(`record chainId ${record.chainId} is not ${chain.id}`);
  }
  const dir = path.join(ROOT, "deployments", chain.dir, "mainnet-batches");
  const written = writeSigningBatches(record, dir);
  console.log(JSON.stringify({
    chainId: chain.id,
    record: recordPath,
    launcher: record.addresses.launcher,
    hook: record.addresses.hook,
    files: written,
    roles: false,
  }, null, 2));
} catch (error) {
  console.error(`[gen8-batches] ${error.message}`);
  process.exit(1);
}
