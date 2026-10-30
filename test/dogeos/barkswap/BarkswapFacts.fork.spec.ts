// Barkswap (Algebra Integral 1.2.1) on DogeOS Chikyu 6281971: the deployed facts every Bark contract depends on.
// Source: docs/dogeos/barkswap-facts.md §1-§2 (spec docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md
// §1). Read-only fork test: nothing here sends a transaction.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkswapFacts.fork.spec.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  BARKSWAP,
  CUSTOM_POOL_DEPLOYER_ROLE,
  DOGEOS_CHIKYU_CHAIN_ID,
  DOGEOS_CHIKYU_BLOCK_GAS_LIMIT,
  barkswapContracts,
  factoryAccessControl,
  readyFork,
} from "./fixtures/barkswap";

// AlgebraFactory.sol:60 at cryptoalgebra/Algebra tag v1.2.1-integral. v1.2.2 and v1.2.3 use 0x62441ebe…, v1.2 0xb3fc09be….
const ALGEBRA_1_2_1_POOL_INIT_CODE_HASH = "0xa18736c3ee97fe3c96c9428c0cc2a9116facec18e84f95f9da30543f8238a782";
// keccak256("CUSTOM_POOL_DEPLOYER"), AlgebraFactory.sol at v1.2.1-integral
const CUSTOM_POOL_DEPLOYER_HASH = "0xc9cf812513d9983585eb40fcfe6fd49fbb6a45815663ec33b30a6c6c7de3683b";
// AlgebraFactory.defaultCommunityFee: 30 / 1000 = 3% of the whole swap fee (facts §2, §8)
const DEFAULT_COMMUNITY_FEE = 30n;

describe("Barkswap facts on the Chikyu fork", function () {
  let c: Awaited<ReturnType<typeof barkswapContracts>>;

  before(async function () {
    await readyFork();
    c = await barkswapContracts();
  });

  it("runs on a Chikyu fork with Chikyu's 10M block gas limit", async function () {
    const net = await ethers.provider.getNetwork();
    expect(net.chainId).to.equal(DOGEOS_CHIKYU_CHAIN_ID);
    const block = await ethers.provider.getBlock("latest");
    expect(block!.gasLimit).to.equal(DOGEOS_CHIKYU_BLOCK_GAS_LIMIT);
  });

  for (const role of ["factory", "customPoolEntryPoint", "swapRouter", "quoterV2", "nonfungiblePositionManager", "wdoge"] as const) {
    it(`has code at the Barkswap ${role}`, async function () {
      const code = await ethers.provider.getCode(BARKSWAP[role]);
      expect(code.length, `${role} ${BARKSWAP[role]}`).to.be.greaterThan(2);
    });
  }

  it("is Algebra Integral 1.2.1: factory POOL_INIT_CODE_HASH is 1.2.1's", async function () {
    expect(await c.factory.POOL_INIT_CODE_HASH()).to.equal(ALGEBRA_1_2_1_POOL_INIT_CODE_HASH);
  });

  it("the entry point holds CUSTOM_POOL_DEPLOYER, and it is the only holder", async function () {
    expect(CUSTOM_POOL_DEPLOYER_ROLE).to.equal(CUSTOM_POOL_DEPLOYER_HASH);
    expect(await c.factory.CUSTOM_POOL_DEPLOYER()).to.equal(CUSTOM_POOL_DEPLOYER_HASH);
    const acl = factoryAccessControl();
    expect(await acl.hasRole(CUSTOM_POOL_DEPLOYER_HASH, BARKSWAP.customPoolEntryPoint)).to.equal(true);
    expect(await acl.getRoleMemberCount(CUSTOM_POOL_DEPLOYER_HASH)).to.equal(1n);
  });

  it("the factory's default community fee is 30 (3% of the swap fee)", async function () {
    expect(await c.factory.defaultCommunityFee()).to.equal(DEFAULT_COMMUNITY_FEE);
  });

  it("the periphery points at this factory and at WDOGE", async function () {
    expect(await c.factory.poolDeployer()).to.equal(BARKSWAP.poolDeployer);
    expect(await c.customPoolEntryPoint.factory()).to.equal(BARKSWAP.factory);
    expect(await c.swapRouterState.factory()).to.equal(BARKSWAP.factory);
    expect(await c.swapRouterState.WNativeToken()).to.equal(BARKSWAP.wdoge);
    expect(await c.nonfungiblePositionManager.factory()).to.equal(BARKSWAP.factory);
    expect(await c.nonfungiblePositionManager.WNativeToken()).to.equal(BARKSWAP.wdoge);
    expect(await c.wdogeMetadata.symbol()).to.equal("WDOGE");
  });
});
