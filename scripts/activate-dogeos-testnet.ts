/**
 * DogeOS Chikyū testnet (6281971): open the Bark launcher for creates (barkswap plan t15; used only in t29, with the
 * founder's explicit go).
 *
 *   DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO \
 *   DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS=0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF \
 *     npx hardhat run scripts/activate-dogeos-testnet.ts --network dogeosTestnet
 *
 * Its own broadcast variable (DOGEOS_TESTNET_ACTIVATE_BROADCAST, not the deploy one), and the same network, signer and
 * route-authority guards as deploy-dogeos-testnet.ts:
 *   Chikyū: the signer is the DogeOS deployer 0x6c5C…82f8, and the env route authority, the manifest's and the
 *     launcher's createSigner() must all be the DogeOS route authority 0x4fcD…76FF.
 *   Chikyū fork (in-process, cannot broadcast to Chikyū): the signer must be the manifest's admin and owner (the fork
 *     deploy's own signer), and createSigner() must equal the fork-local env route authority.
 * Reads the stack from deployments/dogeos/testnet.bark.json (a fork run may point DOGEOS_TESTNET_MANIFEST elsewhere;
 * Chikyū may not), reads every address and role back (readBackDogeosBarkStack, launcher still paused), and refuses
 * unless the signer owns the launcher and GraduationOracle.nativeUsdPrice() is fresh and inside the launcher's band.
 * Then the one call, setCreatePaused(false) on the launcher, and the read-back again with create open.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { hardhatForkUrl } from "./deploy-dogeos-testnet";
import { loadDogeosDeployGuards, readBackDogeosBarkStack } from "./lib/dogeosBarkStack";

const ROOT = path.join(__dirname, "..");

const LAUNCHER_ABI = [
  "function owner() view returns (address)",
  "function createSigner() view returns (address)",
  "function oracle() view returns (address)",
  "function minNativeUsd() view returns (uint256)",
  "function maxNativeUsd() view returns (uint256)",
  "function createPaused() view returns (bool)",
  "function setCreatePaused(bool paused_)",
];

/** The whole activation, guards first. Reads its inputs from process.env; exported so a fork run can chain it. */
export async function runDogeosTestnetActivate(opts: { log?: (line: string) => void } = {}): Promise<{ mode: string; launcher: string; calls: string[] }> {
  const guards = await loadDogeosDeployGuards();
  const log = opts.log ?? ((line: string) => console.log(`[activate-dogeos] ${line}`));

  // ---------------------------------------------------------------- guards
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const forkUrl = hardhatForkUrl();
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error(`no signer on ${network.name}`);
  const { mode, signer: sender, routeAuthority } = guards.assertActivateGuards({
    chainId,
    networkName: network.name,
    forkUrl,
    broadcastToken: process.env[guards.DOGEOS_ACTIVATE_BROADCAST_ENV],
    signer: await signer.getAddress(),
    routeAuthority: process.env[guards.DOGEOS_ROUTE_AUTHORITY_ENV],
  });
  const override = String(process.env[guards.DOGEOS_MANIFEST_OVERRIDE_ENV] || "").trim();
  if (mode === "chikyu" && override) throw new Error(`refusing: ${guards.DOGEOS_MANIFEST_OVERRIDE_ENV} is for a fork run only`);
  const manifestFile = override ? path.resolve(override) : path.join(ROOT, ...String(guards.DOGEOS_MANIFEST_PATH).split("/"));
  if (!fs.existsSync(manifestFile)) throw new Error(`${manifestFile} not found; deploy-dogeos-testnet.ts first`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  // ---------------------------------------------------------------- on-chain preconditions (read-only)
  const launcherAddress = ethers.getAddress(String(manifest?.deployed?.MwzBarkLauncher || ethers.ZeroAddress));
  const hasCode = (await ethers.provider.getCode(launcherAddress)) !== "0x";
  const launcher: any = new ethers.Contract(launcherAddress, LAUNCHER_ABI, signer);
  const onchain = hasCode
    ? {
        hasCode,
        owner: await launcher.owner(),
        createSigner: await launcher.createSigner(),
        oracle: await launcher.oracle(),
        minNativeUsd: BigInt(await launcher.minNativeUsd()),
        maxNativeUsd: BigInt(await launcher.maxNativeUsd()),
        createPaused: await launcher.createPaused(),
      }
    : { hasCode };
  let oracleProbe: { ok: true; price: bigint } | { ok: false; error: string } = { ok: false, error: "no oracle read" };
  if (hasCode) {
    const oracle: any = new ethers.Contract((onchain as any).oracle, ["function nativeUsdPrice() view returns (uint256)"], ethers.provider);
    try {
      oracleProbe = { ok: true, price: BigInt(await oracle.nativeUsdPrice()) };
    } catch (error) {
      oracleProbe = { ok: false, error: (error as any)?.shortMessage || (error as Error)?.message || String(error) };
    }
  }
  const plan = guards.planActivation({ mode, manifest, expectedRouteAuthority: routeAuthority, signer: sender, onchain, oracleProbe });
  const checks = await readBackDogeosBarkStack(manifest, { provider: ethers.provider, expectCreatePaused: true });
  log(`mode ${mode}, launcher ${plan.launcher}, createSigner ${routeAuthority}, nativeUsdPrice ${(oracleProbe as any).price}, read-back ${checks} checks`);
  log(`calls: ${plan.calls.join(", ")}`);

  // ---------------------------------------------------------------- send
  const tx = await launcher.setCreatePaused(false);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error("MwzBarkLauncher.setCreatePaused(false) failed");
  log(`MwzBarkLauncher.setCreatePaused(false): ${tx.hash}`);

  // ---------------------------------------------------------------- read-back
  guards.assertActivated({ createPaused: await launcher.createPaused() });
  await readBackDogeosBarkStack(manifest, { provider: ethers.provider, expectCreatePaused: false });
  log(`launcher ${plan.launcher} is open for creates signed by ${routeAuthority}`);
  return { mode, launcher: plan.launcher, calls: plan.calls };
}

if (require.main === module) {
  runDogeosTestnetActivate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
