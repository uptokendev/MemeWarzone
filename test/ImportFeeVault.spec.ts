/**
 * CO-IMP rev 2 CI1: ImportFeeVault = the unchanged RecruiterRewardsVault bytecode. Unit proof of every property the
 * import fee flow leans on (docs/evm-launch/CO-IMPORT-SWAP-FEE.md I8, CI6): deposits from any sender (EOA, router
 * contract) as Deposit(from, amount, newBalance); paused at deploy; only the admin sets operator / caps / pause; only the
 * operator pays, within maxPayoutPerTx and dailyPayoutCap, which resets on the next UTC day; the protocol sweep to
 * ProtocolRevenueVault (plain value, its receive()) works through the same payout(). Also runs
 * scripts/deploy-import-fee-vault.ts in-process on the local 31337 profile (admin = deployer, calls sent).
 */
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  EXISTING_PAYOUT_OPERATOR,
  IMPORT_FEE_CHAINS,
  importFeeVaultCalls,
  main as deployImportFeeVault,
  resolveCaps,
  resolveOperator,
} from "../scripts/deploy-import-fee-vault";
import { buildBatch } from "../scripts/make-safe-batch";

const E = (x: string) => ethers.parseEther(x);

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error: any) {
    expect(String(error?.message || error)).to.match(pattern);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}`);
}
const DAY = 86_400;

describe("ImportFeeVault (RecruiterRewardsVault bytecode) for CO-IMP", function () {
  async function deploy() {
    const [admin, operator, trader, creator, other] = await ethers.getSigners();
    const vault: any = await (await ethers.getContractFactory("RecruiterRewardsVault")).deploy(admin.address);
    await vault.waitForDeployment();
    return { vault, admin, operator, trader, creator, other };
  }

  async function open() {
    const ctx = await deploy();
    await ctx.vault.setOperator(ctx.operator.address);
    await ctx.vault.setPayoutCaps(E("1"), E("3"));
    await ctx.vault.setPayoutsPaused(false);
    await ctx.trader.sendTransaction({ to: await ctx.vault.getAddress(), value: E("10") });
    return ctx;
  }

  it("deploys paused, no operator, zero caps, admin immutable", async function () {
    const { vault, admin } = await deploy();
    expect(await vault.admin()).to.equal(admin.address);
    expect(await vault.payoutsPaused()).to.equal(true);
    expect(await vault.operator()).to.equal(ethers.ZeroAddress);
    expect(await vault.maxPayoutPerTx()).to.equal(0n);
    expect(await vault.dailyPayoutCap()).to.equal(0n);
  });

  it("takes plain value from any sender (EOA and contract) as one Deposit(from, amount, newBalance); refuses 0", async function () {
    const { vault, trader, admin } = await deploy();
    const v = await vault.getAddress();
    await expect(trader.sendTransaction({ to: v, value: 12345n })).to.emit(vault, "Deposit").withArgs(trader.address, 12345n, 12345n);
    // A contract sender (stands for the Kyber router / Universal Router / ImportSwapFeeRouter): another vault's withdraw.
    const other: any = await (await ethers.getContractFactory("RecruiterRewardsVault")).deploy(admin.address);
    await trader.sendTransaction({ to: await other.getAddress(), value: 777n });
    const rc = await (await other.withdraw(v, 777n)).wait();
    const deposits = rc!.logs.filter((l: any) => l.address === v).map((l: any) => vault.interface.parseLog(l)!);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].name).to.equal("Deposit");
    expect(deposits[0].args.from).to.equal(await other.getAddress());
    expect(deposits[0].args.amount).to.equal(777n);
    expect(deposits[0].args.newBalance).to.equal(12345n + 777n);
    await expect(trader.sendTransaction({ to: v, value: 0n })).to.be.revertedWith("amount=0");
  });

  it("only the admin sets operator, caps and pause; unpause needs operator and both caps", async function () {
    const { vault, operator, other } = await deploy();
    await expect(vault.connect(other).setOperator(operator.address)).to.be.revertedWith("not admin");
    await expect(vault.connect(other).setPayoutCaps(1n, 1n)).to.be.revertedWith("not admin");
    await expect(vault.connect(other).setPayoutsPaused(false)).to.be.revertedWith("not admin");
    await expect(vault.connect(operator).setPayoutsPaused(false)).to.be.revertedWith("not admin");
    await expect(vault.setPayoutsPaused(false)).to.be.revertedWith("operator=0");
    await vault.setOperator(operator.address);
    await expect(vault.setPayoutsPaused(false)).to.be.revertedWith("maxPayoutPerTx=0");
    await vault.setPayoutCaps(E("1"), 0n);
    await expect(vault.setPayoutsPaused(false)).to.be.revertedWith("dailyPayoutCap=0");
    await expect(vault.setPayoutCaps(E("1"), E("3"))).to.emit(vault, "PayoutCapsUpdated").withArgs(E("1"), E("3"));
    await expect(vault.setPayoutsPaused(false)).to.emit(vault, "PayoutsPaused").withArgs(false);
  });

  it("only the operator pays out; paused blocks it; to=0, amount=0, above balance refused", async function () {
    const { vault, admin, operator, creator, other } = await open();
    await expect(vault.connect(other).payout(creator.address, 1n)).to.be.revertedWith("not operator");
    await expect(vault.connect(admin).payout(creator.address, 1n)).to.be.revertedWith("not operator");
    await expect(vault.connect(operator).payout(ethers.ZeroAddress, 1n)).to.be.revertedWith("to=0");
    await expect(vault.connect(operator).payout(creator.address, 0n)).to.be.revertedWith("amount=0");
    await vault.setPayoutCaps(E("100"), E("100"));
    await expect(vault.connect(operator).payout(creator.address, E("10") + 1n)).to.be.revertedWith("insufficient");
    await vault.setPayoutsPaused(true);
    await expect(vault.connect(operator).payout(creator.address, 1n)).to.be.revertedWith("payouts paused");
  });

  it("per-tx cap is inclusive; daily cap is inclusive and resets on the next UTC day", async function () {
    const { vault, operator, creator } = await open();
    // Start at the beginning of a UTC day so the three payouts land on the same day.
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / DAY + 1) * DAY + 10);
    await expect(vault.connect(operator).payout(creator.address, E("1") + 1n)).to.be.revertedWith("maxPayoutPerTx");
    const before = await ethers.provider.getBalance(creator.address);
    await expect(vault.connect(operator).payout(creator.address, E("1"))).to.emit(vault, "Payout").withArgs(creator.address, E("1"));
    await vault.connect(operator).payout(creator.address, E("1"));
    await vault.connect(operator).payout(creator.address, E("1"));
    expect(await vault.dailySpent()).to.equal(E("3"));
    expect((await ethers.provider.getBalance(creator.address)) - before).to.equal(E("3"));
    await expect(vault.connect(operator).payout(creator.address, 1n)).to.be.revertedWith("dailyPayoutCap");
    // Next UTC day: the counter resets on the first payout.
    await time.increaseTo(Math.floor((await time.latest()) / DAY + 1) * DAY + 1);
    await vault.connect(operator).payout(creator.address, 5n);
    expect(await vault.dailySpent()).to.equal(5n);
    expect(await vault.lastDay()).to.equal(BigInt(Math.floor((await time.latest()) / DAY)));
  });

  it("a reverting receiver fails only that payout and spends nothing of the daily cap", async function () {
    const { vault, operator } = await open();
    const bad = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
    const spent = await vault.dailySpent();
    await expect(vault.connect(operator).payout(await bad.getAddress(), 1n)).to.be.revertedWith("transfer failed");
    expect(await vault.dailySpent()).to.equal(spent);
  });

  it("protocol sweep: payout(ProtocolRevenueVault, x) lands as that vault's Deposit(from = ImportFeeVault)", async function () {
    const { vault, admin, operator } = await open();
    const prv = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(admin.address);
    const p = await prv.getAddress();
    const sweep = E("0.4");
    const vb = await ethers.provider.getBalance(await vault.getAddress());
    await expect(vault.connect(operator).payout(p, sweep))
      .to.emit(prv, "Deposit").withArgs(await vault.getAddress(), sweep, sweep)
      .and.to.emit(vault, "Payout").withArgs(p, sweep);
    expect(await ethers.provider.getBalance(p)).to.equal(sweep);
    expect(vb - (await ethers.provider.getBalance(await vault.getAddress()))).to.equal(sweep);
  });

  it("admin withdraw stays available (Safe escape hatch)", async function () {
    const { vault, admin, other } = await open();
    await expect(vault.connect(other).withdraw(other.address, 1n)).to.be.revertedWith("not admin");
    await expect(vault.withdraw(other.address, E("2"))).to.emit(vault, "Withdraw").withArgs(other.address, E("2"), E("8"));
    void admin;
  });

  describe("scripts/deploy-import-fee-vault.ts", function () {
    let outDir: string;
    before(function () {
      if (network.name !== "hardhat") this.skip();
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-fee-vault-"));
    });
    after(() => {
      if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
    });

    it("refuses a missing operator and the existing payout operator 0xdcf07EB0; validates caps", async function () {
      const chain = IMPORT_FEE_CHAINS[31337];
      const [deployer] = await ethers.getSigners();
      await rejects(resolveOperator(chain, deployer.address, deployer.address, {}), /IMPORT_FEE_PAYOUT_OPERATOR_31337 is required/);
      await rejects(resolveOperator(chain, deployer.address, deployer.address, { IMPORT_FEE_PAYOUT_OPERATOR_31337: EXISTING_PAYOUT_OPERATOR.toLowerCase() }), /existing payout operator/);
      for (const id of [56, 4663, 97, 46630]) {
        await rejects(resolveOperator(IMPORT_FEE_CHAINS[id], deployer.address, deployer.address, { [`IMPORT_FEE_PAYOUT_OPERATOR_${id}`]: EXISTING_PAYOUT_OPERATOR }), /existing payout operator/);
      }
      expect(resolveCaps(IMPORT_FEE_CHAINS[56], {})).to.deep.equal({ perTx: E("2"), daily: E("10") });
      expect(resolveCaps(IMPORT_FEE_CHAINS[4663], {})).to.deep.equal({ perTx: E("0.5"), daily: E("3") });
      expect(() => resolveCaps(chain, { IMPORT_FEE_MAX_PAYOUT_PER_TX_31337: "3", IMPORT_FEE_DAILY_PAYOUT_CAP_31337: "2" })).to.throw(/above the daily cap/);
    });

    it("mainnet batch IF1 encodes exactly setOperator, setPayoutCaps, setPayoutsPaused(false)", async function () {
      const vault = "0x00000000000000000000000000000000000000A1";
      const op = "0x00000000000000000000000000000000000000B2";
      const batch = buildBatch(56, "IF1", "test", importFeeVaultCalls(vault, op, { perTx: E("2"), daily: E("10") }).map(({ note: _n, ...c }) => c) as any);
      expect(batch.transactions.map((t: any) => t.contractMethod.name)).to.deep.equal(["setOperator", "setPayoutCaps", "setPayoutsPaused"]);
      const iface = (await ethers.getContractFactory("RecruiterRewardsVault")).interface;
      expect(batch.transactions[0].data).to.equal(iface.encodeFunctionData("setOperator", [op]));
      expect(batch.transactions[1].data).to.equal(iface.encodeFunctionData("setPayoutCaps", [E("2"), E("10")]));
      expect(batch.transactions[2].data).to.equal(iface.encodeFunctionData("setPayoutsPaused", [false]));
      for (const t of batch.transactions) expect(t.value).to.equal("0");
    });

    it("local profile: deploys, sends the three admin calls, records, and resumes without a second vault", async function () {
      const [deployer, , , , , op] = await ethers.getSigners();
      const saved = { ...process.env };
      try {
        process.env.REHEARSAL_OUT_DIR = outDir;
        process.env.IMPORT_FEE_PAYOUT_OPERATOR_31337 = op.address;
        const first = await deployImportFeeVault({ signer: deployer });
        const v = await ethers.getContractAt("RecruiterRewardsVault", first.record.vault);
        expect(await v.admin()).to.equal(deployer.address);
        expect(await v.operator()).to.equal(op.address);
        expect(await v.maxPayoutPerTx()).to.equal(E("0.5"));
        expect(await v.dailyPayoutCap()).to.equal(E("2"));
        expect(await v.payoutsPaused()).to.equal(false);
        expect(first.calls.map((c: any) => c.fn)).to.deep.equal(["setOperator", "setPayoutCaps", "setPayoutsPaused"]);
        expect(fs.existsSync(String((first as any).recordFile))).to.equal(true);
        const again = await deployImportFeeVault({ signer: deployer });
        expect(again.record.vault).to.equal(first.record.vault);
        expect(again.calls.length).to.equal(0);
      } finally {
        process.env = saved;
      }
    });
  });
});
