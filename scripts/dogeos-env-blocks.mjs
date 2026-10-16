#!/usr/bin/env node
// DogeOS Chikyu (6281971) TEST env blocks for the Bark stack (barkswap plan t16; spec section 4 "Indexer", "Keepers",
// B9; section 5 "Deployment 2").
//
//   node scripts/dogeos-env-blocks.mjs [deployments/dogeos/testnet.bark.json]
//
// Prints three paste-ready blocks (TEST frontend, TEST API, TEST indexer) from the Bark deploy manifest (kind
// dogeos-testnet-bark, the dogeosBarkManifestRecord shape in scripts/lib/dogeosBarkStack.ts). The env names are the
// gen-8 ones with the Barkswap venue, exactly as the readers take them: frontend/api/lib/evmGen8Config.js
// (evmGen8ApiConfig), realtime-indexer/src/evm/evmGen8Config.ts (evmGen8BarkConfig) and the app's VITE_EVM_GEN8_*
// (frontend/src/lib/evmGen8Client.mjs); plus the DogeOS RPC, the reused vaults, the oracle push,
// DOGEOS_OPERATOR_ADDRESS (the keeper guards refuse that address as a keeper key, B9) and the DogeOS keepers
// (realtime-indexer/src/evm/dogeosBarkKeepers.ts, plan t20), every lane printed off.
//
// Keys: every key value (*_PRIVATE_KEY, EVM_GEN8_OPERATOR_KEY_6281971) is the literal `<paste NAME from
// config/dogeos.local>`. This script reads only the manifest it is given and refuses config/dogeos.local or any .env
// file as input. The operator's address appears only as DOGEOS_OPERATOR_ADDRESS. VITE_ALLOWED_CHAIN_IDS is an append
// instruction, never a full value.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BARKSWAP_EXTERNAL_ADDRESSES, DOGEOS_BARK_MANIFEST_KIND, DOGEOS_MANIFEST_PATH } from "./lib/dogeosTestnetDeployGuards.mjs";

export const DOGEOS_CHAIN_ID = 6281971;
export const DOGEOS_PUBLIC_RPC = "https://rpc.testnet.dogeos.com";
export const DEFAULT_MANIFEST = DOGEOS_MANIFEST_PATH;
export { DOGEOS_BARK_MANIFEST_KIND };
/** Spec section 4: the money head on Chikyu is 20 blocks below `latest` (evmGen8Config.ts GEN8_MONEY_DEPTH). */
const MONEY_DEPTH_BLOCKS = 20;

/**
 * Every Barkswap address the stack depends on must be the pinned one: the periphery the app trades through (its defaults
 * in frontend/src/lib/barkswapSwap.mjs), the entry point and pool deployer our launcher uses, and the factory the
 * DogeOS side-pool watch reads (realtime-indexer/src/evm/evmGen8SidePools.ts DOGEOS_SIDE_FACTORIES).
 */
const PINNED_BARKSWAP = Object.keys(BARKSWAP_EXTERNAL_ADDRESSES);

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

