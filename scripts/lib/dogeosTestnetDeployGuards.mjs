// DogeOS Chikyū testnet (6281971): the broadcast guards and pure helpers behind
// scripts/deploy-dogeos-testnet.ts, scripts/verify-dogeos-testnet.ts and scripts/activate-dogeos-testnet.ts (plan t8,
// spec §1 "Deploy outputs", gate 4).
//
// Pure functions only (no provider, no hardhat, no key), so every refusal path is tested without a network by
// scripts/dogeos-testnet-deploy-guards.test.mjs. The TypeScript entrypoints do the chain reads and the sends and
// pass plain values in here. Broadcast-token pattern: scripts/robinhoodTestnetInfrastructureAuthority.mjs.
//
// Two modes:
//   "chikyu"       network dogeosTestnet, chain 6281971. Strict: the signer must be the DogeOS deployer 0x6c5C…82f8 and
//                  the route authority the pinned DogeOS route authority 0x4fcD…76FF.
//   "chikyu-fork"  the in-process hardhat network forking Chikyū (hardhat.dogeos-testnet-fork.config.ts, chain 6281971),
//                  which cannot broadcast to Chikyū. The fork's own first signer is the deployer (admin), and the route
//                  authority is any valid address that collides with none of the DogeOS keys or the signer.
// Both modes need the broadcast token (deploy: DOGEOS_TESTNET_DEPLOY_BROADCAST, activate: DOGEOS_TESTNET_ACTIVATE_BROADCAST).
//
// Keys: nothing here reads a key or config/*.local. The route authority is a public address parameter
// (DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS), never derived from a key.
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";

export const DOGEOS_TESTNET_CHAIN_ID = 6281971;
export const DOGEOS_TESTNET_NETWORK_NAME = "dogeosTestnet";
export const DOGEOS_DEPLOY_BROADCAST_ENV = "DOGEOS_TESTNET_DEPLOY_BROADCAST";
export const DOGEOS_ACTIVATE_BROADCAST_ENV = "DOGEOS_TESTNET_ACTIVATE_BROADCAST";
export const DOGEOS_DEPLOY_BROADCAST_TOKEN = "I_HAVE_FOUNDER_GO";
export const DOGEOS_ROUTE_AUTHORITY_ENV = "DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS";
/** The DogeOS route authority (spec §1 Route authority): the only one accepted on Chikyū itself. */
export const DOGEOS_TESTNET_ROUTE_AUTHORITY = "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF";
/** Fork-only: where a fork deploy writes / a fork activate reads its manifest. Refused on Chikyū itself. */
export const DOGEOS_MANIFEST_OVERRIDE_ENV = "DOGEOS_TESTNET_MANIFEST";
export const DOGEOS_MANIFEST_PATH = "deployments/dogeos/testnet.json";
export const DOGEOS_VERIFICATION_PATH = "config/verification/dogeos-testnet-contracts.json";
export const DOGEOS_L2SCAN_API_URL = "https://dogeos-testnet.l2scan.co/api";
export const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price";
/** The 46630 gen-7 testnet record whose airdrop-pot cap the DogeOS pot mirrors, re-priced ETH -> DOGE. */
export const DOGEOS_AIRDROP_CAP_REFERENCE = "deployments/robinhood/testnet.gen7.json";

/** The three DogeOS keys (plan global constraints). The route authority must be none of them. */
export const DOGEOS_TESTNET_ROLES = Object.freeze({
  deployer: "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8",
  oracleUpdater: "0x7dBDFe829309B4170346CF7e4496094CD126E9c1",
  graduationKeeper: "0xb07B9E70D1759Fc42103458039AaE2413026B078",
});

/**
 * MuchFi and WDOGE on Chikyū: external, used by our contracts, never verified by us. Must equal MUCHFI_ADDRESSES in
 * scripts/lib/dogeosGen7Stack.ts (a test reads both).
 */
export const MUCHFI_EXTERNAL_ADDRESSES = Object.freeze({
  factory: "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B",
  poolDeployer: "0x6c04e808d5FfFb597cb6a5b539f2a1dDF3529348",
  positionManager: "0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5",
  smartRouter: "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB",
  swapRouterWithDeadline: "0xd34FE9553CE3012F81c8a7D86F3063AcADb8201c",
  quoterV2: "0x5DE1Ea595653419f295511DEb781b98387a77cc2",
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
});

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MODES = new Set(["chikyu", "chikyu-fork"]);

