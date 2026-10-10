// t7: the full gen-7 lifecycle on the fresh DogeOS stack (scripts/lib/dogeosGen7Stack.ts) on a Chikyū fork, against
// the real MuchFi factory/NPM/SmartRouter and the real WDOGE (spec gate 3, behaviour proven locally first).
//
//   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/DogeosGen7Lifecycle.fork.spec.ts
//
// One coin, in order: owner enableLive + unpause (fork only) -> route-authorized create at the $150 test target ->
// buys from 5 distinct buyers -> a sell -> buys until Pending -> graduate() by a keeper that is not the deployer ->
// the MuchFi 1% pool and the position locked in G3 -> a buy and a sell through S1 (MuchFi SmartRouter) -> LP fees
// harvested through G3 (MuchFi's 32% protocol cut taken at the pool, the 20% protocol share routed by F1) -> the
// creator claims from the creator vault with no operator involved.
//
// Create and trade calls have exactly the shape of test/evmgen7-core-lifecycle.spec.ts and
// scripts/test-robinhood-testnet-gen7-lifecycle.ts; their route authorizations are signed with
// frontend/api/dev-fix/routeAuthorizationSigner.js, as the API does, by a throwaway local wallet whose address is
// the stack's routeAuthority. Every signer is local: hardhat's own funded accounts (admin #0, oracle updater #1,
// keeper #2, creator #3) and throwaway wallets (route authority, 5 buyers) funded with hardhat_setBalance. Nothing is
// sent to Chikyū. Reads are fork-head only (no historical calls): balances are read right before and after each tx.
//
// Per step it records the gas used, the calldata size and the size of the raw signed transaction (re-serialized
// from the mined tx and checked against its hash) and prints a table for t9's DOGE budget.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract, Signer, TransactionReceipt, TransactionResponse } from "ethers";
import { MUCHFI, MUCHFI_FACTORY_ABI, MUCHFI_POOL_ABI, WDOGE_ABI, skipUnlessChikyuFork } from "./helpers/muchfiFork";
import { TESTNET_CAPS } from "../scripts/deploy-robinhood-testnet-gen6-fees";
import { deployDogeosGen7Stack, rescaleNativeCaps, type DogeosGen7Stack } from "../scripts/lib/dogeosGen7Stack";

const E18 = 10n ** 18n;
const BPS = 10_000n;
const CHAIN_ID = 6281971n;
const FEE_TIER = 10000;
const TEST_TARGET = 150n * E18; // LaunchFactoryGen7.TEST_GRADUATION_USD_THRESHOLD, allowed on 6281971
const ETH_USD_8 = 3000n * 10n ** 8n;
const DOGE_USD_8 = 25_000_000n; // $0.25
const AIRDROP_CAP = 500n * E18;
const BLOCK_GAS_LIMIT = 10_000_000n; // Chikyū's real block gas limit (the fork config pins it)
const MUCHFI_PROTOCOL_BPS = 3200n; // slot0.feeProtocol 3200 | 3200 << 16 (test/MuchfiFork.facts.spec.ts)
const FEE_CHOICE_KEEP = 1;
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;
const BUYER_FUNDS = 5_000n * E18;

const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const ROOT = path.resolve(__dirname, "..");
const signerMod: Promise<any> = Function("s", "return import(s)")(
  pathToFileURL(path.join(ROOT, "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href,
);

type GasRow = { step: string; label: string; from: string; gasUsed: bigint; calldataBytes: number; rawTxBytes: number };
type Sent = { rc: TransactionReceipt; gasCost: bigint };

function events(contract: Contract, rc: TransactionReceipt, name: string, address?: string) {
  const at = (address ?? String(contract.target)).toLowerCase();
  const out: any[] = [];
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== at) continue;
    try {
      const p = contract.interface.parseLog({ topics: [...l.topics], data: l.data });
      if (p && p.name === name) out.push(p);
    } catch {
      /* a log this ABI does not declare (e.g. an ERC-20 Transfer from the same address) is skipped */
    }
  }
  return out;
}

/** Raw signed size of a mined tx: re-serialized from the node's copy and proven byte-exact by its hash. */
async function rawSignedTx(hash: string): Promise<{ raw: string; calldataBytes: number }> {
  const t = (await ethers.provider.getTransaction(hash))!;
  const typed = t.type === 2;
  const tx = ethers.Transaction.from({
    type: t.type,
    chainId: t.chainId,
    nonce: t.nonce,
    to: t.to,
    data: t.data,
    value: t.value,
    gasLimit: t.gasLimit,
    ...(typed ? { maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas } : { gasPrice: t.gasPrice }),
    accessList: t.accessList ?? undefined,
    signature: t.signature,
  });
  if (tx.hash !== hash) throw new Error(`re-serialized tx ${tx.hash} != mined ${hash}`);
  return { raw: tx.serialized, calldataBytes: (t.data.length - 2) / 2 };
}

