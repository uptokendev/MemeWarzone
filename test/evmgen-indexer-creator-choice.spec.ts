import { expect } from "chai";
import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { createCoin, req, E, mineAt, buyNative, now, FEE_BUYBACK, type Env } from "./fixtures/evmgenCore";

/**
 * One full week of the indexer's EVM creator-choice operator (realtime-indexer/src/evm/evmCreatorChoicePass.ts)
 * against the compiled CreatorRewardsVaultV2, a real holder RewardDistributor and a throwaway Postgres:
 *   - a buyback coin on the real LaunchCampaign: the curve buyback is authorized by the API's internal endpoint
 *     (frontend/api/evmCreatorChoice.js, the route authority signing for actor = the vault) and accepted by the
 *     campaign's own signature check; after graduation the held tokens are flushed to 0x..dEaD;
 *   - a buyback coin graduated into a locked pool: syncLpFees binds the pool, buybackPool burns MEME to DEAD;
 *   - a holders coin: the snapshot at the week's secret moment, the Monday build (leaf file published, batch
 *     proposed), the Safe signers' script (scripts/evm-holder-batch-verify.mjs) verifies it on chain and its Safe
 *     batch is executed by the admin, the 24 h veto window, executeHolderBatch, and every holder claims.
 * realtime-indexer is an ES module package, so its sources are transpiled here with a require shim.
 */
const E18 = 10n ** 18n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DAY = 86400;
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const ROOT = path.join(__dirname, "..");

function loadIndexer() {
  const dir = path.join(ROOT, "realtime-indexer/src");
  const cache: Record<string, any> = {};
  const load = (rel: string): any => {
    if (cache[rel]) return cache[rel];
    const js = ts.transpileModule(readFileSync(path.join(dir, rel), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} as any };
    cache[rel] = mod.exports;
    const req = (id: string) => {
      if (id.startsWith(".")) return load(path.posix.join(path.posix.dirname(rel), id).replace(/\.js$/, ".ts"));
      return require(id);
    };
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    cache[rel] = mod.exports;
    return mod.exports;
  };
  return {
    rules: load("evm/evmCreatorChoice.ts"),
    chain: load("evm/evmCreatorChoiceChain.ts"),
    pass: load("evm/evmCreatorChoicePass.ts"),
  };
}
const idx = loadIndexer();

async function throwawayDb(port: string) {
  process.env.DBC_THROWAY_PG_PORT = port;
  const { startThrowawayPostgres } = await esmImport(path.join(ROOT, "scripts/dbc/throwaway-postgres.mjs"));
  const pg = await startThrowawayPostgres();
  for (const f of ["db/migrations/20260930_000001_evm_gen5_indexing.sql", "db/migrations/20260930_300001_evm_creator_choice_operator.sql"]) {
    await pg.pool.query(readFileSync(path.join(ROOT, f), "utf8"));
  }
  await pg.pool.query(`
    create table public.reward_batches (id uuid primary key default gen_random_uuid(), reward_type text, chain text, token_symbol text,
      status text, total_amount numeric, recipient_count int, claimable_count int, claimed_count int, failed_count int, source text,
      metadata jsonb, published_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
    create table public.reward_ledger (id uuid primary key default gen_random_uuid(), reward_type text, source_id text, source_label text,
      wallet_address text, chain text, token_symbol text, amount numeric, status text, metadata jsonb, claimable_at timestamptz,
      claim_error text, created_at timestamptz default now(), updated_at timestamptz default now());
    create table public.reward_batch_items (id uuid primary key default gen_random_uuid(), batch_id uuid, reward_ledger_id uuid,
      wallet_address text, amount numeric, status text, metadata jsonb);
  `);
  return pg;
}

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/** An operator wallet with gas, and the worker's ethers chain + sender for `vault`. */
async function operatorFor(vault: string, funder: any) {
  const wallet = ethers.Wallet.createRandom();
  await funder.sendTransaction({ to: wallet.address, value: E18 });
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const provider = ethers.provider as any;
  return {
    wallet,
    chainId,
    chain: idx.chain.createEthersChoiceChain(provider, vault, wallet.address),
    sender: idx.chain.createEthersChoiceSender(provider, new ethers.Wallet(wallet.privateKey), chainId, vault),
  };
}

const CFG_BASE = { masterSecret: "e2e-master", minSpendWei: 10n ** 13n, minPayoutWei: 1n, maxGas: 10_000_000n };

