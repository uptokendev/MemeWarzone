#!/usr/bin/env node
/**
 * For the Safe signers: verify a proposed CreatorRewardsVaultV2 holder batch against its published leaf file,
 * then print the exact weekly Safe batch H to sign (approveHolderBatch + the holder distributor's authorizeBatch,
 * built with holderWeekCalls() from scripts/deploy-evm-treasury-router-v4.ts and encoded by make-safe-batch.ts).
 * Reads only; sends nothing. Refuses on any mismatch.
 *
 *   node scripts/evm-holder-batch-verify.mjs --chain 56 \
 *     --file https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=2026-09-21   (or a local .json;
 *            add &vault=<gen-7 vault> for gen-7's own vault, which publishes its own file per week)
 *     [--rpc <url>] [--vault <addr>] [--tx <propose tx hash>] [--from-block <n>]
 *     [--auth-max <wei>] [--out <safe-batch.json>]
 *
 * Checks, in order:
 *   1. The leaf file itself: every account once, amounts positive, the tree recomputed from the leaves (OpenZeppelin
 *      leaf keccak256(bytes.concat(keccak256(abi.encode(account, amount)))), commutative pairs) gives its root, the
 *      leaves add up to its total, the campaign amounts add up to the same total, and the batch id is this chain
 *      and week's holder batch id.
 *   2. The chain: the RPC is the named chain; the vault is the file's (and EVM_CREATOR_VAULT_V2_<id> when set, or
 *      EVM_GEN7_CREATOR_VAULT_<id> for a gen-7 file, program "airdrop_holders_gen7"); the
 *      vault's holderDistributor is the file's; the vault's HolderBatchProposed for this batch id carries exactly
 *      this root, total and claim deadline; the proposing transaction called proposeHolderBatch on the vault with
 *      exactly the file's campaigns and amounts, in order; every campaign's choice in the vault is holders or split;
 *      the batch was not vetoed or executed.
 *   3. The total is within the Safe's per-batch authorization cap (EVMGEN_HOLDER_BATCH_AUTH_MAX, --auth-max).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const VAULT_ABI = [
  "function holderDistributor() view returns (address)",
  "function cfg(address) view returns (address creator, uint8 choice, uint8 creatorPct, address pool, address quote)",
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, address[] campaigns, uint256[] amounts) returns (uint256 total)",
  "event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline)",
  "event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total)",
  "event HolderBatchVetoed(bytes32 indexed batchId, uint256 total)",
  "event HolderBatchExecuted(bytes32 indexed batchId, uint256 total)",
];
const VAULT_IFACE = new ethers.Interface(VAULT_ABI);

// ------------------------------------------------------------------------------------ the leaf file (pure)

/**
 * program: "airdrop_holders" (gen-6 vault, the default; its files carry no program field) or "airdrop_holders_gen7"
 * (gen-7's own vault, 2026-10-08). Same derivation as realtime-indexer/src/evm/evmCreatorChoice.ts holderBatchId.
 */
export function holderBatchId(chainId, weekId, program = "airdrop_holders") {
  if (!/^[a-z0-9_]+$/.test(program)) throw new Error(`bad holder program ${program}`);
  return ethers.keccak256(ethers.toUtf8Bytes(`mwz-weekly-airdrop:${chainId}:${weekId}:${program}`));
}

/** The env variable that names the vault of a file's program (gen-6 or gen-7's own vault). */
export function vaultEnvName(chainId, program = "airdrop_holders") {
  return program === "airdrop_holders" ? `EVM_CREATOR_VAULT_V2_${chainId}` : `EVM_GEN7_CREATOR_VAULT_${chainId}`;
}

export function merkleLeaf(account, amount) {
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [ethers.getAddress(account), BigInt(amount)]));
  return ethers.keccak256(inner);
}

function hashPair(a, b) {
  return ethers.keccak256(ethers.concat(a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a]));
}

