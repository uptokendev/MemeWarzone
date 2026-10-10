#!/usr/bin/env node
// DogeOS Chikyu (6281971) TEST env blocks (plan t24, spec section 7 / gate 5).
//
//   node scripts/dogeos-env-blocks.mjs [deployments/dogeos/testnet.json] [--start-block N]
//
// Prints three paste-ready blocks (TEST frontend, TEST API, TEST indexer) from the deploy manifest
// (the dogeosManifestRecord shape, scripts/lib/dogeosGen7Stack.ts). The env names are the ones the
// DogeOS code reads (frontend/src/lib/chainConfig.ts, bnbContracts.ts, robinhoodV3Trade.ts,
// robinhoodNativeSwapAdapterEnv.mjs; frontend/api route-auth, rewards, lp-fees, evmGen7Fees;
// realtime-indexer env.ts, evmGen7Fees.ts, the graduation keeper and the oracle push).
//
// Keys: every *_PRIVATE_KEY value is the literal `<paste NAME from config/dogeos.local>`. This script
// reads only the manifest it is given and refuses config/dogeos.local or any .env file as input.
// VITE_ALLOWED_CHAIN_IDS / EVM_INDEXER_CHAIN_IDS are append instructions, never a full value.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DOGEOS_CHAIN_ID = 6281971;
export const DOGEOS_PUBLIC_RPC = "https://rpc.testnet.dogeos.com";
export const DEFAULT_MANIFEST = "deployments/dogeos/testnet.json";
export const START_BLOCK_PLACEHOLDER = "<START_BLOCK>";

/** MuchFi on Chikyu (plan global constraints). The manifest's dex section must match these exactly. */
const MUCHFI = Object.freeze({
  "dex.v3Factory": "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B",
  "dex.positionManager": "0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5",
  "dex.smartRouter": "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB",
  "dex.quoterV2": "0x5DE1Ea595653419f295511DEb781b98387a77cc2",
  "dex.weth": "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
});
const MUCHFI_FEE_TIER = 10000;

const KEY_SHAPE = /0x[0-9a-fA-F]{64}/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const keyPlaceholder = (localName) => `<paste ${localName} from config/dogeos.local>`;

function lookup(manifest, dotted) {
  return dotted.split(".").reduce((node, key) => (node == null ? undefined : node[key]), manifest);
}

function requireAddress(manifest, dotted) {
  const value = lookup(manifest, dotted);
  if (typeof value !== "string" || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`manifest ${dotted}: expected a non-zero address, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Optional address: null/undefined means "not deployed", anything else must be a valid address. */
function optionalAddress(manifest, ...candidates) {
  for (const dotted of candidates) {
    const value = lookup(manifest, dotted);
    if (value == null) continue;
    return requireAddress(manifest, dotted);
  }
  return null;
}

function requirePinned(manifest, dotted, pinned) {
  const value = requireAddress(manifest, dotted);
  if (value.toLowerCase() !== pinned.toLowerCase()) {
    throw new Error(`manifest ${dotted}: ${value} is not the pinned MuchFi address ${pinned}`);
  }
  return value;
}

function startBlockText(startBlock) {
  if (startBlock == null || startBlock === "") return START_BLOCK_PLACEHOLDER;
  const text = String(startBlock).trim();
  if (!/^\d+$/.test(text)) throw new Error(`--start-block: expected a block number, got ${JSON.stringify(startBlock)}`);
  return text;
}

/** Reads and validates everything the blocks need; throws on anything missing or off-pin. */
function readManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest: expected a JSON object");
  if (Number(manifest.chainId) !== DOGEOS_CHAIN_ID) {
    throw new Error(`manifest chainId ${JSON.stringify(manifest.chainId)}: expected ${DOGEOS_CHAIN_ID}`);
  }
  if (Number(lookup(manifest, "dex.feeTier")) !== MUCHFI_FEE_TIER) {
    throw new Error(`manifest dex.feeTier ${JSON.stringify(lookup(manifest, "dex.feeTier"))}: expected ${MUCHFI_FEE_TIER}`);
  }
  const dex = Object.fromEntries(Object.entries(MUCHFI).map(([dotted, pinned]) => [dotted.slice(4), requirePinned(manifest, dotted, pinned)]));
  return {
    dex,
    routeAuthority: requireAddress(manifest, "routeAuthority"),
    factory: requireAddress(manifest, "deployed.LaunchFactoryGen7"),
    campaignImplementation: requireAddress(manifest, "deployed.LaunchCampaignGen7Implementation"),
    positionLocker: requireAddress(manifest, "deployed.MuchfiV3PositionLocker"),
    nativeSwapAdapter: requireAddress(manifest, "nativeSwapAdapter"),
    dogeUsdOracle: requireAddress(manifest, "oracle.dogeUsd"),
    graduationOracle: requireAddress(manifest, "oracle.graduationOracle"),
    weeklyVault: requireAddress(manifest, "vaults.weekly"),
    recruiterVault: requireAddress(manifest, "vaults.recruiter"),
    protocolVault: requireAddress(manifest, "vaults.protocol"),
    // t36: DogeOS runs on the open creator rules; the manifest records registries.creatorRegistry: null
    // (the plan text calls it registries.creator, accepted too).
    creatorRegistry: optionalAddress(manifest, "registries.creatorRegistry", "registries.creator"),
    riskRegistry: requireAddress(manifest, "registries.riskRegistry"),
    feeRouter: requireAddress(manifest, "fees.router"),
    creatorVault: requireAddress(manifest, "fees.vault"),
    holderDistributor: requireAddress(manifest, "fees.holderDistributor"),
    communityVault: requireAddress(manifest, "fees.communityRewardsVault"),
    airdropDistributor: requireAddress(manifest, "fees.airdropDistributor"),
  };
}

function block() {
  const lines = [];
  return {
    lines,
    set: (name, value) => lines.push(`${name}=${value}`),
    note: (...text) => text.forEach((t) => lines.push(`# ${t}`)),
    blank: () => lines.push(""),
  };
}

