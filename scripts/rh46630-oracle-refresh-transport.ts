import { ethers, network } from "hardhat";

const EXPECTED_CHAIN_ID = 46630;
const FORBIDDEN_CHAIN_ID = 4663;
const EXPECTED_ORACLE = "0x5D2A88b0963Bb5b561B495a5fDCba869C01a8cAb";
const EXPECTED_UPDATER = "0xE755A2c52654b2133c7A4fdC5349821C6527A766";

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`MISSING_PROTECTED_INPUT_${name}`);
  return value;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function main() {
  if (network.name !== "robinhoodTestnet") throw new Error(`WRONG_NETWORK_${network.name}`);

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId === FORBIDDEN_CHAIN_ID) throw new Error("PRODUCTION_4663_FORBIDDEN");
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`WRONG_CHAIN_${chainId}`);

  const oracleAddress = ethers.getAddress(required("ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630"));
  if (!sameAddress(oracleAddress, EXPECTED_ORACLE)) throw new Error("WRONG_ORACLE");

  const rawAnswer = required("ROBINHOOD_ETH_USD_8");
  if (!/^-?\d+$/.test(rawAnswer)) throw new Error("ANSWER_MUST_BE_INTEGER");
  const answer = BigInt(rawAnswer);
  if (answer <= 0n) throw new Error("ANSWER_MUST_BE_POSITIVE");

  const pkRaw = required("ROBINHOOD_TESTNET_ORACLE_UPDATER_PRIVATE_KEY");
  const signer = new ethers.Wallet(pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`, ethers.provider);
  if (!sameAddress(signer.address, EXPECTED_UPDATER)) throw new Error("WRONG_UPDATER_KEY");

  const oracle = new ethers.Contract(
    oracleAddress,
    [
      "function updater() view returns(address)",
      "function decimals() view returns(uint8)",
      "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
      "function updateAnswer(int256) returns(uint80)",
    ],
    signer,
  );

  const updater = ethers.getAddress(await oracle.updater());
  if (!sameAddress(updater, EXPECTED_UPDATER)) throw new Error("ORACLE_UPDATER_MISMATCH");
  if (Number(await oracle.decimals()) !== 8) throw new Error("ORACLE_DECIMALS_MISMATCH");

  const before = await oracle.latestRoundData();
  const beforeRoundId = BigInt(before[0]);

  const tx = await oracle.updateAnswer(answer);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("ORACLE_UPDATE_TX_FAILED");

  const after = await oracle.latestRoundData();
  const roundId = BigInt(after[0]);
  const observedAnswer = BigInt(after[1]);
  const updatedAt = BigInt(after[3]);
  if (roundId !== beforeRoundId + 1n) throw new Error("ROUND_DID_NOT_INCREMENT");
  if (observedAnswer !== answer || observedAnswer <= 0n) throw new Error("ANSWER_MISMATCH");
  if (!sameAddress(ethers.getAddress(await oracle.updater()), EXPECTED_UPDATER)) throw new Error("UPDATER_CHANGED");

  const block = await ethers.provider.getBlock(receipt.blockNumber);
  if (!block) throw new Error("BROADCAST_BLOCK_MISSING");
  if (updatedAt < BigInt(block.timestamp)) throw new Error("UPDATED_AT_BEFORE_BROADCAST_BLOCK");

  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("LATEST_BLOCK_MISSING");
  const age = BigInt(latest.timestamp) - updatedAt;
  if (age < 0n || age >= 900n) throw new Error(`ORACLE_NOT_FRESH_${age}`);

  console.log(JSON.stringify({
    txHash: receipt.hash,
    block: receipt.blockNumber,
    roundId: roundId.toString(),
    answer: observedAnswer.toString(),
    updatedAt: updatedAt.toString(),
    age: age.toString(),
    chainId,
    oracle: oracleAddress,
    updater,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
