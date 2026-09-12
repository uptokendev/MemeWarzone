import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther } from "ethers";

const CHAIN_ID = 97;
const EXPECTED_OPERATOR = "0xEE2c6A7605ED378CF1D26D1d828446d63A3fdeDa";
const SOURCE_BASE = "18ffff677f8d6420c4539f9d9db9ec7eee1b0790";
const rpc = process.env.BSC_TESTNET_RPC || process.env.BSC_TESTNET_RPC_URL || process.env.BSC_RPC_HTTP_97;
const privateKey = process.env.BSC_TESTNET_PRIVATE_KEY;
const databaseUrl = process.env.DATABASE_URL;

function required(value, name) {
  if (!value) throw new Error(`BLOCKED: missing ${name}`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env, ...options });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
  return result.stdout.trim();
}

function patchLiveTests(distributorAddress, vaultAddress) {
  const claimsSource = fs.readFileSync("frontend/api/lib/agent5ClaimsCloseout.integration.test.mjs", "utf8");
  const battleSource = fs.readFileSync("frontend/api/lib/bnbBattleClaimRecovery.integration.test.mjs", "utf8");

  let claims = claimsSource;
  claims = claims.replace("JsonRpcProvider, hexlify, keccak256, randomBytes", "JsonRpcProvider, Wallet, Contract, hexlify, keccak256, randomBytes");
  claims = claims.replace(
    "owner = await provider.getSigner(0);\n  user = await provider.getSigner(1);\n  other = await provider.getSigner(2);\n  rootPoster = await provider.getSigner(3);",
    "owner = new Wallet(process.env.BSC_TESTNET_PRIVATE_KEY, provider);\n  user = owner;\n  other = Wallet.createRandom().connect(provider);\n  rootPoster = owner;",
  );
  claims = claims.replace(
    /distributor = await new ContractFactory\(rewardArtifact\.abi, rewardArtifact\.bytecode, owner\)\.deploy\(await owner\.getAddress\(\)\);\n  await distributor\.waitForDeployment\(\);\n  distributorAddress = await distributor\.getAddress\(\);/,
    `distributorAddress = "${distributorAddress}";\n  distributor = new Contract(distributorAddress, rewardArtifact.abi, owner);`,
  );
  claims = claims.replace(
    /vault = await new ContractFactory\(vaultArtifact\.abi, vaultArtifact\.bytecode, owner\)\.deploy\(await owner\.getAddress\(\), await other\.getAddress\(\), await rootPoster\.getAddress\(\)\);\n  await vault\.waitForDeployment\(\);\n  vaultAddress = await vault\.getAddress\(\);/,
    `vaultAddress = "${vaultAddress}";\n  vault = new Contract(vaultAddress, vaultArtifact.abi, owner);`,
  );
  claims = claims.replace("  await (await owner.sendTransaction({ to: vaultAddress, value: 100000000000000000n })).wait();\n", "");

  let battle = battleSource;
  battle = battle.replace("JsonRpcProvider,\n  keccak256", "JsonRpcProvider,\n  Wallet,\n  keccak256");
  battle = battle.replace(
    "owner = await provider.getSigner(0);\n  user = await provider.getSigner(1);\n  other = await provider.getSigner(2);",
    "owner = new Wallet(process.env.BSC_TESTNET_PRIVATE_KEY, provider);\n  user = owner;\n  other = Wallet.createRandom().connect(provider);",
  );
  battle = battle.replace(
    /const factory = new ContractFactory\(artifact\.abi, artifact\.bytecode, owner\);\n  distributor = await factory\.deploy\(await owner\.getAddress\(\)\);\n  await distributor\.waitForDeployment\(\);\n  distributorAddress = await distributor\.getAddress\(\);/,
    `distributorAddress = "${distributorAddress}";\n  distributor = new Contract(distributorAddress, artifact.abi, owner);`,
  );

  assert.notEqual(claims, claimsSource, "claims live transport patch did not apply");
  assert.notEqual(battle, battleSource, "battle live transport patch did not apply");
  fs.writeFileSync("frontend/api/lib/.agent5ClaimsLive97.integration.test.mjs", claims);
  fs.writeFileSync("frontend/api/lib/.agent5BattleLive97.integration.test.mjs", battle);
}

