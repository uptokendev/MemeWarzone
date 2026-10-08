import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers, network } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import {
  APPROVE_HOLDER_BATCH,
  AUTHORIZE_BATCH,
  ExecutionOptions,
  KNOWN_FORBIDDEN_WATCHDOGS,
  Operator,
  PAYOUT_WATCHDOG_ROLE_KEY,
  ParamType,
  SELECTOR,
  SENTINEL_MODULES,
  allowanceKeyFor,
  allowancePlanFor,
  approveHolderBatchConditions,
  authorizeBatchConditions,
  buildPayoutRolesPolicy,
  disableModuleCall,
  rolesProxyPlan,
} from "../scripts/lib/payoutRolesPolicy";
import { MODULE_PROXY_FACTORY, ROLES_MASTERCOPY, assertVendorCreate2, assertZodiacCode, installZodiacLocally, rolesAbi } from "../scripts/lib/zodiacRoles";
import { buildBatch, verifyBatchFile } from "../scripts/make-safe-batch";
import { main as deployRoles } from "../scripts/deploy-payout-roles-module";

/**
 * The payout watchdog's Roles policy (scripts/lib/payoutRolesPolicy.ts) and its deploy script, against the REAL
 * Zodiac Roles v2.1.0 bytecode (the vendored, verified mastercopy, its libraries and the ModuleProxyFactory deployed
 * through the ERC-2470 factory at their canonical addresses on the in-process chain), a Safe stand-in
 * (MockModuleAvatar), the real CreatorRewardsVaultV2 and RewardDistributor. The same flows against the real Safe on
 * forks of 56 and 4663: test/PayoutRolesModule.fork.spec.ts.
 */
const E18 = 10n ** 18n;
const DAY = 86_400;
const WEEK = 7 * DAY;
const STATUS = { DelegateCallNotAllowed: 1, TargetAddressNotAllowed: 2, FunctionNotAllowed: 3, SendNotAllowed: 4, ParameterGreaterThanAllowed: 9, AllowanceExceeded: 17 };
const A = (n: number) => ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);