/** A Sunday late enough that this week's snapshot moment and the day's buyback moments have passed. */
const SUNDAY = new Date("2026-10-04T23:59:00Z");
const MONDAY = new Date("2026-10-05T00:10:00Z");

describe("indexer: EVM creator-choice operator against CreatorRewardsVaultV2 (one week)", function () {
  this.timeout(240_000);
  let pg: any;
  before(async () => {
    pg = await throwawayDb("55453");
  });
  after(async () => {
    await pg?.stop();
  });

  it("buyback coin on the real curve: API-signed buybackCurve accepted by LaunchCampaign, tokens held, flushed to DEAD after graduation", async () => {
    const [admin, creator, alice, , authority] = await ethers.getSigners();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const topazRouter = await (await ethers.getContractFactory("MockTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const t = await now();
    await feed.setRoundData(1, 600n * 10n ** 8n, t, t, 1);
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 1_000_000_000);
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const [weekly, monthly, recruiter, protocol] = [await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy()];
    const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
    const v4 = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
    const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(admin.address, await v4.getAddress(), await wbnb.getAddress(), 1, await topazFactory.getAddress(), DAY);
    await v4.setRecruiterRewardsVault(await recruiter.getAddress());
    await v4.setCommunityRewardsVault(await community.getAddress());
    await v4.setProtocolRevenueVault(await protocol.getAddress());
    await v4.setCreatorRewardsVault(await vault.getAddress());
    const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const factory = (await deployFactoryWithLocker({
      factoryName: "LaunchFactory",
      args: [await topazRouter.getAddress(), await v4.getAddress(), await impl.getAddress(), await oracle.getAddress()],
    })).factory;
    await vault.setFactoryOnce(await factory.getAddress());
    const adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    await adapter.setLocker(await factory.permanentLpLocker());
    await factory.setNativeGraduationAdapter(await adapter.getAddress());
    await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
    await factory.setRouteAuthority(authority.address);
    await factory.enableLive();
    const distributor = await (await ethers.getContractFactory("RewardDistributor")).deploy(admin.address);
    await distributor.setBatchOperator(await vault.getAddress());
    await vault.setHolderDistributorOnce(await distributor.getAddress());
    const vaultAddr = await vault.getAddress();
    const op = await operatorFor(vaultAddr, admin);
    await vault.setOperator(op.wallet.address, false);
    await vault.setCaps(E18, 3n * E18, 3600, 50, 10n * E18);

    const env = { factory, authority, creator } as unknown as Env;
    const { campaign, token } = await createCoin(env, req({ feeChoice: FEE_BUYBACK }));
    const c = (await campaign.getAddress()).toLowerCase();
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, alice, E(5));
    const balance = await vault.buybackBalance(c);
    expect(balance > 0n).to.eq(true);

    // The API's internal endpoint, in-process, signing with the factory's route authority.
    const api = await esmImport(path.join(ROOT, "frontend/api/evmCreatorChoice.js"));
    const SECRET = "e2e-secret";
    // The API stamps deadlines from its clock; anchor it on the chain's, which earlier specs in a full
    // `npx hardhat test` run have moved days ahead with evm_increaseTime (else RouteAuthExpired).
    const chainOffsetMs = Number((await ethers.provider.getBlock("latest"))!.timestamp) * 1000 - Date.now();
    const handler = api.createEvmBuybackAuthorizationHandler({
      nowMs: () => Date.now() + chainOffsetMs,
      env: { EVM_CREATOR_CHOICE_API_SECRET: SECRET, [`EVM_CREATOR_VAULT_V2_${op.chainId}`]: `${vaultAddr}@1` },
      getProvider: async () => ethers.provider,
      signer: authority,
      chains: new Set([op.chainId]),
      logAuthorization: async () => {},
    });
    const asked: any[] = [];
    const client = async (r: any) => {
      asked.push(r);
      const res: any = { statusCode: 0, body: null, setHeader() {}, end(text: string) { this.body = JSON.parse(text); } };
      await handler({ method: "POST", headers: { "x-mwz-internal-secret": SECRET }, body: { chainId: r.chainId, campaign: r.campaign, vault: r.vault, amountIn: r.amountIn.toString(), minOut: r.minOut.toString() } }, res);
      if (res.statusCode !== 200) throw new Error(`api ${res.statusCode} ${res.body?.code}`);
      return { signature: res.body.signature, deadline: BigInt(res.body.deadline) };
    };

    const coins = [{ campaign: c, token: (await token.getAddress()).toLowerCase(), creator: creator.address.toLowerCase(), createdBlock: 0, choice: 4, stage: "trading", pool: null }];
    const cfg = { ...idx.pass.DEFAULT_CHOICE_CONFIG, ...CFG_BASE };
    const run = (send: boolean) =>
      idx.pass.runEvmCreatorChoicePass({ db: pg.pool, chainId: op.chainId, chain: op.chain, sender: op.sender, cfg, send, census: async () => [], api: client, now: SUNDAY, coins });

    // Dry run: decides, asks nobody, sends nothing.
    const dry = await run(false);
    expect(dry.steps.some((s: any) => s.action === "buyback_curve" && s.decision === "dry-run")).to.eq(true);
    expect(asked.length).to.eq(0);
    expect(await vault.heldBuybackTokens(c)).to.eq(0n);

    const p1 = await run(true);
    const sent = p1.steps.find((s: any) => s.action === "buyback_curve" && s.decision === "sent");
    expect(sent, JSON.stringify(p1.steps)).to.not.eq(undefined);
    expect(asked[0].vault).to.eq(ethers.getAddress(vaultAddr));
    const held = await vault.heldBuybackTokens(c);
    expect(held > 0n).to.eq(true);
    expect(await token.balanceOf(vaultAddr)).to.eq(held);
    const receipt = await ethers.provider.getTransactionReceipt(sent.txHash);
    expect(receipt!.status).to.eq(1);
    const p2 = await run(true);
    expect((await pg.pool.query(`select status from public.evm_creator_choice_jobs where action = 'buyback_curve'`)).rows[0].status).to.eq("confirmed");
    expect(p2.steps.some((s: any) => s.action === "buyback_curve" && s.decision === "sent")).to.eq(false); // the moment is used

    // Graduate; the held tokens become flushable and go to DEAD.
    await buyNative(env, campaign, alice, E(60));
    await campaign.graduate();
    expect(await token.tradingEnabled()).to.eq(true);
    const p3 = await run(true);
    expect(p3.steps.some((s: any) => s.action === "flush" && s.decision === "sent")).to.eq(true);
    expect(await token.balanceOf(DEAD)).to.eq(held);
    expect(await vault.heldBuybackTokens(c)).to.eq(0n);
    await run(true);
    expect((await pg.pool.query(`select action, status from public.evm_creator_choice_jobs order by id`)).rows).to.deep.eq([
      { action: "buyback_curve", status: "confirmed" },
      { action: "flush", status: "confirmed" },
    ]);
  });

  it("pool buyback after graduation and a holders week: snapshot, publish, propose, Safe batch from the verify script, veto window, execute, claims", async () => {
    await pg.pool.query(`truncate public.evm_creator_choice_jobs, public.evm_holder_batches, public.evm_holder_snapshots, public.evm_holder_snapshot_runs, public.evm_creator_choice_weeks, public.reward_batches, public.reward_ledger, public.reward_batch_items`);
    const [admin, , creator, trader, , h1, h2] = await ethers.getSigners();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const [weekly, monthly, recruiter, protocol] = [await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy()];
    const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
    const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
    const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(admin.address, await router.getAddress(), await weth.getAddress(), 1, await topazFactory.getAddress(), DAY);
    await router.setRecruiterRewardsVault(await recruiter.getAddress());
    await router.setCommunityRewardsVault(await community.getAddress());
    await router.setProtocolRevenueVault(await protocol.getAddress());
    await router.setCreatorRewardsVault(await vault.getAddress());
    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(admin.address);
    await locker.configureRevenue(await router.getAddress(), await topazFactory.getAddress());
    await router.setAuthorizedLpLocker(await locker.getAddress(), true);
    const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await locker.getAddress());
    await vault.setFactoryOnce(await factory.getAddress());
    const distributor = await (await ethers.getContractFactory("RewardDistributor")).deploy(admin.address);
    await distributor.setBatchOperator(await vault.getAddress());
    await vault.setHolderDistributorOnce(await distributor.getAddress());
    const vaultAddr = await vault.getAddress();
    const op = await operatorFor(vaultAddr, admin);
    await vault.setOperator(op.wallet.address, false);
    await vault.setCaps(E18, 3n * E18, 3600, 50, 10n * E18);
    const campaignWith = async (choice: number) => {
      const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), 100n * E18);
      await factory.addCampaign(await campaign.getAddress());
      await factory.choose(vaultAddr, await campaign.getAddress(), creator.address, choice, 0);
      const token = await ethers.getContractAt("MockLaunchTokenEvmGen", await campaign.token());
      return { campaign, token };
    };

    // Buyback coin graduated into a Topaz pair against WBNB, registered the non-keep way (recipient = vault).
    const bb = await campaignWith(4);
    await bb.campaign.connect(trader).payFee(1, { value: 20n * E18 }); // creator slice 5.6% -> 1.12 BNB buyback balance
    await bb.campaign.graduate();
    await bb.campaign.mintTo(admin.address, 2_000_000n * E18);
    const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await topazFactory.setPool(await bb.token.getAddress(), await weth.getAddress(), false, await pair.getAddress());
    await bb.token.approve(await pair.getAddress(), ethers.MaxUint256);
    await weth.deposit({ value: 100n * E18 });
    await weth.approve(await pair.getAddress(), ethers.MaxUint256);
    const memeIs0 = (await pair.token0()).toLowerCase() === (await bb.token.getAddress()).toLowerCase();
    await pair.seed(memeIs0 ? 1_000_000n * E18 : 100n * E18, memeIs0 ? 100n * E18 : 1_000_000n * E18);
    await pair.setTwapFollowsSpot(true);
    await pair.mint(await locker.getAddress(), E18);
    const bbAddr = (await bb.campaign.getAddress()).toLowerCase();
    await locker.registerGraduatedPool(bbAddr, bbAddr, vaultAddr, await pair.getAddress(), await bb.token.getAddress(), await weth.getAddress(), E18);

    // Holders coin: trade fees for the holders, and a token census from its Transfer logs.
    const ho = await campaignWith(2);
    await ho.campaign.connect(trader).payFee(1, { value: 10n * E18 }); // 0.56 BNB for the holders
    const hoAddr = (await ho.campaign.getAddress()).toLowerCase();
    const createdBlock = await ethers.provider.getBlockNumber();
    await ho.campaign.mintTo(h1.address, 300n * E18);
    await ho.campaign.mintTo(h2.address, 100n * E18);
    await ho.campaign.mintTo(creator.address, 1_000n * E18); // the creator never counts
    await ho.campaign.mintTo(await distributor.getAddress(), 500n * E18); // a contract never counts
    const holderPot = await vault.holderBalance(hoAddr);
    expect(holderPot).to.eq((10n * E18 * 560n) / 10_000n);

    const coins = [
      { campaign: bbAddr, token: (await bb.token.getAddress()).toLowerCase(), creator: creator.address.toLowerCase(), createdBlock: 0, choice: 4, stage: "graduated", pool: (await pair.getAddress()).toLowerCase() },
      { campaign: hoAddr, token: (await ho.token.getAddress()).toLowerCase(), creator: creator.address.toLowerCase(), createdBlock, choice: 2, stage: "trading", pool: null },
    ];
    const cfg = { ...idx.pass.DEFAULT_CHOICE_CONFIG, ...CFG_BASE };
    const census = idx.chain.createLogCensus(ethers.provider as any);
    const run = (at: Date) =>
      idx.pass.runEvmCreatorChoicePass({ db: pg.pool, chainId: op.chainId, chain: op.chain, sender: op.sender, cfg, send: true, census, api: null, now: at, coins });

    // Sunday: the snapshot is taken; syncLpFees binds the buyback coin's pool (one transaction in flight).
    const s1 = await run(SUNDAY);
    expect(s1.steps.some((s: any) => s.action === "sync_lp" && s.decision === "sent")).to.eq(true);
    expect((await vault.cfg(bbAddr)).pool).to.eq(await pair.getAddress());
    const snap = (await pg.pool.query(`select wallet, amount::text from public.evm_holder_snapshots where campaign_address = $1 order by amount desc`, [hoAddr])).rows;
    expect(snap).to.deep.eq([
      { wallet: h1.address.toLowerCase(), amount: String(300n * E18) },
      { wallet: h2.address.toLowerCase(), amount: String(100n * E18) },
    ]);
    // Next pass: the sync resolves; the pool buyback burns MEME to DEAD.
    const deadBefore = await bb.token.balanceOf(DEAD);
    const s2 = await run(SUNDAY);
    const buy = s2.steps.find((s: any) => s.action === "buyback_pool" && s.decision === "sent");
    expect(buy, JSON.stringify(s2.steps)).to.not.eq(undefined);
    expect((await bb.token.balanceOf(DEAD)) > deadBefore).to.eq(true);
    expect(await vault.buybackBalance(bbAddr) < (20n * E18 * 560n) / 10_000n).to.eq(true);

    // Monday: the week's holder batch is built, published and proposed.
    await run(MONDAY); // resolves the buyback, proposes
    await run(MONDAY); // resolves the proposal
    const row = (await pg.pool.query(`select * from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0];
    expect(row.status).to.eq("proposed");
    const file = row.leaf_file;
    expect(file.total).to.eq(holderPot.toString());
    expect(file.leaves.map((l: any) => [l.account, l.amount])).to.deep.eq(
      [[h1.address, String((holderPot * 3n) / 4n + (holderPot - (holderPot * 3n) / 4n - holderPot / 4n))], [h2.address, String(holderPot / 4n)]].sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1)),
    );
    expect(await vault.holderBalance(hoAddr)).to.eq(0n);

    // The Safe signers: verify the published file against the chain, then the Safe batch it prints.
    const verify = await esmImport(path.join(ROOT, "scripts/evm-holder-batch-verify.mjs"));
    verify.checkLeafFile(file);
    const vchain = await verify.createEthersVerifyChain(ethers.provider, vaultAddr, { fromBlock: 0 }).init();
    const onchain = await verify.checkOnChain(file, vchain, { vault: vaultAddr });
    expect(onchain.alreadyApproved).to.eq(false);
    const tampered = JSON.parse(JSON.stringify(file));
    tampered.campaigns[0].amount = String(BigInt(tampered.campaigns[0].amount) - 1n);
    tampered.leaves[0].amount = String(BigInt(tampered.leaves[0].amount) - 1n);
    tampered.total = String(BigInt(tampered.total) - 1n);
    expect(() => verify.checkLeafFile(tampered)).to.throw(/root/);
    const chainNow = (await ethers.provider.getBlock("latest"))!.timestamp;
    const safeBatch = verify.safeBatchFor(file, { authMax: String(10n * E18), nowSec: chainNow });
    expect(safeBatch.transactions.length).to.eq(2);
    // Before the Safe signs, nothing executes.
    const w1 = await run(MONDAY);
    expect(w1.steps.some((s: any) => s.kind === "holders" && s.decision === "wait" && /approve/.test(s.reason))).to.eq(true);
    for (const tx of safeBatch.transactions) await admin.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
    // Approved, still inside the 24 h veto window.
    const w2 = await run(MONDAY);
    expect(w2.steps.some((s: any) => s.kind === "holders" && s.decision === "wait" && /veto window/.test(s.reason))).to.eq(true);
    await increase(DAY + 1);
    const ex = await run(MONDAY);
    expect(ex.steps.some((s: any) => s.action === "execute_holder_batch" && s.decision === "sent")).to.eq(true);
    expect((await distributor.batches(file.batchId)).totalFunded).to.eq(holderPot);
    await run(MONDAY);
    expect((await pg.pool.query(`select status from public.evm_holder_batches where week_id = '2026-09-28'`)).rows[0].status).to.eq("executed");
    expect((await pg.pool.query(`select status from public.reward_batches`)).rows[0].status).to.eq("claim_open");

    // Every holder claims with the proof the Claim Center serves.
    const ledger = (await pg.pool.query(`select wallet_address, amount::text, metadata from public.reward_ledger where status = 'claimable'`)).rows;
    expect(ledger.length).to.eq(2);
    for (const signer of [h1, h2]) {
      const l = ledger.find((x: any) => x.wallet_address === signer.address.toLowerCase());
      const before = await ethers.provider.getBalance(signer.address);
      const tx = await distributor.connect(signer).claim(l.metadata.contractBatchId, BigInt(l.amount), l.metadata.merkleProof);
      const rc = await tx.wait();
      const gas = rc!.gasUsed * rc!.gasPrice;
      expect((await ethers.provider.getBalance(signer.address)) - before + gas).to.eq(BigInt(l.amount));
    }
    expect(await distributor.unclaimed(file.batchId)).to.eq(0n);
    // Solvency: the vault still holds every liability.
    expect((await ethers.provider.getBalance(vaultAddr)) >= (await vault.totalLiabilities())).to.eq(true);
  });
});