function checksum(value) {
  const text = String(value ?? "").trim();
  if (!ADDRESS_RE.test(text)) return null;
  try {
    return getAddress(text);
  } catch {
    return null; // mixed case with a bad checksum
  }
}

function requireRecordAddress(label, value) {
  const a = checksum(value);
  if (!a || a === ZERO) throw new Error(`${label} is missing or not a non-zero address (${value})`);
  return a;
}

function requireMode(mode) {
  if (!MODES.has(mode)) throw new Error(`unknown deploy mode ${mode} (expected chikyu or chikyu-fork)`);
  return mode;
}

// ---------------------------------------------------------------------------------------------------- guards

/**
 * Chikyū itself (network dogeosTestnet, chain 6281971) or the in-process hardhat network forking Chikyū
 * (hardhat.dogeos-testnet-fork.config.ts, which reports 6281971). Nothing else: there is no 31337 path, the t6
 * library and the DOGE/USD oracle are 6281971-only.
 */
export function assertDogeosTarget({ chainId, networkName, forkUrl }) {
  const id = Number(chainId);
  if (id === DOGEOS_TESTNET_CHAIN_ID && networkName === DOGEOS_TESTNET_NETWORK_NAME) return { mode: "chikyu" };
  if (id === DOGEOS_TESTNET_CHAIN_ID && networkName === "hardhat" && String(forkUrl || "").trim()) return { mode: "chikyu-fork" };
  throw new Error(
    `refusing: network ${networkName} / chain ${chainId} is neither ${DOGEOS_TESTNET_NETWORK_NAME} on ${DOGEOS_TESTNET_CHAIN_ID} ` +
      `nor the hardhat fork of Chikyū (hardhat.dogeos-testnet-fork.config.ts, chain ${DOGEOS_TESTNET_CHAIN_ID})`,
  );
}

/** The exact founder-go token under the deploy or the activate variable (each script reads only its own). */
export function assertBroadcastToken(value, envName = DOGEOS_DEPLOY_BROADCAST_ENV) {
  if (envName !== DOGEOS_DEPLOY_BROADCAST_ENV && envName !== DOGEOS_ACTIVATE_BROADCAST_ENV) {
    throw new Error(`unknown broadcast variable ${envName}`);
  }
  if (value !== DOGEOS_DEPLOY_BROADCAST_TOKEN) {
    throw new Error(`refusing to send: set ${envName}=${DOGEOS_DEPLOY_BROADCAST_TOKEN} (only with the founder's explicit go)`);
  }
  return true;
}

export function assertDeployerSigner(signer) {
  const a = checksum(signer);
  if (a !== DOGEOS_TESTNET_ROLES.deployer) {
    throw new Error(`refusing: signer ${signer} is not the DogeOS deployer ${DOGEOS_TESTNET_ROLES.deployer}`);
  }
  return a;
}

/** Chikyū: the pinned DogeOS deployer. Fork: the fork's own first signer, any non-zero address. */
function assertModeSigner(mode, signer) {
  if (requireMode(mode) === "chikyu") return assertDeployerSigner(signer);
  const a = checksum(signer);
  if (!a || a === ZERO) throw new Error(`refusing: fork signer ${signer} is not a non-zero address`);
  return a;
}

/**
 * The public route-authority address: present, valid, non-zero, none of the three DogeOS keys and not the signer.
 * On Chikyū it must also be the pinned DOGEOS_TESTNET_ROUTE_AUTHORITY; the fork keeps the looser rule.
 */
export function resolveRouteAuthority(value, { mode, signer } = {}) {
  requireMode(mode);
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`refusing: ${DOGEOS_ROUTE_AUTHORITY_ENV} is missing`);
  const a = checksum(text);
  if (!a) throw new Error(`refusing: ${DOGEOS_ROUTE_AUTHORITY_ENV} ${text} is not a valid address`);
  if (a === ZERO) throw new Error(`refusing: ${DOGEOS_ROUTE_AUTHORITY_ENV} is the zero address`);
  const roles = [
    [DOGEOS_TESTNET_ROLES.deployer, "the deployer"],
    [DOGEOS_TESTNET_ROLES.oracleUpdater, "the oracle updater"],
    [DOGEOS_TESTNET_ROLES.graduationKeeper, "the graduation keeper"],
  ];
  if (signer) roles.push([checksum(signer), "the signer"]);
  for (const [role, label] of roles) {
    if (a === role) throw new Error(`refusing: ${DOGEOS_ROUTE_AUTHORITY_ENV} ${a} is ${label}; the route authority must be its own key`);
  }
  if (mode === "chikyu" && a !== DOGEOS_TESTNET_ROUTE_AUTHORITY) {
    throw new Error(`refusing: ${DOGEOS_ROUTE_AUTHORITY_ENV} ${a} is not the DogeOS route authority ${DOGEOS_TESTNET_ROUTE_AUTHORITY}`);
  }
  return a;
}