function frontendBlock(m) {
  const b = block();
  b.note(
    "VITE_ALLOWED_CHAIN_IDS: append ,6281971 to the existing TEST value; do not overwrite it:",
    "  VITE_ALLOWED_CHAIN_IDS=<existing TEST value>,6281971",
    "Unchanged, expected on TEST already: VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY=true (DogeOS shares the gen-7",
    "V3 launch flag) and VITE_ENABLE_TEST_GRADUATION_THRESHOLD=true (the $150 test tier).",
  );
  b.set("VITE_PUBLIC_RPC_6281971", DOGEOS_PUBLIC_RPC);
  b.set("VITE_FACTORY_ADDRESS_6281971", m.factory);
  b.set("VITE_SUPPORTED_FACTORY_ADDRESSES_6281971", m.factory);
  b.set("VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_6281971", m.campaignImplementation);
  b.note("Launch readiness (frontend/src/lib/bnbContracts.ts) reads these per chain.");
  b.set("VITE_TREASURY_ROUTER_ADDRESS_6281971", m.feeRouter);
  b.set("VITE_TREASURY_VAULT_ADDRESS_6281971", m.weeklyVault);
  b.set("VITE_RECRUITER_REWARDS_VAULT_ADDRESS_6281971", m.recruiterVault);
  b.set("VITE_COMMUNITY_REWARDS_VAULT_ADDRESS_6281971", m.communityVault);
  b.set("VITE_PROTOCOL_REVENUE_VAULT_ADDRESS_6281971", m.protocolVault);
  if (m.creatorRegistry) {
    b.set("VITE_CREATOR_REGISTRY_ADDRESS_6281971", m.creatorRegistry);
  } else {
    b.note("No VITE_CREATOR_REGISTRY_ADDRESS_6281971: DogeOS has no creator registry (open creator rules).");
  }
  b.set("VITE_RISK_REGISTRY_ADDRESS_6281971", m.riskRegistry);
  b.set("VITE_GRADUATION_ORACLE_ADDRESS_6281971", m.graduationOracle);
  b.set("VITE_PERMANENT_LP_LOCKER_ADDRESS_6281971", m.positionLocker);
  b.note("No VITE_VOTE_TREASURY_ADDRESS_6281971: DogeOS has no vote treasury until sub-project 3.");
  b.note(
    "MuchFi (graduation venue). The V3 swap router is the MuchFi SmartRouter (the no-deadline shape the",
    "native swap adapter is built on), never the deadline SwapRouter.",
  );
  b.set("VITE_WRAPPED_NATIVE_ADDRESS_6281971", m.dex.weth);
  b.set("VITE_ROBINHOOD_V3_FACTORY_ADDRESS_6281971", m.dex.v3Factory);
  b.set("VITE_ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_6281971", m.dex.positionManager);
  b.set("VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971", m.dex.smartRouter);
  b.set("VITE_ROBINHOOD_V3_QUOTER_ADDRESS_6281971", m.dex.quoterV2);
  b.set("VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_6281971", m.nativeSwapAdapter);
  return b.lines;
}