function requireStartBlock(manifest) {
  const value = manifest.startBlock;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`manifest startBlock: expected the deploy's first block (a positive integer), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Reads and validates everything the blocks need; throws on anything missing, off-pin or mis-assigned. */
function readManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest: expected a JSON object");
  if (manifest.kind !== DOGEOS_BARK_MANIFEST_KIND) {
    throw new Error(`manifest kind ${JSON.stringify(manifest.kind)}: expected ${DOGEOS_BARK_MANIFEST_KIND} (deployments/dogeos/testnet.bark.json)`);
  }
  if (Number(manifest.chainId) !== DOGEOS_CHAIN_ID) {
    throw new Error(`manifest chainId ${JSON.stringify(manifest.chainId)}: expected ${DOGEOS_CHAIN_ID}`);
  }
  for (const key of PINNED_BARKSWAP) {
    const value = requireAddress(manifest, `barkswap.${key}`);
    if (value.toLowerCase() !== BARKSWAP_EXTERNAL_ADDRESSES[key].toLowerCase()) {
      throw new Error(`manifest barkswap.${key}: ${value} is not the pinned Barkswap address ${BARKSWAP_EXTERNAL_ADDRESSES[key]}`);
    }
  }
  // B9: the operator is a key of its own. The deploy already refuses otherwise; a hand-edited manifest must not slip by.
  const operator = requireAddress(manifest, "operator");
  for (const role of ["deployer", "admin", "routeAuthority", "oracle.updater"]) {
    const other = requireAddress(manifest, role);
    if (other.toLowerCase() === operator.toLowerCase()) {
      throw new Error(`manifest operator ${operator} is the ${role}; the DogeOS operator must be its own key (spec B9)`);
    }
  }
  return {
    startBlock: requireStartBlock(manifest),
    operator,
    launcher: requireAddress(manifest, "deployed.MwzBarkLauncher"),
    plugin: requireAddress(manifest, "deployed.MwzBarkPlugin"),
    lens: requireAddress(manifest, "deployed.MwzBarkLaunchLens"),
    splitter: requireAddress(manifest, "deployed.MwzBarkFeeSplitter"),
    choiceVault: requireAddress(manifest, "deployed.MwzBarkCreatorChoiceVault"),
    reserveLock: requireAddress(manifest, "deployed.MwzBarkReserveLock"),
    escrow: requireAddress(manifest, "deployed.MwzBarkCreatorEscrow"),
    dogeUsdOracle: requireAddress(manifest, "oracle.dogeUsd"),
    graduationOracle: requireAddress(manifest, "oracle.graduationOracle"),
    weeklyVault: requireAddress(manifest, "vaults.weekly"),
    recruiterVault: requireAddress(manifest, "vaults.recruiter"),
    protocolVault: requireAddress(manifest, "vaults.protocol"),
    communityVault: requireAddress(manifest, "vaults.community"),
    airdropDistributor: requireAddress(manifest, "vaults.airdropDistributor"),
  };
}

function block() {
  const lines = [];
  return {
    lines,
    set: (name, value) => lines.push(`${name}=${value}`),
    note: (...text) => text.forEach((t) => lines.push(`# ${t}`)),
  };
}

function frontendBlock(m) {
  const b = block();
  b.note(
    "VITE_ALLOWED_CHAIN_IDS: append ,6281971 to the existing TEST value; do not overwrite it:",
    "  VITE_ALLOWED_CHAIN_IDS=<existing TEST value>,6281971",
    "Unchanged, expected on TEST already: VITE_ENABLE_TEST_GRADUATION_THRESHOLD=true (the $150 test tier).",
  );
  b.set("VITE_PUBLIC_RPC_6281971", DOGEOS_PUBLIC_RPC);
  b.note(
    "Gen-8 on the Barkswap venue (frontend/src/lib/evmGen8Client.mjs): launcher and plugin are both required. Barkswap's",
    "SwapRouter, QuoterV2 and WDOGE are the app's defaults (no override set here).",
  );
  b.set("VITE_EVM_GEN8_LAUNCHER_6281971", m.launcher);
  b.set("VITE_EVM_GEN8_PLUGIN_6281971", m.plugin);
  b.set("VITE_EVM_GEN8_LENS_6281971", m.lens);
  b.set("VITE_EVM_GEN8_ESCROW_6281971", m.escrow);
  b.set("VITE_EVM_GEN8_CHOICE_VAULT_6281971", m.choiceVault);
  b.set("VITE_EVM_GEN8_RESERVE_LOCK_6281971", m.reserveLock);
  b.note("Reused vaults and the graduation oracle (treasury display, deployment status).");
  b.set("VITE_TREASURY_VAULT_ADDRESS_6281971", m.weeklyVault);
  b.set("VITE_RECRUITER_REWARDS_VAULT_ADDRESS_6281971", m.recruiterVault);
  b.set("VITE_COMMUNITY_REWARDS_VAULT_ADDRESS_6281971", m.communityVault);
  b.set("VITE_PROTOCOL_REVENUE_VAULT_ADDRESS_6281971", m.protocolVault);
  b.set("VITE_GRADUATION_ORACLE_ADDRESS_6281971", m.graduationOracle);
  return b.lines;
}

