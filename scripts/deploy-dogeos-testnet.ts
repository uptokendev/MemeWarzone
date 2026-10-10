/**
 * DogeOS Chikyū testnet (6281971): deploy the fresh gen-7 stack on MuchFi (plan t8, spec §1 "Deploy outputs", gate 4).
 *
 *   DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO \
 *   DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS=0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF \
 *     npx hardhat run scripts/deploy-dogeos-testnet.ts --network dogeosTestnet          (gate 4, founder go only)
 *
 * Two modes (guards: scripts/lib/dogeosTestnetDeployGuards.mjs), both refused before any price fetch or send:
 *   Chikyū (network dogeosTestnet, chain 6281971): needs DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO, the signer
 *     must be the DogeOS deployer 0x6c5C…82f8, the public DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS must be the DogeOS
 *     route authority 0x4fcD…76FF, and neither deployments/dogeos/testnet.json nor
 *     config/verification/dogeos-testnet-contracts.json may exist yet.
 *   Chikyū fork (--config hardhat.dogeos-testnet-fork.config.ts, the in-process hardhat network, which cannot
 *     broadcast to Chikyū): still needs the broadcast token; the fork's own first signer is the deployer and admin;
 *     the route authority is any valid fork-local address that is none of the DogeOS keys and not the signer. Its
 *     outputs go to a temp dir (or DOGEOS_TESTNET_MANIFEST), never into the repo.
 * Then the initial DOGE/USD answer is Binance DOGEUSDT at run time (8 dp, refused if <= 0). Creator-vault caps are
 * TESTNET_CAPS and the airdrop-pot cap is the 46630 gen-7 pot's, both re-priced ETH -> DOGE at the run's Binance
 * ETHUSDT / DOGEUSDT. Lands createPaused and not live: activation is activate-dogeos-testnet.ts only.
 * No key is read here: the signer comes from the hardhat network (dogeosTestnet signs only with the DogeOS
 * deployer key that hardhat.config.ts loads; there is no fallback key).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { deployDogeosGen7Stack, DOGEOS_VAULT_DEX_KIND, dogeosManifestRecord, rescaleNativeCaps, writeDogeosManifest } from "./lib/dogeosGen7Stack";
import { TESTNET_CAPS } from "./deploy-robinhood-testnet-gen6-fees";
import { HOLDER_BATCH_DELAY_SECONDS, UPGRADE_DELAY_SECONDS } from "./deploy-evm-treasury-router-v4";

const ROOT = path.join(__dirname, "..");

export function loadDogeosDeployGuards(): Promise<any> {
  return Function("s", "return import(s)")(pathToFileURL(path.join(__dirname, "lib", "dogeosTestnetDeployGuards.mjs")).href);
}

/** The in-process hardhat network's fork URL, when it forks (hardhat.dogeos-testnet-fork.config.ts). */
export function hardhatForkUrl(): string {
  if (network.name !== "hardhat") return "";
  const forking = (network.config as any).forking;
  return forking && forking.enabled !== false && forking.url ? String(forking.url) : "";
}

export type DogeosDeployResult = { mode: string; manifestPath: string; verificationPath: string; record: any };