/**
 * Order: network, broadcast token, signer, route authority, no earlier output. existingOutputs lists the output files
 * (manifest, verification JSON) that already exist; any one of them refuses the run.
 */
export function assertDeployGuards({ chainId, networkName, forkUrl, broadcastToken, signer, routeAuthority, existingOutputs }) {
  const { mode } = assertDogeosTarget({ chainId, networkName, forkUrl });
  assertBroadcastToken(broadcastToken, DOGEOS_DEPLOY_BROADCAST_ENV);
  const s = assertModeSigner(mode, signer);
  const ra = resolveRouteAuthority(routeAuthority, { mode, signer: s });
  if (!Array.isArray(existingOutputs)) throw new Error("existingOutputs must list the output files that already exist");
  if (existingOutputs.length) {
    throw new Error(`refusing: output(s) already exist: ${existingOutputs.join(", ")}; refusing to deploy a second stack over them`);
  }
  return { mode, signer: s, routeAuthority: ra };
}

/** Activate: the same network, signer and route-authority guards as deploy, under DOGEOS_TESTNET_ACTIVATE_BROADCAST. */
export function assertActivateGuards({ chainId, networkName, forkUrl, broadcastToken, signer, routeAuthority }) {
  const { mode } = assertDogeosTarget({ chainId, networkName, forkUrl });
  assertBroadcastToken(broadcastToken, DOGEOS_ACTIVATE_BROADCAST_ENV);
  const s = assertModeSigner(mode, signer);
  const ra = resolveRouteAuthority(routeAuthority, { mode, signer: s });
  return { mode, signer: s, routeAuthority: ra };
}

// ---------------------------------------------------------------------------------------------------- price

/** Binance /api/v3/ticker/price body -> USD price with 8 decimals (extra digits truncated). Refuses <= 0. */
export function parseBinanceUsd8(body, symbol) {
  if (!body || typeof body !== "object") throw new Error(`Binance ${symbol}: no ticker body`);
  if (body.symbol !== symbol) throw new Error(`Binance ${symbol}: ticker symbol is ${body.symbol}`);
  const price = body.price;
  if (typeof price !== "string" || !/^\d+(\.\d+)?$/.test(price)) throw new Error(`Binance ${symbol}: malformed price ${String(price)}`);
  const [whole, frac = ""] = price.split(".");
  const value = BigInt(whole) * 10n ** 8n + BigInt((frac + "00000000").slice(0, 8));
  if (value <= 0n) throw new Error(`Binance ${symbol}: price ${price} must be > 0 at 8 decimals`);
  return value;
}

