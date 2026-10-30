import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const INITIAL_ANSWER = 25_000_000n; // $0.25 at 8 decimals
const NEXT_ANSWER = 26_000_000n; // $0.26 at 8 decimals
const MAX_PRICE_AGE = 3600;

async function deployOracleFixture() {
  const [deployer, updater, other] = await ethers.getSigners();
  const Oracle = await ethers.getContractFactory("DogeosTestnetDogeUsdOracle", deployer);
  const oracle = await Oracle.deploy(await updater.getAddress(), INITIAL_ANSWER, true);
  await oracle.waitForDeployment();
  return { deployer, updater, other, Oracle, oracle };
}

describe("DogeosTestnetDogeUsdOracle", function () {
  it("runs on local chain 31337", async function () {
    expect(network.config.chainId).to.equal(31337);
  });

  it("refuses local chain 31337 without the rehearsal flag", async function () {
    const [deployer, updater] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("DogeosTestnetDogeUsdOracle", deployer);
    await expect(Oracle.deploy(await updater.getAddress(), INITIAL_ANSWER, false))
      .to.be.revertedWithCustomError(Oracle, "WrongChain")
      .withArgs(31337n);
  });

  it("deploys on 31337 with the rehearsal flag and records the chain and updater", async function () {
    const { oracle, updater } = await loadFixture(deployOracleFixture);
    expect(await oracle.DOGEOS_TESTNET_CHAIN_ID()).to.equal(6281971n);
    expect(await oracle.LOCAL_REHEARSAL_CHAIN_ID()).to.equal(31337n);
    expect(await oracle.certifiedChainId()).to.equal(31337n);
    expect(await oracle.localRehearsal()).to.equal(true);
    expect(await oracle.updater()).to.equal(await updater.getAddress());
    expect(await oracle.description()).to.equal("DOGE / USD - DogeOS Chikyu Testnet 6281971");
    expect(await oracle.SOURCE_VERSION()).to.equal("mwz-dogeos6281971-doge-usd-aggregator-v1");
    expect(await oracle.version()).to.equal(1n);
  });

  it("has no Robinhood chain constants", async function () {
    const { oracle } = await loadFixture(deployOracleFixture);
    expect(oracle.interface.getFunction("ROBINHOOD_TESTNET_CHAIN_ID")).to.equal(null);
    expect(oracle.interface.getFunction("ROBINHOOD_MAINNET_CHAIN_ID")).to.equal(null);
  });

  it("reports 8 decimals", async function () {
    const { oracle } = await loadFixture(deployOracleFixture);
    expect(await oracle.decimals()).to.equal(8n);
  });

  it("rejects a zero updater and a non-positive initial answer", async function () {
    const [deployer, updater] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("DogeosTestnetDogeUsdOracle", deployer);
    await expect(Oracle.deploy(ethers.ZeroAddress, INITIAL_ANSWER, true)).to.be.revertedWithCustomError(Oracle, "ZeroUpdater");
    await expect(Oracle.deploy(await updater.getAddress(), 0, true))
      .to.be.revertedWithCustomError(Oracle, "InvalidAnswer")
      .withArgs(0n);
    await expect(Oracle.deploy(await updater.getAddress(), -1, true))
      .to.be.revertedWithCustomError(Oracle, "InvalidAnswer")
      .withArgs(-1n);
  });

  it("only the updater can publish an answer", async function () {
    const { oracle, other, deployer } = await loadFixture(deployOracleFixture);
    await expect(oracle.connect(other).updateAnswer(NEXT_ANSWER))
      .to.be.revertedWithCustomError(oracle, "UnauthorizedUpdater")
      .withArgs(await other.getAddress());
    await expect(oracle.connect(deployer).updateAnswer(NEXT_ANSWER))
      .to.be.revertedWithCustomError(oracle, "UnauthorizedUpdater")
      .withArgs(await deployer.getAddress());
  });

  it("rejects zero and negative answers", async function () {
    const { oracle, updater } = await loadFixture(deployOracleFixture);
    await expect(oracle.connect(updater).updateAnswer(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer").withArgs(0n);
    await expect(oracle.connect(updater).updateAnswer(-1)).to.be.revertedWithCustomError(oracle, "InvalidAnswer").withArgs(-1n);
    const latest = await oracle.latestRoundData();
    expect(latest[0]).to.equal(1n);
    expect(latest[1]).to.equal(INITIAL_ANSWER);
  });

  it("advances rounds monotonically from 1 to 2 with answeredInRound == roundId", async function () {
    const { oracle, updater } = await loadFixture(deployOracleFixture);
    const first = await oracle.latestRoundData();
    expect(first[0]).to.equal(1n);
    expect(first[1]).to.equal(INITIAL_ANSWER);
    expect(first[2]).to.be.greaterThan(0n);
    expect(first[3]).to.equal(first[2]);
    expect(first[4]).to.equal(first[0]);

    await expect(oracle.connect(updater).updateAnswer(NEXT_ANSWER))
      .to.emit(oracle, "AnswerUpdated")
      .withArgs(2n, NEXT_ANSWER, (ts: bigint) => ts > 0n, await updater.getAddress());

    const second = await oracle.latestRoundData();
    expect(second[0]).to.equal(2n);
    expect(second[1]).to.equal(NEXT_ANSWER);
    expect(second[3]).to.be.greaterThanOrEqual(first[3]);
    expect(second[4]).to.equal(2n);
  });

  it("getRoundData returns historical rounds and reverts RoundUnavailable for unwritten rounds", async function () {
    const { oracle, updater } = await loadFixture(deployOracleFixture);
    await oracle.connect(updater).updateAnswer(NEXT_ANSWER);

    const round1 = await oracle.getRoundData(1);
    expect(round1[0]).to.equal(1n);
    expect(round1[1]).to.equal(INITIAL_ANSWER);
    expect(round1[4]).to.equal(1n);

    const round2 = await oracle.getRoundData(2);
    const latest = await oracle.latestRoundData();
    expect(round2[0]).to.equal(2n);
    expect(round2[1]).to.equal(NEXT_ANSWER);
    expect(round2[4]).to.equal(2n);
    expect([...round2]).to.deep.equal([...latest]);

    await expect(oracle.getRoundData(0)).to.be.revertedWithCustomError(oracle, "RoundUnavailable").withArgs(0n);
    await expect(oracle.getRoundData(3)).to.be.revertedWithCustomError(oracle, "RoundUnavailable").withArgs(3n);
  });

  it("GraduationOracle(feed, 3600) reads the price and reverts StalePrice after 3601 s", async function () {
    const { oracle, deployer } = await loadFixture(deployOracleFixture);
    const GraduationOracle = await ethers.getContractFactory("GraduationOracle", deployer);
    const graduationOracle = await GraduationOracle.deploy(await oracle.getAddress(), MAX_PRICE_AGE);
    await graduationOracle.waitForDeployment();

    expect(await graduationOracle.nativeUsdPrice()).to.equal(INITIAL_ANSWER * 10n ** 10n);

    await network.provider.send("evm_increaseTime", [MAX_PRICE_AGE + 1]);
    await network.provider.send("evm_mine");
    await expect(graduationOracle.nativeUsdPrice()).to.be.revertedWithCustomError(graduationOracle, "StalePrice");
  });
});
