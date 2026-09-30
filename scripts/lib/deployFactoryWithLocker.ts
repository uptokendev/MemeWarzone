import { ethers } from "hardhat";
import type { Signer } from "ethers";

/**
 * Deploys a generation's permanent locker and its factory as two consecutive transactions.
 *
 * The factory no longer creates its locker (that `new` pushed BnbBasicLaunchFactory's initcode to
 * 48,797 of EIP-3860's 49,152). The locker's `admin` is immutable and gates every registration and
 * configuration call, so it is deployed with `admin` = the factory's CREATE address -- the signer's
 * next nonce -- and the factory constructor refuses a locker whose `admin()` is not itself.
 *
 * Both transactions carry explicit nonces, so nothing can slip between them from this signer. If
 * anything still lands the factory elsewhere, the constructor reverts `LockerNotBoundToFactory` and
 * the only loss is one locker deployment (it has no admin that exists, so it can never hold value).
 *
 * The locker kind follows the router exactly as the factory reads it: `liquidityKind() == 2` means a
 * Uniswap V3 position locker, anything else a Topaz V2 LP locker.
 */
export type LockerKind = "v2" | "v3";

export async function detectLockerKind(router: string): Promise<LockerKind> {
  try {
    const raw = await ethers.provider.call({ to: router, data: ethers.id("liquidityKind()").slice(0, 10) });
    if (raw && raw !== "0x" && BigInt(raw) === 2n) return "v3";
  } catch {
    // no liquidityKind(): a plain Topaz V2 router, same fallback as LaunchFactory._readLiquidityKind
  }
  return "v2";
}

export async function deployFactoryWithLocker(opts: {
  factoryName: "LaunchFactory" | "BnbBasicLaunchFactory" | string;
  /** Constructor arguments without the trailing locker; args[0] is the router the factory reads. */
  args: unknown[];
  signer?: Signer;
  lockerKind?: LockerKind;
  log?: (line: string) => void;
}) {
  const signer = opts.signer ?? (await ethers.getSigners())[0];
  const from = await signer.getAddress();
  const kind = opts.lockerKind ?? (await detectLockerKind(String(opts.args[0])));
  const lockerName = kind === "v3" ? "PermanentV3PositionLocker" : "PermanentLpLocker";

  const nonce = await ethers.provider.getTransactionCount(from, "pending");
  const predictedFactory = ethers.getCreateAddress({ from, nonce: nonce + 1 });

  const locker = await (await ethers.getContractFactory(lockerName, signer)).deploy(predictedFactory, { nonce });
  await locker.waitForDeployment();
  const lockerAddress = await locker.getAddress();
  opts.log?.(`${lockerName}=${lockerAddress} (admin = predicted factory ${predictedFactory})`);

  const factory = await (await ethers.getContractFactory(opts.factoryName, signer)).deploy(...opts.args, lockerAddress, {
    nonce: nonce + 1,
  });
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  if (factoryAddress.toLowerCase() !== predictedFactory.toLowerCase()) {
    throw new Error(`factory landed at ${factoryAddress}, locker admin is ${predictedFactory}`);
  }
  const boundLocker = await (factory as any).permanentLpLocker();
  if (String(boundLocker).toLowerCase() !== lockerAddress.toLowerCase()) {
    throw new Error(`factory.permanentLpLocker ${boundLocker} != deployed locker ${lockerAddress}`);
  }
  opts.log?.(`${opts.factoryName}=${factoryAddress}`);
  return { factory: factory as any, factoryAddress, locker: locker as any, lockerAddress, lockerKind: kind };
}