/** Same tree as frontend/scripts/weekly-airdrop/materialize.mjs and the indexer's evmCreatorChoice.ts. */
export function merkleRoot(entries) {
  if (!entries.length) throw new Error("empty leaf list");
  let level = entries.map((e) => merkleLeaf(e.account, e.amount));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export function checkLeafFile(file) {
  if (file?.kind !== "mwz-evm-holder-batch" || file.version !== 1) throw new Error("not a version 1 holder leaf file");
  if (!Array.isArray(file.leaves) || !file.leaves.length) throw new Error("leaf file has no leaves");
  if (!Array.isArray(file.campaigns) || !file.campaigns.length) throw new Error("leaf file has no campaigns");
  const seen = new Set();
  const entries = file.leaves.map((l) => {
    const account = ethers.getAddress(l.account);
    if (seen.has(account.toLowerCase())) throw new Error(`duplicate account ${account}`);
    seen.add(account.toLowerCase());
    const amount = BigInt(l.amount);
    if (amount <= 0n) throw new Error(`non-positive amount for ${account}`);
    return { account, amount };
  });
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  if (total.toString() !== String(file.total)) throw new Error(`total ${file.total} does not match the leaves (${total})`);
  const campaignSeen = new Set();
  let byCampaign = 0n;
  for (const c of file.campaigns) {
    const a = ethers.getAddress(c.campaign).toLowerCase();
    if (campaignSeen.has(a)) throw new Error(`campaign ${c.campaign} listed twice`);
    campaignSeen.add(a);
    if (BigInt(c.amount) <= 0n) throw new Error(`non-positive amount for campaign ${c.campaign}`);
    byCampaign += BigInt(c.amount);
  }
  if (byCampaign !== total) throw new Error(`campaign amounts (${byCampaign}) do not add up to the total (${total})`);
  const root = merkleRoot(entries);
  if (root.toLowerCase() !== String(file.root).toLowerCase()) throw new Error(`root ${file.root} does not match the leaves (${root})`);
  if (holderBatchId(file.chainId, file.weekId, file.program ?? "airdrop_holders").toLowerCase() !== String(file.batchId).toLowerCase()) {
    throw new Error("batch id is not this chain and week's holder batch id");
  }
  checkLeafParts(file);
  return { root, total };
}

/**
 * E19, same rule as the indexer's checkLeafParts: when the leaves carry `parts` (which campaign each wei came
 * from), each leaf's parts add up to the leaf and each campaign's parts add up to that campaign's amount.
 * Returns false for a file without parts; throws on any mismatch.
 */
export function checkLeafParts(file) {
  if (!file.leaves.some((l) => l.parts)) return false;
  const byCampaign = new Map();
  for (const l of file.leaves) {
    if (!Array.isArray(l.parts) || !l.parts.length) throw new Error(`leaf ${l.account} has no parts`);
    let sum = 0n;
    for (const p of l.parts) {
      const a = BigInt(p.amount);
      if (a <= 0n) throw new Error(`non-positive part for ${l.account}`);
      const c = ethers.getAddress(p.campaign).toLowerCase();
      byCampaign.set(c, (byCampaign.get(c) || 0n) + a);
      sum += a;
    }
    if (sum !== BigInt(l.amount)) throw new Error(`parts of ${l.account} (${sum}) do not add up to its leaf (${l.amount})`);
  }
  if (byCampaign.size !== file.campaigns.length) throw new Error("leaf parts name a different set of campaigns");
  for (const c of file.campaigns) {
    if (byCampaign.get(ethers.getAddress(c.campaign).toLowerCase()) !== BigInt(c.amount)) throw new Error(`leaf parts for ${c.campaign} do not add up to its amount`);
  }
  return true;
}

// ------------------------------------------------------------------------------------ the chain

function sameAddr(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

/**
 * Compares the proposal on chain with the leaf file. `chain` is injectable for tests:
 * { chainId, holderDistributor(), cfgChoice(campaign), proposal(batchId) -> { event, tx }, laterEvents(batchId) -> names[] }.
 */
export async function checkOnChain(file, chain, { vault }) {
  if (Number(chain.chainId) !== Number(file.chainId)) throw new Error(`RPC is chain ${chain.chainId}, the file is for ${file.chainId}`);
  if (!sameAddr(vault, file.vault)) throw new Error(`the file's vault ${file.vault} is not ${vault}`);
  const dist = await chain.holderDistributor();
  if (!sameAddr(dist, file.holderDistributor)) throw new Error(`vault's holder distributor is ${dist}, the file says ${file.holderDistributor}`);
  const found = await chain.proposal(file.batchId);
  if (!found) throw new Error(`no HolderBatchProposed for ${file.batchId} on the vault`);
  const { event, tx } = found;
  if (!sameAddr(event.root, file.root)) throw new Error(`proposed root ${event.root} differs from the file's ${file.root}`);
  if (BigInt(event.total) !== BigInt(file.total)) throw new Error(`proposed total ${event.total} differs from the file's ${file.total}`);
  if (BigInt(event.claimDeadline) !== BigInt(file.claimDeadline)) throw new Error(`proposed claim deadline ${event.claimDeadline} differs from the file's ${file.claimDeadline}`);
  if (!sameAddr(tx.to, vault)) throw new Error(`the proposing transaction went to ${tx.to}, not the vault`);
  const decoded = VAULT_IFACE.parseTransaction({ data: tx.data });
  if (decoded?.name !== "proposeHolderBatch") throw new Error("the proposing transaction is not proposeHolderBatch");
  const [batchId, root, claimDeadline, campaigns, amounts] = decoded.args;
  if (!sameAddr(batchId, file.batchId) || !sameAddr(root, file.root) || BigInt(claimDeadline) !== BigInt(file.claimDeadline)) {
    throw new Error("proposeHolderBatch calldata does not match the file (id, root or deadline)");
  }
  if (campaigns.length !== file.campaigns.length) throw new Error(`proposed ${campaigns.length} campaigns, the file lists ${file.campaigns.length}`);
  for (let i = 0; i < campaigns.length; i += 1) {
    if (!sameAddr(campaigns[i], file.campaigns[i].campaign) || BigInt(amounts[i]) !== BigInt(file.campaigns[i].amount)) {
      throw new Error(`campaign ${i} differs: chain ${campaigns[i]} ${amounts[i]}, file ${file.campaigns[i].campaign} ${file.campaigns[i].amount}`);
    }
    const choice = Number(await chain.cfgChoice(campaigns[i]));
    if (choice !== 2 && choice !== 3) throw new Error(`campaign ${campaigns[i]} has choice ${choice} in the vault, not holders or split`);
  }
  const later = await chain.laterEvents(file.batchId);
  if (later.includes("HolderBatchVetoed")) throw new Error("this batch was vetoed");
  if (later.includes("HolderBatchExecuted")) throw new Error("this batch was already executed");
  return { alreadyApproved: later.includes("HolderBatchApproved"), executableAt: BigInt(event.executableAt) };
}

export function createEthersVerifyChain(provider, vault, { tx: txHash, fromBlock } = {}) {
  const v = new ethers.Contract(vault, VAULT_ABI, provider);
  let proposalBlock = null;
  async function scan(topics, from) {
    const latest = await provider.getBlockNumber();
    const logs = [];
    for (let start = from; start <= latest; start += 5_000) {
      logs.push(...(await provider.getLogs({ address: vault, topics, fromBlock: start, toBlock: Math.min(latest, start + 4_999) })));
    }
    return logs;
  }
  return {
    chainId: null,
    async init() {
      this.chainId = Number((await provider.getNetwork()).chainId);
      return this;
    },
    holderDistributor: () => v.holderDistributor(),
    async cfgChoice(campaign) {
      return (await v.cfg(campaign))[1];
    },
    async proposal(batchId) {
      const topic = VAULT_IFACE.getEvent("HolderBatchProposed").topicHash;
      let logs;
      if (txHash) {
        const r = await provider.getTransactionReceipt(txHash);
        logs = (r?.logs || []).filter((l) => sameAddr(l.address, vault) && l.topics[0] === topic && l.topics[1]?.toLowerCase() === batchId.toLowerCase());
      } else {
        const latest = await provider.getBlockNumber();
        logs = await scan([topic, batchId], fromBlock ?? Math.max(0, latest - 200_000));
      }
      if (!logs.length) return null;
      const log = logs[logs.length - 1];
      proposalBlock = log.blockNumber;
      const event = VAULT_IFACE.parseLog({ topics: [...log.topics], data: log.data }).args;
      const tx = await provider.getTransaction(log.transactionHash);
      return { event, tx: { to: tx.to, data: tx.data, hash: tx.hash } };
    },
    async laterEvents(batchId) {
      const names = ["HolderBatchApproved", "HolderBatchVetoed", "HolderBatchExecuted"];
      const topics = names.map((n) => VAULT_IFACE.getEvent(n).topicHash);
      const logs = await scan([topics, batchId], proposalBlock ?? 0);
      return logs.map((l) => VAULT_IFACE.parseLog({ topics: [...l.topics], data: l.data }).name);
    },
  };
}

// ------------------------------------------------------------------------------------ the Safe batch

/** Loads a hardhat-side TypeScript script as CommonJS with a require shim (as the indexer spec does). */
function loadTs(file, deps) {
  const ts = require("typescript");
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const req = (id) => (id in deps ? deps[id] : require(id));
  new Function("module", "exports", "require", "__dirname", "__filename", js)(mod, mod.exports, req, path.dirname(file), file);
  return mod.exports;
}

export function loadSafeBatchBuilders() {
  const safe = loadTs(path.join(HERE, "make-safe-batch.ts"), {});
  const deploy = loadTs(path.join(HERE, "deploy-evm-treasury-router-v4.ts"), {
    hardhat: { ethers, network: { name: "verify-only" } },
    "./make-safe-batch": safe,
  });
  return { holderWeekCalls: deploy.holderWeekCalls, buildBatch: safe.buildBatch };
}

export function safeBatchFor(file, { authMax, nowSec, builders = loadSafeBatchBuilders() }) {
  const calls = builders.holderWeekCalls(
    { vault: file.vault, holderDistributor: file.holderDistributor },
    { batchId: file.batchId, root: file.root, total: BigInt(file.total) },
    { holderBatchAuthorizationMax: BigInt(authMax) },
    nowSec,
  );
  return builders.buildBatch(Number(file.chainId), `MWZ holders ${file.weekId}`, `Approve holder batch ${file.batchId} (root ${file.root}, total ${file.total} wei, ${file.leaves.length} holders) and authorize it on the holder distributor`, calls);
}

// ------------------------------------------------------------------------------------ CLI

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

async function readFileArg(source) {
  let body;
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`fetching the leaf file failed: HTTP ${r.status}`);
    body = await r.json();
  } else {
    body = JSON.parse(fs.readFileSync(source, "utf8"));
  }
  return body?.leafFile ?? body;
}

