/**
 * The payout watchdog's Roles module for GEN-8 ONLY, on a local anvil fork of BNB 56 or Robinhood 4663, against the
 * REAL treasury Safe, the REAL gen-8 MwzCreatorChoiceVault 0xaf11784a69964A576716a5e4b514341F4437CAd3 and its REAL
 * holder RewardDistributor (read from holderDistributor()). Every Safe transaction is the Safe's own execTransaction,
 * approved by its real owners (impersonated, approveHash) through MultiSendCallOnly 1.4.1, as the Transaction Builder
 * does. Nothing leaves the fork; no key that exists on mainnet signs anything.
 *
 *   BSC_FORK_REHEARSAL_URL=http://127.0.0.1:8792 npx hardhat test test/PayoutRolesModuleGen8.fork.spec.ts --network bscForkRehearsal
 *   ROBINHOOD_FORK_REHEARSAL_URL=http://127.0.0.1:8793 npx hardhat test test/PayoutRolesModuleGen8.fork.spec.ts --network robinhoodForkRehearsal
 * The spec starts anvil on the network's port when nothing answers there. Upstream (read-only): BSC_MAINNET_RPC /
 * ROBINHOOD_MAINNET_RPC_URL, else https://bsc-rpc.publicnode.com / https://rpc.mainnet.chain.robinhood.com.
 *
 *   1. scripts/deploy-payout-roles-module.ts with gen-6/7 and the airdrop distributors "none" and
 *      PAYOUT_ROLES_GEN8_VAULT_<id> = the gen-8 vault: Zodiac code verified on the chain, proxy deployed by a throwaway
 *      payer, Safe batch + record written under deployments/fork-rehearsal/<network>/ (never a mainnet record).
 *   2. The real owners execute the batch.
 *   3. (a) approveHolderBatch(bytes32,bytes32,uint256,uint64) through the role reaches the real vault: an unknown batch
 *      id answers the vault's BadBatch (the permission passed); (b) authorizeBatch on the real gen-8 distributor within
 *      the cap succeeds, above it / beyond the allowance is refused; (c) every other function, target, value and
 *      delegatecall is refused by Roles; a non-member has no role.
 *   4. The real watchdog tick (realtime-indexer, gen-8 lane only): health ok through the gen-8 probe, dry run sends
 *      nothing, then it keeps the gen-8 distributor's runway within the caps.
 *   5. The owners' disable batch: afterwards the module can do nothing (GS104).
 */
import { expect } from "chai";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { ethers, network } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { GEN8_APPROVE_SELECTOR, PAYOUT_WATCHDOG_ROLE_KEY, SELECTOR } from "../scripts/lib/payoutRolesPolicy";
import { rolesAbi } from "../scripts/lib/zodiacRoles";
import { main as deployRoles, SAFE } from "../scripts/deploy-payout-roles-module";

const ROOT = path.join(__dirname, "..");
const DAY = 86_400;
const WEEK = 7 * DAY;
const GEN8_VAULT = "0xaf11784a69964A576716a5e4b514341F4437CAd3";
const MULTISEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const STATUS = { DelegateCallNotAllowed: 1, TargetAddressNotAllowed: 2, FunctionNotAllowed: 3, SendNotAllowed: 4, ParameterLessThanAllowed: 8, ParameterGreaterThanAllowed: 9, AllowanceExceeded: 17 };