/** The gen-8 Barkswap names both services read, "0xaddr@startBlock" where the indexer scans from it. */
function gen8BarkNames(b, m, { lens }) {
  const start = m.startBlock;
  b.set("EVM_GEN8_LAUNCHER_6281971", `${m.launcher}@${start}`);
  b.set("EVM_GEN8_PLUGIN_6281971", `${m.plugin}@${start}`);
  if (lens) b.set("EVM_GEN8_LENS_6281971", m.lens);
  b.set("EVM_GEN8_SPLITTER_6281971", `${m.splitter}@${start}`);
  b.set("EVM_GEN8_CHOICE_VAULT_6281971", m.choiceVault);
  b.set("EVM_GEN8_RESERVE_LOCK_6281971", m.reserveLock);
  b.set("EVM_GEN8_ESCROW_6281971", m.escrow);
}

function apiBlock(m) {
  const b = block();
  b.note("Unchanged, expected on TEST already: ENABLE_TEST_GRADUATION_THRESHOLD=true (the $150 test tier).");
  b.set("DOGEOS_RPC_HTTP_6281971", DOGEOS_PUBLIC_RPC);
  b.note(
    "Gen-8 on the Barkswap venue (frontend/api/lib/evmGen8Config.js): inert until launcher and plugin are both set.",
    "No Uniswap V4 setting on this chain: one disables the Barkswap config.",
  );
  gen8BarkNames(b, m, { lens: true });
  b.note("Airdrop RewardDistributor (reward claim verification).");
  b.set("REWARD_DISTRIBUTOR_ADDRESS_6281971", m.airdropDistributor);
  b.note(
    "Create signer (spec B9): the DogeOS route-authority key, read as the TEST API's global route key. On 6281971 the",
    "gen-8 create signer ignores the gen-8 signer key name, so this REPLACES the TEST API's global key. Creates on 97",
    "and 46630 on TEST stay blocked, as today.",
    "Check afterwards: GET /api/routing/status?chainId=6281971 -> signerConfigured true, matchesOnchain true.",
  );
  b.set("ROUTE_AUTHORITY_PRIVATE_KEY", keyPlaceholder("DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY"));
  return b.lines;
}

function indexerBlock(m) {
  const b = block();
  b.set("DOGEOS_RPC_HTTP_6281971", DOGEOS_PUBLIC_RPC);
  b.note(
    "Gen-8 on the Barkswap venue (realtime-indexer/src/evm/evmGen8Config.ts evmGen8BarkConfig): trades from the launcher",
    "and the plugin, scanned from the deploy's first block. Inert until launcher and plugin are both set.",
  );
  gen8BarkNames(b, m, { lens: true });
  b.note(`Money head: ${MONEY_DEPTH_BLOCKS} blocks below latest by default; the env is clamped to 17 (Chikyu's max reorg) or more.`);
  b.note(`EVM_GEN8_MONEY_DEPTH_6281971=${MONEY_DEPTH_BLOCKS}`);
  b.note(
    "The DogeOS operator's PUBLIC address (spec B9: splitter, router-claim and choice-vault operator). The keeper",
    "guards refuse it as a keeper key, and the operator key below must be this address's key.",
  );
  b.set("DOGEOS_OPERATOR_ADDRESS", m.operator);
  b.note(
    "DogeOS keepers (realtime-indexer/src/evm/dogeosBarkKeepers.ts; spec section 4 Keepers, B9). Every lane stays false",
    "and the keepers dry-run (simulate and log, nothing signed) until DOGEOS_BARK_SEND_6281971=true; each switch needs",
    "the founder's go. Keeper key: collect / convert / pull, graduation-fee fallback, reserve release, admin-change",
    "watch + restore. Operator key: route worker (claimRouter, splitter route) and choice-vault buyback. The side-pool",
    "watch only reads. The buyback lane also needs EVM_BUYBACK_SEED_SECRET (shared, set where the creator-choice",
    "operator runs).",
  );
  b.set("DOGEOS_BARK_COLLECT_ENABLED_6281971", "false");
  b.set("DOGEOS_BARK_GRAD_FEE_ENABLED_6281971", "false");
  b.set("DOGEOS_BARK_RESERVE_ENABLED_6281971", "false");
  b.set("DOGEOS_BARK_ADMIN_WATCH_ENABLED_6281971", "false");
  b.set("DOGEOS_BARK_SIDE_POOLS_ENABLED_6281971", "false");
  b.set("DOGEOS_BARK_ROUTE_ENABLED_6281971", "false");
  b.set("EVM_CREATOR_CHOICE_ENABLED_6281971", "false");
  b.set("DOGEOS_BARK_SEND_6281971", "false");
  b.note("Keeper key: holds no contract role; refused if it is the operator, a deployer, the updater or the route authority.");
  b.set("DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971", keyPlaceholder("DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY"));
  b.note("Operator key: refused unless it is DOGEOS_OPERATOR_ADDRESS's key (never the keeper's).");
  b.set("EVM_GEN8_OPERATOR_KEY_6281971", keyPlaceholder("DOGEOS_TESTNET_OPERATOR_PRIVATE_KEY"));
  b.note(
    "DOGE/USD oracle push, TEST indexer only. DOGEOS_ORACLE_PUSH_ENABLED stays false until the founder's go:",
    "the push sends real transactions with the updater key. Interval and deviation are optional.",
  );
  b.set("DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971", m.dogeUsdOracle);
  b.set("DOGEOS_ORACLE_PUSH_ENABLED", "false");
  b.set("DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY", keyPlaceholder("DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY"));
  b.note("DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS=1800");
  b.note("DOGEOS_ORACLE_PUSH_DEVIATION_BPS=100");
  return b.lines;
}