/** Fetches the spot price at run time. fetchImpl is the WHATWG fetch (injected so tests never reach Binance). */
export async function fetchBinanceUsd8(symbol, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error(`Binance ${symbol}: no fetch implementation`);
  const url = `${BINANCE_TICKER_URL}?symbol=${symbol}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`Binance ${symbol}: request failed: ${error?.message || error}`);
  }
  if (!response.ok) throw new Error(`Binance ${symbol}: HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Binance ${symbol}: response is not JSON: ${error?.message || error}`);
  }
  return parseBinanceUsd8(body, symbol);
}

/** amount * fromUsd / toUsd (both prices at the same decimals), the same math as rescaleNativeCaps. */
export function rescaleNative(amount, fromUsd8, toUsd8) {
  if (BigInt(fromUsd8) <= 0n || BigInt(toUsd8) <= 0n) throw new Error("rescaleNative: both USD prices must be positive");
  return (BigInt(amount) * BigInt(fromUsd8)) / BigInt(toUsd8);
}

/**
 * The DogeOS airdrop-pot cap: the 46630 gen-7 testnet pot's cap (wei of ETH, read from its record at run time)
 * re-priced to DOGE at the run's Binance prices, the same way the creator-vault caps are re-scaled.
 */
export function dogeosAirdropCapFromReference(reference, { ethUsd8, dogeUsd8 }) {
  if (Number(reference?.chainId) !== 46630) throw new Error(`${DOGEOS_AIRDROP_CAP_REFERENCE}: expected chainId 46630, got ${reference?.chainId}`);
  const raw = reference?.fees?.airdrop?.cap;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`${DOGEOS_AIRDROP_CAP_REFERENCE}: fees.airdrop.cap missing or not a positive integer (${raw})`);
  }
  const cap = rescaleNative(BigInt(raw), ethUsd8, dogeUsd8);
  if (cap <= 0n) throw new Error(`airdrop cap ${raw} rounds to 0 DOGE at ETHUSDT ${ethUsd8} / DOGEUSDT ${dogeUsd8}`);
  return {
    cap,
    source: `${DOGEOS_AIRDROP_CAP_REFERENCE} fees.airdrop.cap ${raw} wei (46630 gen-7 pot) re-priced ETH->DOGE at ETHUSDT ${ethUsd8} / DOGEUSDT ${dogeUsd8} (8 dp)`,
  };
}

// ---------------------------------------------------------------------------------------------------- output paths

/**
 * Chikyū writes the repo manifest and verification JSON. A fork run never writes into the repo: it writes to
 * forkDir (a temp directory), or to the DOGEOS_TESTNET_MANIFEST override, which only a fork may use.
 */
export function dogeosOutputPaths({ mode, root, forkDir, manifestOverride }) {
  const override = String(manifestOverride || "").trim();
  if (mode === "chikyu") {
    if (override) throw new Error(`refusing: the ${DOGEOS_MANIFEST_OVERRIDE_ENV} manifest override is for a fork run only`);
    return { manifest: path.join(root, ...DOGEOS_MANIFEST_PATH.split("/")), verification: path.join(root, ...DOGEOS_VERIFICATION_PATH.split("/")) };
  }
  if (mode === "chikyu-fork") {
    if (!forkDir) throw new Error("a fork run needs a forkDir (temp directory) for its outputs");
    const rel = path.relative(path.resolve(root), path.resolve(forkDir));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error(`refusing: fork output dir ${forkDir} is inside the repo`);
    const manifest = override ? path.resolve(override) : path.join(forkDir, "testnet.json");
    return { manifest, verification: path.join(path.dirname(manifest), "dogeos-testnet-contracts.json") };
  }
  throw new Error(`unknown deploy mode ${mode}`);
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, `${json}\n`);
}

// ---------------------------------------------------------------------------------------------------- verification

/**
 * Every contract the DogeOS stack deploys, with its constructor arguments as deployDogeosGen7Stack
 * (scripts/lib/dogeosGen7Stack.ts) passes them; shape of verificationEntries in
 * scripts/deploy-robinhood-gen7-generation.ts. MuchFi and WDOGE are external and not listed.
 * Arguments are strings except the oracle's bool, which stays a JSON boolean (a string "false" would encode true).
 */
export function dogeosVerificationEntries(record, { upgradeDelaySeconds, holderBatchDelaySeconds, vaultDexKind }) {
  if (Number(record?.chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`manifest chainId ${record?.chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  const r = (label, v) => requireRecordAddress(label, v);
  const A = r("admin", record.admin);
  const adapterAdmin = r("adapterAdmin", record.adapterAdmin);
  const o = record.oracle || {};
  const v = record.vaults || {};
  const f = record.fees || {};
  const d = record.deployed || {};
  const x = record.dex || {};
  const reg = record.registries || {};
  const G4 = r("deployed.LaunchFactoryGen7", d.LaunchFactoryGen7);
  if (r("deployed.LaunchFactory", d.LaunchFactory) !== G4) throw new Error("deployed.LaunchFactory alias is not deployed.LaunchFactoryGen7");
  const G3 = r("deployed.MuchfiV3PositionLocker", d.MuchfiV3PositionLocker);
  const G2 = r("deployed.MuchfiV3NativeGraduationAdapter", d.MuchfiV3NativeGraduationAdapter);
  const G1 = r("deployed.LaunchCampaignGen7Implementation", d.LaunchCampaignGen7Implementation);
  const G5 = r("deployed.LaunchTokenDeployer", d.LaunchTokenDeployer);
  const O1 = r("oracle.dogeUsd", o.dogeUsd);
  const O2 = r("oracle.graduationOracle", o.graduationOracle);
  const F1 = r("fees.router", f.router);
  const D1 = r("dex.v3Factory", x.v3Factory);
  const D4 = r("dex.positionManager", x.positionManager);
  const D5 = r("dex.smartRouter", x.smartRouter);
  const W = r("dex.weth", x.weth);
  const initialAnswer = String(o.initialAnswer ?? "");
  if (!/^\d+$/.test(initialAnswer) || BigInt(initialAnswer) <= 0n) throw new Error(`oracle.initialAnswer ${o.initialAnswer} is not a positive integer`);
  const monthlyCapUsd = String(v.monthlyCapUsd ?? "");
  if (!/^\d+$/.test(monthlyCapUsd)) throw new Error(`vaults.monthlyCapUsd ${v.monthlyCapUsd} is not an integer`);
  const s = (n) => String(n);
  const sol = (file, name) => `contracts/${file}.sol:${name}`;
  return [
    { name: "DogeosTestnetDogeUsdOracle", address: O1, contract: sol("dogeos/testnet/DogeosTestnetDogeUsdOracle", "DogeosTestnetDogeUsdOracle"), args: [r("oracle.updater", o.updater), initialAnswer, false] },
    { name: "GraduationOracle", address: O2, contract: sol("GraduationOracle", "GraduationOracle"), args: [O1, s(o.maxPriceAge)] },
    { name: "TreasuryVaultV2 (weekly)", address: r("vaults.weekly", v.weekly), contract: sol("TreasuryVaultV2", "TreasuryVaultV2"), args: [A, ZERO, A] },
    { name: "CharityTreasury", address: r("vaults.charity", v.charity), contract: sol("CharityTreasury", "CharityTreasury"), args: [A] },
    { name: "MonthlyLeagueTreasury", address: r("vaults.monthly", v.monthly), contract: sol("MonthlyLeagueTreasury", "MonthlyLeagueTreasury"), args: [A, A, O2, r("vaults.charity", v.charity), monthlyCapUsd] },
    { name: "RecruiterRewardsVault", address: r("vaults.recruiter", v.recruiter), contract: sol("RecruiterRewardsVault", "RecruiterRewardsVault"), args: [A] },
    { name: "ProtocolRevenueVault", address: r("vaults.protocol", v.protocol), contract: sol("ProtocolRevenueVault", "ProtocolRevenueVault"), args: [A] },
    { name: "TreasuryRouterV4", address: F1, contract: sol("TreasuryRouterV4", "TreasuryRouterV4"), args: [A, r("vaults.weekly", v.weekly), r("vaults.monthly", v.monthly), s(upgradeDelaySeconds)] },
    { name: "MuchfiCreatorRewardsVault", address: r("fees.vault", f.vault), contract: sol("dogeos/muchfi/MuchfiCreatorRewardsVault", "MuchfiCreatorRewardsVault"), args: [A, F1, W, s(vaultDexKind), D1, s(holderBatchDelaySeconds)] },
    { name: "RewardDistributor (holders)", address: r("fees.holderDistributor", f.holderDistributor), contract: sol("RewardDistributor", "RewardDistributor"), args: [A] },
    { name: "CommunityRewardsVault", address: r("fees.communityRewardsVault", f.communityRewardsVault), contract: sol("CommunityRewardsVault", "CommunityRewardsVault"), args: [A, F1] },
    { name: "RewardDistributor (airdrop)", address: r("fees.airdropDistributor", f.airdropDistributor), contract: sol("RewardDistributor", "RewardDistributor"), args: [A] },
    { name: "CreatorRegistry", address: r("registries.creatorRegistry", reg.creatorRegistry), contract: sol("CreatorRegistry", "CreatorRegistry"), args: [] },
    { name: "RiskRegistry", address: r("registries.riskRegistry", reg.riskRegistry), contract: sol("RiskRegistry", "RiskRegistry"), args: [] },
    { name: "LaunchCampaignGen7", address: G1, contract: sol("gen7/LaunchCampaignGen7", "LaunchCampaignGen7"), args: [] },
    { name: "MuchfiV3NativeGraduationAdapter", address: G2, contract: sol("dogeos/muchfi/MuchfiV3NativeGraduationAdapter", "MuchfiV3NativeGraduationAdapter"), args: [D1, D4, W, adapterAdmin] },
    { name: "MuchfiV3PositionLocker", address: G3, contract: sol("dogeos/muchfi/MuchfiV3PositionLocker", "MuchfiV3PositionLocker"), args: [G4] },
    { name: "LaunchFactoryGen7", address: G4, contract: sol("gen7/LaunchFactoryGen7", "LaunchFactoryGen7"), args: [G2, F1, G1, O2, G3] },
    { name: "LaunchTokenDeployer", address: G5, contract: sol("token/LaunchTokenDeployer", "LaunchTokenDeployer"), args: [] },
    { name: "RobinhoodV3NativeSwapAdapterV2 (MuchFi SmartRouter)", address: r("nativeSwapAdapter", record.nativeSwapAdapter), contract: sol("integrations/RobinhoodV3NativeSwapAdapterV2", "RobinhoodV3NativeSwapAdapterV2"), args: [D5, W] },
  ];
}

export function dogeosVerificationManifest(record, entries) {
  return {
    purpose:
      "Every contract deployed on DogeOS Chikyū testnet (6281971) for the gen-7 stack, with the constructor arguments it was created with, for L2Scan source verification (scripts/verify-dogeos-testnet.ts). MuchFi (factory, pool deployer, NPM, routers, quoter) and WDOGE are external and not verified by us.",
    deployer: requireRecordAddress("deployer", record.deployer),
    chains: {
      [String(DOGEOS_TESTNET_CHAIN_ID)]: {
        network: DOGEOS_TESTNET_NETWORK_NAME,
        provider: "l2scan",
        apiUrl: DOGEOS_L2SCAN_API_URL,
        contracts: entries,
      },
    },
  };
}

/** Reads chains["6281971"].contracts back and refuses anything malformed or external. */
export function readVerificationList(manifest) {
  const list = manifest?.chains?.[String(DOGEOS_TESTNET_CHAIN_ID)]?.contracts;
  if (!Array.isArray(list)) throw new Error(`verification JSON has no chains["${DOGEOS_TESTNET_CHAIN_ID}"].contracts`);
  const external = new Set(Object.values(MUCHFI_EXTERNAL_ADDRESSES).map((a) => a.toLowerCase()));
  return list.map((e, i) => {
    const label = `entry ${i} (${e?.name})`;
    if (!e || typeof e.name !== "string" || !e.name) throw new Error(`${label}: name missing`);
    const address = checksum(e.address);
    if (!address || address === ZERO) throw new Error(`${label}: address ${e.address} invalid`);
    if (external.has(address.toLowerCase())) throw new Error(`${label}: ${address} is an external MuchFi/WDOGE contract; we never verify it`);
    if (typeof e.contract !== "string" || !/^contracts\/[\w/]+\.sol:\w+$/.test(e.contract)) throw new Error(`${label}: contract must be a fully qualified name`);
    if (!Array.isArray(e.args)) throw new Error(`${label}: args must be an array`);
    return { name: e.name, address, contract: e.contract, args: e.args };
  });
}

/** Verify runs only against Chikyū, with the L2Scan custom chain from hardhat.dogeos-verify.config.ts. */
export function assertVerifyTarget({ chainId, networkName, explorerApiUrl }) {
  if (networkName !== DOGEOS_TESTNET_NETWORK_NAME) throw new Error(`refusing: verify runs only on --network ${DOGEOS_TESTNET_NETWORK_NAME} (got ${networkName})`);
  if (Number(chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`refusing: chain ${chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  if (explorerApiUrl !== DOGEOS_L2SCAN_API_URL) {
    throw new Error(`refusing: no L2Scan custom chain for ${DOGEOS_TESTNET_NETWORK_NAME}; run with --config hardhat.dogeos-verify.config.ts`);
  }
  return true;
}

/** The verification JSON must describe the stack the manifest records: its LaunchFactoryGen7 is the manifest's. */
export function assertVerificationMatchesManifest(list, manifest) {
  if (Number(manifest?.chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`manifest chainId ${manifest?.chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  const factory = requireRecordAddress("manifest deployed.LaunchFactoryGen7", manifest?.deployed?.LaunchFactoryGen7);
  const hits = (list || []).filter((e) => String(e.contract).endsWith(":LaunchFactoryGen7"));
  if (hits.length !== 1) throw new Error(`verification JSON must list exactly one LaunchFactoryGen7 (found ${hits.length})`);
  if (checksum(hits[0].address) !== factory) {
    throw new Error(`refusing: verification JSON LaunchFactoryGen7 ${hits[0].address} is not the manifest's ${factory}`);
  }
  return true;
}

export function isAlreadyVerified(error) {
  const message = typeof error === "string" ? error : String(error?.message || "");
  return /already (been )?verified/i.test(message);
}

// ---------------------------------------------------------------------------------------------------- activate

/**
 * Activation preconditions from the manifest and the factory's on-chain state:
 *   onchain = { hasCode, routeAuthority, owner, graduationOracle, live, createPaused } read from deployed.LaunchFactoryGen7
 *   oracleProbe = { ok: true, price } | { ok: false, error } from GraduationOracle.nativeUsdPrice()
 * Returns the factory and the calls still needed (enableLive only when not live yet).
 * Chikyū: the signer is the pinned deployer, and both the env route authority and factory.routeAuthority() must be the
 * pinned DOGEOS_TESTNET_ROUTE_AUTHORITY. Fork: the signer must be the manifest's admin and owner (the fork deploy's
 * own signer), and factory.routeAuthority() must equal the (fork-local) env route authority.
 */
export function planActivation({ mode, manifest, expectedRouteAuthority, signer, onchain, oracleProbe }) {
  requireMode(mode);
  if (Number(manifest?.chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`manifest chainId ${manifest?.chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  const factory = requireRecordAddress("manifest deployed.LaunchFactoryGen7", manifest?.deployed?.LaunchFactoryGen7);
  if (checksum(manifest.deployed.LaunchFactory) !== factory) throw new Error("manifest deployed.LaunchFactory alias is not deployed.LaunchFactoryGen7");
  const manifestOracle = requireRecordAddress("manifest oracle.graduationOracle", manifest?.oracle?.graduationOracle);
  const s = assertModeSigner(mode, signer);
  if (mode === "chikyu-fork") {
    if (checksum(manifest.admin) !== s) throw new Error(`refusing: fork signer ${s} is not the manifest's admin ${manifest.admin}`);
    if (checksum(manifest.owner) !== s) throw new Error(`refusing: fork signer ${s} is not the manifest's owner ${manifest.owner}`);
  }
  const expected = resolveRouteAuthority(expectedRouteAuthority, { mode, signer: s });
  if (!onchain?.hasCode) throw new Error(`factory ${factory} has no code on chain ${DOGEOS_TESTNET_CHAIN_ID}`);
  const onchainRa = checksum(onchain.routeAuthority);
  if (onchainRa !== expected) {
    throw new Error(`refusing: factory routeAuthority() ${onchain.routeAuthority} is not ${DOGEOS_ROUTE_AUTHORITY_ENV} ${expected}`);
  }
  if (mode === "chikyu" && onchainRa !== DOGEOS_TESTNET_ROUTE_AUTHORITY) {
    throw new Error(`refusing: factory routeAuthority() ${onchain.routeAuthority} is not the DogeOS route authority ${DOGEOS_TESTNET_ROUTE_AUTHORITY}`);
  }
  if (checksum(onchain.owner) !== s) throw new Error(`refusing: factory owner() ${onchain.owner} is not the signer ${s}`);
  if (checksum(onchain.graduationOracle) !== manifestOracle) {
    throw new Error(`refusing: factory graduationOracle() ${onchain.graduationOracle} is not the manifest's ${manifestOracle}`);
  }
  if (!oracleProbe || oracleProbe.ok !== true) {
    throw new Error(`refusing: GraduationOracle.nativeUsdPrice() reverted (${oracleProbe?.error ?? "no probe"}); push a fresh DOGE/USD answer first`);
  }
  if (!(typeof oracleProbe.price === "bigint" && oracleProbe.price > 0n)) {
    throw new Error(`refusing: GraduationOracle.nativeUsdPrice() returned ${oracleProbe.price}`);
  }
  if (onchain.live === true && onchain.createPaused === false) throw new Error(`factory ${factory} is already live and unpaused; nothing to activate`);
  const calls = [];
  if (onchain.live !== true) calls.push("enableLive");
  if (onchain.createPaused !== false) calls.push("setCreatePaused(false)");
  return { factory, calls };
}

export function assertActivated({ live, createPaused }) {
  if (live !== true || createPaused !== false) {
    throw new Error(`activation read-back failed: expected live()==true && createPaused()==false, got live=${live} createPaused=${createPaused}`);
  }
  return true;
}