/** The whole deploy, guards first. Reads its inputs from process.env; exported so a fork run can chain activation. */
export async function runDogeosTestnetDeploy(): Promise<DogeosDeployResult> {
  const guards = await loadDogeosDeployGuards();
  const log = (line: string) => console.log(`[deploy-dogeos] ${line}`);

  // ---------------------------------------------------------------- guards (nothing fetched or sent before these)
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const forkUrl = hardhatForkUrl();
  const { mode } = guards.assertDogeosTarget({ chainId, networkName: network.name, forkUrl });
  // A fresh (not yet created) temp dir: the writers create it, so a refused run leaves nothing behind.
  const forkDir = mode === "chikyu-fork" ? path.join(os.tmpdir(), `mwz-dogeos-fork-deploy-${Date.now()}-${process.pid}`) : undefined;
  const out = guards.dogeosOutputPaths({ mode, root: ROOT, forkDir, manifestOverride: process.env[guards.DOGEOS_MANIFEST_OVERRIDE_ENV] });
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error(`no signer on ${network.name}`);
  const { signer: deployer, routeAuthority } = guards.assertDeployGuards({
    chainId,
    networkName: network.name,
    forkUrl,
    broadcastToken: process.env[guards.DOGEOS_DEPLOY_BROADCAST_ENV],
    signer: await signer.getAddress(),
    routeAuthority: process.env[guards.DOGEOS_ROUTE_AUTHORITY_ENV],
    existingOutputs: [out.manifest, out.verification].filter((f: string) => fs.existsSync(f)),
  });
  log(`mode ${mode}, chain ${chainId}, network ${network.name}, deployer/admin ${deployer}, route authority ${routeAuthority}`);
  log(`outputs: ${out.manifest}, ${out.verification}`);

  // ---------------------------------------------------------------- run-time prices (Binance spot, 8 dp)
  const dogeUsd8: bigint = await guards.fetchBinanceUsd8("DOGEUSDT");
  const ethUsd8: bigint = await guards.fetchBinanceUsd8("ETHUSDT");
  log(`Binance DOGEUSDT ${dogeUsd8} / ETHUSDT ${ethUsd8} (8 dp)`);
  const caps = rescaleNativeCaps(TESTNET_CAPS, { fromNativeUsd: ethUsd8, toNativeUsd: dogeUsd8 });
  const reference = JSON.parse(fs.readFileSync(path.join(ROOT, ...String(guards.DOGEOS_AIRDROP_CAP_REFERENCE).split("/")), "utf8"));
  const airdrop = guards.dogeosAirdropCapFromReference(reference, { ethUsd8, dogeUsd8 });
  log(`caps (DOGE wei): ${JSON.stringify(Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, String(v)])))}`);
  log(`airdrop cap ${airdrop.cap} (${airdrop.source})`);

  // ---------------------------------------------------------------- deploy + wire (t6 library; the factory lands paused, not live)
  const stack = await deployDogeosGen7Stack({
    admin: deployer,
    routeAuthority,
    oracleUpdater: guards.DOGEOS_TESTNET_ROLES.oracleUpdater,
    initialDogeUsdAnswer: dogeUsd8,
    caps,
    airdropCap: airdrop.cap,
    log: (line) => console.log(`[dogeos-gen7] ${line}`),
  });

  // ---------------------------------------------------------------- outputs
  const record = {
    ...dogeosManifestRecord(stack, { network: network.name, deployedAt: new Date().toISOString() }),
    deployInputs: {
      mode,
      dogeUsdSource: `Binance DOGEUSDT at run time: ${dogeUsd8} (8 dp)`,
      capsSource: `TESTNET_CAPS (scripts/deploy-robinhood-testnet-gen6-fees.ts) re-priced ETH->DOGE at ETHUSDT ${ethUsd8} / DOGEUSDT ${dogeUsd8} (8 dp)`,
      airdropCapSource: airdrop.source,
    },
  };
  writeDogeosManifest(out.manifest, record);
  const entries = guards.dogeosVerificationEntries(record, {
    upgradeDelaySeconds: UPGRADE_DELAY_SECONDS,
    holderBatchDelaySeconds: HOLDER_BATCH_DELAY_SECONDS,
    vaultDexKind: DOGEOS_VAULT_DEX_KIND,
  });
  guards.writeJsonFile(out.verification, guards.dogeosVerificationManifest(record, entries));
  log(`manifest -> ${out.manifest}`);
  log(`verification (${entries.length} contracts) -> ${out.verification}`);
  log(`factory ${stack.generation.factory}: createPaused, not live. STOP. Next: verify-dogeos-testnet.ts; activation only with the founder's go.`);
  return { mode, manifestPath: out.manifest, verificationPath: out.verification, record };
}

if (require.main === module) {
  runDogeosTestnetDeploy().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
