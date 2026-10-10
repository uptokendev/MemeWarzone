/**
 * DogeOS Chikyū testnet (6281971): open the gen-7 factory for creates (plan t8; used only in t29, gate 5, with the
 * founder's explicit go).
 *
 *   DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO \
 *   DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS=0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF \
 *     npx hardhat run scripts/activate-dogeos-testnet.ts --network dogeosTestnet
 *
 * Its own broadcast variable (DOGEOS_TESTNET_ACTIVATE_BROADCAST, not the deploy one), and the same network, signer and
 * route-authority guards as deploy-dogeos-testnet.ts:
 *   Chikyū: the signer is the DogeOS deployer 0x6c5C…82f8, and both the env route authority and
 *     factory.routeAuthority() must be the DogeOS route authority 0x4fcD…76FF.
 *   Chikyū fork (in-process, cannot broadcast to Chikyū): the signer must be the manifest's admin and owner (the fork
 *     deploy's own signer), and factory.routeAuthority() must equal the fork-local env route authority.
 * Reads the factory from deployments/dogeos/testnet.json (a fork run may point DOGEOS_TESTNET_MANIFEST elsewhere; Chikyū
 * may not) and refuses unless the signer owns the factory, the factory's graduationOracle() is the manifest's, and
 * GraduationOracle.nativeUsdPrice() does not revert (the DOGE/USD answer is fresh). Then enableLive() (when not live
 * yet) and setCreatePaused(false), and asserts live() && !createPaused(). Never locks security defaults.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { hardhatForkUrl, loadDogeosDeployGuards } from "./deploy-dogeos-testnet";

const ROOT = path.join(__dirname, "..");

/** The whole activation, guards first. Reads its inputs from process.env; exported so a fork run can chain it. */
export async function runDogeosTestnetActivate(): Promise<{ mode: string; factory: string; calls: string[] }> {
  const guards = await loadDogeosDeployGuards();
  const log = (line: string) => console.log(`[activate-dogeos] ${line}`);

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
  const factoryAddress = ethers.getAddress(String(manifest?.deployed?.LaunchFactoryGen7 || ethers.ZeroAddress));
  const hasCode = (await ethers.provider.getCode(factoryAddress)) !== "0x";
  const factory: any = await ethers.getContractAt("LaunchFactoryGen7", factoryAddress, signer);
  const onchain = hasCode
    ? {
        hasCode,
        routeAuthority: await factory.routeAuthority(),
        owner: await factory.owner(),
        graduationOracle: await factory.graduationOracle(),
        live: await factory.live(),
        createPaused: await factory.createPaused(),
      }
    : { hasCode };
  let oracleProbe: { ok: true; price: bigint } | { ok: false; error: string } = { ok: false, error: "no oracle read" };
  if (hasCode) {
    const oracle: any = await ethers.getContractAt("GraduationOracle", (onchain as any).graduationOracle, signer);
    try {
      oracleProbe = { ok: true, price: BigInt(await oracle.nativeUsdPrice()) };
    } catch (error) {
      oracleProbe = { ok: false, error: (error as any)?.shortMessage || (error as Error)?.message || String(error) };
    }
  }
  const plan = guards.planActivation({ mode, manifest, expectedRouteAuthority: routeAuthority, signer: sender, onchain, oracleProbe });
  log(`mode ${mode}, factory ${plan.factory}, route authority ${routeAuthority}, nativeUsdPrice ${(oracleProbe as any).price}`);
  log(`calls: ${plan.calls.join(", ")}`);

  // ---------------------------------------------------------------- send
  async function send(txPromise: Promise<any>, label: string) {
    const tx = await txPromise;
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
    log(`${label}: ${tx.hash}`);
  }
  if (plan.calls.includes("enableLive")) await send(factory.enableLive(), "LaunchFactoryGen7.enableLive");
  if (plan.calls.includes("setCreatePaused(false)")) await send(factory.setCreatePaused(false), "LaunchFactoryGen7.setCreatePaused(false)");

  // ---------------------------------------------------------------- read-back
  const live = await factory.live();
  const createPaused = await factory.createPaused();
  guards.assertActivated({ live, createPaused });
  log(`factory ${plan.factory} is live and create is unpaused (live=${live}, createPaused=${createPaused})`);
  return { mode, factory: plan.factory, calls: plan.calls };
}

if (require.main === module) {
  runDogeosTestnetActivate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
