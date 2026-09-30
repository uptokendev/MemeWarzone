/**
 * Fork rehearsal of the EVM generation 6/5 mainnet sequence (docs/evm-launch/release/EVM_GEN6_GO_LIVE.md
 * section 2), run against a local anvil fork of BNB 56 or Robinhood 4663 with the REAL Safe and the REAL
 * deployer impersonated. Nothing is signed with a key that exists on mainnet; nothing leaves the fork.
 *
 *   npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network bscForkRehearsal
 *   npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network robinhoodForkRehearsal
 *
 * Upstream (read-only) RPC: BSC_MAINNET_RPC / ROBINHOOD_MAINNET_RPC_URL, else the public endpoints. The script
 * starts its own anvil (port 8645 / 8646, `--accounts 0`, forked at the latest block) and stops it at the end;
 * REHEARSAL_KEEP_ANVIL=1 leaves it running for inspection. Records and batches land in
 * deployments/fork-rehearsal/<network>/ (wiped at the start), the report in .../rehearsal-report.json.
 *
 * The sequence, exactly as the runbook orders it, every step through the production script:
 *   0. (BNB) the live generation-3 coin on the old factory 0xc378221E: buy + sell BEFORE batch A
 *   1. deploy-evm-treasury-router-v4.ts (deployer)          -> batch A executed as the Safe
 *   1b.(BNB) the same coin: buy + sell AFTER batch A
 *   2. deploy-<chain>-quote-generation.ts (deployer)
 *   3. EVMGEN_BATCHES_ONLY=1 (batch B, with a D1 operator)   -> batch B executed as the Safe
 *   4. transferOwnershipToSafe (deployer)
 *   5. (RH) deploy-robinhood-stock-campaign-implementation.ts (deployer) -> batch R5 executed as the Safe
 *   6. configure-<chain>-routes (plan, simulate as the Safe, batch Q) -> batch Q executed as the Safe
 *   7. read-backs of runbook 2.1-2.9; check-evm-payout-bounds.mjs against the fork
 *   8. fork-only Safe call: factory.setRouteAuthority(<throwaway key>) so the rehearsal can sign like the API
 *   9. batch H (enableLive + setCreatePaused(false)) executed as the Safe
 *  10. one coin: create with a creator first buy (API signer module), buy after the anti-sniper window, sell,
 *      buy to the graduation target, graduate() from a third wallet, a DEX round trip, harvest()
 * and reports gas per phase x the current mainnet gas price (Robinhood: plus the Nitro L1 data component,
 * from NodeInterface.gasEstimateL1Component on the upstream RPC).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

import { assertLocalFork, FORK_REHEARSAL_NETWORKS } from "./lib/forkRehearsal";
import { writeSafeBatch, type PlannedCall } from "./lib/safeCallPlan";
import { main as feesMain, PINS } from "./deploy-evm-treasury-router-v4";
import { main as bnbGenerationMain } from "./deploy-bnb-quote-generation";
import { main as rhGenerationMain } from "./deploy-robinhood-quote-generation";
import { main as rhStockImplMain } from "./deploy-robinhood-stock-campaign-implementation";
import { main as rhRoutesMain } from "./configure-robinhood-stock-routes";
import { main as bnbRoutesMain } from "./configure-bnb-quote-routes";
import { transferOwnershipToSafe } from "./transfer-evm-ownership-to-safe";

const ROOT = path.resolve(__dirname, "..");
const WAD = 10n ** 18n;
const BPS = 10_000n;
const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
const ROUTE_AUTHORITY = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;

type ChainSetup = {
  key: "bnb" | "robinhood";
  chainId: number;
  native: string;
  port: number;
  upstream: string;
  env: Record<string, string>;
};

function chainSetup(): ChainSetup {
  if (network.name === "bscForkRehearsal") {
    return {
      key: "bnb", chainId: 56, native: "BNB", port: 8645,
      upstream: process.env.BSC_MAINNET_RPC || process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.bnbchain.org",
      env: {
        // Runbook 2.1 (E15 in BNB) and 2.3.
        CONFIRM_EVMGEN_FEES_DEPLOY: "I_UNDERSTAND_MAINNET",
        EVMGEN_BUYBACK_MAX_PER_TX: "0.65", EVMGEN_BUYBACK_MAX_PER_CAMPAIGN_WEEK: "6.5", EVMGEN_BUYBACK_MIN_INTERVAL_SECONDS: "21600",
        EVMGEN_BUYBACK_MAX_IMPACT_BPS: "50", EVMGEN_HOLDER_MAX_PER_WEEK: "32", EVMGEN_HOLDER_BATCH_AUTH_MAX: "32",
        CONFIRM_BNB_QUOTE_GENERATION: "I_UNDERSTAND_MAINNET",
        BNB_NATIVE_USD_FEED: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
      },
    };
  }
  if (network.name === "robinhoodForkRehearsal") {
    return {
      key: "robinhood", chainId: 4663, native: "ETH", port: 8646,
      upstream: process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com",
      env: {
        // Runbook 2.6 (E15 in ETH) and 2.8.
        CONFIRM_EVMGEN_FEES_DEPLOY: "I_UNDERSTAND_MAINNET",
        EVMGEN_BUYBACK_MAX_PER_TX: "0.19", EVMGEN_BUYBACK_MAX_PER_CAMPAIGN_WEEK: "1.9", EVMGEN_BUYBACK_MIN_INTERVAL_SECONDS: "21600",
        EVMGEN_BUYBACK_MAX_IMPACT_BPS: "50", EVMGEN_HOLDER_MAX_PER_WEEK: "9.3", EVMGEN_HOLDER_BATCH_AUTH_MAX: "9.3",
        CONFIRM_ROBINHOOD_GENERATION: "I_UNDERSTAND_MAINNET",
        RH_WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
        RH_V3_FACTORY: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
        RH_POSITION_MANAGER: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
        RH_SWAP_ROUTER: "0xCaf681a66D020601342297493863E78C959E5cb2",
        RH_NATIVE_USD_FEED: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
        RH_GRADUATION_ORACLE: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
        RH_ROUTE_AUTHORITY: ROUTE_AUTHORITY,
        RH_OWNER: SAFE,
      },
    };
  }
  throw new Error(`run with --network bscForkRehearsal or --network robinhoodForkRehearsal (got ${network.name})`);
}

/** Every env input the deploy scripts read, cleared so the rehearsal runs exactly the runbook's values. */
const SCRIPT_INPUTS = [
  "EVMGEN_BATCHES_ONLY", "EVMGEN_VAULT_OPERATOR", "EVMGEN_GENERATION_RECORD", "EVMGEN_NEW_FACTORY", "EVMGEN_QUOTE_ROUTES",
  "BNB_TOPAZ_ROUTER", "BNB_TOPAZ_QUOTE_ROUTER", "BNB_GRADUATION_ORACLE", "BNB_ROUTE_AUTHORITY", "BNB_TREASURY_ROUTER", "BNB_OWNER_SAFE",
  "BNB_CREATOR_REGISTRY", "BNB_RISK_REGISTRY", "QUOTE_GEN_OUT", "RH_ADAPTER_ADMIN", "RH_NATIVE_GRADUATION_ADAPTER", "RH_MAX_ORACLE_AGE_SECONDS",
  "RH_GENERATION_RECORD", "ARENA_RESOLVER", "ARENA_BOOST_QUOTE_SIGNER", "ARENA_PROTOCOL_RECEIVER", "ROUTES_SEND", "ROUTES_STOCK_ADAPTER",
  "ROUTES_BATCH_OUT", "ROUTES_GENERATION_RECORD",
];

