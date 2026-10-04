import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";
import { installRealWbnb, WBNB_ADDRESS } from "./helpers/realWbnb";

// ProtocolRevenueForwarder unit tests: local hardhat network only. The real ProtocolRevenueVault is the sink
// (operator fill + overflow apply as on mainnet) and the wrapped native is the real WBNB (WETH9) runtime
// bytecode read from BSC (test/fixtures/wrapped-native-bytecode.json), so the unwrap leg runs under WETH9's
// 2300 gas `transfer` stipend exactly as it will on BNB 56.

const WAD = 10n ** 18n;

async function setup(opts: { capUsd?: bigint; priceUsd?: bigint } = {}) {
  const [deployer, admin, operator, stranger, other] = await ethers.getSigners();
  const wbnb: any = await installRealWbnb();
  const vault: any = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(admin.address);
  // Operator filled first up to capUsd at priceUsd per native, overflow to the admin (the Safe on mainnet).
  await vault.connect(admin).setOperatorFill(operator.address, admin.address, opts.capUsd ?? 100n * WAD, opts.priceUsd ?? 1000n * WAD);
  const Forwarder = await ethers.getContractFactory("ProtocolRevenueForwarder");
  const forwarder: any = await Forwarder.deploy(admin.address, await vault.getAddress(), WBNB_ADDRESS);
  return { deployer, admin, operator, stranger, other, wbnb, vault, forwarder, Forwarder };
}

async function wrapTo(wbnb: any, from: any, to: string, amount: bigint) {
  await wbnb.connect(from).deposit({ value: amount });
  await wbnb.connect(from).transfer(to, amount);
}

async function forceNative(target: string, amount: bigint) {
  await (await ethers.getContractFactory("ForwarderForceSend")).deploy(target, { value: amount });
}

const bal = (a: string) => ethers.provider.getBalance(a);