function gen7FeeStack(b, m, start) {
  b.note("Gen-7 fees stack, \"address@startBlock\" (evmGen7Fees): creator vault events and creator claims.");
  b.set("EVM_GEN7_ROUTER_6281971", `${m.feeRouter}@${start}`);
  b.set("EVM_GEN7_CREATOR_VAULT_6281971", `${m.creatorVault}@${start}`);
  b.set("EVM_GEN7_HOLDER_DISTRIBUTOR_6281971", `${m.holderDistributor}@${start}`);
  b.set("EVM_GEN7_COMMUNITY_VAULT_6281971", m.communityVault);
}

function apiBlock(m, start) {
  const b = block();
  b.note("Unchanged, expected on TEST already: ENABLE_TEST_GRADUATION_THRESHOLD=true (the $150 test tier).");
  b.set("DOGEOS_RPC_HTTP_6281971", DOGEOS_PUBLIC_RPC);
  b.set("FACTORY_ADDRESS_6281971", m.factory);
  b.note("The create signer reads the VITE_ name first (frontend/api/dev-fix/route-auth.js), so set both.");
  b.set("VITE_FACTORY_ADDRESS_6281971", m.factory);
  b.note("Gen-7 airdrop RewardDistributor (reward claim verification).");
  b.set("REWARD_DISTRIBUTOR_ADDRESS_6281971", m.airdropDistributor);
  b.note("MuchFi V3 position locker (LP fee dashboard).");
  b.set("LP_LOCKER_ADDRESS_6281971", m.positionLocker);
  gen7FeeStack(b, m, start);
  b.note(
    "Route authority (spec section 1): this REPLACES the TEST API's global key with the DogeOS route-authority",
    `key (factory routeAuthority ${m.routeAuthority}). Creates on 97 and 46630 on TEST stay blocked, as today.`,
    "Check afterwards: GET /api/routing/status?chainId=6281971 -> signerConfigured true, matchesOnchain true.",
  );
  b.set("ROUTE_AUTHORITY_PRIVATE_KEY", keyPlaceholder("DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY"));
  return b.lines;
}

function indexerBlock(m, start) {
  const b = block();
  b.note(
    "EVM_INDEXER_CHAIN_IDS: append ,6281971 to the existing TEST value; do not overwrite it:",
    "  EVM_INDEXER_CHAIN_IDS=<existing TEST value>,6281971",
    "Unchanged, expected on TEST already: ENABLE_ROBINHOOD_V3_POOL_INDEXER=1 (it indexes the MuchFi pools",
    "for 6281971 too). The keeper only sends when the global EVM_GRADUATION_KEEPER_SEND=true (unchanged).",
  );
  b.set("DOGEOS_RPC_HTTP_6281971", DOGEOS_PUBLIC_RPC);
  b.set("FACTORY_ADDRESS_6281971", m.factory);
  b.set("FACTORY_START_BLOCK_6281971", start);
  b.set("SUPPORTED_FACTORY_ADDRESSES_6281971", m.factory);
  b.set("SUPPORTED_FACTORY_START_BLOCKS_6281971", start);
  b.note("MuchFi SmartRouter under the existing per-chain V3 router name (V3 pool indexer).");
  b.set("ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971", m.dex.smartRouter);
  gen7FeeStack(b, m, start);
  b.note(
    "Graduation keeper, TEST indexer only. Gas DOGE only, no contract role. Campaigns exist only after the",
    "founder's go (t29). Max gas defaults to 10,000,000 (Chikyu's block limit); env can only lower it.",
  );
  b.set("EVM_GRADUATION_KEEPER_ENABLED_6281971", "true");
  b.set("EVM_GRADUATION_KEEPER_PRIVATE_KEY_6281971", keyPlaceholder("DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY"));
  b.note("EVM_GRADUATION_KEEPER_MAX_GAS_6281971=10000000");
  b.set("EVM_KEEPER_V3_FACTORY_6281971", m.dex.v3Factory);
  b.set("EVM_KEEPER_WETH_6281971", m.dex.weth);
  b.set("EVM_KEEPER_V3_FEE_6281971", String(MUCHFI_FEE_TIER));
  b.note(
    "DOGE/USD oracle push, TEST indexer only. DOGEOS_ORACLE_PUSH_ENABLED stays false until the founder's go",
    "(t29): the push sends real transactions with the updater key. Interval and deviation are optional.",
  );
  b.set("DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971", m.dogeUsdOracle);
  b.set("DOGEOS_ORACLE_PUSH_ENABLED", "false");
  b.set("DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY", keyPlaceholder("DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY"));
  b.note("DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS=1800");
  b.note("DOGEOS_ORACLE_PUSH_DEVIATION_BPS=100");
  return b.lines;
}