async function balanceProof(event, contractAddress, recipient, amount) {
  const blockNumber = event.blockNumber;
  const receipt = await provider.getTransactionReceipt(event.transactionHash);
  const beforeBlock = Math.max(0, blockNumber - 1);
  const recipientBefore = await provider.getBalance(recipient, beforeBlock);
  const recipientAfter = await provider.getBalance(recipient, blockNumber);
  const contractBefore = await provider.getBalance(contractAddress, beforeBlock);
  const contractAfter = await provider.getBalance(contractAddress, blockNumber);
  const gasPrice = receipt?.gasPrice ?? 0n;
  const gasCost = (receipt?.gasUsed ?? 0n) * gasPrice;
  const recipientNetCredit = recipientAfter - recipientBefore + gasCost;
  const contractDebit = contractBefore - contractAfter;
  assert.equal(recipientNetCredit, amount, `recipient credit mismatch for ${event.transactionHash}`);
  assert.equal(contractDebit, amount, `vault debit mismatch for ${event.transactionHash}`);
  return {
    txHash: event.transactionHash,
    blockNumber,
    recipient,
    amountWei: String(amount),
    recipientBalanceBeforeWei: String(recipientBefore),
    recipientBalanceAfterWei: String(recipientAfter),
    gasCostWei: String(gasCost),
    recipientNetCreditWei: String(recipientNetCredit),
    vaultBalanceBeforeWei: String(contractBefore),
    vaultBalanceAfterWei: String(contractAfter),
    vaultDebitWei: String(contractDebit),
  };
}

required(rpc, "BSC_TESTNET_RPC");
required(privateKey, "BSC_TESTNET_PRIVATE_KEY");
required(databaseUrl, "DATABASE_URL");
fs.mkdirSync("reports", { recursive: true });

const provider = new JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
const network = await provider.getNetwork();
assert.equal(Number(network.chainId), CHAIN_ID, "BSC claims acceptance must run on chain 97");
const operator = new Wallet(privateKey, provider);
assert.equal(operator.address.toLowerCase(), EXPECTED_OPERATOR.toLowerCase(), "unauthorized BSC97 operator");
const beforeOperator = await provider.getBalance(operator.address);
if (beforeOperator < 30_000_000_000_000_000n) throw new Error("BLOCKED: operator needs at least 0.03 test BNB");

run("npx", ["hardhat", "compile", "--config", "hardhat.agent5-claims-closeout.config.cjs"]);
const rewardArtifact = JSON.parse(fs.readFileSync(".agent5-artifacts/contracts/RewardDistributor.sol/RewardDistributor.json", "utf8"));
const vaultArtifact = JSON.parse(fs.readFileSync(".agent5-artifacts/contracts/TreasuryVaultV2.sol/TreasuryVaultV2.json", "utf8"));

const distributor = await new ContractFactory(rewardArtifact.abi, rewardArtifact.bytecode, operator).deploy(operator.address);
const distributorReceipt = await distributor.deploymentTransaction().wait();
const distributorAddress = await distributor.getAddress();
const vault = await new ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, operator).deploy(operator.address, operator.address, operator.address);
const vaultReceipt = await vault.deploymentTransaction().wait();
const vaultAddress = await vault.getAddress();
await (await operator.sendTransaction({ to: vaultAddress, value: 10_000_000_000_000_000n })).wait();
await (await vault.setClaimCaps(10_000_000_000_000_000n, 100_000_000_000_000_000n)).wait();
await (await vault.setClaimsPaused(false)).wait();

const distributorCode = await provider.getCode(distributorAddress);
const vaultCode = await provider.getCode(vaultAddress);
assert.notEqual(distributorCode, "0x", "RewardDistributor runtime missing");
assert.notEqual(vaultCode, "0x", "TreasuryVaultV2 runtime missing");

const deployment = {
  sourceBase: SOURCE_BASE,
  sourceHead: process.env.GITHUB_SHA || null,
  chainId: CHAIN_ID,
  operator: operator.address,
  operatorBalanceBeforeWei: String(beforeOperator),
  rewardDistributor: {
    address: distributorAddress,
    deploymentTx: distributorReceipt.hash,
    deploymentBlock: distributorReceipt.blockNumber,
    runtimeBytes: (distributorCode.length - 2) / 2,
  },
  treasuryVaultV2: {
    address: vaultAddress,
    deploymentTx: vaultReceipt.hash,
    deploymentBlock: vaultReceipt.blockNumber,
    runtimeBytes: (vaultCode.length - 2) / 2,
    owner: operator.address,
    emergencyAdmin: operator.address,
    rootPoster: operator.address,
    fundedWei: "10000000000000000",
  },
};
fs.writeFileSync("reports/agent5-bsc97-claim-rails.json", JSON.stringify(deployment, null, 2));