const report: any = { startedAt: new Date().toISOString(), network: network.name, phases: [], checks: [], notes: [] };
const phaseTxs: Array<{ phase: string; from: string; to: string | null; data: string; gasUsed: bigint }> = [];
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function check(name: string, pass: boolean, proof: Record<string, unknown> = {}) {
  report.checks.push({ name, pass, ...JSON.parse(JSON.stringify(proof, big)) });
  console.log(`[rehearsal] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(proof, big)}`);
  if (!pass) throw new Error(`check failed: ${name}`);
}

async function rpc(method: string, params: unknown[] = []) {
  return ethers.provider.send(method, params);
}

async function startAnvil(c: ChainSetup): Promise<ChildProcess | null> {
  const url = String((network.config as any).url);
  const probe = async () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.ok, () => false);
  if (await probe()) throw new Error(`${url} already answers; stop that node first (the rehearsal needs a fresh fork)`);
  const args = ["--fork-url", c.upstream, "--port", String(c.port), "--accounts", "0", "--retries", "20", "--fork-retry-backoff", "1000", "--timeout", "60000", "--silent"];
  const child = spawn("anvil", args, { stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 120; i++) {
    if (await probe()) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("anvil did not come up within 60 s");
}

async function blockNumber() {
  return Number(await rpc("eth_blockNumber"));
}

/** Run a phase and collect every mined transaction's sender, calldata and gas. */
async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = await blockNumber();
  console.log(`\n[rehearsal] ===== ${name}`);
  const out = await fn();
  const end = await blockNumber();
  let gas = 0n;
  const byFrom: Record<string, bigint> = {};
  for (let b = start + 1; b <= end; b++) {
    const block = await rpc("eth_getBlockByNumber", [ethers.toQuantity(b), true]);
    for (const tx of block.transactions) {
      const rc = await rpc("eth_getTransactionReceipt", [tx.hash]);
      if (rc.status !== "0x1") throw new Error(`${name}: tx ${tx.hash} reverted`);
      const used = BigInt(rc.gasUsed);
      gas += used;
      const from = ethers.getAddress(tx.from);
      byFrom[from] = (byFrom[from] ?? 0n) + used;
      phaseTxs.push({ phase: name, from, to: tx.to ?? null, data: tx.input ?? tx.data, gasUsed: used });
    }
  }
  report.phases.push({ name, blocks: [start + 1, end], gas: gas.toString(), byFrom: JSON.parse(JSON.stringify(byFrom, big)) });
  console.log(`[rehearsal] ${name}: ${gas} gas`);
  return out;
}

async function impersonate(address: string, fundNative: string) {
  await rpc("anvil_impersonateAccount", [address]);
  await rpc("anvil_setBalance", [address, ethers.toQuantity(ethers.parseEther(fundNative))]);
}

/** Execute a Safe Transaction Builder batch as the (impersonated) Safe, one call at a time, in order. */
async function executeBatchAsSafe(file: string, expectedChainId: number) {
  const batch = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Number(batch.chainId) !== expectedChainId) throw new Error(`${file} is for chain ${batch.chainId}`);
  await impersonate(SAFE, "10");
  const safe = await ethers.getSigner(SAFE);
  try {
    for (const tx of batch.transactions) {
      const sent = await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
      const rc = await sent.wait();
      if (!rc || rc.status !== 1) throw new Error(`${tx.contractMethod?.name} on ${tx.to} failed`);
      console.log(`  safe ${tx.contractMethod?.name}(${Object.values(tx.contractInputsValues || {}).join(", ")}) -> ${tx.to}  gas ${rc.gasUsed}`);
    }
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [SAFE]);
  }
  return batch.transactions.length as number;
}