describe("DogeOS gen-7 full lifecycle on a Chikyū fork (t7)", function () {
  let admin: Signer;
  let updater: Signer;
  let keeper: Signer;
  let creator: Signer;
  let A: string;
  let K: string;
  let C: string;
  const routeAuthority = ethers.Wallet.createRandom();
  const buyers = Array.from({ length: 5 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
  const gas: GasRow[] = [];
  let stack: DogeosGen7Stack;
  let signer: any;

  let factory: Contract;
  let router: Contract;
  let vault: Contract;
  let locker: Contract;
  let s1: Contract;
  let npm: Contract;
  let wdoge: Contract;
  let campaign: Contract;
  let token: Contract;
  let campaignAddr: string;
  let tokenAddr: string;
  let tradeProfile: number;
  let finalizeProfile: number;
  let poolAddr: string;
  let pool: Contract;
  let creatorFeesAccrued = 0n;
  // Swap-fee bookkeeping for step 9, from the pool's own Swap events in step 8.
  let wdogeSwapFee = 0n;
  let wdogeProtocolFee = 0n;
  let memeSwapFee = 0n;
  let memeProtocolFee = 0n;

  async function send(step: string, label: string, from: string, p: Promise<TransactionResponse>): Promise<Sent> {
    const tx = await p;
    const rc = (await tx.wait(1))!;
    expect(rc.status, `${label} ${tx.hash}`).to.equal(1);
    expect(same(rc.from, from), `${label} sender`).to.equal(true);
    const { raw, calldataBytes } = await rawSignedTx(tx.hash);
    gas.push({ step, label, from, gasUsed: rc.gasUsed, calldataBytes, rawTxBytes: (raw.length - 2) / 2 });
    return { rc, gasCost: rc.gasUsed * rc.gasPrice };
  }

  const nativeBal = (a: string) => ethers.provider.getBalance(a);
  const latestTs = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  async function tradeAuth(actor: string, action: number, amount: bigint, limit: bigint) {
    const deadline = (await latestTs()) + 3600n;
    const sig = await signer.signTradeAuthorization({
      signer: routeAuthority,
      chainId: CHAIN_ID,
      campaignAddress: campaignAddr,
      actor,
      routeProfileId: tradeProfile,
      action,
      amount,
      limit,
      deadline,
    });
    return { deadline, sig };
  }

  /** Every fee-receiving balance the trade split touches (native). */
  function splitTargets() {
    return [stack.vaults.weekly, stack.vaults.monthly, stack.vaults.recruiter, stack.fees.communityRewardsVault, stack.vaults.protocol, stack.fees.vault];
  }

  /** An authorized exact-native buy (buyExactBnbAuthorized, the API's buy shape), checked by events and deltas. */
  async function buyNative(step: string, label: string, who: Signer, value: bigint) {
    const addr = await who.getAddress();
    const [quotedOut] = await campaign.quoteBuyExactBnb(value);
    expect(quotedOut, `${label} quote`).to.be.greaterThan(0n);
    const a = await tradeAuth(addr, ACT_BUY_NATIVE, value, quotedOut);
    const tokBefore: bigint = await token.balanceOf(addr);
    const natBefore = await nativeBal(addr);
    const targets = splitTargets();
    const tBefore = await Promise.all(targets.map(nativeBal));
    const r = await send(step, label, addr, (campaign.connect(who) as any).buyExactBnbAuthorized(quotedOut, tradeProfile, a.deadline, a.sig, { value }));
    const tAfter = await Promise.all(targets.map(nativeBal));
    const bought = events(campaign, r.rc, "TokensPurchased");
    expect(bought, `${label} TokensPurchased`).to.have.length(1);
    expect(same(bought[0].args.buyer, addr)).to.equal(true);
    const amountOut: bigint = bought[0].args.amountOut;
    const cost: bigint = bought[0].args.cost;
    expect(amountOut).to.be.greaterThanOrEqual(quotedOut);
    expect(cost).to.be.lessThanOrEqual(value);
    expect((await token.balanceOf(addr)) - tokBefore, `${label} MEME delta`).to.equal(amountOut);
    // Native out of the buyer: exactly cost + gas (any unfilled remainder is refunded in the same tx).
    expect(natBefore - (await nativeBal(addr)), `${label} native delta`).to.equal(cost + r.gasCost);

    // The 2% trade fee goes through F1.routeTrade and lands in the vaults exactly as previewTrade splits it.
    const route = events(router, r.rc, "RouteExecuted");
    expect(route, `${label} RouteExecuted`).to.have.length(1);
    const fee: bigint = route[0].args.amountIn;
    expect(same(route[0].args.campaign, campaignAddr)).to.equal(true);
    expect(fee, `${label} 2% fee`).to.equal(((cost - fee) * 200n) / BPS);
    const pv = await router.previewTrade(fee, tradeProfile);
    const league = await router.previewLeagueSplit(pv.league);
    const deltas = tAfter.map((v, i) => v - tBefore[i]);
    expect(deltas, `${label} fee split by balance deltas`).to.deep.equal([
      league.weekly,
      league.monthly,
      pv.recruiter,
      pv.airdrop + pv.squad,
      pv.protocol,
      pv.creator,
    ]);
    const accrued = events(vault, r.rc, "TradeFeeAccrued");
    expect(accrued).to.have.length(1);
    expect(accrued[0].args.amount).to.equal(pv.creator);
    expect(accrued[0].args.toCreator, `${label} Keep: all to the creator`).to.equal(pv.creator);
    expect(pv.creator).to.equal((fee * 560n) / BPS);
    creatorFeesAccrued += pv.creator;
    return { rc: r.rc, amountOut, cost, fee, pending: events(campaign, r.rc, "GraduationPending") };
  }

  before(async function () {
    skipUnlessChikyuFork(this);
    [admin, updater, keeper, creator] = await ethers.getSigners();
    A = await admin.getAddress();
    K = await keeper.getAddress();
    C = await creator.getAddress();
    signer = await signerMod;
    stack = await deployDogeosGen7Stack({
      admin: A,
      routeAuthority: routeAuthority.address,
      oracleUpdater: await updater.getAddress(),
      initialDogeUsdAnswer: DOGE_USD_8,
      caps: rescaleNativeCaps(TESTNET_CAPS, { fromNativeUsd: ETH_USD_8, toNativeUsd: DOGE_USD_8 }),
      airdropCap: AIRDROP_CAP,
      log: () => {},
    });
    factory = (await ethers.getContractAt("LaunchFactoryGen7", stack.generation.factory, admin)) as unknown as Contract;
    router = (await ethers.getContractAt("TreasuryRouterV4", stack.fees.router)) as unknown as Contract;
    vault = (await ethers.getContractAt("MuchfiCreatorRewardsVault", stack.fees.vault)) as unknown as Contract;
    locker = (await ethers.getContractAt("MuchfiV3PositionLocker", stack.generation.positionLocker)) as unknown as Contract;
    s1 = (await ethers.getContractAt("RobinhoodV3NativeSwapAdapterV2", stack.nativeSwapAdapter)) as unknown as Contract;
    npm = new ethers.Contract(
      MUCHFI.NPM,
      [
        "function ownerOf(uint256) view returns (address)",
        "function positions(uint256) view returns (uint96, address, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)",
      ],
      ethers.provider,
    );
    wdoge = new ethers.Contract(MUCHFI.WDOGE, WDOGE_ABI, ethers.provider);
    tradeProfile = Number(await factory.tradeRouteProfile());
    finalizeProfile = Number(await factory.finalizeRouteProfile());
    for (const b of buyers) await ethers.provider.send("hardhat_setBalance", [b.address, ethers.toQuantity(BUYER_FUNDS)]);
  });

  after(function () {
    if (!gas.length) return;
    const rows = gas.map((g) => ({
      step: g.step,
      tx: g.label,
      from: `${g.from.slice(0, 8)}…`,
      gasUsed: g.gasUsed.toString(),
      calldataBytes: g.calldataBytes,
      rawTxBytes: g.rawTxBytes,
    }));
    console.log("\n    [t7] gas per lifecycle tx (fork; raw = signed tx bytes, for t9's L1 fee budget)");
    console.table(rows);
    const total = gas.reduce((s, g) => s + g.gasUsed, 0n);
    const max = gas.reduce((m, g) => (g.gasUsed > m ? g.gasUsed : m), 0n);
    console.log(`    [t7] ${gas.length} txs, total gas ${total}, max single tx gas ${max} (block limit ${BLOCK_GAS_LIMIT})`);
  });

  it("the stack lands paused with the throwaway wallet as route authority; the keeper is not the deployer", async function () {
    expect(await factory.live()).to.equal(false);
    expect(await factory.createPaused()).to.equal(true);
    expect(same(await factory.routeAuthority(), routeAuthority.address)).to.equal(true);
    expect(same(await factory.owner(), A)).to.equal(true);
    expect(same(K, A)).to.equal(false);
    expect(same(C, A) || same(C, K)).to.equal(false);
    expect(new Set(buyers.map((b) => b.address)).size).to.equal(5);
    expect(signer.isSupportedGenerationPair(6281971, Number(await factory.FACTORY_GENERATION()), Number(await factory.CAMPAIGN_GENERATION()))).to.equal(true);
    expect(await factory.isGraduationTargetAllowedForChain(CHAIN_ID, TEST_TARGET)).to.equal(true);
    // No CreatorRegistry on DogeOS (spec section 1, founder 2026-10-10); the RiskRegistry stays.
    expect(await factory.creatorRegistry()).to.equal(ethers.ZeroAddress);
    expect(stack.registries.creatorRegistry).to.equal(null);
    expect(same(await factory.riskRegistry(), stack.registries.riskRegistry)).to.equal(true);
  });

  it("step 1: the owner enables live and unpauses create (fork only)", async function () {
    const live = await send("1", "factory.enableLive", A, factory.enableLive());
    const liveEv = events(factory, live.rc, "LiveEnabled");
    expect(liveEv).to.have.length(1);
    const unpause = await send("1", "factory.setCreatePaused(false)", A, factory.setCreatePaused(false));
    const pauseEv = events(factory, unpause.rc, "CreatePauseUpdated");
    expect(pauseEv).to.have.length(1);
    expect(pauseEv[0].args.paused).to.equal(false);
    expect(await factory.live()).to.equal(true);
    expect(await factory.createPaused()).to.equal(false);
    expect(await factory.requireRouteAuthorization()).to.equal(true);
    expect(await factory.requireAuthorizedTrading()).to.equal(true);
  });

  it("step 2: a route-authorized create at the $150 test target, signed like the API signs it", async function () {
    const req = {
      name: "DogeOS Lifecycle",
      symbol: "DGLC",
      logoURI: "ipfs://memewarzone-dogeos-t7",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: TEST_TARGET,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: FEE_CHOICE_KEEP,
      feeCreatorPct: 0,
    };
    const deadline = (await latestTs()) + 3600n;
    const signature = await signer.signCreateAuthorization({
      signer: routeAuthority,
      chainId: CHAIN_ID,
      factoryAddress: stack.generation.factory,
      creator: C,
      request: req,
      factoryGeneration: Number(await factory.FACTORY_GENERATION()),
      tradeRouteProfileId: tradeProfile,
      finalizeRouteProfileId: finalizeProfile,
      deadline,
    });
    // A signature for another creator is refused: the authorization binds the sender.
    await expect(
      (factory.connect(keeper) as any).createCampaignAuthorized(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }),
    ).to.be.revertedWithCustomError(factory, "InvalidRouteAuthorization");

    const before = await nativeBal(C);
    const r = await send(
      "2",
      "factory.createCampaignAuthorized",
      C,
      (factory.connect(creator) as any).createCampaignAuthorized(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }),
    );
    const created = events(factory, r.rc, "CampaignCreated");
    expect(created).to.have.length(1);
    campaignAddr = created[0].args.campaign;
    tokenAddr = created[0].args.token;
    expect(same(created[0].args.creator, C)).to.equal(true);
    expect(created[0].args.name).to.equal(req.name);
    expect(created[0].args.symbol).to.equal(req.symbol);
    const choice = events(factory, r.rc, "CampaignFeeChoiceSet");
    expect(choice).to.have.length(1);
    expect(same(choice[0].args.vault, stack.fees.vault)).to.equal(true);
    expect(choice[0].args.choice).to.equal(BigInt(FEE_CHOICE_KEEP));
    expect(before - (await nativeBal(C)), "no value sent, gas only").to.equal(r.gasCost);

    campaign = (await ethers.getContractAt("LaunchCampaignGen7", campaignAddr)) as unknown as Contract;
    token = (await ethers.getContractAt("LaunchToken", tokenAddr)) as unknown as Contract;
    expect(await factory.campaignsCount()).to.equal(1n);
    // No CreatorRegistry: the launch records nothing, so the creator has no cooldown and no live-coin limit after it.
    const [allowed, , liveCount, maxLive] = await factory.creatorLaunchEligibility(C);
    expect(allowed).to.equal(true);
    expect(liveCount).to.equal(0n);
    expect(maxLive).to.equal(ethers.MaxUint256);
    expect(await vault.isKeep(campaignAddr)).to.equal(true);
    expect(same((await vault.cfg(campaignAddr)).creator, C)).to.equal(true);
    // The $150 target at $0.25 is a 600 DOGE market cap; the curve raises less than that when it sells out.
    expect(stack.curvesAtDeploy["150"].marketCapNative).to.equal((600n * E18).toString());
    const target: bigint = await campaign.graduationNativeTarget();
    expect(target).to.be.greaterThan(0n);
    expect(target).to.be.lessThan(600n * E18);
    expect(await campaign.sold()).to.equal(0n);
    expect(await campaign.graduationPending()).to.equal(false);
    expect(await campaign.launched()).to.equal(false);
  });

  it("step 3: buys from 5 distinct buyers (2% fee after the 60 s launch window, split exactly)", async function () {
    const launchAt = BigInt(await campaign.launchAt());
    const now = await latestTs();
    if (now < launchAt + 61n) {
      await ethers.provider.send("evm_increaseTime", [Number(launchAt + 61n - now)]);
      await ethers.provider.send("evm_mine", []);
    }
    expect(await campaign.currentTradeFeeBps()).to.equal(200n);
    const target: bigint = await campaign.graduationNativeTarget();
    const each = target / 20n; // 5 buys = 25% of the raise
    for (let i = 0; i < buyers.length; i++) {
      const b = await buyNative("3", `buy ${i + 1} (buyer ${i + 1})`, buyers[i], each);
      expect(b.pending, "no graduation yet").to.have.length(0);
      expect(await token.balanceOf(buyers[i].address)).to.equal(b.amountOut);
    }
    expect(await campaign.graduationPending()).to.equal(false);
  });

  it("step 4: a sell (authorized, 2% fee, payout == quote)", async function () {
    const seller = buyers[0];
    const amount: bigint = (await token.balanceOf(seller.address)) / 2n;
    await send("4", "token.approve(campaign)", seller.address, (token.connect(seller) as any).approve(campaignAddr, amount));
    const quoted: bigint = await campaign.quoteSellExactTokens(amount);
    const a = await tradeAuth(seller.address, ACT_SELL, amount, quoted);
    const natBefore = await nativeBal(seller.address);
    const tokBefore: bigint = await token.balanceOf(seller.address);
    const creatorBefore: bigint = await vault.creatorBalance(campaignAddr);
    const r = await send("4", "sell", seller.address, (campaign.connect(seller) as any).sellExactTokensAuthorized(amount, quoted, tradeProfile, a.deadline, a.sig));
    const sold = events(campaign, r.rc, "TokensSold");
    expect(sold).to.have.length(1);
    expect(same(sold[0].args.seller, seller.address)).to.equal(true);
    expect(sold[0].args.amountIn).to.equal(amount);
    expect(sold[0].args.payout).to.equal(quoted);
    const route = events(router, r.rc, "RouteExecuted");
    expect(route).to.have.length(1);
    const fee: bigint = route[0].args.amountIn;
    expect(fee).to.equal(((quoted + fee) * 200n) / BPS);
    expect((await nativeBal(seller.address)) - natBefore + r.gasCost).to.equal(quoted);
    expect(tokBefore - (await token.balanceOf(seller.address))).to.equal(amount);
    const accrued = events(vault, r.rc, "TradeFeeAccrued");
    expect(accrued).to.have.length(1);
    expect(accrued[0].args.toCreator).to.equal((fee * 560n) / BPS);
    expect((await vault.creatorBalance(campaignAddr)) - creatorBefore).to.equal(accrued[0].args.toCreator);
    creatorFeesAccrued += accrued[0].args.toCreator as bigint;
  });

  it("step 5: buys until Pending (the last buy sells out the curve, enters Pending in that tx, refunds the remainder)", async function () {
    const target: bigint = await campaign.graduationNativeTarget();
    const chunk = target / 3n;
    let i = 1;
    let pendingSeen = false;
    for (let n = 0; n < 8 && !pendingSeen; n++, i = (i + 1) % buyers.length) {
      const b = await buyNative("5", `buy to Pending #${n + 1} (buyer ${i + 1})`, buyers[i], chunk);
      if (b.pending.length) {
        pendingSeen = true;
        expect(b.cost, "partial fill: the unfilled remainder was refunded").to.be.lessThan(chunk);
        expect(b.pending[0].args.nativeTarget).to.equal(target);
      }
    }
    expect(pendingSeen).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    expect(await campaign.sold()).to.equal(await campaign.curveSupply());
  });

  it("step 6: graduate() by the keeper (not the deployer): 2% via routeFinalize, 0 creator, the rest into MuchFi", async function () {
    const g0 = await campaign.getGraduationState();
    const raise: bigint = g0.graduationBalance;
    const P: bigint = g0.finalCurvePrice;
    expect(await nativeBal(campaignAddr)).to.equal(raise);
    const comm0 = await nativeBal(stack.fees.communityRewardsVault);
    const rec0 = await nativeBal(stack.vaults.recruiter);
    const prot0 = await nativeBal(stack.vaults.protocol);

    const r = await send("6", "campaign.graduate (keeper)", K, (campaign.connect(keeper) as any).graduate());
    expect(r.rc.gasUsed).to.be.lessThan(BLOCK_GAS_LIMIT);
    const grad = events(campaign, r.rc, "Graduated");
    expect(grad).to.have.length(1);
    const ev = grad[0].args;
    const protocolShare = (raise * 200n) / BPS;
    expect(ev.raise).to.equal(raise);
    expect(ev.protocolShare).to.equal(protocolShare);
    expect(ev.creatorShare).to.equal(0n);
    expect(ev.repaired).to.equal(false);
    // Start price within the on-chain 50 bps band of the last curve price.
    expect(ev.startPrice * BPS).to.be.greaterThanOrEqual(P * 9950n);
    expect(ev.startPrice * BPS).to.be.lessThanOrEqual(P * 10050n);
    const fin = events(router, r.rc, "RouteExecuted");
    expect(fin).to.have.length(1);
    expect(fin[0].args.amountIn).to.equal(protocolShare);
    const pf = await router.previewFinalize(protocolShare, finalizeProfile);
    expect((await nativeBal(stack.fees.communityRewardsVault)) - comm0).to.equal(pf.airdrop + pf.squad);
    expect((await nativeBal(stack.vaults.recruiter)) - rec0).to.equal(pf.recruiter);
    expect((await nativeBal(stack.vaults.protocol)) - prot0).to.equal(pf.protocol);
    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);
    // gen-7: nothing is owed to the creator at graduation beyond adapter residuals (at most 1 bp of the pool value).
    const residual: bigint = await campaign.pendingCreatorGraduation();
    expect(residual * BPS).to.be.lessThanOrEqual(ev.poolNative as bigint);
    expect(await nativeBal(campaignAddr)).to.equal(residual);
    const g1 = await campaign.getGraduationState();
    poolAddr = ev.pool;
    expect(same(g1.dexPair, poolAddr)).to.equal(true);
    expect(g1.graduatedLiquidityTokens + g1.burnedUnsoldTokens).to.equal(
      (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.curveSupply()),
    );
  });

  it("step 7: the MuchFi 1% pool exists on the MuchFi factory and its position is locked in G3", async function () {
    const v3 = new ethers.Contract(MUCHFI.FACTORY, MUCHFI_FACTORY_ABI, ethers.provider);
    expect(same(await v3.getPool(tokenAddr, MUCHFI.WDOGE, FEE_TIER), poolAddr)).to.equal(true);
    pool = new ethers.Contract(poolAddr, MUCHFI_POOL_ABI, ethers.provider);
    expect(same(await pool.factory(), MUCHFI.FACTORY)).to.equal(true);
    expect(await pool.fee()).to.equal(BigInt(FEE_TIER));
    expect(await pool.tickSpacing()).to.equal(200n);
    const slot0 = await pool.slot0();
    expect(slot0.feeProtocol).to.equal(MUCHFI_PROTOCOL_BPS | (MUCHFI_PROTOCOL_BPS << 16n));

    const info = await locker.poolInfo(poolAddr);
    expect(info.registered).to.equal(true);
    expect(same(info.campaign, campaignAddr)).to.equal(true);
    // Keep coin: the creator is the key and the LP-fee recipient (LaunchFactoryGen7.notifyCampaignGraduated).
    expect(same(info.creator, C)).to.equal(true);
    expect(same(info.creatorFeeRecipient, C)).to.equal(true);
    expect(same(info.memeToken, tokenAddr)).to.equal(true);
    expect(same(info.pairedToken, MUCHFI.WDOGE)).to.equal(true);
    expect(info.feeTier).to.equal(BigInt(FEE_TIER));
    expect(info.creatorFeeBps).to.equal(8000n);
    expect(same(await npm.ownerOf(info.tokenId), stack.generation.positionLocker)).to.equal(true);
    const pos = await npm.positions(info.tokenId);
    expect(pos.liquidity).to.equal(info.lockedLiquidity);
    expect(info.lockedLiquidity).to.be.greaterThan(0n);
    expect(pos.fee).to.equal(BigInt(FEE_TIER));
    // The locked position is the pool's only liquidity, and it is full range for spacing 200.
    expect(await pool.liquidity()).to.equal(info.lockedLiquidity);
    expect(pos.tickLower).to.equal(-887200n);
    expect(pos.tickUpper).to.equal(887200n);
    // No residual native/WDOGE/MEME left in the adapter.
    const g2 = stack.generation.nativeGraduationAdapter;
    expect(await nativeBal(g2)).to.equal(0n);
    expect(await wdoge.balanceOf(g2)).to.equal(0n);
    expect(await token.balanceOf(g2)).to.equal(0n);
  });

  it("step 8: a post-graduation buy and sell through S1 into the MuchFi SmartRouter", async function () {
    const trader = buyers[2];
    const memeIs0 = BigInt(tokenAddr) < BigInt(MUCHFI.WDOGE);
    const deadline = (await latestTs()) + 1800n;

    const buyIn = 20n * E18;
    const outQ: bigint = await (s1.connect(trader) as any).buyExactNativeIn.staticCall(tokenAddr, FEE_TIER, 1n, trader.address, deadline, { value: buyIn });
    expect(outQ).to.be.greaterThan(0n);
    const tok0: bigint = await token.balanceOf(trader.address);
    const nat0 = await nativeBal(trader.address);
    const b = await send("8", "S1.buyExactNativeIn", trader.address, (s1.connect(trader) as any).buyExactNativeIn(tokenAddr, FEE_TIER, (outQ * 99n) / 100n, trader.address, deadline, { value: buyIn }));
    const nb = events(s1, b.rc, "NativeBuy");
    expect(nb).to.have.length(1);
    expect(nb[0].args.nativeIn).to.equal(buyIn);
    const got: bigint = nb[0].args.tokenOut;
    expect((await token.balanceOf(trader.address)) - tok0).to.equal(got);
    expect(nat0 - (await nativeBal(trader.address))).to.equal(buyIn + b.gasCost);
    const bs = events(pool, b.rc, "Swap");
    expect(bs).to.have.length(1);
    expect(same(bs[0].args.sender, MUCHFI.SMART_ROUTER)).to.equal(true);
    const wIn: bigint = memeIs0 ? bs[0].args.amount1 : bs[0].args.amount0;
    expect(wIn).to.equal(buyIn);
    wdogeSwapFee += (wIn * BigInt(FEE_TIER)) / 1_000_000n;
    wdogeProtocolFee += (memeIs0 ? bs[0].args.protocolFeesToken1 : bs[0].args.protocolFeesToken0) as bigint;

    const sellAmt = got / 2n;
    await send("8", "token.approve(S1)", trader.address, (token.connect(trader) as any).approve(stack.nativeSwapAdapter, sellAmt));
    const sq: bigint = await (s1.connect(trader) as any).sellExactTokenIn.staticCall(tokenAddr, FEE_TIER, sellAmt, 1n, trader.address, deadline);
    const nat1 = await nativeBal(trader.address);
    const s = await send("8", "S1.sellExactTokenIn", trader.address, (s1.connect(trader) as any).sellExactTokenIn(tokenAddr, FEE_TIER, sellAmt, (sq * 99n) / 100n, trader.address, deadline));
    const ns = events(s1, s.rc, "NativeSell");
    expect(ns).to.have.length(1);
    expect(ns[0].args.tokenIn).to.equal(sellAmt);
    expect(ns[0].args.nativeOut).to.equal(sq);
    expect((await nativeBal(trader.address)) - nat1 + s.gasCost).to.equal(sq);
    const ss = events(pool, s.rc, "Swap");
    expect(ss).to.have.length(1);
    const mIn: bigint = memeIs0 ? ss[0].args.amount0 : ss[0].args.amount1;
    expect(mIn).to.equal(sellAmt);
    memeSwapFee += (mIn * BigInt(FEE_TIER)) / 1_000_000n;
    memeProtocolFee += (memeIs0 ? ss[0].args.protocolFeesToken0 : ss[0].args.protocolFeesToken1) as bigint;

    // MuchFi takes 32% of each swap's 1% LP fee at the pool (SwapMath rounding: a few wei).
    expect(wdogeProtocolFee).to.be.closeTo((wdogeSwapFee * MUCHFI_PROTOCOL_BPS) / BPS, 2n);
    expect(memeProtocolFee).to.be.closeTo((memeSwapFee * MUCHFI_PROTOCOL_BPS) / BPS, 2n);
    expect(await wdoge.balanceOf(stack.nativeSwapAdapter)).to.equal(0n);
    expect(await token.balanceOf(stack.nativeSwapAdapter)).to.equal(0n);
  });

  it("step 9: LP fees harvested through G3: the 68% left after MuchFi's cut is split 80/20, the 20% routed by F1", async function () {
    const v5 = stack.vaults.protocol;
    const wV5 = await wdoge.balanceOf(v5);
    const wCreator = await wdoge.balanceOf(C);
    const r = await send("9", "G3.harvest (keeper)", K, (locker.connect(keeper) as any).harvest(poolAddr));

    // MEME-side fees are sold on the same MuchFi pool through muchfiV3SwapCallback (bounded 0.5% impact).
    const sold = events(locker, r.rc, "MemeFeesSold");
    expect(sold).to.have.length(1);
    const memeLp = memeSwapFee - memeProtocolFee;
    expect((sold[0].args.memeSold as bigint) + (sold[0].args.memeCarried as bigint)).to.be.closeTo(memeLp, 4n);
    const pairedOut: bigint = sold[0].args.pairedOut;

    const fh = events(locker, r.rc, "FeesHarvested");
    expect(fh).to.have.length(1);
    expect(same(fh[0].args.token, MUCHFI.WDOGE)).to.equal(true);
    const collected: bigint = fh[0].args.collected;
    // WDOGE LP fee = swap fee - MuchFi's 32% (fee-growth rounding: a few wei), plus the MEME sale's proceeds.
    expect(collected - pairedOut).to.be.closeTo(wdogeSwapFee - wdogeProtocolFee, 4n);
    expect(((collected - pairedOut) * BPS) / (collected - pairedOut + wdogeProtocolFee)).to.be.closeTo(6_800n, 1n);
    const creatorPaid: bigint = fh[0].args.creatorPaid;
    const protocolRouted: bigint = fh[0].args.protocolRouted;
    expect(creatorPaid).to.equal((collected * 8000n) / BPS);
    expect(protocolRouted).to.equal(collected - creatorPaid);

    const routed = events(router, r.rc, "LpTokenRouted");
    expect(routed).to.have.length(1);
    expect(same(routed[0].args.locker, stack.generation.positionLocker)).to.equal(true);
    expect(same(routed[0].args.token, MUCHFI.WDOGE)).to.equal(true);
    expect(same(routed[0].args.protocolRevenueVault, v5)).to.equal(true);
    expect(routed[0].args.amount).to.equal(protocolRouted);
    expect((await wdoge.balanceOf(v5)) - wV5).to.equal(protocolRouted);
    expect((await wdoge.balanceOf(C)) - wCreator).to.equal(creatorPaid);
    expect(await locker.cumulativeProtocolRouted(poolAddr, MUCHFI.WDOGE)).to.equal(protocolRouted);
    expect(await wdoge.balanceOf(stack.generation.positionLocker)).to.equal(0n);
    // The principal never moves.
    const info = await locker.poolInfo(poolAddr);
    expect(same(await npm.ownerOf(info.tokenId), stack.generation.positionLocker)).to.equal(true);
    expect((await npm.positions(info.tokenId)).liquidity).to.equal(info.lockedLiquidity);
  });

  it("step 10: the creator claims the Keep trade fees from the creator vault, with no operator involved", async function () {
    const owed: bigint = await vault.creatorBalance(campaignAddr);
    expect(owed).to.equal(creatorFeesAccrued);
    expect(owed).to.be.greaterThan(0n);
    // Only the creator can claim; the vault operator (the admin here) plays no part.
    await expect((vault.connect(keeper) as any).claimCreatorFees(campaignAddr)).to.be.revertedWithCustomError(vault, "NotCreator");
    expect(same(await vault.operator(), C)).to.equal(false);
    const vaultBefore = await nativeBal(stack.fees.vault);
    const before = await nativeBal(C);
    const r = await send("10", "vault.claimCreatorFees", C, (vault.connect(creator) as any).claimCreatorFees(campaignAddr));
    const claimed = events(vault, r.rc, "CreatorFeesClaimed");
    expect(claimed).to.have.length(1);
    expect(same(claimed[0].args.campaign, campaignAddr)).to.equal(true);
    expect(same(claimed[0].args.creator, C)).to.equal(true);
    expect(claimed[0].args.amount).to.equal(owed);
    expect((await nativeBal(C)) - before + r.gasCost).to.equal(owed);
    expect(vaultBefore - (await nativeBal(stack.fees.vault))).to.equal(owed);
    expect(await vault.creatorBalance(campaignAddr)).to.equal(0n);
    await expect((vault.connect(creator) as any).claimCreatorFees(campaignAddr)).to.be.revertedWithCustomError(vault, "NothingToClaim");
  });

  it("every lifecycle tx fits Chikyū's 10M block gas limit, and the gas table covers every step", function () {
    expect(new Set(gas.map((g) => g.step))).to.deep.equal(new Set(["1", "2", "3", "4", "5", "6", "8", "9", "10"]));
    for (const g of gas) {
      expect(g.gasUsed, g.label).to.be.lessThan(BLOCK_GAS_LIMIT);
      expect(g.rawTxBytes, g.label).to.be.greaterThan(g.calldataBytes);
    }
    expect(gas.filter((g) => g.step === "3")).to.have.length(5);
    expect(new Set(gas.filter((g) => g.step === "3").map((g) => g.from)).size).to.equal(5);
  });
});
