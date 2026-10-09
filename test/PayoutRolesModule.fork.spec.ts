/**
 * The payout watchdog's Safe module on a local anvil fork of BNB 56 or Robinhood 4663 with the REAL treasury Safe
 * (1.4.1, 2 of 3): every Safe transaction here is the Safe's own execTransaction, approved by its real owners
 * (impersonated, approveHash) and executed through MultiSendCallOnly 1.4.1, exactly as the Transaction Builder does.
 * Nothing leaves the fork; no key that exists on mainnet signs anything.
 *
 *   npx hardhat test test/PayoutRolesModule.fork.spec.ts --network bscForkRehearsal        (starts anvil on :8645)
 *   npx hardhat test test/PayoutRolesModule.fork.spec.ts --network robinhoodForkRehearsal   (starts anvil on :8646)
 * Upstream (read-only): BSC_MAINNET_RPC / ROBINHOOD_MAINNET_RPC_URL, else the public endpoints.
 *
 * The sequence:
 *   1. Safe batch S0 (fork-only parts marked): gen-7 stack wiring (its own CreatorRewardsVaultV2 + holder distributor +
 *      community vault + airdrop distributor, all Safe-administered, deployed on the fork); FORK-ONLY: the live gen-6
 *      factory's route authority -> a throwaway key, the live gen-6 vault's operator -> a throwaway key (the real ones'
 *      keys are not here).
 *   2. A holders coin on the LIVE gen-6 factory (real create + signed buys: real trade fees into the real gen-6 vault),
 *      a holders coin on the gen-7 vault (fees through its router).
 *   3. scripts/deploy-payout-roles-module.ts (deployer impersonated): Zodiac code verified on chain, proxy deployed,
 *      Safe batch written (scopes, allowances, role, 12-week runway, enableModule). The owners execute it.
 *   4. The real creator-choice operator pass (throwaway Postgres, log census) snapshots both coins at next week's
 *      secret moment, builds, publishes and proposes both weekly holder batches on Monday.
 *   5. The watchdog (realtime-indexer payoutWatchdogWorker.runWatchdogTick, its own key): dry run sends nothing; then
 *      it recomputes both batches from chain data, approves both through the module, and extends every distributor's
 *      runway within the caps and the allowance. The operator executes after the veto window; every holder claims.
 *   6. NEGATIVE, through the real module: Safe native / token transfers, setOperator, setCaps, veto, rescue, approve
 *      above the cap, value, delegatecall, the Safe itself, the module's own admin, an unlisted distributor, other
 *      distributor functions, authorize above the cap and beyond the allowance, a different root (the vault refuses),
 *      a non-member; then the owners disable the module (the script's disable batch) and the watchdog can do nothing.
 */
import { expect } from "chai";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { ethers, network } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { PAYOUT_WATCHDOG_ROLE_KEY } from "../scripts/lib/payoutRolesPolicy";
import { rolesAbi } from "../scripts/lib/zodiacRoles";
import { main as deployRoles, SAFE } from "../scripts/deploy-payout-roles-module";

const ROOT = path.join(__dirname, "..");
const E18 = 10n ** 18n;
const DAY = 86_400;
const WEEK = 7 * DAY;
const DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
const MULTISEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const STATUS = { DelegateCallNotAllowed: 1, TargetAddressNotAllowed: 2, FunctionNotAllowed: 3, SendNotAllowed: 4, ParameterGreaterThanAllowed: 9, AllowanceExceeded: 17 };
const esm = (p: string): Promise<any> => Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, p)).href);

type Net = { chainId: number; port: number; upstream: string; dir: string; wrapped: string; dexKind: number; dexFactory: string; factory6: string; factoryArtifact: string; buy: string };
const NETS: Record<string, Net> = {
  bscForkRehearsal: {
    chainId: 56, port: 8645, dir: "bnb", upstream: process.env.BSC_MAINNET_RPC || process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.bnbchain.org",
    wrapped: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", dexKind: 1, dexFactory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
    factory6: "0x1948411B84424f6f67fDf83ce4A9b8ED49c8bF4F", factoryArtifact: "BnbBasicLaunchFactory", buy: "0.05",
  },
  robinhoodForkRehearsal: {
    chainId: 4663, port: 8646, dir: "robinhood", upstream: process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com",
    wrapped: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", dexKind: 2, dexFactory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    factory6: "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F", factoryArtifact: "LaunchFactory", buy: "0.02",
  },
};

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function isModuleEnabled(address) view returns (bool)",
  "function approveHash(bytes32 hashToApprove)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function enableModule(address module)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
];