async function freshWallet(fund: string) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await rpc("anvil_setBalance", [w.address, ethers.toQuantity(ethers.parseEther(fund))]);
  return w;
}

async function warp(seconds: number) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

async function revertReason(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (e: any) {
    return e?.revert ? `${e.revert.name}(${(e.revert.args || []).map(String).join(",")})` : String(e?.shortMessage || e?.message || e).split("\n")[0];
  }
}

const signerMod: Promise<any> = Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href);

async function tradeAuth(authority: any, chainId: number, campaign: string, actor: string, profile: number, action: number, amount: bigint, limit: bigint) {
  const signer = await signerMod;
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
  const sig = await signer.signTradeAuthorization({ signer: authority, chainId: BigInt(chainId), campaignAddress: campaign, actor, routeProfileId: profile, action, amount, limit, deadline });
  return { deadline, sig };
}

const OLD_CAMPAIGN_ABI = [
  "function token() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function tradeRouteProfile() view returns (uint8)",
  "function buyExactBnbAuthorized(uint256 minTokensOut, uint8 routeProfile, uint64 deadline, bytes signature) payable returns (uint256, uint256)",
  "function sellExactTokensAuthorized(uint256 amountIn, uint256 minPayout, uint8 routeProfile, uint64 deadline, bytes signature) returns (uint256)",
  "function quoteSellExactTokens(uint256) view returns (uint256)",
];

/**
 * The BNB generation-3 coin on 0xc378221E (the only campaign on any open BNB factory, read 2026-10-01): a
 * signed buy and a signed sell, with its own factory's route authority replaced on the fork by a throwaway
 * key (fork-only Safe call). Proves whether batch A breaks its trading.
 */
async function oldBnbCoinRoundTrip(label: string, authority: any) {
  const OLD_FACTORY = "0xc378221E57898106079aE4B818a92978e4cd9559";
  const factory = new ethers.Contract(OLD_FACTORY, ["function campaignsCount() view returns (uint256)", "function getCampaign(uint256) view returns (tuple(address campaign,address token,address creator,string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint64 createdAt))", "function routeAuthority() view returns (address)", "function tradeRouteProfile() view returns (uint8)", "function setRouteAuthority(address)", "function createPaused() view returns (bool)"], ethers.provider);
  const count = Number(await factory.campaignsCount());
  const raw = await ethers.provider.call({ to: OLD_FACTORY, data: ethers.id("getCampaign(uint256)").slice(0, 10) + ethers.zeroPadValue("0x00", 32).slice(2) });
  const campaignAddr = ethers.getAddress("0x" + raw.slice(2 + 64 + 24, 2 + 128));
  const campaign = new ethers.Contract(campaignAddr, OLD_CAMPAIGN_ABI, ethers.provider);
  const router = await campaign.feeRecipient();
  const routerC = new ethers.Contract(router, ["function communityRewardsVault() view returns (address)"], ethers.provider);
  const community = await routerC.communityRewardsVault();
  const communityRouter = await new ethers.Contract(community, ["function router() view returns (address)"], ethers.provider).router();
  if (!same(await factory.routeAuthority(), authority.address)) {
    await impersonate(SAFE, "10");
    await (await (factory.connect(await ethers.getSigner(SAFE)) as any).setRouteAuthority(authority.address)).wait();
    await rpc("anvil_stopImpersonatingAccount", [SAFE]);
  }
  const buyer = await freshWallet("5");
  const value = ethers.parseEther("0.02");
  // The campaign stores no per-coin profile the signer could read reliably, so find the one it accepts.
  const candidates = [...new Set([Number(await factory.tradeRouteProfile()), 0, 1, 2, 3])];
  let profile = -1;
  let lastReason: string | null = null;
  for (const p of candidates) {
    const a = await tradeAuth(authority, 56, campaignAddr, buyer.address, p, ACT_BUY_NATIVE, value, 1n);
    lastReason = await revertReason(() => (campaign.connect(buyer) as any).buyExactBnbAuthorized.staticCall(1n, p, a.deadline, a.sig, { value }));
    if (lastReason === null) { profile = p; break; }
  }
  const token = new ethers.Contract(await campaign.token(), ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], buyer);
  const result: any = { campaign: campaignAddr, factoryCampaigns: count, router, routerCommunityVault: community, communityVaultRouter: communityRouter, factoryCreatePaused: await factory.createPaused() };
  if (profile < 0) {
    result.buy = { ok: false, revert: lastReason };
    return result;
  }
  const comBefore = await ethers.provider.getBalance(community);
  const a = await tradeAuth(authority, 56, campaignAddr, buyer.address, profile, ACT_BUY_NATIVE, value, 1n);
  const rc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(1n, profile, a.deadline, a.sig, { value })).wait();
  const got: bigint = await token.balanceOf(buyer.address);
  const comAfterBuy = await ethers.provider.getBalance(community);
  const sellAmt = got / 2n;
  await (await token.approve(campaignAddr, sellAmt)).wait();
  const minPayout = ((await campaign.quoteSellExactTokens(sellAmt)) as bigint) * 99n / 100n;
  const s = await tradeAuth(authority, 56, campaignAddr, buyer.address, profile, ACT_SELL, sellAmt, minPayout);
  const sellReason = await revertReason(() => (campaign.connect(buyer) as any).sellExactTokensAuthorized.staticCall(sellAmt, minPayout, profile, s.deadline, s.sig));
  let sellGas: bigint | null = null;
  if (sellReason === null) sellGas = (await (await (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, minPayout, profile, s.deadline, s.sig)).wait()).gasUsed;
  result.profile = profile;
  result.buy = { ok: rc.status === 1, tokens: got.toString(), gas: rc.gasUsed.toString(), communityVaultDelta: (comAfterBuy - comBefore).toString() };
  result.sell = sellReason === null ? { ok: true, tokens: sellAmt.toString(), gas: String(sellGas) } : { ok: false, revert: sellReason };
  console.log(`[rehearsal] old BNB coin ${label}: ${JSON.stringify(result)}`);
  return result;
}

