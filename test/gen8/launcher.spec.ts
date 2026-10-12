import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployGen8, launch, req, reqTuple, hashReq, signCreate, now, mineAt, trade, mineHookSalt, revertOf, Env, TEST_TARGET, FAST_TARGET, DEFAULT_TARGET, coder,
} from "./fixtures/gen8";
import { BPS, WAD, SUPPLY, RESERVE, gen7Curve, sqrtAtTick, isqrt } from "./fixtures/v4math";

async function base() {
  return deployGen8();
}

async function impersonate(addr: string) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

/** Deploys a fresh hook + launcher pair with custom wiring, for the constructor checks. */
async function deployLauncherWith(env: Env, o: { vaultLauncher?: string; lockLauncher?: string; oracle?: string; min?: bigint; max?: bigint; owner?: string }) {
  const deployer = env.deployer;
  const n0 = await ethers.provider.getTransactionCount(deployer.address);
  // tx order: hook (n0), vault (n0+1), lock (n0+2), launcher (n0+3)
  const launcherAddr = ethers.getCreateAddress({ from: deployer.address, nonce: n0 + 3 });
  const HookF = await ethers.getContractFactory("MwzLaunchHook", { libraries: env.libs });
  const initCode = (await HookF.getDeployTransaction(await env.pm.getAddress(), launcherAddr, env.safe.address, env.other.address, ethers.ZeroAddress)).data!;
  const { salt, address: hookAddr } = mineHookSalt(await env.c2.getAddress(), initCode);
  await (await env.c2.connect(deployer).deploy(salt, initCode)).wait();
  const vault = await (await ethers.getContractFactory("MwzCreatorChoiceVault")).connect(deployer).deploy(env.safe.address, hookAddr, o.vaultLauncher ?? launcherAddr, 86400);
  const lock = await (await ethers.getContractFactory("MwzReserveLock")).connect(deployer).deploy(hookAddr, o.lockLauncher ?? launcherAddr, await vault.getAddress());
  const L = await ethers.getContractFactory("MwzV4Launcher");
  const args = [await env.pm.getAddress(), hookAddr, o.oracle ?? (await env.oracle.getAddress()), await lock.getAddress(), await vault.getAddress(), o.owner ?? env.safe.address, env.apiSigner.address, o.min ?? 50n * WAD, o.max ?? 50_000n * WAD];
  return { L, args, launcherAddr, hookAddr, deploy: () => L.connect(deployer).deploy(...(args as [any, any, any, any, any, any, any, any, any])) };
}