type Net = { chainId: number; upstream: string };
const NETS: Record<string, Net> = {
  bscForkRehearsal: { chainId: 56, upstream: process.env.BSC_MAINNET_RPC || "https://bsc-rpc.publicnode.com" },
  robinhoodForkRehearsal: { chainId: 4663, upstream: process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com" },
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
const VAULT_ABI = [
  "function admin() view returns (address)",
  "function operator() view returns (address)",
  "function holderDistributor() view returns (address)",
  "function maxHolderBatchPerWeek() view returns (uint256)",
  "function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline)",
  "function setOperator(address operator_, bool paused_)",
  "function setCaps(uint256,uint256,uint256,uint256,uint256)",
  "function vetoHolderBatch(bytes32 batchId)",
  "function rescueExcessNative(address to, uint256 amount)",
  "function setHolderDistributorOnce(address distributor)",
  "function creditUnclaimedHolders(bytes32[] ids, uint256[] amounts)",
  "function executeHolderBatch(bytes32 batchId)",
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, bytes32[] ids, uint256[] amounts)",
  "error BadBatch()",
  "error OnlyAdmin()",
];
const DIST_ABI = [
  "function owner() view returns (address)",
  "function batchOperator() view returns (address)",
  "function authorizeBatch(bytes32 batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline)",
  "function batchAuthorization(bytes32) view returns (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed)",
  "function revokeBatch(bytes32 batchId)",
  "function setBatchOperator(address operator)",
  "function recoverUnclaimed(bytes32 batchId, address to)",
  "function rescueExcessNative(address to, uint256 amount)",
  "function transferOwnership(address newOwner)",
  "event BatchAuthorized(bytes32 indexed batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline)",
];
// The 3-arg gen-6/7 selector, encoded by hand (the gen-8 vault has no such function; Roles must refuse it first).
const THREE_ARG = new ethers.Interface(["function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total)"]);

/** realtime-indexer is an ES module package: its sources are transpiled here with a require shim (as the other fork specs do). */
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
  return { wdChain: load("evm/payoutWatchdogChain.ts"), wdWorker: load("evm/payoutWatchdogWorker.ts"), wd: load("evm/payoutWatchdog.ts") };
}

const net = NETS[network.name];
const d = net ? describe : describe.skip;