async function readBacks(c: ChainSetup, fees: any, gen: any) {
  const pins = PINS[c.key === "bnb" ? "bscMainnet" : "robinhoodMainnet"];
  const R = fees.contracts.router, V = fees.contracts.vault, D = fees.contracts.holderDistributor;
  const call = (to: string, sig: string, args: unknown[] = []) => new ethers.Contract(to, [`function ${sig}`], ethers.provider)[sig.split("(")[0]](...args);
  const deployed = gen.contracts || gen.deployed;
  const F = deployed.BnbBasicLaunchFactory || deployed.LaunchFactory;
  const L = deployed.PermanentLpLocker || deployed.PermanentV3PositionLocker;
  const lim = await call(V, "limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)");
  const e15 = c.key === "bnb" ? ["0.65", "6.5", "32"] : ["0.19", "1.9", "9.3"];
  check("2.1/2.6 router V4: admin Safe, creator 5.6%, delay 3600, league vaults pinned", same(await call(R, "admin() view returns (address)"), SAFE) && (await call(R, "CREATOR_TRADE_BPS() view returns (uint16)")) === 560n && (await call(R, "upgradeDelay() view returns (uint256)")) === 3600n && same(await call(R, "weeklyLeagueVault() view returns (address)"), pins.weekly) && same(await call(R, "monthlyLeagueTreasury() view returns (address)"), pins.monthly), { router: R });
  check("2.1/2.6 vault V2: admin Safe, router V4, dex kind, wrapped native, 24 h holder delay", same(await call(V, "admin() view returns (address)"), SAFE) && same(await call(V, "router() view returns (address)"), R) && Number(await call(V, "dexKind() view returns (uint8)")) === pins.dexKind && same(await call(V, "wrappedNative() view returns (address)"), pins.wrappedNative) && (await call(V, "holderBatchDelay() view returns (uint256)")) === 86400n, { vault: V });
  check("2.2/2.7 batch A: old factory paused, V4 vaults, community vault -> V4, distributor <-> vault, caps E15", (await call(pins.oldFactory, "createPaused() view returns (bool)")) === true && same(await call(R, "recruiterRewardsVault() view returns (address)"), pins.recruiter) && same(await call(R, "communityRewardsVault() view returns (address)"), pins.community) && same(await call(R, "protocolRevenueVault() view returns (address)"), pins.protocol) && same(await call(R, "creatorRewardsVault() view returns (address)"), V) && same(await call(pins.community, "router() view returns (address)"), R) && same(await call(D, "owner() view returns (address)"), SAFE) && same(await call(D, "batchOperator() view returns (address)"), V) && same(await call(V, "holderDistributor() view returns (address)"), D) && lim[1] === ethers.parseEther(e15[0]) && lim[2] === ethers.parseEther(e15[1]) && lim[3] === 21600n && lim[4] === 50n && lim[5] === ethers.parseEther(e15[2]), { caps: lim.map(String) });
  check("2.3/2.8 generation: 6/5, fees and league to V4, locker bound both ways, create paused, not live, 0 campaigns", (await call(F, "FACTORY_GENERATION() view returns (uint32)")) === 6n && (await call(F, "CAMPAIGN_GENERATION() view returns (uint32)")) === 5n && same(await call(F, "feeRecipient() view returns (address)"), R) && same(await call(F, "leagueReceiver() view returns (address)"), R) && same(await call(F, "permanentLpLocker() view returns (address)"), L) && same(await call(L, "admin() view returns (address)"), F) && same(await call(F, "routeAuthority() view returns (address)"), ROUTE_AUTHORITY) && (await call(F, "createPaused() view returns (bool)")) === true && (await call(F, "live() view returns (bool)")) === false && (await call(F, "campaignsCount() view returns (uint256)")) === 0n, { factory: F, locker: L });
  check("2.4/2.9 batch B: locker authorized + primary on V4, vault pinned to the factory, D1 operator", (await call(R, "authorizedLpLocker(address) view returns (bool)", [L])) === true && same(await call(R, "permanentLpLocker() view returns (address)"), L) && same(await call(V, "factory() view returns (address)"), F) && same(await call(V, "operator() view returns (address)"), report.d1Operator), { operator: report.d1Operator });
  check("2.5/2.9 ownership: factory owned by the Safe", same(await call(F, "owner() view returns (address)"), SAFE), {});
  if (c.key === "bnb") {
    const Q = deployed.BnbQuoteGraduationAdapter;
    check("2.3/2.4 BNB: quote adapter admin Safe and bound; launch recorder; native adapter bound", same(await call(Q, "admin() view returns (address)"), SAFE) && same(await call(Q, "campaignFactory() view returns (address)"), F) && (await call(gen.inputs.creatorRegistry, "launchRecorder(address) view returns (bool)", [F])) === true && same(await call(deployed.BnbNativeGraduationAdapter, "campaignFactory() view returns (address)"), F) && same(await call(F, "bnbQuoteGraduationAdapter() view returns (address)"), Q), { quoteAdapter: Q });
  } else {
    const S = deployed.RobinhoodStockGraduationAdapterV2, N = deployed.RobinhoodV3NativeGraduationAdapterV2;
    check("2.8/2.9 RH: both V2 adapters admin Safe and locked to the factory; V3 kind; oracle age 90000; fee 3000; registries Safe-owned", same(await call(S, "admin() view returns (address)"), SAFE) && same(await call(N, "admin() view returns (address)"), SAFE) && same(await call(S, "campaignFactory() view returns (address)"), F) && same(await call(N, "campaignFactory() view returns (address)"), F) && Number(await call(F, "liquidityKind() view returns (uint8)")) === 2 && same(await call(F, "stockGraduationAdapter() view returns (address)"), S) && (await call(S, "maxOracleAgeSeconds() view returns (uint32)")) === 90000n && Number(await call(N, "feeTier() view returns (uint24)")) === 3000 && same(await call(gen.registries.creatorRegistry, "owner() view returns (address)"), SAFE) && same(await call(gen.registries.riskRegistry, "owner() view returns (address)"), SAFE), { stockAdapter: S, nativeAdapter: N });
    check("2.9 R5: stock campaign implementation bound before the first campaign", same(await call(F, "stockCampaignImplementation() view returns (address)"), report.r5Implementation), { implementation: report.r5Implementation });
  }
}

