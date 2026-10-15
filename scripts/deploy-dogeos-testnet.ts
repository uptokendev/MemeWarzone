/**
 * DogeOS Chikyū testnet (6281971): deploy the Bark stack (gen-8 on Barkswap custom pools; barkswap plan t15, spec
 * section 5 "Deployment 1"). The gen-7 stack this script used to deploy is gone (B8).
 *
 *   npx hardhat compile && npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile      (both builds current)
 *   DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO \
 *   DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS=0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF \
 *   DOGEOS_OPERATOR_ADDRESS=<the DogeOS operator's public address> \
 *     npm run deploy:dogeos-testnet                                                          (plan t29, founder go only)
 *
 * Two modes (guards: scripts/lib/dogeosTestnetDeployGuards.mjs), both refused before any price fetch or send:
 *   Chikyū (network dogeosTestnet, chain 6281971): needs DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO, the signer
 *     must be the DogeOS deployer 0x6c5C…82f8, the public DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS must be the DogeOS
 *     route authority 0x4fcD…76FF (the launcher's createSigner), DOGEOS_OPERATOR_ADDRESS must be a key of its own
 *     (spec B9), and none of deployments/dogeos/testnet.bark.json, config/verification/dogeos-testnet-contracts.json
 *     and deployments/dogeos/testnet.bark.partial.json may exist yet.
 *   Chikyū fork (`npx hardhat --config hardhat.dogeos-bark-fork.config.ts run scripts/deploy-dogeos-testnet.ts`, the
 *     in-process hardhat network, which cannot broadcast to Chikyū): still needs the broadcast token; the fork's own
 *     first signer is the deployer and admin; route authority and operator are fork-local addresses that collide with
 *     no DogeOS key. Its outputs go to a temp dir (or DOGEOS_TESTNET_MANIFEST), never into the repo.
 * Then the initial DOGE/USD answer is Binance DOGEUSDT at run time (8 dp, refused if <= 0), and the choice-vault caps
 * are the gen-8 testnet caps (TESTNET_CAPS, in ETH) re-priced to DOGE at the run's Binance ETHUSDT / DOGEUSDT. The
 * launcher lands createPaused: opening it is activate-dogeos-testnet.ts only.
 * Partial runs: before every send, after it returns and when it is mined, the run rewrites `<manifest>.partial.json`
 * with every transaction and every contract so far (and the planned Bark addresses). It is removed right after the
 * final manifest is written (the manifest alone marks a completed run; the verification JSON follows from it). If a run stops half-way the file stays, and every later run refuses until the founder
 * has checked what was deployed and removed it by hand: there is no resume, and no second stack goes out silently.
 * No key is read here: the signer comes from the hardhat network (dogeosTestnet signs only with the DogeOS deployer key
 * that hardhat.config.ts loads; there is no fallback key).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers, network } from "hardhat";
import { deployDogeosBarkStack, dogeosBarkManifestRecord, loadDogeosDeployGuards, writeDogeosManifest } from "./lib/dogeosBarkStack";
import { TESTNET_CAPS } from "./deploy-robinhood-testnet-gen6-fees";

const ROOT = path.join(__dirname, "..");

export { loadDogeosDeployGuards };

/** The in-process hardhat network's fork URL, when it forks (hardhat.dogeos-bark-fork.config.ts). */
export function hardhatForkUrl(): string {
  if (network.name !== "hardhat") return "";
  const forking = (network.config as any).forking;
  return forking && forking.enabled !== false && forking.url ? String(forking.url) : "";
}

export type DogeosDeployResult = { mode: string; manifestPath: string; verificationPath: string; record: any };
export type DogeosDeployOptions = { fetchImpl?: typeof fetch; log?: (line: string) => void };