d(`payout watchdog Roles module, gen-8 only, with the REAL Safe and the REAL gen-8 vault (${network.name})`, function () {
  this.timeout(1_800_000);
  let anvil: ChildProcess | null = null;
  let forkBlock = 0;
  const rpc = (m: string, p: unknown[] = []) => ethers.provider.send(m, p);
  const now = async () => Number((await ethers.provider.getBlock("latest"))!.timestamp);
  const impersonate = async (a: string, fund = "10") => {
    await rpc("anvil_impersonateAccount", [a]);
    await rpc("anvil_setBalance", [a, ethers.toQuantity(ethers.parseEther(fund))]);
    return ethers.getSigner(a);
  };
  const wallet = async (fund = "1") => {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await rpc("anvil_setBalance", [w.address, ethers.toQuantity(ethers.parseEther(fund))]);
    return w;
  };

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

  before(async function () {
    const url = String((network.config as any).url);
    const port = Number(new URL(url).port);
    const probe = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.ok, () => false);
    if (!(await probe())) {
      const bin = fs.existsSync(path.join(process.env.HOME || "", ".foundry/bin/anvil")) ? path.join(process.env.HOME || "", ".foundry/bin/anvil") : "anvil";
      anvil = spawn(bin, ["--fork-url", net.upstream, "--port", String(port), "--accounts", "0", "--retries", "20", "--fork-retry-backoff", "1000", "--timeout", "60000", "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
      for (let i = 0; i < 240 && !(await probe()); i += 1) await new Promise((r) => setTimeout(r, 500));
    }
    const fork = await assertLocalFork(net.chainId);
    forkBlock = fork.forkBlock;
    console.log(`      fork of ${net.chainId} at block ${fork.forkBlock} (${fork.forkUrl})`);
  });

  after(async function () {
    if (anvil && !process.env.REHEARSAL_KEEP_ANVIL) anvil.kill();
  });

  it("deploys the gen-8-only module, the owners execute it; the role reaches only the 4-arg approve on the gen-8 vault and authorizeBatch on its distributor", async function () {
    const vault = new ethers.Contract(GEN8_VAULT, VAULT_ABI, ethers.provider);
    expect(await vault.admin()).to.equal(SAFE);
    const hdAddr = ethers.getAddress(await vault.holderDistributor());
    const dist = new ethers.Contract(hdAddr, DIST_ABI, ethers.provider);
    expect(await dist.owner()).to.equal(SAFE);
    expect(await dist.batchOperator()).to.equal(GEN8_VAULT);
    const cap = BigInt(await vault.maxHolderBatchPerWeek());
    console.log(`      gen-8 vault ${GEN8_VAULT}: admin = Safe, operator ${await vault.operator()}, holder distributor ${hdAddr} (owner Safe, batchOperator vault), weekly cap ${ethers.formatEther(cap)}`);

    // ---- 1. The deploy script, gen-8 only. A throwaway payer pays the proxy's gas; it holds no role.
    const payer = await wallet("1");
    const watchdog = await wallet("1");
    const id = net.chainId;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PAYOUT_ROLES_MODE: "",
      [`PAYOUT_WATCHDOG_ADDRESS_${id}`]: watchdog.address,
      [`PAYOUT_ROLES_GEN6_VAULT_${id}`]: "none",
      [`PAYOUT_ROLES_GEN7_VAULT_${id}`]: "none",
      [`PAYOUT_ROLES_AIRDROP_DISTRIBUTOR_${id}`]: "none",
      [`PAYOUT_ROLES_GEN7_AIRDROP_DISTRIBUTOR_${id}`]: "none",
      [`PAYOUT_ROLES_GEN8_VAULT_${id}`]: GEN8_VAULT,
      PAYOUT_ROLES_RUNWAY_WEEKS: "12",
    };
    // The vault operator as watchdog is refused before anything is sent.
    let refusedMsg = "";
    try {
      await deployRoles({ signer: payer, env: { ...env, [`PAYOUT_WATCHDOG_ADDRESS_${id}`]: await vault.operator() } });
    } catch (e: any) {
      refusedMsg = String(e.message);
    }
    expect(refusedMsg).to.match(/REFUSED: watchdog/);
    const out: any = await deployRoles({ signer: payer, env });
    const rolesAddr = out.record.roles;
    expect(out.recordFile).to.match(/deployments[\\/]fork-rehearsal[\\/]/);
    expect(out.record.vaults).to.deep.equal([]);
    expect(out.record.gen8Vaults.map((v: any) => [v.address, BigInt(v.maxTotalWei)])).to.deep.equal([[GEN8_VAULT, cap]]);
    expect(out.record.distributors.map((x: any) => [x.label, x.address, BigInt(x.capWei), x.program])).to.deep.equal([["gen-8 holder", hdAddr, cap, "airdrop_holders_gen8"]]);
    const table = out.record.permissionTable.map((r: any) => [r.target, r.selector]);
    expect(table).to.deep.equal([[GEN8_VAULT, GEN8_APPROVE_SELECTOR], [hdAddr, SELECTOR.authorizeBatch]]);
    const fns = out.calls.map((c: any) => `${c.fn}@${c.to}`);
    console.log(`      Roles proxy ${rolesAddr}; Safe batch ${path.relative(ROOT, out.batchFile)}: ${out.calls.length} calls (${out.runway.length} runway authorizations)`);
    console.log(`      calls: ${out.calls.filter((c: any) => c.fn !== "authorizeBatch").map((c: any) => `${c.fn}${c.fn === "scopeFunction" ? `(${c.args[2]})` : ""}`).join(", ")}`);
    expect(fns.filter((f: string) => !f.startsWith("authorizeBatch@"))).to.deep.equal([
      `scopeTarget@${rolesAddr}`, `scopeFunction@${rolesAddr}`, `scopeTarget@${rolesAddr}`, `setAllowance@${rolesAddr}`, `scopeFunction@${rolesAddr}`, `assignRoles@${rolesAddr}`, `enableModule@${SAFE}`,
    ]);
    expect(out.runway.every((c: any) => c.to === hdAddr && BigInt(c.args[1]) === cap)).to.equal(true);

    // ---- 2. The owners execute the batch.
    const txs = JSON.parse(fs.readFileSync(out.batchFile, "utf8")).transactions;
    const rc = await safeExec(txs.map((t: any) => ({ to: t.to, data: t.data, value: BigInt(t.value) })));
    console.log(`      Safe executed ${path.basename(out.batchFile)}: ${txs.length} calls, gas ${rc.gasUsed}`);
    expect(await new ethers.Contract(SAFE, SAFE_ABI, ethers.provider).isModuleEnabled(rolesAddr)).to.equal(true);
    const roles = new ethers.Contract(rolesAddr, rolesAbi(), watchdog);
    const exec = (to: string, data: string, o: { value?: bigint; operation?: number; from?: any } = {}) =>
      (roles.connect(o.from ?? watchdog) as any).execTransactionWithRole(to, o.value ?? 0n, data, o.operation ?? 0, PAYOUT_WATCHDOG_ROLE_KEY, true);
    const refused = async (p: Promise<any>, status: number) => expect(p).to.be.revertedWithCustomError(roles, "ConditionViolation").withArgs(status, anyValue);

    // ---- 3a. The 4-arg approve through the role reaches the real vault: an unknown batch -> the vault's BadBatch.
    const t = await now();
    const unknown = ethers.id(`mwz-gen8-fork-unknown-${id}`);
    const approve = vault.interface.encodeFunctionData("approveHolderBatch", [unknown, ethers.id("root"), ethers.parseEther("1"), t + 70 * DAY]);
    expect(approve.slice(0, 10)).to.equal(GEN8_APPROVE_SELECTOR);
    const [ok, ret] = await (roles as any).execTransactionWithRoleReturnData.staticCall(GEN8_VAULT, 0n, approve, 0, PAYOUT_WATCHDOG_ROLE_KEY, false);
    expect(ok).to.equal(false);
    expect(ret).to.equal(vault.interface.getError("BadBatch")!.selector);
    console.log(`      (a) approveHolderBatch(bytes32,bytes32,uint256,uint64) via the role: Roles passed, the vault answered ${vault.interface.parseError(ret)!.name} (unknown batch)`);
    await expect(exec(GEN8_VAULT, approve)).to.be.revertedWithCustomError(roles, "ModuleTransactionFailed");
    // The same call from the watchdog directly: OnlyAdmin (only the Safe's module path can approve).
    await expect((vault.connect(watchdog) as any).approveHolderBatch(unknown, ethers.id("root"), 1n, t + 70 * DAY)).to.be.revertedWithCustomError(vault, "OnlyAdmin");

    // ---- 3a'. The real watchdog tick, gen-8 lane only, against this module.
    const idx = loadIndexer();
    // The scan starts after the fork block: the vault's logs before it would be served by the upstream node (and a
    // public BSC node refuses getLogs); nothing was proposed on mainnet yet.
    const wdCfg = {
      chainId: id, send: false, roles: rolesAddr, safe: SAFE, vaults: [], airdrops: [],
      gen8Vaults: [{ label: "gen-8", vault: GEN8_VAULT, program: "airdrop_holders_gen8", startBlock: forkBlock + 1, hook: null, expectedRouter: null, holderCapWei: null }],
      weeks: 12, intervalMs: 60_000, lookbackBlocks: 500, logChunk: 500, censusLagBlocks: 0, snapshotToleranceSec: 0, maxExcludedBps: 2_000, maxTxPerTick: 30,
      minPayoutWei: 1n, claimWindowDays: 60, excluded: new Set<string>(), masterSecret: "fork-only",
    };
    const wchain = idx.wdChain.createEthersWatchdogChain(ethers.provider as any, { logChunk: 500 });
    const sender = idx.wdChain.createEthersWatchdogSender(ethers.provider as any, new ethers.Wallet(watchdog.privateKey));
    const memory = idx.wdWorker.emptyMemory();
    const nonceBefore = await ethers.provider.getTransactionCount(watchdog.address);
    const dry = await idx.wdWorker.runWatchdogTick({ db: null, cfg: wdCfg, chain: wchain, sender, memory, log: () => {}, gen8CensusExclusions: async () => [] });
    expect([dry.wiringOk, dry.moduleEnabled, dry.roleOk], JSON.stringify(dry)).to.deep.equal([true, true, true]);
    expect(await ethers.provider.getTransactionCount(watchdog.address)).to.equal(nonceBefore);
    const live = await idx.wdWorker.runWatchdogTick({ db: null, cfg: { ...wdCfg, send: true }, chain: wchain, sender, memory, log: () => {}, gen8CensusExclusions: async () => [] });
    expect(live.actions.filter((x: any) => x.decision === "refused" || x.decision === "failed"), JSON.stringify(live.actions)).to.deep.equal([]);
    const cov = live.coverage.find((c: any) => c.distributor === hdAddr);
    console.log(`      watchdog tick: health ok (gen-8 probe), dry run sent nothing; live: ${live.actions.filter((x: any) => x.decision === "sent").length} authorizations, gen-8 distributor covered ${cov?.coveredWeeks} weeks`);
    expect(cov.coveredWeeks).to.be.gte(12);
    for (const x of live.actions.filter((y: any) => y.decision === "sent")) {
      const a = await dist.batchAuthorization(x.subject);
      expect([a.authorized, BigInt(a.maxAmount), Number(a.publishDeadline) - Number(a.publishAfter)]).to.deep.equal([true, cap, 6 * DAY]);
    }

    // ---- 3b. authorizeBatch on the real gen-8 holder distributor within the cap.
    const aid = ethers.id(`mwz-gen8-fork-auth-${id}`);
    const arc = await (await exec(hdAddr, dist.interface.encodeFunctionData("authorizeBatch", [aid, cap, t + 30 * WEEK, t + 30 * WEEK + 6 * DAY]))).wait();
    const ev = arc.logs.filter((l: any) => l.address === hdAddr).map((l: any) => dist.interface.parseLog(l)).find((x: any) => x?.name === "BatchAuthorized");
    expect([ev.args.batchId, BigInt(ev.args.maxAmount)]).to.deep.equal([aid, cap]);
    const auth = await dist.batchAuthorization(aid);
    expect([auth.authorized, BigInt(auth.maxAmount)]).to.deep.equal([true, cap]);
    console.log(`      (b) authorizeBatch(${ethers.formatEther(cap)}) on ${hdAddr} via the role: authorized`);
    await refused(exec(hdAddr, dist.interface.encodeFunctionData("authorizeBatch", [ethers.id("over cap"), cap + 1n, t + 31 * WEEK, t + 31 * WEEK + 6 * DAY])), STATUS.ParameterGreaterThanAllowed);
    // Allowance (2 weeks x 1 id x cap at start, refilled one week per week): drain what is left, then one wei more is refused.
    const key = out.record.allowances[0].key;
    let left = BigInt((await new ethers.Contract(rolesAddr, rolesAbi(), ethers.provider).allowances(key)).balance);
    for (let i = 0; left > 0n; i += 1) {
      const amt = left > cap ? cap : left;
      await (await exec(hdAddr, dist.interface.encodeFunctionData("authorizeBatch", [ethers.id(`drain ${i}`), amt, t + (40 + i) * WEEK, t + (40 + i) * WEEK + 6 * DAY]))).wait();
      left -= amt;
    }
    await refused(exec(hdAddr, dist.interface.encodeFunctionData("authorizeBatch", [ethers.id("one more"), 1n, t + 33 * WEEK, t + 33 * WEEK + 6 * DAY])), STATUS.AllowanceExceeded);
    console.log("      (b) above the cap: ParameterGreaterThanAllowed; beyond the allowance: AllowanceExceeded");

    // ---- 3c. Everything else is refused by Roles.
    const outsider = await wallet("1");
    const g = vault.interface;
    await refused(exec(GEN8_VAULT, THREE_ARG.encodeFunctionData("approveHolderBatch", [unknown, ethers.id("root"), 1n])), STATUS.FunctionNotAllowed);
    for (const data of [
      g.encodeFunctionData("setOperator", [outsider.address, false]),
      g.encodeFunctionData("setCaps", [1n, 1n, 1n, 1n, 1n]),
      g.encodeFunctionData("vetoHolderBatch", [unknown]),
      g.encodeFunctionData("rescueExcessNative", [outsider.address, 1n]),
      g.encodeFunctionData("setHolderDistributorOnce", [outsider.address]),
      g.encodeFunctionData("creditUnclaimedHolders", [[unknown], [1n]]),
      g.encodeFunctionData("executeHolderBatch", [unknown]),
      g.encodeFunctionData("proposeHolderBatch", [unknown, ethers.id("root"), t + 70 * DAY, [unknown], [1n]]),
    ]) await refused(exec(GEN8_VAULT, data), STATUS.FunctionNotAllowed);
    await refused(exec(GEN8_VAULT, g.encodeFunctionData("approveHolderBatch", [unknown, ethers.id("root"), cap + 1n, t + 70 * DAY])), STATUS.ParameterGreaterThanAllowed);
    await refused(exec(GEN8_VAULT, g.encodeFunctionData("approveHolderBatch", [unknown, ethers.id("root"), 1n, 0])), STATUS.ParameterLessThanAllowed);
    await refused(exec(GEN8_VAULT, approve, { value: 1n }), STATUS.SendNotAllowed);
    await refused(exec(GEN8_VAULT, approve, { operation: 1 }), STATUS.DelegateCallNotAllowed);
    for (const [fn, args] of [["revokeBatch", [aid]], ["setBatchOperator", [outsider.address]], ["recoverUnclaimed", [aid, outsider.address]], ["rescueExcessNative", [outsider.address, 1n]], ["transferOwnership", [outsider.address]]] as const) {
      await refused(exec(hdAddr, dist.interface.encodeFunctionData(fn as any, args as any)), STATUS.FunctionNotAllowed);
    }
    await refused(exec(hdAddr, dist.interface.encodeFunctionData("authorizeBatch", [ethers.id("value"), 1n, t + 34 * WEEK, t + 34 * WEEK + 6 * DAY]), { value: 1n }), STATUS.SendNotAllowed);
    await refused(exec(outsider.address, "0x", { value: 1n }), STATUS.TargetAddressNotAllowed);
    const safeIface = new ethers.Interface(SAFE_ABI);
    await refused(exec(SAFE, safeIface.encodeFunctionData("addOwnerWithThreshold", [outsider.address, 1n])), STATUS.TargetAddressNotAllowed);
    await refused(exec(SAFE, safeIface.encodeFunctionData("enableModule", [outsider.address])), STATUS.TargetAddressNotAllowed);
    await refused(exec(rolesAddr, roles.interface.encodeFunctionData("assignRoles", [outsider.address, [PAYOUT_WATCHDOG_ROLE_KEY], [true]])), STATUS.TargetAddressNotAllowed);
    // The gen-6 vault on this chain is not a target of this module.
    const gen6 = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", id === 56 ? "bnb" : "robinhood", "mainnet.evmgen-fees.json"), "utf8")).contracts.vault;
    await refused(exec(gen6, THREE_ARG.encodeFunctionData("approveHolderBatch", [unknown, ethers.id("root"), 1n])), STATUS.TargetAddressNotAllowed);
    await expect(exec(GEN8_VAULT, approve, { from: outsider })).to.be.revertedWithCustomError(roles, "NotAuthorized");
    console.log("      (c) refused by Roles: 3-arg approve, 8 other vault functions, total > cap, deadline 0, value, delegatecall, 5 other distributor functions, the Safe, the module, an EOA, the gen-6 vault; a non-member: NotAuthorized");

    // ---- 5. The owners switch it off with the script's disable batch.
    const off: any = await deployRoles({ signer: payer, env: { ...env, PAYOUT_ROLES_MODE: "disable" } });
    const offTxs = JSON.parse(fs.readFileSync(off.batchFile, "utf8")).transactions;
    await safeExec(offTxs.map((x: any) => ({ to: x.to, data: x.data, value: BigInt(x.value) })));
    expect(await new ethers.Contract(SAFE, SAFE_ABI, ethers.provider).isModuleEnabled(rolesAddr)).to.equal(false);
    await expect(exec(GEN8_VAULT, approve)).to.be.revertedWith("GS104");
    const after = await idx.wdWorker.runWatchdogTick({ db: null, cfg: { ...wdCfg, send: true }, chain: wchain, sender, memory, log: () => {}, gen8CensusExclusions: async () => [] });
    expect(after.moduleEnabled).to.equal(false);
    expect(after.actions).to.deep.equal([]);
    console.log("      off switch: disableModule executed by the owners; the role call now stops at the Safe (GS104); the tick reports module disabled and sends nothing");
  });
});