async function lifecycle(c: ChainSetup, fees: any, gen: any, authority: any) {
  const deployed = gen.contracts || gen.deployed;
  const F = deployed.BnbBasicLaunchFactory || deployed.LaunchFactory;
  const L = deployed.PermanentLpLocker || deployed.PermanentV3PositionLocker;
  const factory: any = await ethers.getContractAt(c.key === "bnb" ? "BnbBasicLaunchFactory" : "LaunchFactory", F);
  const signer = await signerMod;
  const tradeProfile = Number(await factory.tradeRouteProfile());
  const finalizeProfile = Number(await factory.finalizeRouteProfile());
  const fGen = Number(await factory.FACTORY_GENERATION());
  check("API signer accepts the new factory's generation pair", signer.isSupportedGenerationPair(c.chainId, fGen, Number(await factory.CAMPAIGN_GENERATION())), { fGen });

  const creator = await freshWallet(c.key === "bnb" ? "5" : "2");
  const buyer = await freshWallet(c.key === "bnb" ? "80" : "25");
  const third = await freshWallet("2");
  const cfg = await factory.config();
  const firstBuyTokens = ethers.parseEther("10000000"); // 1% of supply
  const noFee = (firstBuyTokens * cfg.basePrice) / WAD + (cfg.priceSlope * firstBuyTokens * firstBuyTokens) / (2n * WAD * WAD);
  const firstBuyMaxCost = noFee + (noFee * 200n) / BPS;
  const feeChoice = c.key === "bnb" ? 1 : 2; // keep on BNB, holders on Robinhood (runbook 6.1)
  const req = { name: `Rehearsal ${c.native}`, symbol: `RH${c.chainId}`, logoURI: "ipfs://mwz-fork-rehearsal", xAccount: "", website: "", extraLink: "", graduationTarget: ethers.parseEther("15000"), firstBuyTokens, firstBuyMaxCost, feeChoice, feeCreatorPct: 0 };
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
  const signature = await signer.signCreateAuthorization({ signer: authority, chainId: BigInt(c.chainId), factoryAddress: F, creator: creator.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline });
  const auth = { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature };
  const createRc = await (await (factory.connect(creator) as any).createCampaignAuthorized(req, auth, { value: firstBuyMaxCost + ethers.parseEther("0.001") })).wait();
  const created = createRc.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CampaignCreated");
  const campaignAddr = created.args.campaign as string;
  const campaign: any = await ethers.getContractAt("LaunchCampaign", campaignAddr);
  const token: any = await ethers.getContractAt("LaunchToken", created.args.token);
  const vault: any = await ethers.getContractAt("CreatorRewardsVaultV2", fees.contracts.vault);
  check("create: one wallet signature, generation 5 campaign, creator first buy delivered, fee choice on the vault", (await token.balanceOf(creator.address)) === firstBuyTokens && Number((await vault.cfg(campaignAddr)).choice) === feeChoice && (await factory.campaignsCount()) === 1n, { campaign: campaignAddr, token: created.args.token, gas: createRc.gasUsed });

  await warp(61);
  const buyValue = ethers.parseEther(c.key === "bnb" ? "0.05" : "0.02");
  const [q] = await campaign.quoteBuyExactBnb(buyValue);
  const minOut = (q * 99n) / 100n;
  const ba = await tradeAuth(authority, c.chainId, campaignAddr, buyer.address, tradeProfile, ACT_BUY_NATIVE, buyValue, minOut);
  const buyRc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(minOut, tradeProfile, ba.deadline, ba.sig, { value: buyValue })).wait();
  const bought: bigint = await token.balanceOf(buyer.address);
  const sellAmt = bought / 2n;
  await (await (token.connect(buyer) as any).approve(campaignAddr, sellAmt)).wait();
  const payoutQ: bigint = await campaign.quoteSellExactTokens(sellAmt);
  const sa = await tradeAuth(authority, c.chainId, campaignAddr, buyer.address, tradeProfile, ACT_SELL, sellAmt, payoutQ);
  const sellRc = await (await (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, payoutQ, tradeProfile, sa.deadline, sa.sig)).wait();
  check("trade: signed buy after the anti-sniper window and signed sell", bought > 0n && sellRc.status === 1, { bought, sold: sellAmt, buyGas: buyRc.gasUsed, sellGas: sellRc.gasUsed });

  const target: bigint = await campaign.graduationNativeTarget();
  const need = target - ((await campaign.netRaisedWei()) as bigint);
  const value = need + need / 10n + (need * 300n) / BPS;
  const [q2] = await campaign.quoteBuyExactBnb(value);
  const min2 = (q2 * 99n) / 100n;
  const ca = await tradeAuth(authority, c.chainId, campaignAddr, buyer.address, tradeProfile, ACT_BUY_NATIVE, value, min2);
  await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(min2, tradeProfile, ca.deadline, ca.sig, { value })).wait();
  check(`graduation target ($15,000 = ${ethers.formatEther(target)} ${c.native}) reached -> Pending`, (await campaign.graduationPending()) === true && (await campaign.launched()) === false, { nativeTarget: target, sent: value });

  const gradRc = await (await (campaign.connect(third) as any).graduate({ gasLimit: 12_000_000 })).wait();
  const grad = gradRc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Graduated");
  const pool = grad.args.pool as string;
  check("graduate() from a third wallet: launched, pool created, 2.2 / 19.8 / 78", (await campaign.launched()) === true && grad.args.protocolShare === (grad.args.raise * 220n) / BPS && grad.args.creatorShare === (grad.args.raise * 1980n) / BPS && grad.args.startPrice >= grad.args.curvePrice, { pool, raise: grad.args.raise, protocolShare: grad.args.protocolShare, creatorShare: grad.args.creatorShare, poolNative: grad.args.poolNative, curvePrice: grad.args.curvePrice, startPrice: grad.args.startPrice, repaired: grad.args.repaired, gas: gradRc.gasUsed });

  // A DEX round trip on the graduated pool so the position earns fees on both sides.
  const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
  const dexIn = ethers.parseEther(c.key === "bnb" ? "0.5" : "0.2");
  let memeBought = 0n;
  if (c.key === "bnb") {
    const ROUTE = "(address from,address to,bool stable,address factory)[]";
    const topaz = new ethers.Contract("0x1E98c8226e7d452e1888e3d3d2F929346321c6c3", [`function swapExactETHForTokens(uint256,${ROUTE},address,uint256) payable returns (uint256[])`, `function swapExactTokensForETH(uint256,uint256,${ROUTE},address,uint256) returns (uint256[])`], third);
    const wbnb = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", topazFactory = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";
    await (await topaz.swapExactETHForTokens(1n, [{ from: wbnb, to: created.args.token, stable: false, factory: topazFactory }], third.address, dl, { value: dexIn })).wait();
    memeBought = await token.balanceOf(third.address);
    await (await (token.connect(third) as any).approve(await topaz.getAddress(), memeBought)).wait();
    await (await topaz.swapExactTokensForETH(memeBought, 1n, [{ from: created.args.token, to: wbnb, stable: false, factory: topazFactory }], third.address, dl)).wait();
  } else {
    const swap: any = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", deployed.RobinhoodV3NativeSwapAdapter, third);
    await (await swap.buyExactNativeIn(created.args.token, 3000, 1n, third.address, dl, { value: dexIn })).wait();
    memeBought = await token.balanceOf(third.address);
    await (await (token.connect(third) as any).approve(deployed.RobinhoodV3NativeSwapAdapter, memeBought)).wait();
    await (await swap.sellExactTokenIn(created.args.token, 3000, memeBought, 1n, third.address, dl)).wait();
  }
  check("post-graduation DEX buy and sell on the locked pool", memeBought > 0n, { memeBought, nativeIn: dexIn });

  await warp(1800);
  const locker: any = await ethers.getContractAt(c.key === "bnb" ? "PermanentLpLocker" : "PermanentV3PositionLocker", L, third);
  const hRc = await (await locker.harvest(pool, { gasLimit: 2_000_000 })).wait();
  const hEvents = hRc.logs.map((l: any) => { try { return locker.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  const paired = hEvents.filter((e: any) => e.name === "FeesHarvested");
  const sold = hEvents.find((e: any) => e.name === "MemeFeesSold");
  const splitOk = paired.every((e: any) => e.args.creatorPaid === (e.args.collected * 8000n) / BPS && e.args.creatorPaid + e.args.protocolRouted === e.args.collected);
  check("harvest(): LP fees collected, paired side paid exactly 80/20 creator/protocol", paired.length > 0 && splitOk, { harvested: paired.map((e: any) => ({ token: e.args.token, collected: e.args.collected, creatorPaid: e.args.creatorPaid, protocolRouted: e.args.protocolRouted })), memeSold: sold?.args.memeSold, memeCarried: sold?.args.memeCarried, gas: hRc.gasUsed });
  report.coin = { campaign: campaignAddr, token: created.args.token, pool };
}

/** Nitro: the L1 data part of each deployer transaction, priced by NodeInterface on the upstream RPC. */
async function robinhoodL1Component(upstream: string, txs: typeof phaseTxs) {
  const up = new ethers.JsonRpcProvider(upstream, 4663, { staticNetwork: true });
  const ni = new ethers.Contract("0x00000000000000000000000000000000000000C8", ["function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"], up);
  let l1Gas = 0n;
  let baseFee = 0n;
  const perTx: Array<{ phase: string; to: string | null; bytes: number; l2Gas: string; l1Gas: string }> = [];
  for (const t of txs) {
    const creation = !t.to;
    const [g, bf] = await ni.gasEstimateL1Component.staticCall(creation ? ethers.ZeroAddress : t.to, creation, t.data);
    l1Gas += BigInt(g);
    baseFee = BigInt(bf);
    perTx.push({ phase: t.phase, to: t.to, bytes: (t.data.length - 2) / 2, l2Gas: t.gasUsed.toString(), l1Gas: String(g) });
  }
  return { l1Gas, baseFee, perTx };
}

async function main() {
  const c = chainSetup();
  const outDir = path.join(ROOT, "deployments", "fork-rehearsal", network.name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  process.env.REHEARSAL_OUT_DIR = outDir;
  for (const k of SCRIPT_INPUTS) delete process.env[k];
  Object.assign(process.env, c.env);

  const anvil = await startAnvil(c);
  try {
    const fork = await assertLocalFork(c.chainId);
    const up = new ethers.JsonRpcProvider(c.upstream, c.chainId, { staticNetwork: true });
    const [mainnetGasPrice, deployerReal, safeCode] = await Promise.all([up.send("eth_gasPrice", []).then(BigInt), up.getBalance(DEPLOYER, fork.forkBlock || "latest"), ethers.provider.getCode(SAFE)]);
    Object.assign(report, { chainId: c.chainId, forkBlock: fork.forkBlock, upstream: c.upstream.replace(/\/\/([^/]*@)?/, "//"), mainnetGasPriceWei: mainnetGasPrice.toString(), deployerBalanceAtFork: ethers.formatEther(deployerReal) });
    check("fork: the Safe has code and the deployer is the real one", safeCode !== "0x", { forkBlock: fork.forkBlock, deployerBalance: ethers.formatEther(deployerReal) });
    // The deployer, impersonated first so eth_accounts[0] (the scripts' signer) is exactly the deployer.
    await impersonate(DEPLOYER, "1000");
    const [signer0] = await ethers.getSigners();
    if (!same(signer0.address, DEPLOYER)) throw new Error(`signer ${signer0.address} is not the deployer`);
    const authority = ethers.Wallet.createRandom(); // throwaway route authority, installed on the fork only
    const pinsName = c.key === "bnb" ? "bscMainnet" : "robinhoodMainnet";
    const dirOut = path.join(outDir, c.key);

    if (c.key === "bnb") report.oldCoinBeforeA = await phase("0 old BNB coin before batch A", () => oldBnbCoinRoundTrip("before batch A", authority));

    const fees = await phase("1 fees stack (deployer)", async () => { await feesMain(); return JSON.parse(fs.readFileSync(path.join(dirOut, "mainnet.evmgen-fees.json"), "utf8")); });
    await phase("1 batch A (Safe)", () => executeBatchAsSafe(path.join(dirOut, "mainnet.evmgen-fees.A.safe-batch.json"), c.chainId));

    if (c.key === "bnb") {
      report.oldCoinAfterA = await phase("1b old BNB coin after batch A", () => oldBnbCoinRoundTrip("after batch A", authority));
      check("the live generation-3 BNB coin still buys and sells after batch A (it routes through V2 and V2's own community vault)", report.oldCoinBeforeA.buy.ok && report.oldCoinBeforeA.sell.ok && report.oldCoinAfterA.buy.ok && report.oldCoinAfterA.sell.ok && !same(report.oldCoinAfterA.routerCommunityVault, PINS.bscMainnet.community), { router: report.oldCoinAfterA.router, itsCommunityVault: report.oldCoinAfterA.routerCommunityVault, batchARepoints: PINS.bscMainnet.community });
    }

    process.env[c.key === "bnb" ? "BNB_TREASURY_ROUTER" : "RH_TREASURY_ROUTER"] = fees.contracts.router;
    const gen: any = await phase("2 generation (deployer)", async () => (c.key === "bnb" ? bnbGenerationMain() : rhGenerationMain()));

    report.d1Operator = ethers.Wallet.createRandom().address;
    process.env.EVMGEN_BATCHES_ONLY = "1";
    process.env.EVMGEN_VAULT_OPERATOR = report.d1Operator;
    const rebuilt: any = await feesMain();
    delete process.env.EVMGEN_BATCHES_ONLY;
    report.batchB = (rebuilt.b || []).map((x: PlannedCall) => `${x.contract}.${x.fn}`);
    await phase("3 batch B (Safe)", () => executeBatchAsSafe(rebuilt.bFile, c.chainId));

    const deployed = gen.contracts || gen.deployed;
    const factoryAddress = deployed.BnbBasicLaunchFactory || deployed.LaunchFactory;
    const ownables = c.key === "bnb" ? [factoryAddress] : [factoryAddress, gen.registries.creatorRegistry, gen.registries.riskRegistry];
    await phase("4 ownership to the Safe (deployer)", () => transferOwnershipToSafe({ contracts: ownables, newOwner: SAFE, senderAddress: DEPLOYER, requireContractOwner: true }));

    if (c.key === "robinhood") {
      const r5: any = await phase("5 stock campaign implementation (deployer)", () => rhStockImplMain());
      report.r5Implementation = r5.implementation;
      await phase("5 batch R5 (Safe)", () => executeBatchAsSafe(r5.batchFile, c.chainId));
    }

    process.env.ROUTES_GENERATION_RECORD = path.join(dirOut, "mainnet.quote-generation.json");
    const routes: any = await phase("6 route plan (simulated as the Safe)", () => (c.key === "bnb" ? bnbRoutesMain() : rhRoutesMain()));
    report.routes = (routes.results || []).map((r: any) => ({ symbol: r.symbol, adapter: r.adapter, vault: r.vault, depthUsd: r.stockSideUsd ?? r.poolUsd }));
    if (routes.batch) await phase("6 batch Q (Safe)", () => executeBatchAsSafe(routes.batch, c.chainId));
    if (c.key === "robinhood") {
      const adapter = new ethers.Contract(deployed.RobinhoodStockGraduationAdapterV2, ["function stockRoutes(address) view returns (address,address,uint24,uint256,uint16,uint16,uint16,bool)"], ethers.provider);
      const cfgRoutes = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "robinhood", "mainnet-stock-routes.json"), "utf8")).routes;
      const enabled = [];
      for (const r of cfgRoutes) if ((await adapter.stockRoutes(r.stockToken))[7]) enabled.push(r.symbol);
      check("batch Q: every route in the file is enabled on the V2 stock adapter (executed as the Safe on the real V3 factory)", enabled.length === cfgRoutes.length, { enabled });
    }

    await readBacks(c, fees, gen);

    // check-evm-payout-bounds against the fork, generation 6 bounds included.
    const bounds = await new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "check-evm-payout-bounds.mjs")], { env: { ...process.env, BOUNDS_CHAINS: String(c.chainId), [`BOUNDS_RPC_${c.chainId}`]: String((network.config as any).url), [`EVMGEN_FEES_RECORD_${c.chainId}`]: path.join(dirOut, "mainnet.evmgen-fees.json") } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
    });
    console.log(bounds.out);
    check("check-evm-payout-bounds.mjs on the fork (incl. vault V2 limits) exits 0", bounds.code === 0 && /vault holder batches \/ week/.test(bounds.out), {});

    await phase("8 fork-only: Safe sets a throwaway route authority", async () => {
      const f = path.join(outDir, "fork-only.route-authority.safe-batch.json");
      writeSafeBatch(f, c.chainId, "FORK ONLY", "never on mainnet", [{ contract: c.key === "bnb" ? "BnbBasicLaunchFactory" : "LaunchFactory", to: factoryAddress, fn: "setRouteAuthority", args: [authority.address] }]);
      return executeBatchAsSafe(f, c.chainId);
    });
    await phase("9 batch H (Safe)", async () => {
      const f = path.join(dirOut, "mainnet.H-open.safe-batch.json");
      const name = c.key === "bnb" ? "BnbBasicLaunchFactory" : "LaunchFactory";
      writeSafeBatch(f, c.chainId, "MWZ gen6 H: open", "enableLive + setCreatePaused(false)", [{ contract: name, to: factoryAddress, fn: "enableLive", args: [] }, { contract: name, to: factoryAddress, fn: "setCreatePaused", args: [false] }]);
      return executeBatchAsSafe(f, c.chainId);
    });
    await phase("10 one coin: create, trade, graduate, DEX trade, harvest", () => lifecycle(c, fees, gen, authority));

    // Gas and funding.
    const deployerTxs = phaseTxs.filter((t) => same(t.from, DEPLOYER));
    // The Safe's production batches only (A, B, R5, Q, H); the fork-only route-authority calls are left out.
    const safeTxs = phaseTxs.filter((t) => same(t.from, SAFE) && /batch/.test(t.phase));
    const deployerGas = deployerTxs.reduce((s, t) => s + t.gasUsed, 0n);
    const safeGas = safeTxs.reduce((s, t) => s + t.gasUsed, 0n);
    const funding: any = { deployerTxs: deployerTxs.length, deployerGas: deployerGas.toString(), safeCalls: safeTxs.length, safeGas: safeGas.toString(), gasPriceGwei: ethers.formatUnits(mainnetGasPrice, "gwei") };
    let deployerCost = deployerGas * mainnetGasPrice;
    if (c.key === "robinhood") {
      const l1 = await robinhoodL1Component(c.upstream, deployerTxs);
      funding.l1DataGas = l1.l1Gas.toString();
      funding.l1DataCost = ethers.formatEther(l1.l1Gas * l1.baseFee);
      funding.l1PerTx = l1.perTx;
      deployerCost += l1.l1Gas * l1.baseFee;
    }
    funding.deployerCost = `${ethers.formatEther(deployerCost)} ${c.native}`;
    funding.safeExecutionCost = `${ethers.formatEther(safeGas * mainnetGasPrice)} ${c.native} (paid by the signer who executes each Safe batch)`;
    funding.deployerBalanceAtFork = `${ethers.formatEther(deployerReal)} ${c.native}`;
    report.funding = funding;
    report.accepted = true;
    console.log(`\n[rehearsal] FUNDING ${JSON.stringify(funding, null, 2)}`);
  } catch (error) {
    report.accepted = false;
    report.error = String((error as Error)?.stack || error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "rehearsal-report.json"), `${JSON.stringify(report, big, 2)}\n`);
    console.log(`[rehearsal] report: ${path.join(outDir, "rehearsal-report.json")}  accepted=${report.accepted}`);
    if (anvil && process.env.REHEARSAL_KEEP_ANVIL !== "1") anvil.kill();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
}