describe("payout watchdog Roles policy (pure)", function () {
  const base = () => ({
    chainId: 56,
    safe: A(0x5afe),
    roles: A(0x401e5),
    watchdog: A(0xdd),
    vaults: [{ label: "gen-6", address: A(0x601), maxTotalWei: 32n * E18 }, { label: "gen-7", address: A(0x701), maxTotalWei: 32n * E18 }],
    distributors: [
      { label: "gen-6 holder", kind: "holders" as const, address: A(0x602), capWei: 32n * E18, idsPerWeek: 1, scheme: "h6" },
      { label: "main airdrop", kind: "airdrop" as const, address: A(0x603), capWei: 5n * E18, idsPerWeek: 2, scheme: "a" },
    ],
    allowance: { maxWeeks: 2, initialWeeks: 2 },
  });

  it("conditions are breadth-first trees on the real parameter layout, caps strict + 1, one allowance key per distributor", function () {
    const ap = approveHolderBatchConditions(32n * E18);
    expect(ap.map((c) => [c.parent, c.paramType, c.operator])).to.deep.equal([[0, ParamType.Calldata, Operator.Matches], [0, ParamType.Static, Operator.Pass], [0, ParamType.Static, Operator.Pass], [0, ParamType.Static, Operator.LessThan]]);
    expect(BigInt(ap[3].compValue)).to.equal(32n * E18 + 1n);
    const key = allowanceKeyFor(56, A(0x603));
    const au = authorizeBatchConditions(5n * E18, key);
    expect(au.map((c) => [c.parent, c.paramType, c.operator])).to.deep.equal([
      [0, ParamType.Calldata, Operator.Matches], [0, ParamType.Static, Operator.Pass], [0, ParamType.None, Operator.And], [0, ParamType.Static, Operator.Pass], [0, ParamType.Static, Operator.Pass],
      [2, ParamType.Static, Operator.LessThan], [2, ParamType.Static, Operator.WithinAllowance],
    ]);
    expect(BigInt(au[5].compValue)).to.equal(5n * E18 + 1n);
    expect(au[6].compValue).to.equal(key.toLowerCase());
    expect(allowanceKeyFor(56, A(0x603))).to.not.equal(allowanceKeyFor(56, A(0x602)));
    expect(allowanceKeyFor(56, A(0x603))).to.not.equal(allowanceKeyFor(4663, A(0x603)));
    expect(SELECTOR.approveHolderBatch).to.equal(ethers.id(APPROVE_HOLDER_BATCH).slice(0, 10));
    expect(SELECTOR.authorizeBatch).to.equal(ethers.id(AUTHORIZE_BATCH).slice(0, 10));
    expect(() => approveHolderBatchConditions(0n)).to.throw(/positive/);
    expect(() => approveHolderBatchConditions(1n << 255n)).to.throw(/2\^255/);
  });

  it("allowance: one week of authorizations per week, at most maxWeeks weeks, starting at initialWeeks", function () {
    const a = allowancePlanFor({ label: "main airdrop", kind: "airdrop", address: A(0x603), capWei: 5n * E18, idsPerWeek: 2, scheme: "a" }, { maxWeeks: 2, initialWeeks: 2 }, 56);
    expect([a.refill, a.maxRefill, a.balance, a.period]).to.deep.equal([10n * E18, 20n * E18, 20n * E18, WEEK]);
    expect(() => allowancePlanFor({ label: "x", kind: "airdrop", address: A(1), capWei: 1n, idsPerWeek: 2, scheme: "" }, { maxWeeks: 0, initialWeeks: 0 }, 56)).to.throw(/maxWeeks/);
  });

  it("the batch: scope + function per vault, allowance + scope + function per distributor, the role, enableModule last; nothing else", function () {
    const p = buildPayoutRolesPolicy(base());
    expect(p.roleKey).to.equal(ethers.encodeBytes32String("payout-watchdog"));
    expect(p.calls.map((c) => c.fn)).to.deep.equal([
      "scopeTarget", "scopeFunction", "scopeTarget", "scopeFunction",
      "scopeTarget", "setAllowance", "scopeFunction", "scopeTarget", "setAllowance", "scopeFunction",
      "assignRoles", "enableModule",
    ]);
    expect(p.calls.slice(0, -1).every((c) => c.to === A(0x401e5) && c.contract === "IZodiacRolesV2")).to.equal(true);
    expect(p.calls.at(-1)).to.include({ contract: "ISafeModuleManager", to: A(0x5afe), fn: "enableModule" });
    for (const c of p.calls.filter((x) => x.fn === "scopeFunction")) expect(c.args[4]).to.equal(ExecutionOptions.None);
    expect(p.calls.filter((c) => c.fn === "scopeFunction").map((c) => [c.args[1], c.args[2]])).to.deep.equal([
      [A(0x601), SELECTOR.approveHolderBatch], [A(0x701), SELECTOR.approveHolderBatch], [A(0x602), SELECTOR.authorizeBatch], [A(0x603), SELECTOR.authorizeBatch],
    ]);
    expect(p.calls.find((c) => c.fn === "assignRoles")!.args).to.deep.equal([A(0xdd), [PAYOUT_WATCHDOG_ROLE_KEY], [true]]);
    expect(p.table.length).to.equal(4);
    // The Transaction Builder file encodes and re-checks every call from the compiled interfaces.
    const batch = buildBatch(56, "t", "t", p.calls.map(({ note: _n, ...c }) => c) as any);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mwz-roles-")), "b.json");
    fs.writeFileSync(file, JSON.stringify(batch));
    expect(verifyBatchFile(file, 56).transactions.length).to.equal(12);
  });

  it("refuses: a watchdog that is any operator / deployer / route authority / Safe / module, a duplicate target, no target", function () {
    for (const f of KNOWN_FORBIDDEN_WATCHDOGS) expect(() => buildPayoutRolesPolicy({ ...base(), watchdog: f.address })).to.throw(/REFUSED/);
    expect(() => buildPayoutRolesPolicy({ ...base(), watchdog: A(0x5afe) })).to.throw(/Safe/);
    expect(() => buildPayoutRolesPolicy({ ...base(), watchdog: A(0x401e5) })).to.throw(/Roles module/);
    expect(() => buildPayoutRolesPolicy({ ...base(), forbidden: [{ address: A(0xdd), label: "Safe owner" }] })).to.throw(/Safe owner/);
    const b = base();
    b.distributors[1].address = A(0x601);
    expect(() => buildPayoutRolesPolicy(b)).to.throw(/listed twice/);
    expect(() => buildPayoutRolesPolicy({ ...base(), vaults: [], distributors: [] })).to.throw(/no targets/);
  });

  it("the off switch: disableModule(prev, roles) from the Safe's linked list; the proxy address is the factory's CREATE2", function () {
    expect(disableModuleCall(A(0x5afe), [A(0x401e5), A(0x77)], A(0x401e5)).args).to.deep.equal([SENTINEL_MODULES, A(0x401e5)]);
    expect(disableModuleCall(A(0x5afe), [A(0x77), A(0x401e5)], A(0x401e5)).args).to.deep.equal([A(0x77), A(0x401e5)]);
    expect(() => disableModuleCall(A(0x5afe), [A(0x77)], A(0x401e5))).to.throw(/not an enabled module/);
    expect(Object.keys(assertVendorCreate2())).to.deep.equal(["Roles", "Integrity", "Packer", "ModuleProxyFactory"]);
  });
});