describe("gen8 MwzV4Launcher", function () {
  describe("constructor wiring and constants (L1)", () => {
    it("fixed rates, supply split and limits", async () => {
      const env = await loadFixture(base);
      const L = env.launcher;
      expect((await L.feeConfig()).map((x: bigint) => x)).to.deep.eq([200n, 100n, 50n, 9000n, 560n]);
      expect(await L.SUPPLY()).to.eq(SUPPLY);
      expect(await L.COINS_A()).to.eq(850_000_000n * WAD);
      expect(await L.COINS_B()).to.eq(130_000_000n * WAD);
      expect(await L.CREATOR_RESERVE()).to.eq(RESERVE);
      expect(await L.FIRST_BUY_MAX()).to.eq(700_000_000n * WAD);
      expect(await L.MAX_AUTH_TTL()).to.eq(86400n);
      expect(await L.createPaused()).to.eq(false); // opened by the fixture; deploys paused (next test)
      expect(await L.owner()).to.eq(env.safe.address);
      expect(await L.createSigner()).to.eq(env.apiSigner.address);
    });

    it("deploys paused; rejects a hook bound elsewhere, unbound vault / lock, zero addresses and an unsuitable oracle", async () => {
      const env = await loadFixture(base);
      const ok = await deployLauncherWith(env, {});
      const launcher = await ok.deploy();
      expect(await launcher.getAddress()).to.eq(ok.launcherAddr);
      expect(await launcher.createPaused()).to.eq(true);
      // the existing hook is bound to the fixture launcher, not to a new one
      const L = await ethers.getContractFactory("MwzV4Launcher");
      await expect(L.deploy(await env.pm.getAddress(), await env.hook.getAddress(), await env.oracle.getAddress(), await env.reserveLock.getAddress(), await env.vault.getAddress(), env.safe.address, env.apiSigner.address, WAD, 2n * WAD)).to.be.revertedWithCustomError(L, "HookMismatch");
      const badVault = await deployLauncherWith(env, { vaultLauncher: env.other.address });
      await expect(badVault.deploy()).to.be.revertedWithCustomError(L, "WiringMismatch");
      const badLock = await deployLauncherWith(env, { lockLauncher: env.other.address });
      await expect(badLock.deploy()).to.be.revertedWithCustomError(L, "WiringMismatch");
      const zeroOwner = await deployLauncherWith(env, { owner: ethers.ZeroAddress });
      await expect(zeroOwner.deploy()).to.be.revertedWithCustomError(L, "ZeroAddress");
      const badBand = await deployLauncherWith(env, { min: 10n * WAD, max: 10n * WAD });
      await expect(badBand.deploy()).to.be.revertedWithCustomError(L, "OracleUnsuitable");
      const slowFeed = await (await ethers.getContractFactory("GraduationOracle")).deploy(await env.feed.getAddress(), 2 * 86400 + 1);
      const slow = await deployLauncherWith(env, { oracle: await slowFeed.getAddress() });
      await expect(slow.deploy()).to.be.revertedWithCustomError(L, "OracleUnsuitable");
    });
  });

  describe("curve sizing from the oracle (L2, L3)", () => {
    it("plan() == gen-7 curveForMarketCap on the oracle's market cap, ticks on the grid nearest the gen-7 prices", async () => {
      const env = await loadFixture(base);
      for (const target of [TEST_TARGET, FAST_TARGET, DEFAULT_TARGET]) {
        const [mc, vN, vT, tickStart, tickGrad] = await env.launcher.plan(target);
        expect(mc).to.eq(await env.oracle.nativeTargetForUsd(target));
        const g = gen7Curve(mc);
        expect([vN, vT]).to.deep.eq([g.vN, g.vT]);
        expect(Number(tickStart) % 10).to.eq(0);
        expect(Number(tickGrad) % 10).to.eq(0);
        const root = isqrt(vN * vT);
        const s0 = (vT << 96n) / root;
        const s1 = ((vT - 850_000_000n * WAD) << 96n) / root;
        for (const [t, s] of [[Number(tickStart), s0], [Number(tickGrad), s1]] as [number, bigint][]) {
          const here = sqrtAtTick(t);
          const dist = here > s ? here - s : s - here;
          expect(dist <= sqrtAtTick(t + 10) - here && dist <= here - sqrtAtTick(t - 10)).to.eq(true);
        }
      }
    });

    it("graduation target allow-list: $30K and $50K, $150 only on testnets (and local 31337)", async () => {
      const env = await loadFixture(base);
      expect(await env.launcher.isGraduationTargetAllowed(FAST_TARGET)).to.eq(true);
      expect(await env.launcher.isGraduationTargetAllowed(DEFAULT_TARGET)).to.eq(true);
      expect(await env.launcher.isGraduationTargetAllowed(TEST_TARGET)).to.eq(true); // chain 31337
      expect(await env.launcher.isGraduationTargetAllowed(40_000n * WAD)).to.eq(false);
      expect(await env.launcher.isGraduationTargetAllowed(0n)).to.eq(false);
      const r = req({ targetUsd: 40_000n * WAD });
      const deadline = (await now()) + 600n;
      const sig = await signCreate(env, env.creator.address, r, deadline);
      await expect(env.launcher.connect(env.creator).launch(reqTuple(r), { deadline, signature: sig })).to.be.revertedWithCustomError(env.launcher, "UnsupportedGraduationTarget");
    });

    it("a stale, non-positive or out-of-band oracle price refuses the launch, never a trade", async () => {
      const env = await loadFixture(base);
      const { P } = await launch(env, env.creator, { firstBuyValue: WAD / 10n });
      const t0 = await now();
      await (await env.feed.set(600n * 10n ** 8n, t0 - 4000n)).wait(); // older than the oracle's 3600 s
      await expect(env.launcher.plan(FAST_TARGET)).to.be.revertedWithCustomError(env.launcher, "OraclePriceUnavailable");
      await expect(launch(env, env.creator2)).to.be.revertedWithCustomError(env.launcher, "OraclePriceUnavailable");
      // trading is unaffected by the oracle
      await mineAt(P.launchTs + 61n);
      await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: WAD });
      await (await env.feed.set(0n, await now())).wait();
      await expect(env.launcher.plan(FAST_TARGET)).to.be.revertedWithCustomError(env.launcher, "OraclePriceUnavailable");
      // F6: the fixture uses the BNB production band, $10 .. $100,000
      await (await env.feed.set(999_999_999n, await now())).wait(); // $9.99999999
      await expect(env.launcher.plan(FAST_TARGET)).to.be.revertedWithCustomError(env.launcher, "OraclePriceOutOfBand");
      await (await env.feed.set(100_000n * 10n ** 8n + 1n, await now())).wait();
      await expect(env.launcher.plan(FAST_TARGET)).to.be.revertedWithCustomError(env.launcher, "OraclePriceOutOfBand");
      await (await env.feed.set(100_000n * 10n ** 8n, await now())).wait();
      expect((await env.launcher.plan(FAST_TARGET))[0]).to.eq(await env.oracle.nativeTargetForUsd(FAST_TARGET));
    });

    it("C8 bounds: a market cap under 0.001 native or a curve above 1e30 virtual native reverts", async () => {
      const env = await loadFixture(base);
      await expect(env.launcher.curveForMarketCap(10n ** 15n - 1n)).to.be.revertedWithCustomError(env.launcher, "TargetOutOfRangeAtPrice");
      await expect(env.launcher.curveForMarketCap(10n ** 33n)).to.be.revertedWithCustomError(env.launcher, "TargetOutOfRangeAtPrice");
      const g = gen7Curve(10n ** 15n);
      expect(await env.launcher.curveForMarketCap(10n ** 15n)).to.deep.eq([g.vN, g.vT]);
    });
  });

  describe("create authorization (L4, D3)", () => {
    it("digest matches the API scheme (EIP-191 over chain, launcher, creator, request hash, deadline)", async () => {
      const env = await loadFixture(base);
      const r = req();
      expect(await env.launcher.hashRequest(reqTuple(r))).to.eq(hashReq(r));
      const deadline = (await now()) + 600n;
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const payload = ethers.keccak256(coder.encode(["bytes32", "uint256", "address", "address", "bytes32", "uint64"], [ethers.id("MWZ_GEN8_CREATE_AUTH"), chainId, await env.launcher.getAddress(), env.creator.address, hashReq(r), deadline]));
      expect(await env.launcher.authorizationDigest(env.creator.address, reqTuple(r), deadline)).to.eq(ethers.hashMessage(ethers.getBytes(payload)));
    });

    it("expired, too long, wrong signer, someone else's signature, a tampered request and a replay all revert", async () => {
      const env = await loadFixture(base);
      const L = env.launcher;
      const r = req();
      const t = await now();
      const go = (who: any, rr: any, deadline: bigint, sig: string, value = 0n) => L.connect(who).launch(reqTuple(rr), { deadline, signature: sig }, { value });
      await expect(go(env.creator, r, t - 1n, await signCreate(env, env.creator.address, r, t - 1n))).to.be.revertedWithCustomError(L, "AuthorizationExpired");
      const far = t + 2n * 86400n; // margin: after a fixture revert hardhat moves time on by the wall-clock time elapsed
      await expect(go(env.creator, r, far, await signCreate(env, env.creator.address, r, far))).to.be.revertedWithCustomError(L, "AuthorizationTooLong");
      const d = t + 600n;
      await expect(go(env.creator, r, d, await signCreate(env, env.creator.address, r, d, env.attacker))).to.be.revertedWithCustomError(L, "InvalidAuthorization");
      const sig = await signCreate(env, env.creator.address, r, d);
      await expect(go(env.attacker, r, d, sig)).to.be.revertedWithCustomError(L, "InvalidAuthorization"); // front-run with the creator's signature
      await expect(go(env.creator, { ...r, name: "Other" }, d, sig)).to.be.revertedWithCustomError(L, "InvalidAuthorization");
      await expect(go(env.creator, { ...r, salt: r.salt + 1n }, d, sig)).to.be.revertedWithCustomError(L, "InvalidAuthorization");
      await expect(go(env.creator, r, d + 1n, sig)).to.be.revertedWithCustomError(L, "InvalidAuthorization");
      await (await go(env.creator, r, d, sig)).wait();
      expect(await L.usedAuthorizations(await L.authorizationDigest(env.creator.address, reqTuple(r), d))).to.eq(true);
      await expect(go(env.creator, r, d, sig)).to.be.revertedWithCustomError(L, "AuthorizationReplayed");
      // a malleable (high-s) twin of a valid signature is rejected by OZ ECDSA
      const r2 = req();
      const sig2 = ethers.Signature.from(await signCreate(env, env.creator.address, r2, d));
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const highS = ethers.concat([sig2.r, ethers.toBeHex(n - BigInt(sig2.s), 32), sig2.v === 27 ? "0x1c" : "0x1b"]);
      expect(await revertOf(() => go(env.creator, r2, d, highS), env)).to.match(/ECDSAInvalidSignatureS|InvalidAuthorization/);
    });

    it("signer rotation and zero signer; only the owner", async () => {
      const env = await loadFixture(base);
      await expect(env.launcher.connect(env.attacker).setCreateSigner(env.attacker.address)).to.be.revertedWithCustomError(env.launcher, "NotOwner");
      await expect(env.launcher.connect(env.safe).setCreateSigner(ethers.ZeroAddress)).to.emit(env.launcher, "CreateSignerUpdated").withArgs(env.apiSigner.address, ethers.ZeroAddress);
      await expect(launch(env, env.creator)).to.be.revertedWithCustomError(env.launcher, "CreateSignerZero");
      await (await env.launcher.connect(env.safe).setCreatePaused(true)).wait();
      await expect(env.launcher.connect(env.safe).setCreatePaused(false)).to.be.revertedWithCustomError(env.launcher, "CreateSignerZero");
      await (await env.launcher.connect(env.safe).setCreateSigner(env.other.address)).wait();
      await (await env.launcher.connect(env.safe).setCreatePaused(false)).wait();
      await expect(launch(env, env.creator)).to.be.revertedWithCustomError(env.launcher, "InvalidAuthorization"); // old key no longer valid
    });
  });

  describe("create pause (L5, D4)", () => {
    it("pauses launches only: trades, claims and graduation keep working; only the owner toggles", async () => {
      const env = await loadFixture(base);
      const { P } = await launch(env, env.creator, { firstBuyValue: WAD / 10n });
      await expect(env.launcher.connect(env.attacker).setCreatePaused(true)).to.be.revertedWithCustomError(env.launcher, "NotOwner");
      await expect(env.launcher.connect(env.safe).setCreatePaused(true)).to.emit(env.launcher, "CreatePauseUpdated").withArgs(true);
      await expect(launch(env, env.creator2)).to.be.revertedWithCustomError(env.launcher, "CreatePaused");
      await mineAt(P.launchTs + 61n);
      const t = await trade(env, P, { wallet: env.bot, buy: true, exactIn: true, amount: 20n * WAD });
      expect(t.graduated).to.not.eq(null);
      await (await env.hook.connect(env.creator).claimCreator(P.id, env.creator.address)).wait();
      await (await env.hook.connect(env.operator).claimRouter()).wait();
      await (await env.launcher.connect(env.safe).setCreatePaused(false)).wait();
      await launch(env, env.creator2);
    });
  });

  describe("request checks and the creator first buy", () => {
    it("empty name / symbol / logo, bad fee choices and a value different from the signed first buy revert", async () => {
      const env = await loadFixture(base);
      const L = env.launcher;
      const d = (await now()) + 600n;
      const go = async (o: any, value?: bigint) => {
        const r = req(o);
        return L.connect(env.creator).launch(reqTuple(r), { deadline: d, signature: await signCreate(env, env.creator.address, r, d) }, { value: value ?? r.firstBuyValue });
      };
      await expect(go({ name: "" })).to.be.revertedWithCustomError(L, "NameEmpty");
      await expect(go({ symbol: "" })).to.be.revertedWithCustomError(L, "SymbolEmpty");
      await expect(go({ logoURI: "" })).to.be.revertedWithCustomError(L, "LogoEmpty");
      for (const [c, p] of [[0, 0], [5, 0], [3, 0], [3, 100], [1, 10], [2, 5], [4, 1]]) {
        await expect(go({ feeChoice: c, feeCreatorPct: p })).to.be.revertedWithCustomError(L, "InvalidFeeChoice");
      }
      await expect(go({ firstBuyValue: WAD }, WAD - 1n)).to.be.revertedWithCustomError(L, "FirstBuyValueMismatch");
      await expect(go({}, 1n)).to.be.revertedWithCustomError(L, "FirstBuyValueMismatch");
    });

    it("one atomic transaction: token, pool, reserve lock, first buy at 2%; the launcher keeps no coins and no native", async () => {
      const env = await loadFixture(base);
      const value = WAD;
      const { P, rc, ev, r } = await launch(env, env.creator, { firstBuyValue: value, minFirstBuyOut: 1n });
      const L = await env.launcher.getAddress();
      expect(await P.coin.balanceOf(L)).to.eq(0n);
      expect(await ethers.provider.getBalance(L)).to.eq(0n);
      expect(await P.coin.balanceOf(env.creator.address)).to.eq(ev.args.firstBuyOut);
      expect(ev.args.firstBuyIn).to.eq(value);
      expect(ev.args.hookCreator).to.eq(env.creator.address);
      const fee = rc.logs.map((l: any) => { try { return env.hook.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "HookFee");
      expect(fee.args.feeBps).to.eq(200n);
      expect(fee.args.swapSender).to.eq(L);
      const cost = (value * BPS) / (BPS + 200n);
      expect(fee.args.curveAmount).to.eq(cost);
      expect(fee.args.fee).to.eq(value - cost);
      const meta = rc.logs.map((l: any) => { try { return env.launcher.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "LaunchMetadata");
      expect([meta.args.name, meta.args.symbol, meta.args.logoURI, meta.args.xAccount, meta.args.website, meta.args.extraLink, meta.args.metadataHash]).to.deep.eq([r.name, r.symbol, r.logoURI, r.xAccount, r.website, r.extraLink, r.metadataHash]);
      expect(await P.coin.name()).to.eq(r.name);
      expect(await P.coin.symbol()).to.eq(r.symbol);
      expect(await P.coin.decimals()).to.eq(18n);
      const res = await env.reserveLock.reserves(P.id);
      expect([res.token, res.amount]).to.deep.eq([P.token, RESERVE]);
    });

    it("first buy up to 70% of supply; above 70% reverts FirstBuyTooLarge; below the signed minimum reverts FirstBuyTooSmall", async () => {
      const env = await loadFixture(base);
      // native that buys exactly 700M from the start price at the 2% rate, from the gen-7 curve: cost = Y(700M) - vN
      const [, vN, vT] = await env.launcher.plan(FAST_TARGET);
      const s = 700_000_000n * WAD;
      const curveCost = (vN * vT + (vT - s) - 1n) / (vT - s) - vN;
      // tick rounding shifts the V4 curve by < 0.03%: 0.5% under passes, 0.5% over fails
      const under = ((curveCost * 995n) / 1000n * (BPS + 200n)) / BPS;
      const over = ((curveCost * 1005n) / 1000n * (BPS + 200n)) / BPS;
      const { ev } = await launch(env, env.creator, { firstBuyValue: under });
      expect(ev.args.firstBuyOut <= 700_000_000n * WAD && ev.args.firstBuyOut > 690_000_000n * WAD).to.eq(true);
      await expect(launch(env, env.creator2, { firstBuyValue: over })).to.be.revertedWithCustomError(env.launcher, "FirstBuyTooLarge");
      await expect(launch(env, env.creator2, { firstBuyValue: WAD, minFirstBuyOut: 10n ** 30n })).to.be.revertedWithCustomError(env.launcher, "FirstBuyTooSmall");
      // a value far above A's raise (buys deep into B) also reverts
      await expect(launch(env, env.creator2, { firstBuyValue: 1000n * WAD })).to.be.revertedWithCustomError(env.launcher, "FirstBuyTooLarge");
    });

    it("fee choice: keep pays the creator wallet directly; holders / split / buyback register the choice vault as the hook creator", async () => {
      const env = await loadFixture(base);
      const { P: keep } = await launch(env, env.creator, { feeChoice: 1 });
      expect((await env.hook.pools(keep.id)).creator).to.eq(env.creator.address);
      for (const [choice, pct] of [[2, 0], [3, 40], [4, 0]]) {
        const { P, ev } = await launch(env, env.creator2, { feeChoice: choice, feeCreatorPct: pct });
        expect(ev.args.hookCreator).to.eq(await env.vault.getAddress());
        expect((await env.hook.pools(P.id)).creator).to.eq(await env.vault.getAddress());
        const c = await env.vault.cfg(P.id);
        expect([c.creator, c.choice, c.creatorPct, c.token]).to.deep.eq([env.creator2.address, BigInt(choice), BigInt(pct), P.token]);
        expect(await env.reserveLock.beneficiaryOf(P.id)).to.eq(env.creator2.address);
      }
    });

    it("unlockCallback only from the PoolManager and only inside launch (A11)", async () => {
      const env = await loadFixture(base);
      await expect(env.launcher.connect(env.attacker).unlockCallback("0x")).to.be.revertedWithCustomError(env.launcher, "NotPoolManager");
      const pmSigner = await impersonate(await env.pm.getAddress());
      await expect(env.launcher.connect(pmSigner).unlockCallback("0x")).to.be.revertedWithCustomError(env.launcher, "CallbackOutsideLaunch");
    });

    it("ownership is two-step", async () => {
      const env = await loadFixture(base);
      await expect(env.launcher.connect(env.attacker).transferOwnership(env.attacker.address)).to.be.revertedWithCustomError(env.launcher, "NotOwner");
      await (await env.launcher.connect(env.safe).transferOwnership(env.other.address)).wait();
      await expect(env.launcher.connect(env.attacker).acceptOwnership()).to.be.revertedWithCustomError(env.launcher, "NotOwner");
      await (await env.launcher.connect(env.other).acceptOwnership()).wait();
      expect(await env.launcher.owner()).to.eq(env.other.address);
    });
  });

  describe("MwzV4Token", () => {
    it("plain ERC20: fixed 1B supply, no owner, no tax, free transfers", async () => {
      const env = await loadFixture(base);
      const { P } = await launch(env, env.creator, { firstBuyValue: WAD });
      const fns = P.coin.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name).sort();
      expect(fns).to.deep.eq(["allowance", "approve", "balanceOf", "decimals", "name", "symbol", "totalSupply", "transfer", "transferFrom"]);
      const amt = 1_234_567n * WAD;
      await (await P.coin.connect(env.creator).transfer(env.payee.address, amt)).wait();
      expect(await P.coin.balanceOf(env.payee.address)).to.eq(amt);
      expect(await P.coin.totalSupply()).to.eq(SUPPLY);
    });
  });
});
