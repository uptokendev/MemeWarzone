import { expect } from "chai";
import { ethers } from "hardhat";
import { authorizeBatch, createAuthorizedBatch, latestTs } from "./helpers/settlementAuth";

function hexToBigInt(h: string) {
  return BigInt(h);
}

function hashPair(a: string, b: string) {
  const [x, y] = hexToBigInt(a) < hexToBigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

function leafFor(account: string, amount: bigint) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, amount]);
  return ethers.keccak256(ethers.concat([ethers.keccak256(encoded)]));
}

function buildMerkleRootAndProof(leaves: string[], index: number) {
  let level = leaves.slice();
  const proof: string[] = [];
  let idx = index;

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(hashPair(left, right));

      if (i === idx || i + 1 === idx) {
        const sibling = i === idx ? right : left;
        if (sibling !== level[idx]) proof.push(sibling);
        idx = Math.floor(i / 2);
      }
    }
    level = next;
  }

  return { root: level[0], proof };
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("RewardDistributor", function () {
  async function deployFixture() {
    const [owner, operator, user, other, recovery] = await ethers.getSigners();
    const RewardDistributor = await ethers.getContractFactory("RewardDistributor");
    const distributor = await RewardDistributor.deploy(await owner.getAddress());
    await distributor.waitForDeployment();
    return { distributor, owner, operator, user, other, recovery };
  }

  it("lets a wallet claim its BNB reward once", async () => {
    const { distributor, owner, user } = await deployFixture();
    const amount = ethers.parseEther("0.25");
    const batchId = ethers.id("airdrop-week-1");
    const root = leafFor(await user.getAddress(), amount);

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, amount);

    await expect(() => distributor.connect(user).claim(batchId, amount, [])).to.changeEtherBalances(
      [distributor, user],
      [-amount, amount]
    );
    expect(await distributor.hasClaimed(batchId, await user.getAddress())).to.eq(true);

    await expect(distributor.connect(user).claim(batchId, amount, [])).to.be.revertedWithCustomError(
      distributor,
      "AlreadyClaimed"
    );
  });

  it("lets the configured batch operator create funded batches", async () => {
    const { distributor, owner, operator, user } = await deployFixture();
    const batchId = ethers.id("operator-airdrop");
    const amount = ethers.parseEther("0.15");
    const root = leafFor(await user.getAddress(), amount);

    await expect(distributor.connect(owner).setBatchOperator(await operator.getAddress()))
      .to.emit(distributor, "BatchOperatorUpdated")
      .withArgs(ethers.ZeroAddress, await operator.getAddress());

    await authorizeBatch(distributor, owner, batchId, amount);
    await expect(distributor.connect(operator).createBatch(batchId, root, 0, { value: amount }))
      .to.emit(distributor, "BatchCreated")
      .withArgs(batchId, root, amount, 0);

    const batch = await distributor.batches(batchId);
    expect(batch.merkleRoot).to.eq(root);
    expect(batch.totalFunded).to.eq(amount);
    expect(batch.totalClaimed).to.eq(0n);
    expect(batch.exists).to.eq(true);
  });

  it("restricts owner-only operator and global pause controls", async () => {
    const { distributor, owner, operator, other } = await deployFixture();
    const operatorAddress = await operator.getAddress();
    const otherAddress = await other.getAddress();

    await expect(distributor.connect(other).setBatchOperator(operatorAddress))
      .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
      .withArgs(otherAddress);
    await expect(distributor.connect(other).pause())
      .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
      .withArgs(otherAddress);
    await expect(distributor.connect(other).unpause())
      .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
      .withArgs(otherAddress);

    await distributor.connect(owner).setBatchOperator(operatorAddress);
    expect(await distributor.batchOperator()).to.eq(operatorAddress);

    await distributor.connect(owner).pause();
    expect(await distributor.paused()).to.eq(true);
    await distributor.connect(owner).unpause();
    expect(await distributor.paused()).to.eq(false);
  });

  it("rejects unauthorized or malformed batch creation", async () => {
    const { distributor, owner, user, other } = await deployFixture();
    const batchId = ethers.id("bad-batch");
    const amount = ethers.parseEther("0.1");
    const root = leafFor(await user.getAddress(), amount);

    await expect(distributor.connect(other).createBatch(batchId, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "NotBatchOperator"
    );
    await expect(distributor.connect(owner).createBatch(ethers.ZeroHash, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "RootZero"
    );
    await expect(distributor.connect(owner).createBatch(batchId, ethers.ZeroHash, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "RootZero"
    );
    await expect(distributor.connect(owner).createBatch(batchId, root, 0, { value: 0n })).to.be.revertedWithCustomError(
      distributor,
      "AmountZero"
    );
    await expect(distributor.connect(owner).createBatch(batchId, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "BatchNotAuthorized"
    );

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, amount);
    await expect(distributor.connect(owner).createBatch(batchId, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "BatchExists"
    );
  });

  it("rejects invalid proofs", async () => {
    const { distributor, owner, user, other } = await deployFixture();
    const amount = ethers.parseEther("0.1");
    const batchId = ethers.id("airdrop-week-2");
    const root = leafFor(await user.getAddress(), amount);

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, amount);

    await expect(distributor.connect(other).claim(batchId, amount, [])).to.be.revertedWithCustomError(
      distributor,
      "InvalidProof"
    );
  });

  it("blocks claims while globally paused and allows them after unpause", async () => {
    const { distributor, owner, user } = await deployFixture();
    const amount = ethers.parseEther("0.1");
    const batchId = ethers.id("global-pause-airdrop");
    const root = leafFor(await user.getAddress(), amount);

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, amount);
    await distributor.connect(owner).pause();

    await expect(distributor.connect(user).claim(batchId, amount, [])).to.be.revertedWithCustomError(
      distributor,
      "EnforcedPause"
    );
    expect(await distributor.hasClaimed(batchId, await user.getAddress())).to.eq(false);

    await distributor.connect(owner).unpause();
    await expect(distributor.connect(user).claim(batchId, amount, []))
      .to.emit(distributor, "RewardClaimed")
      .withArgs(batchId, await user.getAddress(), amount);
  });

  it("blocks claims when a batch is paused", async () => {
    const { distributor, owner, user } = await deployFixture();
    const amount = ethers.parseEther("0.1");
    const batchId = ethers.id("airdrop-week-3");
    const root = leafFor(await user.getAddress(), amount);

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, amount);
    await expect(distributor.connect(owner).setBatchPaused(batchId, true))
      .to.emit(distributor, "BatchPauseUpdated")
      .withArgs(batchId, true);

    await expect(distributor.connect(user).claim(batchId, amount, [])).to.be.revertedWithCustomError(
      distributor,
      "BatchPaused"
    );

    await expect(distributor.connect(owner).setBatchPaused(ethers.id("missing"), true)).to.be.revertedWithCustomError(
      distributor,
      "BatchMissing"
    );
  });

  it("blocks claims after the claim deadline", async () => {
    const { distributor, owner, user } = await deployFixture();
    const amount = ethers.parseEther("0.1");
    const batchId = ethers.id("expired-airdrop");
    const root = leafFor(await user.getAddress(), amount);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await createAuthorizedBatch(distributor, owner, batchId, root, now + 30, amount);
    await increaseTime(31);

    await expect(distributor.connect(user).claim(batchId, amount, [])).to.be.revertedWithCustomError(
      distributor,
      "BatchExpired"
    );
  });

  it("rejects missing batches and zero amount claims", async () => {
    const { distributor, owner, user } = await deployFixture();
    const amount = ethers.parseEther("0.1");
    const batchId = ethers.id("zero-claim");
    const root = leafFor(await user.getAddress(), amount);

    await expect(distributor.connect(user).claim(ethers.id("missing"), amount, [])).to.be.revertedWithCustomError(
      distributor,
      "BatchMissing"
    );

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, amount);
    await expect(distributor.connect(user).claim(batchId, 0n, [])).to.be.revertedWithCustomError(
      distributor,
      "AmountZero"
    );
  });

  it("enforces funded unclaimed balance across multiple valid leaves", async () => {
    const { distributor, owner, user, other } = await deployFixture();
    const batchId = ethers.id("underfunded-airdrop");
    const amountUser = ethers.parseEther("0.1");
    const amountOther = ethers.parseEther("0.1");
    const leafUser = leafFor(await user.getAddress(), amountUser);
    const leafOther = leafFor(await other.getAddress(), amountOther);
    const { root, proof: proofUser } = buildMerkleRootAndProof([leafUser, leafOther], 0);
    const { proof: proofOther } = buildMerkleRootAndProof([leafUser, leafOther], 1);

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, ethers.parseEther("0.15"));
    await distributor.connect(user).claim(batchId, amountUser, proofUser);

    await expect(distributor.connect(other).claim(batchId, amountOther, proofOther)).to.be.revertedWithCustomError(
      distributor,
      "InsufficientUnclaimed"
    );
    expect(await distributor.unclaimed(batchId)).to.eq(ethers.parseEther("0.05"));
  });

  it("recovers unclaimed BNB after the deadline", async () => {
    const { distributor, owner, user, recovery } = await deployFixture();
    const amount = ethers.parseEther("0.5");
    const batchId = ethers.id("airdrop-week-4");
    const root = leafFor(await user.getAddress(), amount);
    const recoveryAddress = await recovery.getAddress();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await createAuthorizedBatch(distributor, owner, batchId, root, now + 60, amount);

    await expect(distributor.connect(owner).recoverUnclaimed(batchId, recoveryAddress)).to.be.revertedWithCustomError(
      distributor,
      "BatchStillOpen"
    );

    await increaseTime(61);

    await expect(() => distributor.connect(owner).recoverUnclaimed(batchId, recoveryAddress)).to.changeEtherBalances(
      [distributor, recovery],
      [-amount, amount]
    );
    expect(await distributor.unclaimed(batchId)).to.eq(0n);
  });

  it("rolls back recovered accounting when the recovery recipient rejects BNB", async () => {
    const { distributor, owner, user } = await deployFixture();
    const RevertingReceiver = await ethers.getContractFactory("RevertingReceiver");
    const rejectingReceiver = await RevertingReceiver.deploy();
    await rejectingReceiver.waitForDeployment();

    const amount = ethers.parseEther("0.25");
    const batchId = ethers.id("recovery-transfer-failure");
    const root = leafFor(await user.getAddress(), amount);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await createAuthorizedBatch(distributor, owner, batchId, root, now + 10, amount);
    await increaseTime(11);

    await expect(distributor.connect(owner).recoverUnclaimed(batchId, await rejectingReceiver.getAddress())).to.be.revertedWithCustomError(
      distributor,
      "TransferFailed"
    );
    expect(await distributor.unclaimed(batchId)).to.eq(amount);
    expect(await ethers.provider.getBalance(await distributor.getAddress())).to.eq(amount);
  });

  it("rejects recovery for missing, open-ended, or fully claimed batches", async () => {
    const { distributor, owner, user, recovery } = await deployFixture();
    const amount = ethers.parseEther("0.2");
    const batchId = ethers.id("fully-claimed");
    const root = leafFor(await user.getAddress(), amount);
    const recoveryAddress = await recovery.getAddress();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await expect(distributor.connect(owner).recoverUnclaimed(ethers.id("missing"), recoveryAddress)).to.be.revertedWithCustomError(
      distributor,
      "BatchMissing"
    );

    await createAuthorizedBatch(distributor, owner, ethers.id("open-ended"), root, 0, amount);
    await expect(distributor.connect(owner).recoverUnclaimed(ethers.id("open-ended"), recoveryAddress)).to.be.revertedWithCustomError(
      distributor,
      "BatchStillOpen"
    );

    await createAuthorizedBatch(distributor, owner, batchId, root, now + 20, amount);
    await distributor.connect(user).claim(batchId, amount, []);
    await increaseTime(21);

    await expect(distributor.connect(owner).recoverUnclaimed(batchId, recoveryAddress)).to.be.revertedWithCustomError(
      distributor,
      "AmountZero"
    );
  });

  it("requires Safe-authorized batches before the operator can publish a settlement", async () => {
    const { distributor, owner, operator, user } = await deployFixture();
    const batchId = ethers.id("auth-required");
    const amount = ethers.parseEther("0.4");
    const root = leafFor(await user.getAddress(), amount);
    const now = await latestTs();

    await distributor.connect(owner).setBatchOperator(await operator.getAddress());
    await expect(distributor.connect(operator).createBatch(batchId, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "BatchNotAuthorized"
    );
    await expect(distributor.connect(operator).authorizeBatch(batchId, amount, now, now + 3600)).to.be.revertedWithCustomError(
      distributor,
      "OwnableUnauthorizedAccount"
    );

    await distributor.connect(owner).authorizeBatch(batchId, amount, now + 10_000, now + 20_000);
    await expect(distributor.connect(operator).createBatch(batchId, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "BatchTooEarly"
    );

    await distributor.connect(owner).authorizeBatch(batchId, amount, now - 20, now - 1);
    await expect(distributor.connect(operator).createBatch(batchId, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "BatchAuthExpired"
    );

    await distributor.connect(owner).authorizeBatch(batchId, amount, now, now + 3600);
    await distributor.connect(owner).revokeBatch(batchId);
    await expect(distributor.connect(operator).createBatch(batchId, root, 0, { value: amount })).to.be.revertedWithCustomError(
      distributor,
      "BatchNotAuthorized"
    );

    await authorizeBatch(distributor, owner, batchId, ethers.parseEther("0.1"));
    await expect(
      distributor.connect(operator).createBatch(batchId, root, 0, { value: amount })
    ).to.be.revertedWithCustomError(distributor, "BatchAboveAuthorizedMax");

    await authorizeBatch(distributor, owner, batchId, amount);
    await distributor.connect(operator).createBatch(batchId, root, 0, { value: amount });
    await expect(distributor.connect(owner).authorizeBatch(batchId, amount, now, now + 3600)).to.be.revertedWithCustomError(
      distributor,
      "BatchAuthConsumed"
    );
  });
});
