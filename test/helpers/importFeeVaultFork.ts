/**
 * Shared fork setup for the CO-IMP proofs: runs scripts/deploy-import-fee-vault.ts in-process on a local anvil fork as
 * the impersonated real deployer (mainnet profile: admin = the Safe, batch IF1 written under deployments/fork-rehearsal/),
 * then executes IF1 exactly as written, as the impersonated Safe. Nothing is signed with a real key.
 */
import { expect } from "chai";
import fs from "node:fs";
import { ethers } from "hardhat";
import { main as deployImportFeeVault, SAFE } from "../../scripts/deploy-import-fee-vault";

export const DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
export const rpc = (m: string, p: unknown[] = []) => ethers.provider.send(m, p);

export async function impersonate(addr: string, fund = "10") {
  await rpc("anvil_impersonateAccount", [addr]);
  await rpc("anvil_setBalance", [addr, ethers.toQuantity(ethers.parseEther(fund))]);
  return ethers.getSigner(addr);
}

/** A throwaway wallet funded on the fork only (never a real key). */
export async function freshWallet(fund: string) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await rpc("anvil_setBalance", [w.address, ethers.toQuantity(ethers.parseEther(fund))]);
  return w;
}

/** Deploy the ImportFeeVault through the deploy script, then execute its Safe batch as the Safe. */
export async function deployVaultOnFork(chainId: number, opts: { withTopazRouter?: boolean } = {}) {
  const operator = ethers.Wallet.createRandom().address;
  const saved = { ...process.env };
  let out: any;
  try {
    process.env.CONFIRM_IMPORT_FEE_VAULT = "I_UNDERSTAND_MAINNET";
    process.env[`IMPORT_FEE_PAYOUT_OPERATOR_${chainId}`] = operator;
    if (opts.withTopazRouter) process.env.IMPORT_FEE_DEPLOY_TOPAZ_ROUTER = "1";
    // Fresh run every time: a previous rehearsal's record would otherwise resume onto a vault this fork never saw.
    process.env.REHEARSAL_OUT_DIR = fs.mkdtempSync(`${require("node:os").tmpdir()}/import-fee-vault-fork-`);
    const deployer = await impersonate(DEPLOYER, "5");
    out = await deployImportFeeVault({ signer: deployer });
  } finally {
    process.env = saved;
  }
  expect(out.record.admin).to.equal(SAFE);
  const batch = JSON.parse(fs.readFileSync(out.batchFile, "utf8"));
  expect(Number(batch.chainId)).to.equal(chainId);
  expect(batch.transactions.map((t: any) => t.contractMethod.name)).to.deep.equal(["setOperator", "setPayoutCaps", "setPayoutsPaused"]);
  const safe = await impersonate(SAFE, "1");
  for (const tx of batch.transactions) {
    const rc = await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
    expect(rc!.status).to.equal(1);
  }
  await rpc("anvil_stopImpersonatingAccount", [SAFE]);
  const vault = await ethers.getContractAt("RecruiterRewardsVault", out.record.vault);
  expect(await vault.payoutsPaused()).to.equal(false);
  expect(await vault.operator()).to.equal(operator);
  return { vault, vaultAddress: out.record.vault as string, operator, record: out.record };
}

/** Every Deposit(from, amount, newBalance) the vault emitted in a receipt. */
export function vaultDeposits(vault: any, rc: any) {
  const addr = String(vault.target).toLowerCase();
  return rc.logs
    .filter((l: any) => String(l.address).toLowerCase() === addr)
    .map((l: any) => vault.interface.parseLog(l))
    .filter((e: any) => e && e.name === "Deposit")
    .map((e: any) => ({ from: String(e.args.from), amount: BigInt(e.args.amount), newBalance: BigInt(e.args.newBalance) }));
}

export const gasCost = (rc: any) => BigInt(rc.gasUsed) * BigInt(rc.gasPrice ?? rc.effectiveGasPrice);