process.env.BSC_RPC_HTTP_97 = rpc;
process.env.REWARD_DISTRIBUTOR_ADDRESS_97 = distributorAddress;
process.env.TREASURY_VAULT_V2_ADDRESS_97 = vaultAddress;
process.env.REWARD_CLAIM_RECOVERY_FROM_BLOCK_97 = String(Math.min(distributorReceipt.blockNumber, vaultReceipt.blockNumber));
patchLiveTests(distributorAddress, vaultAddress);

try {
  run("node", ["--test", "api/lib/.agent5ClaimsLive97.integration.test.mjs"], { cwd: path.resolve("frontend") });
  const genericDb = capture("psql", [databaseUrl, "-Atc", "select coalesce(json_agg(x),'[]'::json) from (select reward_type,status,claim_tx_hash,wallet_address,amount::text,metadata from reward_ledger order by created_at) x"], { cwd: path.resolve("frontend") });
  const leagueDb = capture("psql", [databaseUrl, "-Atc", "select coalesce(json_agg(x),'[]'::json) from (select chain_id,period,category,rank,recipient_address,amount_raw::text,tx_hash from league_epoch_payouts order by epoch_start,category,rank) x"], { cwd: path.resolve("frontend") });
  fs.writeFileSync("reports/agent5-bsc97-generic-db.json", `${genericDb}\n`);
  fs.writeFileSync("reports/agent5-bsc97-league-db.json", `${leagueDb}\n`);

  run("node", ["--test", "api/lib/.agent5BattleLive97.integration.test.mjs"], { cwd: path.resolve("frontend") });
  const battleDb = capture("psql", [databaseUrl, "-Atc", "select coalesce(json_agg(x),'[]'::json) from (select reward_type,status,claim_tx_hash,wallet_address,amount::text,metadata from reward_ledger order by created_at) x"], { cwd: path.resolve("frontend") });
  fs.writeFileSync("reports/agent5-bsc97-battle-db.json", `${battleDb}\n`);
} finally {
  fs.rmSync("frontend/api/lib/.agent5ClaimsLive97.integration.test.mjs", { force: true });
  fs.rmSync("frontend/api/lib/.agent5BattleLive97.integration.test.mjs", { force: true });
}

const fromBlock = Math.min(distributorReceipt.blockNumber, vaultReceipt.blockNumber);
const rewardClaims = await distributor.queryFilter(distributor.filters.RewardClaimed(), fromBlock, "latest");
const leagueClaims = await vault.queryFilter(vault.filters.Claimed(), fromBlock, "latest");
assert.ok(rewardClaims.length > 0, "no actual RewardDistributor payout transactions observed");
assert.ok(leagueClaims.length > 0, "no actual TreasuryVaultV2 payout transactions observed");

const rewardPayoutProof = [];
for (const event of rewardClaims) {
  const recipient = event.args?.account ?? event.args?.[1];
  const amount = BigInt(event.args?.amount ?? event.args?.[2]);
  rewardPayoutProof.push(await balanceProof(event, distributorAddress, recipient, amount));
}
const leaguePayoutProof = [];
for (const event of leagueClaims) {
  const recipient = event.args?.recipient ?? event.args?.[1];
  const amount = BigInt(event.args?.amount ?? event.args?.[4] ?? event.args?.[2]);
  leaguePayoutProof.push(await balanceProof(event, vaultAddress, recipient, amount));
}

const evidence = {
  ...deployment,
  final: {
    operatorBalanceWei: String(await provider.getBalance(operator.address)),
    rewardDistributorBalanceWei: String(await provider.getBalance(distributorAddress)),
    treasuryVaultBalanceWei: String(await provider.getBalance(vaultAddress)),
    rewardPayoutProof,
    leaguePayoutProof,
  },
};
fs.writeFileSync("reports/agent5-bsc97-live-chain-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({
  accepted: true,
  chainId: CHAIN_ID,
  operator: operator.address,
  rewardDistributor: distributorAddress,
  treasuryVaultV2: vaultAddress,
  rewardPayouts: rewardClaims.length,
  leaguePayouts: leagueClaims.length,
  operatorBalanceAfterBNB: formatEther(await provider.getBalance(operator.address)),
}, null, 2));
await provider.destroy();
