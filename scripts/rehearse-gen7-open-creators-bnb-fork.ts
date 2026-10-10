/**
 * Founder 2026-10-10: no creator launch cooldown and no cluster-wallet limit on BNB gen-7 (match the Solana DBC path).
 * One Safe call, no new contract: gen-7 factory setRegistries(address(0), <current RiskRegistry>).
 *   - creatorRegistry = 0: _enforceCreatorEligibility returns (0,0,0) -> no 24h cooldown, no live-coin limit, no tier
 *     rules; maxClusterWallets = 0 -> RiskRegistry.canCreatorLaunch skips the cluster-size check.
 *   - riskRegistry kept: wallets / clusters the Safe marked restricted stay blocked from launching and trading.
 * Writes deployments/bnb/mainnet.gen7.R-open-creators.safe-batch.json and proves it on an anvil fork of the LIVE
 * gen-7 deployment (deployments/bnb/mainnet.gen7.json): second launch refused before, four launches back to back after.
 *
 *   npx hardhat run scripts/rehearse-gen7-open-creators-bnb-fork.ts --network bscForkRehearsal
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

import { assertLocalFork } from "./lib/forkRehearsal";
import { writeSafeBatch, simulateAsAdmin, type PlannedCall } from "./lib/safeCallPlan";

const ROOT = path.resolve(__dirname, "..");
const BPS = 10_000n;
const ACT_BUY_NATIVE = 1;
const PORT = 8645;
const importEsm: (s: string) => Promise<any> = Function("s", "return import(s)") as any;
const signerMod = importEsm(pathToFileURL(path.join(ROOT, "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href);
const apiGen6Mod = importEsm(pathToFileURL(path.join(ROOT, "frontend", "api", "lib", "evmLaunchGen6.js")).href);
const rpc = (method: string, params: unknown[] = []) => ethers.provider.send(method, params);
const checks: Array<{ name: string; pass: boolean; proof: unknown }> = [];
function check(name: string, pass: boolean, proof: unknown = {}) {
  checks.push({ name, pass, proof });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(proof, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

async function startAnvil(upstream: string): Promise<ChildProcess> {
  const url = String((network.config as any).url);
  const probe = async () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.ok, () => false);
  if (await probe()) throw new Error(`${url} already answers; stop that node first`);
  const child = spawn("anvil", ["--fork-url", upstream, "--port", String(PORT), "--accounts", "0", "--retries", "20", "--fork-retry-backoff", "1000", "--timeout", "60000", "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 120; i++) {
    if (await probe()) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("anvil did not come up within 60 s");
}

async function impersonate(address: string, fund: string) {
  await rpc("anvil_impersonateAccount", [address]);
  await rpc("anvil_setBalance", [address, ethers.toQuantity(ethers.parseEther(fund))]);
  return ethers.getSigner(address);
}

async function revertReason(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (e: any) {
    if (e?.revert) return `${e.revert.name}(${(e.revert.args || []).map(String).join(",")})`;
    return String(e?.shortMessage || e?.message || e).split("\n")[0];
  }
}

async function main() {
  if (network.name !== "bscForkRehearsal") throw new Error(`run with --network bscForkRehearsal (got ${network.name})`);
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "bnb", "mainnet.gen7.json"), "utf8"));
  const F = rec.contracts.BnbBasicLaunchFactoryGen7 as string;
  const SAFE = rec.admin as string;
  const GEN6 = rec.gen6.factory as string;
  const upstream = process.env.BSC_MAINNET_RPC || process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.bnbchain.org";

  // The real batch, from mainnet state.
  const up = new ethers.JsonRpcProvider(upstream, 56, { staticNetwork: true });
  const regAbi = ["function creatorRegistry() view returns (address)", "function riskRegistry() view returns (address)", "function owner() view returns (address)"];
  const live = new ethers.Contract(F, regAbi, up);
  const [liveCreatorReg, liveRiskReg, liveOwner] = await Promise.all([live.creatorRegistry(), live.riskRegistry(), live.owner()]);
  if (ethers.getAddress(liveOwner) !== ethers.getAddress(SAFE)) throw new Error(`gen-7 factory owner ${liveOwner} is not the Safe ${SAFE}`);
  if (liveRiskReg === ethers.ZeroAddress) throw new Error("gen-7 factory has no RiskRegistry; refusing to write a batch that would keep none");
  const call: PlannedCall = { contract: "BnbBasicLaunchFactoryGen7", to: F, fn: "setRegistries", args: [ethers.ZeroAddress, liveRiskReg], note: "no creator cooldown / live limit / cluster-size check; restricted wallets stay blocked" };
  const batchFile = path.join(ROOT, "deployments", "bnb", "mainnet.gen7.R-open-creators.safe-batch.json");
  writeSafeBatch(batchFile, 56, "MWZ gen7 R: open creators", `gen-7 factory ${F}: setRegistries(0x0, ${liveRiskReg}) (was creatorRegistry ${liveCreatorReg}). Removes the 24h creator cooldown, the live-coin limit and the cluster-size check; restricted wallets stay blocked by the RiskRegistry.`, [call]);
  console.log(`[open-creators] wrote ${batchFile}`);

  const anvil = await startAnvil(upstream);
  try {
    const fork = await assertLocalFork(56);
    console.log(`[open-creators] fork block ${fork.forkBlock}`);
    const signer = await signerMod;
    const api = await apiGen6Mod;
    const factory: any = await ethers.getContractAt("BnbBasicLaunchFactoryGen7", F);
    const gen6: any = new ethers.Contract(GEN6, regAbi, ethers.provider);
    const gen6Before = [await gen6.creatorRegistry(), await gen6.riskRegistry()];
    const tradeProfile = Number(await factory.tradeRouteProfile());
    const finalizeProfile = Number(await factory.finalizeRouteProfile());
    const fGen = Number(await factory.FACTORY_GENERATION());
    check("fork starts from the live state: gen-7 live, creates open, creatorRegistry set", (await factory.live()) && !(await factory.createPaused()) && (await factory.creatorRegistry()) === liveCreatorReg, { forkBlock: fork.forkBlock, creatorRegistry: liveCreatorReg, riskRegistry: liveRiskReg });

    const authority = ethers.Wallet.createRandom();
    const safe = await impersonate(SAFE, "10");
    await (await (factory.connect(safe) as any).setRouteAuthority(authority.address)).wait(); // fork only

    const apiProvider = new ethers.JsonRpcProvider(String((network.config as any).url), 56, { staticNetwork: true });
    const target = ethers.parseEther("50000");
    const readContext = async ({ graduationTarget }: any) => api.readGen6FactoryCreateContext({ provider: apiProvider, factoryAddress: F, graduationTarget, factoryGeneration: fGen });
    const ctx: any = await readContext({ graduationTarget: target });
    let n = 0;
    const create = async (creator: any, send: boolean) => {
      n += 1;
      const firstBuyTokens = (BigInt(ctx.totalSupply) * 100n) / BPS; // 1%
      const prepared: any = await api.prepareGen6CreateOptions({ source: { feeChoice: "keep", firstBuyTokens: firstBuyTokens.toString() }, graduationTarget: target, readContext, autoMaxCost: true });
      const req = {
        name: `Open creators ${n}`, symbol: `OC${n}`, logoURI: "ipfs://mwz-open-creators-fork", xAccount: "", website: "", extraLink: "",
        graduationTarget: target, firstBuyTokens: BigInt(prepared.requestFields.firstBuyTokens), firstBuyMaxCost: BigInt(prepared.requestFields.firstBuyMaxCost),
        feeChoice: prepared.requestFields.feeChoice, feeCreatorPct: prepared.requestFields.feeCreatorPct,
      };
      const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
      const signature = await signer.signCreateAuthorization({ signer: authority, chainId: 56n, factoryAddress: F, creator: creator.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline });
      const args = [req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }, { value: req.firstBuyMaxCost }] as const;
      if (!send) return { reason: await revertReason(() => (factory.connect(creator) as any).createCampaignAuthorized.staticCall(...args)) };
      const rc = await (await (factory.connect(creator) as any).createCampaignAuthorized(...args)).wait();
      const ev = rc.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CampaignCreated");
      return { campaign: ev.args.campaign as string, token: ev.args.token as string, firstBuyTokens };
    };

    const creator = ethers.Wallet.createRandom().connect(ethers.provider);
    await rpc("anvil_setBalance", [creator.address, ethers.toQuantity(ethers.parseEther("50"))]);
    const first = await create(creator, true);
    const blocked = await create(creator, false);
    check("BEFORE: same wallet, second launch right after the first is refused (the 24h cooldown)", typeof blocked.reason === "string" && /CreatorNotEligible|0x9f9d1b59/.test(blocked.reason), { first: first.campaign, reason: blocked.reason });

    const sim = await simulateAsAdmin(SAFE, [call]);
    console.log(`[open-creators] batch simulated as the Safe: ${JSON.stringify(sim)}`);
    const rc = await (await safe.sendTransaction({ to: F, data: factory.interface.encodeFunctionData("setRegistries", [ethers.ZeroAddress, liveRiskReg]) })).wait();
    check("Safe batch R: setRegistries(0x0, RiskRegistry) succeeds", rc!.status === 1 && (await factory.creatorRegistry()) === ethers.ZeroAddress && (await factory.riskRegistry()) === liveRiskReg, { gas: rc!.gasUsed });
    const elig = await factory.creatorLaunchEligibility(creator.address);
    check("eligibility the API reads: allowed, no cooldown end in the future", elig[0] === true && BigInt(elig[1]) <= BigInt((await ethers.provider.getBlock("latest"))!.timestamp), { allowed: elig[0], cooldownEndsAt: elig[1] });

    const more = [await create(creator, true), await create(creator, true), await create(creator, true)];
    check("AFTER: the same wallet launches 3 more coins back to back (4 live, above the old limit of 3), no wait", more.every((c) => !!c.campaign), { campaigns: more.map((c) => c.campaign) });

    const coin = more[2];
    const token: any = await ethers.getContractAt("LaunchToken", coin.token);
    const campaign: any = await ethers.getContractAt("LaunchCampaignGen7", coin.campaign);
    const value = ethers.parseEther("0.05");
    const [q] = await campaign.quoteBuyExactBnb(value);
    const minOut = (q * 99n) / 100n;
    let deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const sig = await signer.signTradeAuthorization({ signer: authority, chainId: 56n, campaignAddress: coin.campaign, actor: creator.address, routeProfileId: tradeProfile, action: ACT_BUY_NATIVE, amount: value, limit: minOut, deadline });
    const before: bigint = await token.balanceOf(creator.address);
    await (await (campaign.connect(creator) as any).buyExactBnbAuthorized(minOut, tradeProfile, deadline, sig, { value })).wait();
    const after: bigint = await token.balanceOf(creator.address);
    const escrowed: bigint = await campaign.creatorEscrowTotal();
    check("creator buys their own coin right after launch: allowed, tokens go to the C4 escrow (kept, founder 2026-10-10)", after === before && escrowed > 0n, { escrowed, feeBpsNow: await campaign.currentTradeFeeBps() });
    const sellAmt = coin.firstBuyTokens / 2n;
    await (await (token.connect(creator) as any).approve(coin.campaign, sellAmt)).wait();
    const payout: bigint = await campaign.quoteSellExactTokens(sellAmt);
    deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const ssig = await signer.signTradeAuthorization({ signer: authority, chainId: 56n, campaignAddress: coin.campaign, actor: creator.address, routeProfileId: tradeProfile, action: 2, amount: sellAmt, limit: payout, deadline });
    await (await (campaign.connect(creator) as any).sellExactTokensAuthorized(sellAmt, payout, tradeProfile, deadline, ssig)).wait();
    check("creator sells half of the first buy right after launch (first-buy tokens are not locked)", (await token.balanceOf(creator.address)) === after - sellAmt, { sold: sellAmt, payout });

    const gen6After = [await gen6.creatorRegistry(), await gen6.riskRegistry()];
    check("gen-6 factory untouched (its registries are its own)", gen6After[0] === gen6Before[0] && gen6After[1] === gen6Before[1], { gen6: gen6After });
  } finally {
    anvil.kill();
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n[open-creators] ${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