/** Pure: the three TEST blocks as one paste-ready text. Throws on a bad manifest; never emits a key. */
export function renderDogeosEnvBlocks(manifest, { manifestPath = DEFAULT_MANIFEST, startBlock } = {}) {
  const m = readManifest(manifest);
  const start = startBlockText(startBlock);
  const header = [
    "# DogeOS Chikyu testnet (6281971): TEST env blocks",
    `# Generated by scripts/dogeos-env-blocks.mjs from ${manifestPath}.`,
    "# TEST ONLY. Never paste any of this into a production service (api.memewar.zone, indexer.memewar.zone,",
    "# the live frontend) or production Supabase.",
    "# Paste each block into its TEST Coolify service:",
    "#   API       \"Backend API Dev\"        jkq5rjveklrueuuuputnpj6o",
    "#   Indexer   \"realtime-indexer Dev\"   s75mnp6dfpjtv8m8fcefxlay",
    "#   Frontend  \"Frontend Dev\"           4kdlgixhrtsorbqn6wi7kmr0   (rebuild after: Vite bakes VITE_* at build time)",
    "# Order: indexer, then API, then frontend (rebuild).",
    "# Keys: every *_PRIVATE_KEY value below is a placeholder. Paste the real value from config/dogeos.local",
    "# straight into Coolify. This script never reads config/dogeos.local or any .env file.",
    "# The contracts stay paused (createPaused, live=false) until the founder's go (t29); nothing here enables them.",
  ];
  if (start === START_BLOCK_PLACEHOLDER) {
    header.push(`# ${START_BLOCK_PLACEHOLDER}: the LaunchFactoryGen7 deploy block (L2Scan). Re-run with --start-block N to fill it.`);
  }
  const sections = [
    header,
    ["# ===== TEST frontend: \"Frontend Dev\" (4kdlgixhrtsorbqn6wi7kmr0), build-time VITE_*, rebuild after =====", ...frontendBlock(m)],
    ["# ===== TEST API: \"Backend API Dev\" (jkq5rjveklrueuuuputnpj6o), runtime =====", ...apiBlock(m, start)],
    ["# ===== TEST indexer: \"realtime-indexer Dev\" (s75mnp6dfpjtv8m8fcefxlay), runtime =====", ...indexerBlock(m, start)],
  ];
  const text = `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
  if (KEY_SHAPE.test(text)) throw new Error("refusing to print: the output contains a private-key-shaped value");
  return text;
}

/** Inputs this script must never read: key files and env files. */
function isForbiddenInput(file) {
  const base = path.basename(String(file).replace(/\\/g, "/"));
  return /\.local$/i.test(base) || /^\.env/i.test(base);
}

function parseArgs(argv) {
  const out = { manifestPath: DEFAULT_MANIFEST, startBlock: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--start-block") {
      out.startBlock = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--start-block=")) {
      out.startBlock = arg.slice("--start-block=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error("expected at most one manifest path");
  if (positional.length === 1) out.manifestPath = positional[0];
  return out;
}

/** CLI entry. Returns the exit code; I/O goes only through `deps` (fs defaults to node:fs). */
export function main(argv = process.argv.slice(2), deps = {}) {
  const fsImpl = deps.fs ?? fs;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const { manifestPath, startBlock } = parseArgs(argv);
    if (isForbiddenInput(manifestPath)) {
      throw new Error(`refusing to read ${manifestPath}: keys and .env files are never inputs; pass the deploy manifest`);
    }
    const manifest = JSON.parse(String(fsImpl.readFileSync(manifestPath, "utf8")));
    stdout.write(renderDogeosEnvBlocks(manifest, { manifestPath, startBlock }));
    return 0;
  } catch (error) {
    stderr.write(`dogeos-env-blocks: ${error?.message || error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
