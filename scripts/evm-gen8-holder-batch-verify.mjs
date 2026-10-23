#!/usr/bin/env node
/**
 * For the Safe signers: verify a proposed GEN-8 holder batch (MwzCreatorChoiceVault on BNB 56 / Robinhood 4663) with
 * the SAME code the payout watchdog runs before it approves (realtime-indexer/src/evm/payoutWatchdogGen8.ts
 * verifyGen8HolderProposal, shared hold-through rule), then print the Safe batch to sign: approveHolderBatch(batchId,
 * root, total, claimDeadline) (selector 0xc62732bb) and, only when the holder distributor has no live authorization for
 * the batch id, authorizeBatch. Reads only; sends nothing. Refuses on any mismatch and prints no batch then.
 * Use it when the watchdog is off, raised "does NOT match the chain", or the signers want to check by hand.
 *
 *   node scripts/evm-gen8-holder-batch-verify.mjs --chain 56 \
 *     --file <published leaf file: https://... or a local .json> --vault-block <the vault's deploy block> \
 *     [--rpc <url>] [--vault <addr>] [--tx <propose tx hash>] [--from-block <n>] \
 *     [--risk-excluded 0x..,0x..] [--side-pools 0x..,0x..] [--exclusions 0x..,0x..] [--week-secret <hex>] [--out <safe-batch.json>]
 *
 * Inputs read from the environment by NAME only (the operator's values): EVM_BUYBACK_SEED_SECRET (or --week-secret, that
 * week's secret only), EVM_GEN8_CHOICE_VAULT_<id> ("0xaddr@block", also gives --vault / --vault-block),
 * EVM_HOLDER_MIN_PAYOUT_WEI[_<id>], EVM_HOLDER_CLAIM_WINDOW_DAYS, EVM_HOLDER_EXCLUDED_WALLETS[_<id>],
 * PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS, PAYOUT_WATCHDOG_MAX_UNLISTED_EXCLUDED_BPS, PAYOUT_WATCHDOG_GEN8_CHECK_TOLERANCE_MIN,
 * EVM_GEN8_LAUNCHER_<id> / HOOK / POOL_MANAGER / RESERVE_LOCK / ESCROW (the census exclusions: only KNOWN contracts are
 * skipped, founder 2026-10-22, so set them; without them only the vault's hook / poolManager / launcher are known and a
 * batch that skipped the reserve lock or escrow is refused; add more with --exclusions), RPC BSC_RPC_HTTP_56 /
 * ROBINHOOD_RPC_HTTP_4663. The soft-excluded wallets come from the file per check (bounded); the risk table lives in the
 * database: pass its wallets with --risk-excluded so they do not count as "on no current list".
 *
 * It needs tsx (realtime-indexer/node_modules) to load the TypeScript verifier and re-runs itself under it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const IDX = path.join(ROOT, "realtime-indexer");

async function loadIndexer() {
  const load = (rel) => import(pathToFileURL(path.join(IDX, "src", rel)).href);
  return {
    gen8: await load("evm/payoutWatchdogGen8.ts"),
    gen8Chain: await load("evm/payoutWatchdogGen8Chain.ts"),
    cfg: await load("evm/payoutWatchdogConfig.ts"),
    gen8Config: await load("evm/evmGen8Config.ts"),
    gen8Holders: await load("evm/evmGen8Holders.ts"),
    sidePools: await load("evm/evmGen8SidePools.ts"),
    watchdog: await load("evm/payoutWatchdog.ts"),
    ethers: (await import(pathToFileURL(path.join(IDX, "node_modules/ethers/lib.esm/index.js")).href)),
  };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

function list(raw) {
  return String(raw || "")
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^0x[0-9a-f]{40}$/.test(x));
}

function rpcFor(chainId) {
  const names = { 56: ["BSC_RPC_HTTP_56", "BSC_RPC_HTTP"], 97: ["BSC_RPC_HTTP_97"], 4663: ["ROBINHOOD_RPC_HTTP_4663", "ROBINHOOD_MAINNET_RPC_URL"], 46630: ["ROBINHOOD_RPC_HTTP_46630", "ROBINHOOD_TESTNET_RPC_URL"] }[chainId] || [];
  for (const n of names) if (process.env[n]) return process.env[n];
  return null;
}

async function readFileArg(source) {
  let raw;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`GET ${source}: ${res.status}`);
    raw = await res.json();
  } else {
    raw = JSON.parse(fs.readFileSync(source, "utf8"));
  }
  const file = raw?.kind === "mwz-evm-gen8-holder-batch" ? raw : raw?.leafFile ?? raw?.leaf_file ?? raw?.file ?? raw;
  if (file?.kind !== "mwz-evm-gen8-holder-batch") throw new Error("not a gen-8 holder batch leaf file");
  return file;
}

/** The Transaction Builder batch (same shape as scripts/make-safe-batch.ts writes). */
function safeBatch(ethers, chainId, name, description, calls) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: "1.16.5" },
    transactions: calls.map((c) => {
      const iface = new ethers.Interface([c.sig]);
      const fragment = iface.fragments[0];
      const data = iface.encodeFunctionData(fragment.name, c.args);
      const contractInputsValues = {};
      fragment.inputs.forEach((input, i) => {
        contractInputsValues[input.name] = String(c.args[i]);
      });
      return {
        to: ethers.getAddress(c.to),
        value: "0",
        data,
        contractMethod: { inputs: fragment.inputs.map((i) => ({ internalType: i.type, name: i.name, type: i.type })), name: fragment.name, payable: false },
        contractInputsValues,
      };
    }),
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const chainId = Number(a.chain);
  if (!a.file || !chainId) throw new Error("usage: --chain <id> --file <path|url> --vault-block <n> [--rpc url] [--vault addr] [--tx hash] [--from-block n] [--risk-excluded list] [--side-pools list] [--week-secret hex] [--out file]");
  const L = await loadIndexer();
  const { ethers } = L;
  const file = await readFileArg(a.file);
  if (Number(file.chainId) !== chainId) throw new Error(`the file is for chain ${file.chainId}, not ${chainId}`);
  const rpc = a.rpc || rpcFor(chainId);
  if (!rpc) throw new Error("no RPC: pass --rpc or set the chain's RPC env");
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const net = Number((await provider.getNetwork()).chainId);
  if (net !== chainId) throw new Error(`RPC is chain ${net}, not ${chainId}`);

  const envVault = String(process.env[`EVM_GEN8_CHOICE_VAULT_${chainId}`] || "").trim();
  const [envAddr, envBlock] = envVault.split("@");
  const vault = ethers.getAddress(a.vault || envAddr || file.vault);
  if (envAddr && ethers.getAddress(envAddr) !== vault) throw new Error(`--vault ${vault} is not EVM_GEN8_CHOICE_VAULT_${chainId} ${envAddr}`);
  if (ethers.getAddress(file.vault) !== vault) throw new Error(`the file names vault ${file.vault}, not ${vault}`);
  const vaultBlock = Number(a["vault-block"] || envBlock || 0);
  if (!Number.isInteger(vaultBlock) || vaultBlock <= 0) throw new Error("--vault-block <the vault's deploy block> is required (CoinRegistered is scanned from it)");

  const g8 = new ethers.Contract(vault, L.gen8Chain.GEN8_WATCHDOG_VAULT_ABI, provider);
  const latest = await provider.getBlockNumber();
  // The proposal: the given transaction, or HolderBatchProposed for this batch id.
  const proposedTopic = g8.interface.getEvent("HolderBatchProposed").topicHash;
  let log = null;
  if (a.tx) {
    const rc = await provider.getTransactionReceipt(a.tx);
    log = rc?.logs.find((l) => ethers.getAddress(l.address) === vault && l.topics[0] === proposedTopic && l.topics[1].toLowerCase() === file.batchId.toLowerCase()) ?? null;
  } else {
    const from = Number(a["from-block"] || Math.max(vaultBlock, latest - 200_000));
    for (let start = from; start <= latest && !log; start += 5_000) {
      const logs = await provider.getLogs({ address: vault, topics: [proposedTopic, file.batchId], fromBlock: start, toBlock: Math.min(latest, start + 4_999) });
      log = logs[0] ?? null;
    }
  }
  if (!log) throw new Error(`no HolderBatchProposed for ${file.batchId} on ${vault} (pass --tx or --from-block)`);
  const ev = g8.interface.parseLog(log);
  const tx = await provider.getTransaction(log.transactionHash);
  const block = await provider.getBlock(log.blockNumber);
  const proposal = {
    chainId, vault, program: "airdrop_holders_gen8", batchId: String(ev.args.batchId).toLowerCase(), root: String(ev.args.root), total: BigInt(ev.args.total),
    executableAt: BigInt(ev.args.executableAt), claimDeadline: BigInt(ev.args.claimDeadline), blockNumber: log.blockNumber, blockTime: Number(block.timestamp),
    txHash: log.transactionHash, txTo: tx?.to ? ethers.getAddress(tx.to) : null, txData: tx?.data ?? "0x",
  };
  const state = await g8.holderBatches(proposal.batchId);
  if (Number(state.status) !== 1) throw new Error(`batch ${proposal.batchId} has status ${state.status} (1 proposed, 2 executed, 3 vetoed): nothing to approve`);
  if (state.approved) throw new Error(`batch ${proposal.batchId} is already approved`);

  // The same configuration the watchdog reads (env names), and the census exclusions.
  const wcfg = L.cfg.watchdogConfig(chainId, process.env);
  const risk = new Set(list(a["risk-excluded"]));
  let exclusions;
  const g8cfg = L.gen8Config.evmGen8Config(chainId, process.env).config;
  if (g8cfg) {
    exclusions = new Set(L.gen8Holders.gen8HolderExclusions(g8cfg).map((x) => x.wallet));
    console.log(`[verify] census exclusions from the gen-8 config (EVM_GEN8_*): ${exclusions.size}`);
  } else {
    const imm = new ethers.Contract(vault, ["function hook() view returns (address)", "function poolManager() view returns (address)", "function launcher() view returns (address)"], provider);
    exclusions = new Set([await imm.hook(), await imm.poolManager(), await imm.launcher(), vault].map((x) => x.toLowerCase()));
    if (L.sidePools.INFINITY_VAULT[chainId]) exclusions.add(L.sidePools.INFINITY_VAULT[chainId]);
    console.log("[verify] census exclusions from the vault's hook / poolManager / launcher only (EVM_GEN8_* not set): add the reserve lock, escrow and side pools with --exclusions / --side-pools");
  }
  for (const w of [...list(a["side-pools"]), ...list(a.exclusions)]) exclusions.add(w);
  const deps = L.gen8Chain.createEthersGen8WatchdogChain(provider, { logChunk: 5_000 }).verifyDeps({ vault, startBlock: vaultBlock, censusExclusions: async () => exclusions });
  const result = await L.gen8.verifyGen8HolderProposal(proposal, file, deps, {
    minPayoutWei: wcfg.minPayoutWei, claimWindowDays: wcfg.claimWindowDays, excluded: wcfg.excluded, riskExcluded: risk,
    masterSecret: wcfg.masterSecret, weekSecret: a["week-secret"] || null, maxExcludedBps: wcfg.maxExcludedBps,
    maxUnlistedExcludedBps: wcfg.maxUnlistedExcludedBps, checkToleranceSec: wcfg.gen8CheckToleranceSec,
  });
  if (!result.ok) {
    console.error(`[verify] REFUSED (${result.kind}): ${result.reasons.join("; ")}`);
    console.error("[verify] no Safe batch printed. Veto the batch (vetoHolderBatch) or find the difference first.");
    process.exitCode = 2;
    return;
  }
  for (const u of result.unlisted) console.log(`[verify] note: ${u.wallet} was left out at check ${u.index} of pool ${u.poolId} (${u.amount} tokens) and is on no current list (within the bound)`);
  console.log(`[verify] MATCH: week ${result.weekId}, ${result.pools} pool(s), ${result.leaves} leaves, total ${result.total} wei, root ${result.root}, claim deadline ${result.claimDeadline}`);

  // The Safe batch: the 4-arg approve; authorizeBatch only when no live authorization covers this id.
  const distAddr = ethers.getAddress(await g8.holderDistributor());
  const dist = new ethers.Contract(distAddr, ["function batchAuthorization(bytes32) view returns (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed)", "function batches(bytes32) view returns (bytes32 merkleRoot, uint256 totalFunded, uint256 totalClaimed, uint64 claimDeadline, bool paused, bool exists)"], provider);
  const auth = await dist.batchAuthorization(proposal.batchId);
  const exists = (await dist.batches(proposal.batchId)).exists;
  if (auth.consumed || exists) throw new Error(`the distributor's id ${proposal.batchId} is consumed or created already`);
  const executableAt = Number(proposal.executableAt);
  const live = auth.authorized && BigInt(auth.maxAmount) >= proposal.total && Number(auth.publishAfter) <= executableAt && Number(auth.publishDeadline) > executableAt + 3600;
  const calls = [
    { to: vault, sig: "function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline)", args: [proposal.batchId, result.root, result.total.toString(), result.claimDeadline.toString()] },
  ];
  if (!live) calls.push({ to: distAddr, sig: "function authorizeBatch(bytes32 batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline)", args: [proposal.batchId, proposal.total.toString(), String(executableAt), String(executableAt + 6 * 86_400)] });
  if (ethers.dataSlice(new ethers.Interface([calls[0].sig]).encodeFunctionData("approveHolderBatch", calls[0].args), 0, 4) !== "0xc62732bb") throw new Error("approve selector is not 0xc62732bb");
  const batch = safeBatch(ethers, chainId, `MWZ gen-8 holders ${result.weekId}`, `approveHolderBatch(${proposal.batchId}, root ${result.root}, ${result.total} wei, deadline ${result.claimDeadline}) on ${vault}${live ? "; the distributor id is already authorized" : `; authorizeBatch on ${distAddr} for ${proposal.total} wei, publishable from executableAt for 6 days`}. Verified with scripts/evm-gen8-holder-batch-verify.mjs.`, calls);
  const text = `${JSON.stringify(batch, null, 2)}\n`;
  if (a.out) {
    fs.writeFileSync(a.out, text);
    console.log(`[verify] Safe batch written to ${a.out} (${calls.length} call${calls.length === 1 ? "" : "s"})`);
  } else {
    process.stdout.write(text);
  }
}

// The verifier is TypeScript: re-run under tsx when plain node cannot load it.
async function entry() {
  try {
    await import(pathToFileURL(path.join(IDX, "src/evm/payoutWatchdogGen8.ts")).href);
  } catch (error) {
    if (error?.code !== "ERR_UNKNOWN_FILE_EXTENSION" || process.env.MWZ_GEN8_VERIFY_UNDER_TSX) throw error;
    const tsx = path.join(IDX, "node_modules/.bin/tsx");
    if (!fs.existsSync(tsx)) throw new Error("tsx not found: run npm ci in realtime-indexer first");
    const r = spawnSync(tsx, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, MWZ_GEN8_VERIFY_UNDER_TSX: "1" } });
    process.exit(r.status ?? 1);
  }
  await main();
}

entry().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