describe("ProtocolRevenueForwarder", function () {
  describe("constructor", function () {
    it("stores admin, sink and wrapped native as immutables; the sink is administered by the same admin", async function () {
      const f = await setup();
      expect(await f.forwarder.admin()).to.equal(f.admin.address);
      expect(await f.forwarder.nativeSink()).to.equal(await f.vault.getAddress());
      expect(await f.forwarder.wrappedNative()).to.equal(WBNB_ADDRESS);
      expect(await f.vault.admin()).to.equal(f.admin.address);
      expect(await f.wbnb.symbol()).to.equal("WBNB");
      expect(await f.wbnb.decimals()).to.equal(18n);
    });

    it("has no setter, pause, fallback, owner or native withdraw in its ABI", async function () {
      const f = await setup();
      const names = f.forwarder.interface.fragments.filter((x: any) => x.type === "function").map((x: any) => x.name).sort();
      expect(names).to.deep.equal(["admin", "flush", "nativeSink", "withdrawToken", "wrappedNative"]);
      // From the compiled ABI (ethers folds receive into a "fallback" fragment): receive yes, fallback no.
      const abi = artifacts.readArtifactSync("ProtocolRevenueForwarder").abi;
      expect(abi.some((x: any) => x.type === "fallback")).to.equal(false);
      expect(abi.some((x: any) => x.type === "receive")).to.equal(true);
    });

    it("reverts on each zero address", async function () {
      const f = await setup();
      const sink = await f.vault.getAddress();
      await expect(f.Forwarder.deploy(ethers.ZeroAddress, sink, WBNB_ADDRESS)).to.be.revertedWithCustomError(f.Forwarder, "ZeroAddress");
      await expect(f.Forwarder.deploy(f.admin.address, ethers.ZeroAddress, WBNB_ADDRESS)).to.be.revertedWithCustomError(f.Forwarder, "ZeroAddress");
      await expect(f.Forwarder.deploy(f.admin.address, sink, ethers.ZeroAddress)).to.be.revertedWithCustomError(f.Forwarder, "ZeroAddress");
    });

    it("reverts when sink == wrapped, or sink / wrapped / admin is the forwarder itself", async function () {
      const f = await setup();
      const sink = await f.vault.getAddress();
      await expect(f.Forwarder.deploy(f.admin.address, WBNB_ADDRESS, WBNB_ADDRESS)).to.be.revertedWithCustomError(f.Forwarder, "InvalidSink");
      const self = ethers.getCreateAddress({ from: f.deployer.address, nonce: await ethers.provider.getTransactionCount(f.deployer.address) });
      await expect(f.Forwarder.deploy(f.admin.address, self, WBNB_ADDRESS)).to.be.revertedWithCustomError(f.Forwarder, "InvalidSink");
      const self2 = ethers.getCreateAddress({ from: f.deployer.address, nonce: await ethers.provider.getTransactionCount(f.deployer.address) });
      await expect(f.Forwarder.deploy(f.admin.address, sink, self2)).to.be.revertedWithCustomError(f.Forwarder, "InvalidSink");
      const self3 = ethers.getCreateAddress({ from: f.deployer.address, nonce: await ethers.provider.getTransactionCount(f.deployer.address) });
      await expect(f.Forwarder.deploy(self3, sink, WBNB_ADDRESS)).to.be.revertedWithCustomError(f.Forwarder, "InvalidSink");
    });

    it("reverts when the sink or the wrapped native has no code", async function () {
      const f = await setup();
      await expect(f.Forwarder.deploy(f.admin.address, f.stranger.address, WBNB_ADDRESS))
        .to.be.revertedWithCustomError(f.Forwarder, "NotContract")
        .withArgs(f.stranger.address);
      await expect(f.Forwarder.deploy(f.admin.address, await f.vault.getAddress(), f.stranger.address))
        .to.be.revertedWithCustomError(f.Forwarder, "NotContract")
        .withArgs(f.stranger.address);
    });

    it("reverts when the sink has no admin() or a different admin", async function () {
      const f = await setup();
      const noAdmin = await (await ethers.getContractFactory("ForwarderSinkWithoutAdmin")).deploy();
      await expect(f.Forwarder.deploy(f.admin.address, await noAdmin.getAddress(), WBNB_ADDRESS)).to.be.reverted;
      const otherVault = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(f.other.address);
      await expect(f.Forwarder.deploy(f.admin.address, await otherVault.getAddress(), WBNB_ADDRESS))
        .to.be.revertedWithCustomError(f.Forwarder, "SinkAdminMismatch")
        .withArgs(f.other.address);
    });
  });

  describe("receive()", function () {
    it("forwards exactly msg.value to the real vault in the same call; operator fill then overflow still apply", async function () {
      const f = await setup({ capUsd: 100n * WAD, priceUsd: 1000n * WAD });
      const fwd = await f.forwarder.getAddress();
      const vaultAddr = await f.vault.getAddress();
      const op0 = await bal(f.operator.address);
      const safe0 = await bal(f.admin.address);

      // 0.05 native = $50 < $100 cap: all to the operator.
      const a = ethers.parseEther("0.05");
      await expect(f.stranger.sendTransaction({ to: fwd, value: a }))
        .to.emit(f.forwarder, "Forwarded")
        .withArgs(f.stranger.address, a)
        .and.to.emit(f.vault, "Deposit")
        .withArgs(fwd, a, 0n);
      expect((await bal(f.operator.address)) - op0).to.equal(a);
      expect(await f.vault.operatorFilledUsd()).to.equal(50n * WAD);

      // 0.1 native = $100 > $50 remaining: half to the operator, half overflow to the Safe.
      const b = ethers.parseEther("0.1");
      await f.stranger.sendTransaction({ to: fwd, value: b });
      expect((await bal(f.operator.address)) - op0).to.equal(a + b / 2n);
      expect((await bal(f.admin.address)) - safe0).to.equal(b / 2n);
      expect(await f.vault.operatorFilledUsd()).to.equal(100n * WAD);

      // Cap reached: everything overflows to the Safe.
      const c = ethers.parseEther("0.3");
      await f.stranger.sendTransaction({ to: fwd, value: c });
      expect((await bal(f.admin.address)) - safe0).to.equal(b / 2n + c);
      expect(await bal(fwd)).to.equal(0n);
      expect(await bal(vaultAddr)).to.equal(0n);
    });

    it("reverts on zero value", async function () {
      const f = await setup();
      await expect(f.stranger.sendTransaction({ to: await f.forwarder.getAddress(), value: 0n })).to.be.revertedWithCustomError(f.forwarder, "ZeroAmount");
    });

    it("reverts when the sink reverts (same strictness as the router sees from the vault today)", async function () {
      const f = await setup();
      const sink: any = await (await ethers.getContractFactory("ForwarderTestSink")).deploy(f.admin.address);
      const fwd: any = await f.Forwarder.deploy(f.admin.address, await sink.getAddress(), WBNB_ADDRESS);
      await sink.configure(await fwd.getAddress(), 1); // REVERT
      await expect(f.stranger.sendTransaction({ to: await fwd.getAddress(), value: 1n })).to.be.revertedWithCustomError(fwd, "SinkRejected");

      // The real vault reverting (its operator rejects native) reverts the forwarder too.
      const rejecting = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      await f.vault.connect(f.admin).setOperatorFill(await rejecting.getAddress(), f.admin.address, 100n * WAD, 1000n * WAD);
      await expect(f.stranger.sendTransaction({ to: await f.forwarder.getAddress(), value: 1000n })).to.be.revertedWithCustomError(f.forwarder, "SinkRejected");
    });

    it("a call with data reverts (no fallback), with or without value", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      await expect(f.stranger.sendTransaction({ to: fwd, value: 1n, data: "0x12345678" })).to.be.reverted;
      await expect(f.stranger.sendTransaction({ to: fwd, data: "0x12345678" })).to.be.reverted;
      await expect(f.stranger.sendTransaction({ to: fwd, value: 1n, data: "0x00" })).to.be.reverted;
    });

    it("the wrapped-native branch fits WETH9's 2300 gas stipend with a wide margin and moves nothing", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      const est = await ethers.provider.estimateGas({ from: WBNB_ADDRESS, to: fwd, value: 1n });
      const execution = est - 21_000n;
      console.log(`        receive() from wrapped native: ${execution} gas of execution (stipend 2300)`);
      expect(execution).to.be.lt(2300n);
      // Sent for real with exactly the stipend on top of the intrinsic cost: accepted, nothing forwarded, no event.
      await network.provider.send("hardhat_impersonateAccount", [WBNB_ADDRESS]);
      await network.provider.send("hardhat_setBalance", [WBNB_ADDRESS, ethers.toQuantity(ethers.parseEther("1"))]);
      const w = await ethers.getSigner(WBNB_ADDRESS);
      const vault0 = await bal(await f.vault.getAddress());
      const rc = await (await w.sendTransaction({ to: fwd, value: 7n, gasLimit: 21_000n + 2_300n })).wait();
      await network.provider.send("hardhat_stopImpersonatingAccount", [WBNB_ADDRESS]);
      expect(rc!.status).to.equal(1);
      expect(rc!.logs.length).to.equal(0);
      expect(await bal(fwd)).to.equal(7n);
      expect(await bal(await f.vault.getAddress())).to.equal(vault0);
    });
  });

  describe("flush()", function () {
    it("wrapped only: unwraps through real WETH9 (transfer, 2300 gas) and forwards the exact amount; fill/overflow exact", async function () {
      const f = await setup({ capUsd: 100n * WAD, priceUsd: 1000n * WAD });
      const fwd = await f.forwarder.getAddress();
      const w = ethers.parseEther("0.25"); // $250: $100 to the operator (0.1), 0.15 overflow to the Safe
      await wrapTo(f.wbnb, f.other, fwd, w);
      const op0 = await bal(f.operator.address);
      const safe0 = await bal(f.admin.address);
      const ret = await f.forwarder.connect(f.stranger).flush.staticCall();
      expect(ret[0]).to.equal(w);
      expect(ret[1]).to.equal(w);
      await expect(f.forwarder.connect(f.stranger).flush())
        .to.emit(f.forwarder, "Flushed")
        .withArgs(f.stranger.address, w, w)
        .and.to.emit(f.vault, "Deposit")
        .withArgs(fwd, w, 0n);
      expect((await bal(f.operator.address)) - op0).to.equal(ethers.parseEther("0.1"));
      expect((await bal(f.admin.address)) - safe0).to.equal(ethers.parseEther("0.15"));
      expect(await f.wbnb.balanceOf(fwd)).to.equal(0n);
      expect(await bal(fwd)).to.equal(0n);
    });

    it("native only: native forced in by selfdestruct (no receive) leaves through flush", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      const n = ethers.parseEther("0.03");
      await forceNative(fwd, n);
      expect(await bal(fwd)).to.equal(n);
      const vaultReceived0 = (await bal(f.operator.address)) + (await bal(f.admin.address));
      await expect(f.forwarder.connect(f.stranger).flush()).to.emit(f.forwarder, "Flushed").withArgs(f.stranger.address, 0n, n);
      expect(await bal(fwd)).to.equal(0n);
      expect((await bal(f.operator.address)) + (await bal(f.admin.address)) - vaultReceived0).to.equal(n);
    });

    it("wrapped + native together: one flush moves both", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      const w = ethers.parseEther("0.04");
      const n = ethers.parseEther("0.01");
      await wrapTo(f.wbnb, f.other, fwd, w);
      await forceNative(fwd, n);
      await expect(f.forwarder.flush()).to.emit(f.forwarder, "Flushed").withArgs(f.deployer.address, w, w + n);
      expect(await bal(fwd)).to.equal(0n);
      expect(await f.wbnb.balanceOf(fwd)).to.equal(0n);
    });

    it("both zero: reverts NothingToFlush", async function () {
      const f = await setup();
      await expect(f.forwarder.flush()).to.be.revertedWithCustomError(f.forwarder, "NothingToFlush");
    });

    it("a reverting sink reverts the flush and leaves the wrapped balance in place for the next one", async function () {
      const f = await setup();
      const sink: any = await (await ethers.getContractFactory("ForwarderTestSink")).deploy(f.admin.address);
      const fwd: any = await f.Forwarder.deploy(f.admin.address, await sink.getAddress(), WBNB_ADDRESS);
      const addr = await fwd.getAddress();
      await sink.configure(addr, 1); // REVERT
      await wrapTo(f.wbnb, f.other, addr, 1000n);
      await expect(fwd.flush()).to.be.revertedWithCustomError(fwd, "SinkRejected");
      expect(await f.wbnb.balanceOf(addr)).to.equal(1000n);
      await sink.configure(addr, 0); // ACCEPT
      await fwd.flush();
      expect(await sink.received()).to.equal(1000n);
      expect(await f.wbnb.balanceOf(addr)).to.equal(0n);
    });

    it("a malicious sink re-entering flush() hits the reentrancy guard", async function () {
      const f = await setup();
      const sink: any = await (await ethers.getContractFactory("ForwarderTestSink")).deploy(f.admin.address);
      const fwd: any = await f.Forwarder.deploy(f.admin.address, await sink.getAddress(), WBNB_ADDRESS);
      const addr = await fwd.getAddress();
      await wrapTo(f.wbnb, f.other, addr, 5000n);

      await sink.configure(addr, 2); // REENTER_FLUSH_BUBBLE: the inner revert bubbles, the outer flush reverts
      await expect(fwd.flush()).to.be.revertedWithCustomError(fwd, "SinkRejected");
      expect(await f.wbnb.balanceOf(addr)).to.equal(5000n);

      await sink.configure(addr, 3); // REENTER_FLUSH_CATCH: the sink swallows the inner revert; record it
      await fwd.flush();
      const inner = await sink.lastInnerRevert();
      expect(inner).to.equal(fwd.interface.getError("ReentrancyGuardReentrantCall")!.selector);
      expect(await sink.received()).to.equal(5000n);
      expect(await sink.calls()).to.equal(1n); // the re-entry moved nothing
      expect(await bal(addr)).to.equal(0n);
    });

    it("a sink sending value back into receive() during flush is harmless: it is forwarded straight back", async function () {
      const f = await setup();
      const sink: any = await (await ethers.getContractFactory("ForwarderTestSink")).deploy(f.admin.address);
      const fwd: any = await f.Forwarder.deploy(f.admin.address, await sink.getAddress(), WBNB_ADDRESS);
      const addr = await fwd.getAddress();
      await sink.configure(addr, 4); // SEND_BACK_ONCE
      await wrapTo(f.wbnb, f.other, addr, 1000n);
      await expect(fwd.flush()).to.emit(fwd, "Forwarded").withArgs(await sink.getAddress(), 500n);
      expect(await bal(await sink.getAddress())).to.equal(1000n);
      expect(await bal(addr)).to.equal(0n);
      expect(await sink.received()).to.equal(1500n); // 1000 from flush + the 500 it sent back, forwarded again
    });

    it("is permissionless", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      await wrapTo(f.wbnb, f.other, fwd, 10n);
      await expect(f.forwarder.connect(f.other).flush()).to.emit(f.forwarder, "Flushed").withArgs(f.other.address, 10n, 10n);
    });
  });

  describe("withdrawToken()", function () {
    it("only the admin; recipient is always the admin", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      const token: any = await (await ethers.getContractFactory("MockERC20")).deploy("Quote", "QT", 1_000n * WAD, f.other.address);
      await token.connect(f.other).transfer(fwd, 100n * WAD);
      await expect(f.forwarder.connect(f.stranger).withdrawToken(await token.getAddress(), 1n)).to.be.revertedWithCustomError(f.forwarder, "OnlyAdmin");
      await expect(f.forwarder.connect(f.operator).withdrawToken(await token.getAddress(), 1n)).to.be.revertedWithCustomError(f.forwarder, "OnlyAdmin");
      await expect(f.forwarder.connect(f.admin).withdrawToken(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(f.forwarder, "ZeroAddress");
      await expect(f.forwarder.connect(f.admin).withdrawToken(await token.getAddress(), 0n)).to.be.revertedWithCustomError(f.forwarder, "ZeroAmount");
      await expect(f.forwarder.connect(f.admin).withdrawToken(await token.getAddress(), 40n * WAD))
        .to.emit(f.forwarder, "TokenWithdrawn")
        .withArgs(await token.getAddress(), f.admin.address, 40n * WAD);
      expect(await token.balanceOf(f.admin.address)).to.equal(40n * WAD);
      expect(await token.balanceOf(fwd)).to.equal(60n * WAD);
      await expect(f.forwarder.connect(f.admin).withdrawToken(await token.getAddress(), 61n * WAD)).to.be.reverted;
    });

    it("a token that returns false reverts (SafeERC20); a token that blocks the admin reverts", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      const t: any = await (await ethers.getContractFactory("MockBlockableERC20")).deploy();
      await t.mint(fwd, 100n);
      await t.setBlocked(f.admin.address, true); // return false
      await expect(f.forwarder.connect(f.admin).withdrawToken(await t.getAddress(), 10n)).to.be.revertedWithCustomError(f.forwarder, "SafeERC20FailedOperation");
      await t.setBlocked(f.admin.address, false); // revert
      await expect(f.forwarder.connect(f.admin).withdrawToken(await t.getAddress(), 10n)).to.be.revertedWith("BLOCKED");
      expect(await t.balanceOf(fwd)).to.equal(100n);
      await t.setBlocked(ethers.ZeroAddress, false);
      await f.forwarder.connect(f.admin).withdrawToken(await t.getAddress(), 10n);
      expect(await t.balanceOf(f.admin.address)).to.equal(10n);
    });

    it("fee-on-transfer: the forwarder sends `amount`, the admin receives amount minus the token's fee", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      const t: any = await (await ethers.getContractFactory("MockFeeOnTransferERC20")).deploy(1000); // 10%
      await t.mint(fwd, 1000n);
      await expect(f.forwarder.connect(f.admin).withdrawToken(await t.getAddress(), 1000n))
        .to.emit(f.forwarder, "TokenWithdrawn")
        .withArgs(await t.getAddress(), f.admin.address, 1000n);
      expect(await t.balanceOf(fwd)).to.equal(0n);
      expect(await t.balanceOf(f.admin.address)).to.equal(900n);
    });

    it("wrapped native can be recovered by the admin (escape hatch if unwrap ever stops working); flush is the normal path", async function () {
      const f = await setup();
      const fwd = await f.forwarder.getAddress();
      await wrapTo(f.wbnb, f.other, fwd, 77n);
      const before = await f.wbnb.balanceOf(f.admin.address); // WBNB lives at a fixed address across tests
      await f.forwarder.connect(f.admin).withdrawToken(WBNB_ADDRESS, 77n);
      expect((await f.wbnb.balanceOf(f.admin.address)) - before).to.equal(77n);
      await expect(f.forwarder.flush()).to.be.revertedWithCustomError(f.forwarder, "NothingToFlush");
    });
  });
});
