/**
 * Dry run of scripts/deploy-import-fee-vault.ts on a local fork with the real deployer impersonated (no key). Testnet
 * profiles send the three admin calls as the deployer; mainnet profiles write IF1, which this then executes as the
 * impersonated Safe. Records land under deployments/fork-rehearsal/ (gitignored) or REHEARSAL_OUT_DIR.
 *
 *   anvil --fork-url https://bsc-testnet-rpc.publicnode.com --chain-id 97 --port 8697 --accounts 0
 *   IMPORT_FEE_DEPLOY_TOPAZ_ROUTER=1 npx hardhat --config hardhat.bnb-gen7-fork.config.ts \
 *     run scripts/rehearse-import-fee-vault-fork.ts --network bscTestnetForkRehearsal
 *   npx hardhat --config hardhat.rh-gen7-testnet-fork.config.ts run scripts/rehearse-import-fee-vault-fork.ts   # 46630, in-process
 */
import fs from "node:fs";
import { ethers, network } from "hardhat";
import { isRehearsal, main as deployImportFeeVault, SAFE } from "./deploy-import-fee-vault";

const DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";

async function rehearse() {
  if (!isRehearsal()) throw new Error(`REFUSED: ${network.name} is not a local fork`);
  const send = (m: string, p: unknown[]) => ethers.provider.send(m, p).catch(() => ethers.provider.send(m.replace("anvil_", "hardhat_"), p));
  await send("anvil_impersonateAccount", [DEPLOYER]);
  await send("anvil_setBalance", [DEPLOYER, ethers.toQuantity(ethers.parseEther("5"))]);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  process.env[`IMPORT_FEE_PAYOUT_OPERATOR_${chainId}`] ||= ethers.Wallet.createRandom().address;
  process.env.CONFIRM_IMPORT_FEE_VAULT ||= chainId === 56 || chainId === 4663 ? "I_UNDERSTAND_MAINNET" : "I_UNDERSTAND_TESTNET";
  const out = await deployImportFeeVault({ signer: await ethers.getSigner(DEPLOYER) });
  if (out.batchFile) {
    await send("anvil_impersonateAccount", [SAFE]);
    await send("anvil_setBalance", [SAFE, ethers.toQuantity(ethers.parseEther("1"))]);
    const safe = await ethers.getSigner(SAFE);
    for (const tx of JSON.parse(fs.readFileSync(out.batchFile, "utf8")).transactions) {
      const rc = await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
      if (rc?.status !== 1) throw new Error(`IF1 ${tx.contractMethod.name} failed`);
      console.log(`[rehearse] Safe executed IF1 ${tx.contractMethod.name}`);
    }
  }
  const v = await ethers.getContractAt("RecruiterRewardsVault", out.record.vault);
  const [admin, operator, perTx, daily, paused] = await Promise.all([v.admin(), v.operator(), v.maxPayoutPerTx(), v.dailyPayoutCap(), v.payoutsPaused()]);
  console.log(`[rehearse] chain ${chainId} vault ${out.record.vault} admin ${admin} operator ${operator} caps ${ethers.formatEther(perTx)}/${ethers.formatEther(daily)} paused ${paused}`);
  if (paused) throw new Error("vault still paused after the admin calls");
  if (out.record.importSwapFeeRouter) {
    const r = await ethers.getContractAt("ImportSwapFeeRouter", out.record.importSwapFeeRouter.address);
    console.log(`[rehearse] ImportSwapFeeRouter ${out.record.importSwapFeeRouter.address}: v2Router ${await r.v2Router()} factory ${await r.v2Factory()} wrapped ${await r.wrappedNative()} bps ${await r.protocolBps()}/${await r.creatorBps()} receivers ${await r.protocolReceiver()} ${await r.creatorReceiver()}`);
  }
}

rehearse().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