/** realtime-indexer is an ES module package: its sources are transpiled here with a require shim (as the evmgen specs do). */
function loadIndexer() {
  const dir = path.join(ROOT, "realtime-indexer/src");
  const cache: Record<string, any> = {};
  const load = (rel: string): any => {
    if (cache[rel]) return cache[rel];
    const js = ts.transpileModule(fs.readFileSync(path.join(dir, rel), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} as any };
    cache[rel] = mod.exports;
    const req = (id: string) => (id.startsWith(".") ? load(path.posix.join(path.posix.dirname(rel), id).replace(/\.js$/, ".ts")) : require(id));
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    cache[rel] = mod.exports;
    return mod.exports;
  };
  return {
    rules: load("evm/evmCreatorChoice.ts"),
    chain: load("evm/evmCreatorChoiceChain.ts"),
    pass: load("evm/evmCreatorChoicePass.ts"),
    wd: load("evm/payoutWatchdog.ts"),
    wdChain: load("evm/payoutWatchdogChain.ts"),
    wdWorker: load("evm/payoutWatchdogWorker.ts"),
  };
}

const net = NETS[network.name];
const d = net ? describe : describe.skip;

d(`payout watchdog Roles module with the REAL Safe (${network.name})`, function () {
  this.timeout(3_600_000);
  let anvil: ChildProcess | null = null;
  let pg: any;
  let idx: ReturnType<typeof loadIndexer>;
  let forkBlock = 0;
  const rpc = (m: string, p: unknown[] = []) => ethers.provider.send(m, p);
  const now = async () => Number((await ethers.provider.getBlock("latest"))!.timestamp);
  const setTime = async (t: number) => {
    await rpc("evm_setNextBlockTimestamp", [ethers.toQuantity(t)]);
    await rpc("evm_mine", []);
  };
  const impersonate = async (a: string, fund = "10") => {
    await rpc("anvil_impersonateAccount", [a]);
    await rpc("anvil_setBalance", [a, ethers.toQuantity(ethers.parseEther(fund))]);
    return ethers.getSigner(a);
  };
  const wallet = async (fund = "5") => {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await rpc("anvil_setBalance", [w.address, ethers.toQuantity(ethers.parseEther(fund))]);
    return w;
  };

  /** The Safe's own execTransaction: threshold owners approveHash, sorted v=1 signatures, MultiSendCallOnly for a batch. */
  async function safeExec(calls: Array<{ to: string; data: string; value?: bigint }>) {
    const safe = new ethers.Contract(SAFE, SAFE_ABI, ethers.provider);
    const owners: string[] = await safe.getOwners();
    const threshold = Number(await safe.getThreshold());
    let to: string, data: string, value: bigint, operation: number;
    if (calls.length === 1) {
      ({ to, data } = calls[0]);
      value = calls[0].value ?? 0n;
      operation = 0;
    } else {
      const packed = ethers.concat(calls.map((c) => ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value ?? 0n, ethers.dataLength(c.data), c.data])));
      to = MULTISEND_CALL_ONLY;
      data = new ethers.Interface(["function multiSend(bytes transactions)"]).encodeFunctionData("multiSend", [packed]);
      value = 0n;
      operation = 1;
    }
    const nonce = await safe.nonce();
    const hash = await safe.getTransactionHash(to, value, data, operation, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
    const signers = owners.slice(0, threshold).map((o) => ethers.getAddress(o)).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    for (const o of signers) await (await (safe.connect(await impersonate(o, "1")) as any).approveHash(hash)).wait();
    const sigs = ethers.concat(signers.map((o) => ethers.concat([ethers.zeroPadValue(o, 32), ethers.ZeroHash, "0x01"])));
    const rc = await (await (safe.connect(await ethers.getSigner(signers[0])) as any).execTransaction(to, value, data, operation, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sigs, { gasLimit: 25_000_000 })).wait();
    expect(rc.logs.some((l: any) => l.address.toLowerCase() === SAFE.toLowerCase() && l.topics[0] === safe.interface.getEvent("ExecutionSuccess")!.topicHash)).to.equal(true);
    return rc;
  }
  const safeExecBatchFile = async (file: string) => {
    const txs = JSON.parse(fs.readFileSync(file, "utf8")).transactions;
    const rc = await safeExec(txs.map((t: any) => ({ to: t.to, data: t.data, value: BigInt(t.value) })));
    console.log(`      Safe executed ${path.basename(file)}: ${txs.length} calls, gas ${rc.gasUsed}`);
    return rc;
  };

  before(async function () {
    const url = String((network.config as any).url);
    const probe = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.ok, () => false);
    if (!(await probe())) {
      anvil = spawn("anvil", ["--fork-url", net.upstream, "--port", String(net.port), "--accounts", "0", "--retries", "20", "--fork-retry-backoff", "1000", "--timeout", "60000", "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
      for (let i = 0; i < 240 && !(await probe()); i += 1) await new Promise((r) => setTimeout(r, 500));
    }
    const fork = await assertLocalFork(net.chainId);
    await rpc("evm_mine", []);
    forkBlock = await ethers.provider.getBlockNumber();
    console.log(`      fork of ${net.chainId} at block ${fork.forkBlock}`);
    idx = loadIndexer();
    process.env.DBC_THROWAY_PG_PORT = String(55470 + (net.chainId % 7));
    const { startThrowawayPostgres } = await esm("scripts/dbc/throwaway-postgres.mjs");
    pg = await startThrowawayPostgres();
    for (const f of ["db/migrations/20260930_000001_evm_gen5_indexing.sql", "db/migrations/20260930_300001_evm_creator_choice_operator.sql", "db/migrations/20261008_000040_evm_holder_batches_per_vault.sql", "db/migrations/20261008_000050_payout_watchdog_state.sql"]) {
      await pg.pool.query(fs.readFileSync(path.join(ROOT, f), "utf8"));
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
      create table public.reward_alerts (id uuid primary key default gen_random_uuid(), severity text, reward_type text, batch_id uuid, title text,
        message text, status text default 'open', metadata jsonb default '{}'::jsonb, created_at timestamptz default now(), resolved_at timestamptz, resolved_by text);
    `);
    await pg.pool.query(fs.readFileSync(path.join(ROOT, "db/migrations/20260710_000002_weekly_airdrop_automation_guards.sql"), "utf8"));
  });

  after(async function () {
    await pg?.stop();
    if (anvil && !process.env.REHEARSAL_KEEP_ANVIL) anvil.kill();
  });

  it("the whole loop on the real Safe: module set up by the owners, both weekly holder batches approved and the runway kept by the watchdog, holders paid; nothing else possible; the owners switch it off", async function () {
    const fees6 = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", net.dir, "mainnet.evmgen-fees.json"), "utf8")).contracts;
    const mainAirdrop = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", net.dir, "mainnet.reward-distributor.json"), "utf8")).address;
    const vault6 = await ethers.getContractAt("CreatorRewardsVaultV2", fees6.vault);
    const hd6 = await ethers.getContractAt("RewardDistributor", fees6.holderDistributor);
    const airdrop6 = await ethers.getContractAt("RewardDistributor", mainAirdrop);
    const limits6 = await vault6.limits();
    const [op6, op7, airOp7, authority, admin7, watchdog, outsider, creator6, creator7] = await Promise.all([wallet(), wallet(), wallet(), wallet(), wallet("50"), wallet("5"), wallet(), wallet(net.chainId === 56 ? "5" : "2"), wallet()]);

    // ---- 1. Gen-7 stack on the fork (Safe-administered) + S0.
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock", admin7);
    const [weekly, monthly, recruiter, protocol] = [await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy()];
    const router7 = await (await ethers.getContractFactory("TreasuryRouterV4", admin7)).deploy(admin7.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
    const vault7 = await (await ethers.getContractFactory("CreatorRewardsVaultV2", admin7)).deploy(SAFE, await router7.getAddress(), net.wrapped, net.dexKind, net.dexFactory, DAY);
    const vault7Block = await ethers.provider.getBlockNumber();
    const locker7 = await (await ethers.getContractFactory("PermanentLpLocker", admin7)).deploy(admin7.address);
    const factory7 = await (await ethers.getContractFactory("MockFactoryEvmGen", admin7)).deploy(await locker7.getAddress());
    const hd7 = await (await ethers.getContractFactory("RewardDistributor", admin7)).deploy(SAFE);
    const community7 = await (await ethers.getContractFactory("CommunityRewardsVault", admin7)).deploy(SAFE, await router7.getAddress());
    const airdrop7 = await (await ethers.getContractFactory("RewardDistributor", admin7)).deploy(SAFE);
    await (await router7.setRecruiterRewardsVault(await recruiter.getAddress())).wait();
    await (await router7.setCommunityRewardsVault(await community7.getAddress())).wait();
    await (await router7.setProtocolRevenueVault(await protocol.getAddress())).wait();
    await (await router7.setCreatorRewardsVault(await vault7.getAddress())).wait();
    const factory6 = await ethers.getContractAt(net.factoryArtifact, net.factory6);
    const V = vault7.interface;
    await safeExec([
      { to: await vault7.getAddress(), data: V.encodeFunctionData("setFactoryOnce", [await factory7.getAddress()]) },
      { to: await hd7.getAddress(), data: hd7.interface.encodeFunctionData("setBatchOperator", [await vault7.getAddress()]) },
      { to: await vault7.getAddress(), data: V.encodeFunctionData("setHolderDistributorOnce", [await hd7.getAddress()]) },
      { to: await vault7.getAddress(), data: V.encodeFunctionData("setOperator", [op7.address, false]) },
      { to: await vault7.getAddress(), data: V.encodeFunctionData("setCaps", [limits6[1], limits6[2], limits6[3], limits6[4], limits6[5]]) },
      { to: await community7.getAddress(), data: community7.interface.encodeFunctionData("setRewardDistributor", [await airdrop7.getAddress()]) },
      { to: await community7.getAddress(), data: community7.interface.encodeFunctionData("setAirdropOperator", [airOp7.address]) },
      { to: await airdrop7.getAddress(), data: airdrop7.interface.encodeFunctionData("setBatchOperator", [await community7.getAddress()]) },
      // FORK-ONLY: the real route authority and gen-6 operator keys are not here.
      { to: net.factory6, data: factory6.interface.encodeFunctionData("setRouteAuthority", [authority.address]) },
      { to: fees6.vault, data: vault6.interface.encodeFunctionData("setOperator", [op6.address, false]) },
    ]);

    // ---- 2. A holders coin on the LIVE gen-6 factory, real trade fees into the real gen-6 vault.
    const signer = await esm("frontend/api/dev-fix/routeAuthorizationSigner.js");
    const cfg = await (factory6 as any).config();
    const tradeProfile = Number(await (factory6 as any).tradeRouteProfile());
    const finalizeProfile = Number(await (factory6 as any).finalizeRouteProfile());
    const fGen = Number(await (factory6 as any).FACTORY_GENERATION());
    const firstBuyTokens = ethers.parseEther("10000000");
    const noFee = (firstBuyTokens * cfg.basePrice) / E18 + (cfg.priceSlope * firstBuyTokens * firstBuyTokens) / (2n * E18 * E18);
    const firstBuyMaxCost = noFee + (noFee * 200n) / 10_000n;
    const req = { name: "Watchdog Fork", symbol: `WD${net.chainId}`, logoURI: "ipfs://mwz-payout-watchdog-fork", xAccount: "", website: "", extraLink: "", graduationTarget: ethers.parseEther("15000"), firstBuyTokens, firstBuyMaxCost, feeChoice: 2, feeCreatorPct: 0 };
    const deadline = BigInt(await now()) + 3600n;
    const signature = await signer.signCreateAuthorization({ signer: authority, chainId: BigInt(net.chainId), factoryAddress: net.factory6, creator: creator6.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline });
    const createRc = await (await (factory6.connect(creator6) as any).createCampaignAuthorized(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }, { value: firstBuyMaxCost + ethers.parseEther("0.001") })).wait();
    const created = createRc.logs.map((l: any) => { try { return factory6.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CampaignCreated");
    const camp6 = await ethers.getContractAt("LaunchCampaign", created.args.campaign);
    const token6 = await ethers.getContractAt("LaunchToken", created.args.token);
    expect(Number((await vault6.cfg(created.args.campaign)).choice)).to.equal(2);
    await setTime((await now()) + 61);
    const buyers6 = [await wallet(), await wallet(), await wallet()];
    for (const [i, b] of buyers6.entries()) {
      const value = ethers.parseEther(net.buy) * BigInt(i + 1);
      const [q] = await camp6.quoteBuyExactBnb(value);
      const min = (q * 99n) / 100n;
      const dl = BigInt(await now()) + 3600n;
      const sig = await signer.signTradeAuthorization({ signer: authority, chainId: BigInt(net.chainId), campaignAddress: created.args.campaign, actor: b.address, routeProfileId: tradeProfile, action: 1, amount: value, limit: min, deadline: dl });
      await (await (camp6.connect(b) as any).buyExactBnbAuthorized(min, tradeProfile, dl, sig, { value })).wait();
    }
    const pot6: bigint = await vault6.holderBalance(created.args.campaign);
    expect(pot6 > 0n).to.equal(true);

    // A holders coin on the gen-7 vault: fees through the gen-7 router, three holders.
    const camp7 = await (await ethers.getContractFactory("MockCampaignEvmGen", admin7)).deploy(await router7.getAddress(), 1000n * E18);
    await (await factory7.addCampaign(await camp7.getAddress())).wait();
    await (await factory7.choose(await vault7.getAddress(), await camp7.getAddress(), creator7.address, 2, 0)).wait();
    const camp7Block = await ethers.provider.getBlockNumber();
    await (await camp7.payFee(1, { value: ethers.parseEther("1") })).wait();
    const holders7 = [await wallet("0.1"), await wallet("0.1"), await wallet("0.1")];
    for (const [i, h] of holders7.entries()) await (await camp7.mintTo(h.address, BigInt(100 * (i + 1)) * E18)).wait();
    await (await camp7.mintTo(creator7.address, 1000n * E18)).wait();
    const pot7: bigint = await vault7.holderBalance(await camp7.getAddress());
    expect(pot7 > 0n).to.equal(true);

    // ---- 3. The module: the deploy script, then the owners execute its batch.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-payout-roles-fork-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PAYOUT_ROLES_MODE: "",
      [`PAYOUT_WATCHDOG_ADDRESS_${net.chainId}`]: watchdog.address,
      [`PAYOUT_ROLES_GEN7_VAULT_${net.chainId}`]: await vault7.getAddress(),
      [`PAYOUT_ROLES_GEN7_AIRDROP_DISTRIBUTOR_${net.chainId}`]: await airdrop7.getAddress(),
      PAYOUT_ROLES_RUNWAY_WEEKS: "12",
      REHEARSAL_OUT_DIR: outDir,
    };
    // A watchdog that is any money key is refused before anything is sent.
    for (const bad of [op6.address, "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50", (await new ethers.Contract(SAFE, SAFE_ABI, ethers.provider).getOwners())[0], DEPLOYER]) {
      let msg = "";
      try {
        await deployRoles({ signer: await impersonate(DEPLOYER, "1"), env: { ...env, [`PAYOUT_WATCHDOG_ADDRESS_${net.chainId}`]: bad } });
      } catch (e: any) {
        msg = String(e.message);
      }
      expect(msg, bad).to.match(/REFUSED: watchdog/);
    }
    const out: any = await deployRoles({ signer: await impersonate(DEPLOYER, "1"), env });
    const rolesAddr = out.record.roles;
    const caps = Object.fromEntries(out.record.distributors.map((x: any) => [x.address.toLowerCase(), BigInt(x.capWei)]));
    console.log(`      Roles proxy ${rolesAddr}; ${out.calls.length} Safe calls (${out.runway.length} runway); caps ${JSON.stringify(out.record.distributors.map((x: any) => [x.label, ethers.formatEther(x.capWei)]))}`);
    expect(await new ethers.Contract(SAFE, SAFE_ABI, ethers.provider).isModuleEnabled(rolesAddr)).to.equal(false);
    await safeExecBatchFile(out.batchFile);
    expect(await new ethers.Contract(SAFE, SAFE_ABI, ethers.provider).isModuleEnabled(rolesAddr)).to.equal(true);
    const roles = new ethers.Contract(rolesAddr, rolesAbi(), watchdog);
    const exec = (to: string, data: string, o: { value?: bigint; operation?: number; from?: any } = {}) =>
      (roles.connect(o.from ?? watchdog) as any).execTransactionWithRole(to, o.value ?? 0n, data, o.operation ?? 0, PAYOUT_WATCHDOG_ROLE_KEY, true);

    // ---- 4. The operator: next week's snapshot at its secret moment, Monday build + propose for both vaults.
    const MASTER = "payout-watchdog-fork-master";
    const t0 = await now();
    const W1 = idx.rules.weekOf(new Date((t0 + WEEK) * 1000));
    const moment = Math.floor(idx.rules.snapshotMoment(idx.rules.weekSecret(MASTER, net.chainId, W1.weekId), net.chainId, W1.start).getTime() / 1000);
    await setTime(moment + 60);
    const ccfg = { ...idx.pass.DEFAULT_CHOICE_CONFIG, masterSecret: MASTER, minSpendWei: 10n ** 13n, minPayoutWei: 1n, maxGas: 10_000_000n };
    const census = idx.chain.createLogCensus(ethers.provider as any, 2_000);
    const lane = (vault: string, op: any, program: string, coins: any[]) => async () =>
      idx.pass.runEvmCreatorChoicePass({
        db: pg.pool, chainId: net.chainId, chain: idx.chain.createEthersChoiceChain(ethers.provider as any, vault, op.address),
        sender: idx.chain.createEthersChoiceSender(ethers.provider as any, new ethers.Wallet(op.privateKey), net.chainId, vault),
        cfg: ccfg, send: true, census, api: null, program, now: new Date((await now()) * 1000), coins,
      });
    const pass6 = lane(fees6.vault, op6, "airdrop_holders", [{ campaign: created.args.campaign.toLowerCase(), token: created.args.token.toLowerCase(), creator: creator6.address.toLowerCase(), createdBlock: createRc.blockNumber, choice: 2, stage: "trading", pool: null }]);
    const pass7 = lane(await vault7.getAddress(), op7, "airdrop_holders_gen7", [{ campaign: (await camp7.getAddress()).toLowerCase(), token: (await camp7.token()).toLowerCase(), creator: creator7.address.toLowerCase(), createdBlock: camp7Block, choice: 2, stage: "trading", pool: null }]);
    for (const p of [pass6, pass7]) {
      const r = await p();
      expect(r.steps.filter((s: any) => s.kind === "snapshot" && s.decision === "sent").length, JSON.stringify(r.steps)).to.equal(1);
    }
    await setTime(Math.floor(W1.end.getTime() / 1000) + 600); // Monday 00:10 UTC
    for (const p of [pass6, pass6, pass7, pass7]) await p();
    const rows = (await pg.pool.query(`select vault_address, batch_id, status, root, total_raw from public.evm_holder_batches where week_id = $1 order by vault_address`, [W1.weekId])).rows;
    expect(rows.map((r: any) => r.status)).to.deep.equal(["proposed", "proposed"]);
    const b6 = rows.find((r: any) => r.vault_address === fees6.vault.toLowerCase());
    const v7lc = (await vault7.getAddress()).toLowerCase();
    const b7 = rows.find((r: any) => r.vault_address === v7lc);
    expect(BigInt(b6.total_raw)).to.equal(pot6);
    expect(BigInt(b7.total_raw)).to.equal(pot7);
    // Before the watchdog: a different root is refused by the vault (Roles allows the call shape).
    await expect(exec(fees6.vault, vault6.interface.encodeFunctionData("approveHolderBatch", [b6.batch_id, ethers.id("not the root"), BigInt(b6.total_raw)]))).to.be.revertedWithCustomError(roles, "ModuleTransactionFailed");

    // ---- 5. The watchdog.
    const wdCfg = {
      chainId: net.chainId, send: false, roles: rolesAddr, safe: SAFE,
      vaults: [
        { vault: ethers.getAddress(fees6.vault), program: "airdrop_holders", label: "gen-6", startBlock: forkBlock, holderCapWei: null },
        { vault: await vault7.getAddress(), program: "airdrop_holders_gen7", label: "gen-7", startBlock: vault7Block, holderCapWei: null },
      ],
      airdrops: [
        { label: "main airdrop", kind: "airdrop", address: ethers.getAddress(mainAirdrop), pot: "main", capWei: caps[mainAirdrop.toLowerCase()] },
        { label: "gen-7 airdrop", kind: "airdrop", address: await airdrop7.getAddress(), pot: "gen7", capWei: caps[(await airdrop7.getAddress()).toLowerCase()] },
      ],
      weeks: 12, intervalMs: 60_000, lookbackBlocks: 100_000, logChunk: 2_000, censusLagBlocks: 20, snapshotToleranceSec: 12 * 3600, maxExcludedBps: 2_000, maxTxPerTick: 30,
      minPayoutWei: 1n, claimWindowDays: ccfg.claimWindowDays, excluded: new Set<string>(), masterSecret: MASTER,
    };
    const wchain = idx.wdChain.createEthersWatchdogChain(ethers.provider as any, { logChunk: 2_000 });
    const sender = idx.wdChain.createEthersWatchdogSender(ethers.provider as any, new ethers.Wallet(watchdog.privateKey));
    // The key check against the chain's own role holders passes for this key and refuses the gen-6 operator.
    const refusals = await idx.wdWorker.onChainRefusals(wchain, wdCfg);
    expect(refusals.some((r: any) => r.address === op6.address.toLowerCase())).to.equal(true);
    const memory = idx.wdWorker.emptyMemory();
    const nonceBefore = await ethers.provider.getTransactionCount(watchdog.address);
    const dry = await idx.wdWorker.runWatchdogTick({ db: pg.pool, cfg: wdCfg, chain: wchain, sender, memory, log: () => {} });
    expect(await ethers.provider.getTransactionCount(watchdog.address)).to.equal(nonceBefore);
    expect(dry.actions.filter((a: any) => a.kind === "approve" && a.decision === "dry-run").length, JSON.stringify(dry.actions)).to.equal(2);
    expect(dry.roleOk && dry.moduleEnabled && dry.wiringOk).to.equal(true);

    const live = await idx.wdWorker.runWatchdogTick({ db: pg.pool, cfg: { ...wdCfg, send: true }, chain: wchain, sender, memory, log: () => {} });
    console.log(`      watchdog: ${live.actions.filter((a: any) => a.decision === "sent").length} sent; coverage ${JSON.stringify(live.coverage.map((c: any) => [c.label, c.coveredWeeks]))}`);
    expect(live.actions.filter((a: any) => a.kind === "approve" && a.decision === "sent").length, JSON.stringify(live.actions)).to.equal(2);
    expect(live.actions.filter((a: any) => a.decision === "refused" || a.decision === "failed"), JSON.stringify(live.actions)).to.deep.equal([]);
    for (const c of live.coverage) expect(c.coveredWeeks, c.label).to.be.gte(12);
    // Every authorization the watchdog made follows the formulas, at the cap, in the 6-day window.
    for (const a of live.actions.filter((x: any) => x.kind === "authorize" && x.decision === "sent")) {
      const dist = await ethers.getContractAt("RewardDistributor", a.target);
      const auth = await dist.batchAuthorization(a.subject);
      expect(auth.authorized).to.equal(true);
      expect(auth.maxAmount).to.equal(caps[a.target.toLowerCase()]);
      expect(Number(auth.publishDeadline) - Number(auth.publishAfter)).to.equal(6 * DAY);
    }
    expect(live.actions.filter((a: any) => a.kind === "authorize" && a.decision === "sent").length).to.be.greaterThan(0);

    // The operator executes after the 24 h veto window; every holder claims from the distributor.
    await setTime((await now()) + DAY + 60);
    for (const p of [pass6, pass6, pass7, pass7]) await p();
    expect((await hd6.batches(b6.batch_id)).totalFunded).to.equal(pot6);
    expect((await hd7.batches(b7.batch_id)).totalFunded).to.equal(pot7);
    const ledger = (await pg.pool.query(`select wallet_address, amount::text, metadata from public.reward_ledger where status = 'claimable'`)).rows;
    expect(ledger.length).to.equal(buyers6.length + holders7.length);
    for (const w of [...buyers6, ...holders7]) {
      const l = ledger.find((x: any) => x.wallet_address === w.address.toLowerCase());
      const dist = await ethers.getContractAt("RewardDistributor", l.metadata.distributorAddress, w);
      await (await dist.claim(l.metadata.contractBatchId, BigInt(l.amount), l.metadata.merkleProof)).wait();
    }
    expect(await hd6.unclaimed(b6.batch_id)).to.equal(0n);
    expect(await hd7.unclaimed(b7.batch_id)).to.equal(0n);

    // ---- 6. NEGATIVE through the real module.
    const t = await now();
    const wrapped = new ethers.Contract(net.wrapped, ["function deposit() payable", "function transfer(address,uint256) returns (bool)"], await impersonate(SAFE, "3"));
    await (await wrapped.deposit({ value: E18 })).wait();
    await rpc("anvil_stopImpersonatingAccount", [SAFE]);
    const refused = async (p: Promise<any>, status: number) => expect(p).to.be.revertedWithCustomError(roles, "ConditionViolation").withArgs(status, anyValue);
    await refused(exec(outsider.address, "0x", { value: E18 }), STATUS.TargetAddressNotAllowed);
    await refused(exec(net.wrapped, wrapped.interface.encodeFunctionData("transfer", [outsider.address, E18])), STATUS.TargetAddressNotAllowed);
    await refused(exec(fees6.vault, vault6.interface.encodeFunctionData("setOperator", [outsider.address, false])), STATUS.FunctionNotAllowed);
    await refused(exec(fees6.vault, vault6.interface.encodeFunctionData("setCaps", [1n, 1n, 1n, 1n, 1n])), STATUS.FunctionNotAllowed);
    await refused(exec(await vault7.getAddress(), V.encodeFunctionData("rescueExcessNative", [outsider.address, 1n])), STATUS.FunctionNotAllowed);
    await refused(exec(fees6.vault, vault6.interface.encodeFunctionData("approveHolderBatch", [b6.batch_id, b6.root, limits6[5] + 1n])), STATUS.ParameterGreaterThanAllowed);
    await refused(exec(fees6.vault, vault6.interface.encodeFunctionData("approveHolderBatch", [b6.batch_id, b6.root, 1n]), { value: 1n }), STATUS.SendNotAllowed);
    await refused(exec(fees6.vault, vault6.interface.encodeFunctionData("approveHolderBatch", [b6.batch_id, b6.root, 1n]), { operation: 1 }), STATUS.DelegateCallNotAllowed);
    const safeIface = new ethers.Interface(SAFE_ABI);
    await refused(exec(SAFE, safeIface.encodeFunctionData("addOwnerWithThreshold", [outsider.address, 1n])), STATUS.TargetAddressNotAllowed);
    await refused(exec(SAFE, safeIface.encodeFunctionData("enableModule", [outsider.address])), STATUS.TargetAddressNotAllowed);
    await refused(exec(rolesAddr, roles.interface.encodeFunctionData("assignRoles", [outsider.address, [PAYOUT_WATCHDOG_ROLE_KEY], [true]])), STATUS.TargetAddressNotAllowed);
    const unlisted = await (await ethers.getContractFactory("RewardDistributor", admin7)).deploy(SAFE);
    await refused(exec(await unlisted.getAddress(), unlisted.interface.encodeFunctionData("authorizeBatch", [ethers.id("x"), 1n, t + WEEK, t + 2 * WEEK])), STATUS.TargetAddressNotAllowed);
    for (const [fn, args] of [["revokeBatch", [ethers.id("x")]], ["setBatchOperator", [outsider.address]], ["recoverUnclaimed", [ethers.id("x"), outsider.address]], ["rescueExcessNative", [outsider.address, 1n]], ["setBatchPaused", [ethers.id("x"), true]], ["transferOwnership", [outsider.address]]] as const) {
      await refused(exec(mainAirdrop, airdrop6.interface.encodeFunctionData(fn as any, args as any)), STATUS.FunctionNotAllowed);
    }
    const capMain = caps[mainAirdrop.toLowerCase()];
    await refused(exec(mainAirdrop, airdrop6.interface.encodeFunctionData("authorizeBatch", [ethers.id("over cap"), capMain + 1n, t + WEEK, t + 2 * WEEK])), STATUS.ParameterGreaterThanAllowed);
    // The allowance: what the watchdog has left this period, then one wei more is refused.
    const key = out.record.allowances.find((a: any) => a.distributor.toLowerCase() === mainAirdrop.toLowerCase()).key;
    const al = await new ethers.Contract(rolesAddr, rolesAbi(), ethers.provider).allowances(key);
    let left = BigInt(al.balance);
    let i = 0;
    while (left > 0n) {
      const amt = left > capMain ? capMain : left;
      await (await exec(mainAirdrop, airdrop6.interface.encodeFunctionData("authorizeBatch", [ethers.id(`drain ${i++}`), amt, t + 30 * WEEK, t + 31 * WEEK]))).wait();
      left -= amt;
    }
    await refused(exec(mainAirdrop, airdrop6.interface.encodeFunctionData("authorizeBatch", [ethers.id("one more"), 1n, t + 30 * WEEK, t + 31 * WEEK])), STATUS.AllowanceExceeded);
    await expect(exec(fees6.vault, vault6.interface.encodeFunctionData("approveHolderBatch", [b6.batch_id, b6.root, BigInt(b6.total_raw)]), { from: outsider })).to.be.reverted;
    await expect((vault6.connect(watchdog) as any).approveHolderBatch(b6.batch_id, b6.root, BigInt(b6.total_raw))).to.be.revertedWithCustomError(vault6, "OnlyAdmin");

    // The owners switch it off with the script's disable batch; afterwards the watchdog can do nothing.
    const off: any = await deployRoles({ signer: await impersonate(DEPLOYER, "1"), env: { ...env, PAYOUT_ROLES_MODE: "disable" } });
    await safeExecBatchFile(off.batchFile);
    expect(await new ethers.Contract(SAFE, SAFE_ABI, ethers.provider).isModuleEnabled(rolesAddr)).to.equal(false);
    // A call Roles itself allows (approve, no allowance involved) now stops at the Safe: GS104, module not enabled.
    await expect(exec(fees6.vault, vault6.interface.encodeFunctionData("approveHolderBatch", [ethers.ZeroHash, ethers.ZeroHash, 0n]))).to.be.revertedWith("GS104");
    await expect(exec(mainAirdrop, airdrop6.interface.encodeFunctionData("authorizeBatch", [ethers.id("after off"), 1n, t + 40 * WEEK, t + 41 * WEEK]))).to.be.reverted;
    const after = await idx.wdWorker.runWatchdogTick({ db: pg.pool, cfg: { ...wdCfg, send: true }, chain: wchain, sender, memory, log: () => {} });
    expect(after.moduleEnabled).to.equal(false);
    expect(after.actions).to.deep.equal([]);
    const alerts = (await pg.pool.query(`select severity, metadata->>'kind' as kind from public.reward_alerts where status = 'open' and reward_type = 'payout_watchdog'`)).rows;
    expect(alerts.some((a: any) => a.kind === "payout_watchdog_module" && a.severity === "critical")).to.equal(true);
  });
});
