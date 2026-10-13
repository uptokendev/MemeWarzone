/**
 * Write the unsigned Safe batches for one chain from a deployer address and nonce.
 * No network. No signature.
 *
 *   node scripts/gen8/deploy/write-gen8-mainnet-batches.mjs --chain 56 --deployer 0x... --nonce 0
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { buildDeployment, chainById, writeBatchSet } from "./gen8-mainnet-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
};

const chain = chainById(opt("--chain"));
const deployer = ethers.getAddress(opt("--deployer"));
const nonce = Number(opt("--nonce") || "0");
if (!Number.isInteger(nonce) || nonce < 0) throw new Error("--nonce must be a whole number");
const plan = buildDeployment(chain, deployer, nonce);
const dir = path.join(ROOT, "deployments", chain.dir, "mainnet-batches");
const written = writeBatchSet(dir, plan, { rehearsal: false });
console.log(JSON.stringify({ chainId: chain.id, deployer, nonce, launcher: plan.addr.launcher, hook: plan.addr.hook, files: written }, null, 2));