/** The whole deploy, guards first. Reads its inputs from process.env; exported so a fork run can chain activation. */
export async function runDogeosTestnetDeploy(opts: DogeosDeployOptions = {}): Promise<DogeosDeployResult> {
  const guards = await loadDogeosDeployGuards();
  const log = opts.log ?? ((line: string) => console.log(`[deploy-dogeos] ${line}`));

  // ---------------------------------------------------------------- guards (nothing fetched or sent before these)
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const forkUrl = hardhatForkUrl();
  const { mode } = guards.assertDogeosTarget({ chainId, networkName: network.name, forkUrl });
  // A fresh (not yet created) temp dir: the writers create it, so a refused run leaves nothing behind.
  const forkDir = mode === "chikyu-fork" ? path.join(os.tmpdir(), `mwz-dogeos-fork-deploy-${Date.now()}-${process.pid}`) : undefined;
  const out = guards.dogeosOutputPaths({ mode, root: ROOT, forkDir, manifestOverride: process.env[guards.DOGEOS_MANIFEST_OVERRIDE_ENV] });
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error(`no signer on ${network.name}`);
  const { signer: deployer, routeAuthority, operator } = guards.assertDeployGuards({
    chainId,
    networkName: network.name,
    forkUrl,
    broadcastToken: process.env[guards.DOGEOS_DEPLOY_BROADCAST_ENV],
    signer: await signer.getAddress(),
    routeAuthority: process.env[guards.DOGEOS_ROUTE_AUTHORITY_ENV],
    operator: process.env[guards.DOGEOS_OPERATOR_ENV],
    existingOutputs: [out.partial, out.manifest, out.verification].filter((f: string) => fs.existsSync(f)),
  });
  log(`mode ${mode}, chain ${chainId}, network ${network.name}, deployer/admin ${deployer}, route authority ${routeAuthority}, operator ${operator}`);
  log(`outputs: ${out.manifest}, ${out.verification} (partial record while running: ${out.partial})`);

  // ---------------------------------------------------------------- run-time prices (Binance spot, 8 dp)
  const dogeUsd8: bigint = await guards.fetchBinanceUsd8("DOGEUSDT", opts.fetchImpl);
  const ethUsd8: bigint = await guards.fetchBinanceUsd8("ETHUSDT", opts.fetchImpl);
  log(`Binance DOGEUSDT ${dogeUsd8} / ETHUSDT ${ethUsd8} (8 dp)`);
  const caps = guards.choiceVaultCapsInDoge(TESTNET_CAPS, { ethUsd8, dogeUsd8 });
  log(`choice-vault caps (DOGE wei): ${JSON.stringify(Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, String(v)])))}`);

  // ---------------------------------------------------------------- deploy + wire (the launcher lands createPaused)
  const writePartial = (progress: object) =>
    guards.writeJsonFile(out.partial, {
      ...progress,
      network: network.name,
      manifest: out.manifest,
      updatedAt: new Date().toISOString(),
      howToClear:
        "This run sent the transactions below and stopped before writing its manifest. Check each on the explorer, then remove this file by hand; the next deploy refuses while it exists (no resume).",
    });
  let stack;
  try {
    stack = await deployDogeosBarkStack({
      admin: deployer,
      routeAuthority,
      operator,
      oracleUpdater: guards.DOGEOS_TESTNET_ROLES.oracleUpdater,
      initialDogeUsdAnswer: dogeUsd8,
      choiceVaultCaps: caps,
      log: (line) => log(`[dogeos-bark] ${line}`),
      onProgress: writePartial,
    });
  } catch (error) {
    if (fs.existsSync(out.partial)) {
      const message = (error as Error)?.message ?? String(error);
      throw new Error(`${message}; deploy stopped after sending transactions, the partial record is ${out.partial} (check it, then remove it by hand)`);
    }
    throw error;
  }

  // ---------------------------------------------------------------- outputs
  const record = {
    ...dogeosBarkManifestRecord(stack, { network: network.name, deployedAt: new Date().toISOString() }),
    deployInputs: {
      mode,
      dogeUsdSource: `Binance DOGEUSDT at run time: ${dogeUsd8} (8 dp)`,
      capsSource: `TESTNET_CAPS (scripts/deploy-robinhood-testnet-gen6-fees.ts, the gen-8 testnet caps) re-priced ETH->DOGE at ETHUSDT ${ethUsd8} / DOGEUSDT ${dogeUsd8} (8 dp)`,
    },
  };
  const entries = guards.dogeosVerificationEntries(record);
  writeDogeosManifest(out.manifest, record);
  // The manifest now holds everything the partial record held and marks the run complete. A kill between these two
  // lines leaves both files; the guards then say the run may have completed.
  fs.rmSync(out.partial, { force: true });
  guards.writeJsonFile(out.verification, guards.dogeosVerificationManifest(record, entries));
  log(`manifest -> ${out.manifest}`);
  log(`verification (${entries.length} contracts) -> ${out.verification}`);
  log(`launcher ${stack.deployed.MwzBarkLauncher}: createPaused. STOP. Next: verify-dogeos-testnet.ts (both builds); activation only with the founder's go.`);
  return { mode, manifestPath: out.manifest, verificationPath: out.verification, record };
}

if (require.main === module) {
  runDogeosTestnetDeploy().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