describe("payout watchdog Roles module on the real Roles v2.1.0 bytecode (local chain)", function () {
  this.timeout(300_000);
  let snapshot: string;
  before(async function () {
    snapshot = await network.provider.send("evm_snapshot", []);
  });
  after(async function () {
    await network.provider.send("evm_revert", [snapshot]);
  });

  async function fixture() {
    const [owner, deployer, operator, airdropOperator, watchdog, creator, trader, outsider] = await ethers.getSigners();
    await installZodiacLocally((m, p) => network.provider.send(m, p), deployer);
    await assertZodiacCode(ethers.provider);
    const safe: any = await (await ethers.getContractFactory("MockModuleAvatar")).deploy(owner.address);
    const S = await safe.getAddress();
    const asSafe = async (to: any, data: string, value = 0n) => (await safe.connect(owner).exec(typeof to === "string" ? to : await to.getAddress(), value, data)).wait();

    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const [weekly, monthly, recruiter, protocol] = [await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy(), await Receiver.deploy()];
    const community3 = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
    const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
    const vaults: any[] = [];
    const holderDists: any[] = [];
    const factories: any[] = [];
    for (let i = 0; i < 2; i += 1) {
      const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(S, await router.getAddress(), await weth.getAddress(), 1, await topazFactory.getAddress(), DAY);
      const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
      const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await locker.getAddress());
      const dist = await (await ethers.getContractFactory("RewardDistributor")).deploy(S);
      const vi = vault.interface;
      await asSafe(dist, dist.interface.encodeFunctionData("setBatchOperator", [await vault.getAddress()]));
      await asSafe(vault, vi.encodeFunctionData("setFactoryOnce", [await factory.getAddress()]));
      await asSafe(vault, vi.encodeFunctionData("setHolderDistributorOnce", [await dist.getAddress()]));
      await asSafe(vault, vi.encodeFunctionData("setOperator", [operator.address, false]));
      await asSafe(vault, vi.encodeFunctionData("setCaps", [E18, 3n * E18, 3600, 50, 10n * E18]));
      vaults.push(vault);
      holderDists.push(dist);
      factories.push(factory);
    }
    await router.setRecruiterRewardsVault(await recruiter.getAddress());
    await router.setCommunityRewardsVault(await community3.getAddress());
    await router.setProtocolRevenueVault(await protocol.getAddress());
    await router.setCreatorRewardsVault(await vaults[0].getAddress());
    const community = await (await ethers.getContractFactory("CommunityRewardsVault")).deploy(S, owner.address);
    const airdrop = await (await ethers.getContractFactory("RewardDistributor")).deploy(S);
    await asSafe(community, community.interface.encodeFunctionData("setRewardDistributor", [await airdrop.getAddress()]));
    await asSafe(community, community.interface.encodeFunctionData("setAirdropOperator", [airdropOperator.address]));
    await asSafe(airdrop, airdrop.interface.encodeFunctionData("setBatchOperator", [await community.getAddress()]));

    // A holders coin on the gen-6 vault with trade fees for its holders, and a proposed batch.
    const campaign: any = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), 100n * E18);
    await factories[0].addCampaign(await campaign.getAddress());
    await factories[0].choose(await vaults[0].getAddress(), await campaign.getAddress(), creator.address, 2, 0);
    await campaign.connect(trader).payFee(1, { value: 10n * E18 });
    const holderBalance: bigint = await vaults[0].holderBalance(await campaign.getAddress());
    const batchId = ethers.id("mwz-weekly-airdrop:31337:2026-09-28:airdrop_holders");
    const root = ethers.id("root");
    const claimDeadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 70 * DAY);
    await (await vaults[0].connect(operator).proposeHolderBatch(batchId, root, claimDeadline, [await campaign.getAddress()], [holderBalance])).wait();

    const env: NodeJS.ProcessEnv = {
      PAYOUT_ROLES_SAFE_31337: S,
      PAYOUT_WATCHDOG_ADDRESS_31337: watchdog.address,
      PAYOUT_ROLES_GEN6_VAULT_31337: await vaults[0].getAddress(),
      PAYOUT_ROLES_GEN7_VAULT_31337: await vaults[1].getAddress(),
      PAYOUT_ROLES_AIRDROP_DISTRIBUTOR_31337: await airdrop.getAddress(),
      PAYOUT_ROLES_AIRDROP_CAP_31337: "0.5",
      PAYOUT_ROLES_RUNWAY_WEEKS: "0",
      REHEARSAL_OUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "mwz-payout-roles-")),
    };
    return { owner, deployer, operator, airdropOperator, watchdog, outsider, safe, S, asSafe, vaults, holderDists, airdrop, community, campaign, batchId, root, holderBalance, env, weth };
  }

  async function deployed() {
    const f = await fixture();
    const out: any = await deployRoles({ signer: f.deployer, env: f.env });
    const batch = JSON.parse(fs.readFileSync(out.batchFile, "utf8"));
    for (const tx of batch.transactions) await f.asSafe(tx.to, tx.data, BigInt(tx.value));
    const roles = new ethers.Contract(out.record.roles, rolesAbi(), f.watchdog);
    const exec = (to: any, data: string, opts: { value?: bigint; operation?: number; signer?: any } = {}) =>
      (roles.connect(opts.signer ?? f.watchdog) as any).execTransactionWithRole(typeof to === "string" ? to : to.target, opts.value ?? 0n, data, opts.operation ?? 0, PAYOUT_WATCHDOG_ROLE_KEY, true);
    return { ...f, out, batch, roles, exec };
  }

  it("deploy script: proxy owned by the Safe from its first instruction, scoped batch, module enabled only by the batch's last call", async function () {
    const f = await fixture();
    const out: any = await deployRoles({ signer: f.deployer, env: f.env });
    const plan = rolesProxyPlan({ factory: MODULE_PROXY_FACTORY, mastercopy: ROLES_MASTERCOPY, safe: f.S, saltNonce: BigInt(out.record.saltNonce) });
    expect(out.record.roles).to.equal(plan.proxy);
    const roles = new ethers.Contract(plan.proxy, rolesAbi(), ethers.provider);
    expect([await roles.owner(), await roles.avatar(), await roles.getFunction("target")()]).to.deep.equal([f.S, f.S, f.S]);
    expect(await f.safe.isModuleEnabled(plan.proxy)).to.equal(false);
    const batch = JSON.parse(fs.readFileSync(out.batchFile, "utf8"));
    expect(batch.transactions.at(-1).to).to.equal(f.S);
    expect(batch.transactions.at(-1).contractMethod.name).to.equal("enableModule");
    expect(out.record.distributors.map((d: any) => [d.label, d.capWei.toString()])).to.deep.equal([["gen-6 holder", String(10n * E18)], ["gen-7 holder", String(10n * E18)], ["main airdrop", String(E18 / 2n)]]);
    for (const tx of batch.transactions) await f.asSafe(tx.to, tx.data, BigInt(tx.value));
    expect(await f.safe.isModuleEnabled(plan.proxy)).to.equal(true);
    // Re-running is idempotent: the same proxy is reused (no second deploy), enableModule is left out.
    const again: any = await deployRoles({ signer: f.deployer, env: f.env });
    expect(again.record.roles).to.equal(plan.proxy);
    expect(again.record.deployTx).to.equal(null);
    expect(again.calls.some((c: any) => c.fn === "enableModule")).to.equal(false);
  });

  it("PAYOUT_ROLES_DEPLOY_IN_BATCH: nothing deployed by the signer; the Safe batch deploys the proxy first and works the same", async function () {
    const f = await fixture();
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    const out: any = await deployRoles({ signer: f.deployer, env: { ...f.env, PAYOUT_ROLES_DEPLOY_IN_BATCH: "1" } });
    expect(await ethers.provider.getTransactionCount(f.deployer.address)).to.equal(nonce);
    expect(await ethers.provider.getCode(out.record.roles)).to.equal("0x");
    const batch = JSON.parse(fs.readFileSync(out.batchFile, "utf8"));
    expect(batch.transactions[0].to).to.equal(MODULE_PROXY_FACTORY);
    expect(batch.transactions[0].contractMethod.name).to.equal("deployModule");
    for (const tx of batch.transactions) await f.asSafe(tx.to, tx.data, BigInt(tx.value));
    const roles = new ethers.Contract(out.record.roles, rolesAbi(), f.watchdog);
    expect(await roles.owner()).to.equal(f.S);
    await expect((roles as any).execTransactionWithRole(await f.vaults[0].getAddress(), 0n, f.vaults[0].interface.encodeFunctionData("approveHolderBatch", [f.batchId, f.root, f.holderBalance]), 0, PAYOUT_WATCHDOG_ROLE_KEY, true)).to.emit(f.vaults[0], "HolderBatchApproved");
  });

  it("deploy script refuses a watchdog that is a vault operator, the airdrop operator or a Safe owner", async function () {
    const f = await fixture();
    for (const who of [f.operator.address, f.airdropOperator.address, f.owner.address, f.deployer.address]) {
      let err = "";
      try {
        await deployRoles({ signer: f.deployer, env: { ...f.env, PAYOUT_WATCHDOG_ADDRESS_31337: who } });
      } catch (e: any) {
        err = String(e.message);
      }
      expect(err, who).to.match(/REFUSED: watchdog/);
    }
  });

  it("the watchdog approves a proposed batch and authorizes ids within the caps and the allowance; the allowance refills weekly", async function () {
    const d = await deployed();
    await expect(d.exec(d.vaults[0], d.vaults[0].interface.encodeFunctionData("approveHolderBatch", [d.batchId, d.root, d.holderBalance]))).to.emit(d.vaults[0], "HolderBatchApproved");
    const t = (await ethers.provider.getBlock("latest"))!.timestamp;
    const auth = (dist: any, id: string, max: bigint) => d.exec(dist, dist.interface.encodeFunctionData("authorizeBatch", [ethers.id(id), max, t + WEEK, t + WEEK + 6 * DAY]));
    await expect(auth(d.holderDists[0], "h1", 10n * E18)).to.emit(d.holderDists[0], "BatchAuthorized");
    await expect(auth(d.holderDists[1], "h7", 10n * E18)).to.emit(d.holderDists[1], "BatchAuthorized");
    // Airdrop: cap 0.5 per id, allowance 2 weeks x 2 ids x 0.5 = 2.
    for (let i = 0; i < 4; i += 1) await expect(auth(d.airdrop, `a${i}`, E18 / 2n)).to.emit(d.airdrop, "BatchAuthorized");
    await expect(auth(d.airdrop, "a4", 1n)).to.be.revertedWithCustomError(d.roles, "ConditionViolation").withArgs(STATUS.AllowanceExceeded, anyValue);
    await network.provider.send("evm_increaseTime", [WEEK]);
    await network.provider.send("evm_mine", []);
    await expect(auth(d.airdrop, "a5", E18 / 2n)).to.emit(d.airdrop, "BatchAuthorized");
    await expect(auth(d.airdrop, "a6", E18 / 2n)).to.emit(d.airdrop, "BatchAuthorized");
    await expect(auth(d.airdrop, "a7", 1n)).to.be.revertedWithCustomError(d.roles, "ConditionViolation").withArgs(STATUS.AllowanceExceeded, anyValue);
  });

  it("NEGATIVE: everything else is refused by Roles, a different root by the vault, and disableModule ends it", async function () {
    const d = await deployed();
    const t = (await ethers.provider.getBlock("latest"))!.timestamp;
    const V = d.vaults[0];
    const cv = d.roles;
    // Safe funds: native and tokens.
    await d.owner.sendTransaction({ to: d.S, value: E18 });
    await expect(d.exec(d.watchdog.address, "0x", { value: E18 })).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.TargetAddressNotAllowed, anyValue);
    await expect(d.exec(d.weth, d.weth.interface.encodeFunctionData("transfer", [d.watchdog.address, 1n]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.TargetAddressNotAllowed, anyValue);
    // Other functions on listed targets.
    await expect(d.exec(V, V.interface.encodeFunctionData("setOperator", [d.watchdog.address, false]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.FunctionNotAllowed, anyValue);
    await expect(d.exec(V, V.interface.encodeFunctionData("setCaps", [1n, 1n, 1n, 1n, 1n]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.FunctionNotAllowed, anyValue);
    await expect(d.exec(V, V.interface.encodeFunctionData("vetoHolderBatch", [d.batchId]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.FunctionNotAllowed, anyValue);
    await expect(d.exec(V, V.interface.encodeFunctionData("rescueExcessNative", [d.watchdog.address, 1n]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.FunctionNotAllowed, anyValue);
    for (const fn of [["revokeBatch", [ethers.id("x")]], ["setBatchOperator", [d.watchdog.address]], ["rescueExcessNative", [d.watchdog.address, 1n]], ["transferOwnership", [d.watchdog.address]]] as const) {
      await expect(d.exec(d.airdrop, d.airdrop.interface.encodeFunctionData(fn[0] as any, fn[1] as any))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.FunctionNotAllowed, anyValue);
    }
    // Above the cap; value on an allowed call; delegatecall to an allowed target.
    await expect(d.exec(d.airdrop, d.airdrop.interface.encodeFunctionData("authorizeBatch", [ethers.id("big"), E18 / 2n + 1n, t + WEEK, t + 2 * WEEK]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.ParameterGreaterThanAllowed, anyValue);
    await expect(d.exec(V, V.interface.encodeFunctionData("approveHolderBatch", [d.batchId, d.root, 10n * E18 + 1n]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.ParameterGreaterThanAllowed, anyValue);
    await expect(d.exec(V, V.interface.encodeFunctionData("approveHolderBatch", [d.batchId, d.root, d.holderBalance]), { value: 1n })).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.SendNotAllowed, anyValue);
    await expect(d.exec(V, V.interface.encodeFunctionData("approveHolderBatch", [d.batchId, d.root, d.holderBalance]), { operation: 1 })).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.DelegateCallNotAllowed, anyValue);
    // The Safe itself, the Roles module's own admin, a distributor not listed.
    await expect(d.exec(d.S, d.safe.interface.encodeFunctionData("enableModule", [d.watchdog.address]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.TargetAddressNotAllowed, anyValue);
    const other = await (await ethers.getContractFactory("RewardDistributor")).deploy(d.S);
    await expect(d.exec(other, other.interface.encodeFunctionData("authorizeBatch", [ethers.id("o"), 1n, t + WEEK, t + 2 * WEEK]))).to.be.revertedWithCustomError(cv, "ConditionViolation").withArgs(STATUS.TargetAddressNotAllowed, anyValue);
    await expect((d.roles.connect(d.watchdog) as any).assignRoles(d.outsider.address, [PAYOUT_WATCHDOG_ROLE_KEY], [true])).to.be.revertedWithCustomError(cv, "OwnableUnauthorizedAccount");
    await expect((d.roles.connect(d.watchdog) as any).setAllowance(ethers.ZeroHash, 1n, 1n, 1n, 1n, 0n)).to.be.revertedWithCustomError(cv, "OwnableUnauthorizedAccount");
    // Not a member; the watchdog calling the vault directly.
    await expect(d.exec(V, V.interface.encodeFunctionData("approveHolderBatch", [d.batchId, d.root, d.holderBalance]), { signer: d.outsider })).to.be.reverted;
    await expect(V.connect(d.watchdog).approveHolderBatch(d.batchId, d.root, d.holderBalance)).to.be.revertedWithCustomError(V, "OnlyAdmin");
    // A root other than the proposed one: Roles allows the call shape, the vault refuses (BadBatch).
    await expect(d.exec(V, V.interface.encodeFunctionData("approveHolderBatch", [d.batchId, ethers.id("other root"), d.holderBalance]))).to.be.revertedWithCustomError(cv, "ModuleTransactionFailed");
    expect(await V.holderBalance(await d.campaign.getAddress())).to.equal(0n);
    // The off switch: the Safe's disableModule batch from the script; afterwards nothing works.
    const off: any = await deployRoles({ signer: d.deployer, env: { ...d.env, PAYOUT_ROLES_MODE: "disable" } });
    const batch = JSON.parse(fs.readFileSync(off.batchFile, "utf8"));
    expect(batch.transactions.map((x: any) => x.contractMethod.name)).to.deep.equal(["disableModule"]);
    for (const tx of batch.transactions) await d.asSafe(tx.to, tx.data);
    expect(await d.safe.isModuleEnabled(d.out.record.roles)).to.equal(false);
    await expect(d.exec(V, V.interface.encodeFunctionData("approveHolderBatch", [d.batchId, d.root, d.holderBalance]))).to.be.revertedWithCustomError(d.safe, "ModuleNotEnabled");
  });
});