/** Pure: the three TEST blocks as one paste-ready text. Throws on a bad manifest; never emits a key. */
export function renderDogeosEnvBlocks(manifest, { manifestPath = DEFAULT_MANIFEST } = {}) {
  const m = readManifest(manifest);
  const header = [
    "# DogeOS Chikyu testnet (6281971): TEST env blocks for the Bark stack (gen-8 on Barkswap custom pools)",
    `# Generated by scripts/dogeos-env-blocks.mjs from ${manifestPath} (start block ${m.startBlock}).`,
    "# TEST ONLY. Never paste any of this into a production service (api.memewar.zone, indexer.memewar.zone,",
    "# the live frontend) or production Supabase.",
    "# Paste each block into its TEST Coolify service:",
    "#   API       \"Backend API Dev\"        jkq5rjveklrueuuuputnpj6o",
    "#   Indexer   \"realtime-indexer Dev\"   s75mnp6dfpjtv8m8fcefxlay",
    "#   Frontend  \"Frontend Dev\"           4kdlgixhrtsorbqn6wi7kmr0   (rebuild after: Vite bakes VITE_* at build time)",
    "# Order: indexer, then API, then frontend (rebuild).",
    "# Keys: every *_PRIVATE_KEY value below is a placeholder. Paste the real value from config/dogeos.local",
    "# straight into Coolify. This script never reads config/dogeos.local or any .env file.",
    "# The launcher stays createPaused until activation with the founder's go; nothing here opens it.",
  ];
  const sections = [
    header,
    ["# ===== TEST frontend: \"Frontend Dev\" (4kdlgixhrtsorbqn6wi7kmr0), build-time VITE_*, rebuild after =====", ...frontendBlock(m)],
    ["# ===== TEST API: \"Backend API Dev\" (jkq5rjveklrueuuuputnpj6o), runtime =====", ...apiBlock(m)],
    ["# ===== TEST indexer: \"realtime-indexer Dev\" (s75mnp6dfpjtv8m8fcefxlay), runtime =====", ...indexerBlock(m)],
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
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new Error("expected at most one manifest path");
  return { manifestPath: positional[0] ?? DEFAULT_MANIFEST };
}

/** CLI entry. Returns the exit code; I/O goes only through `deps` (fs defaults to node:fs). */
export function main(argv = process.argv.slice(2), deps = {}) {
  const fsImpl = deps.fs ?? fs;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const { manifestPath } = parseArgs(argv);
    if (isForbiddenInput(manifestPath)) {
      throw new Error(`refusing to read ${manifestPath}: keys and .env files are never inputs; pass the deploy manifest`);
    }
    const manifest = JSON.parse(String(fsImpl.readFileSync(manifestPath, "utf8")));
    stdout.write(renderDogeosEnvBlocks(manifest, { manifestPath }));
    return 0;
  } catch (error) {
    stderr.write(`dogeos-env-blocks: ${error?.message || error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