function rpcFor(chainId) {
  const names = { 56: ["BSC_RPC_HTTP_56", "BSC_RPC_HTTP"], 97: ["BSC_RPC_HTTP_97"], 4663: ["ROBINHOOD_RPC_HTTP_4663", "ROBINHOOD_MAINNET_RPC_URL"], 46630: ["ROBINHOOD_RPC_HTTP_46630", "ROBINHOOD_TESTNET_RPC_URL"] }[chainId] || [];
  for (const n of names) {
    const v = String(process.env[n] || "").split(",")[0].trim();
    if (v) return v;
  }
  return "";
}

async function main() {
  const a = args(process.argv.slice(2));
  const chainId = Number(a.chain);
  if (!a.file || !chainId) throw new Error("usage: --chain <id> --file <path|url> [--rpc url] [--vault addr] [--tx hash] [--from-block n] [--auth-max wei] [--out file]");
  const file = await readFileArg(a.file);
  const { root, total } = checkLeafFile(file);
  console.log(`[verify] leaf file OK: ${file.leaves.length} holders, ${file.campaigns.length} campaigns, total ${total} wei, root ${root}`);

  const envName = vaultEnvName(chainId, file.program ?? "airdrop_holders");
  const envVault = String(process.env[envName] || "").split(",")[0].split("@")[0].trim();
  const vault = ethers.getAddress(a.vault || envVault || file.vault);
  if (envVault && !sameAddr(envVault, vault)) throw new Error(`--vault ${vault} differs from ${envName} ${envVault}`);
  const rpc = a.rpc || rpcFor(chainId);
  if (!rpc) throw new Error(`no RPC: pass --rpc or set the chain's RPC env`);
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const chain = await createEthersVerifyChain(provider, vault, { tx: a.tx, fromBlock: a["from-block"] ? Number(a["from-block"]) : undefined }).init();
  const onchain = await checkOnChain(file, chain, { vault });
  console.log(`[verify] chain OK: the vault's proposal matches the file; executable after ${new Date(Number(onchain.executableAt) * 1000).toISOString()}${onchain.alreadyApproved ? " (already approved)" : ""}`);

  const authMax = a["auth-max"] || process.env.EVMGEN_HOLDER_BATCH_AUTH_MAX;
  if (!authMax || !/^\d+$/.test(String(authMax))) throw new Error("the Safe's per-batch cap is required: --auth-max <wei> or EVMGEN_HOLDER_BATCH_AUTH_MAX");
  const batch = safeBatchFor(file, { authMax, nowSec: Math.floor(Date.now() / 1000) });
  const text = `${JSON.stringify(batch, null, 2)}\n`;
  if (a.out) {
    fs.writeFileSync(a.out, text);
    console.log(`[verify] Safe batch H written to ${a.out}`);
  } else {
    process.stdout.write(text);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[verify] REFUSED: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
