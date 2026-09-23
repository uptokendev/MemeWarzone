import { ethers } from "hardhat";

/**
 * Authorize a PermanentLpLocker on TreasuryRouterV3, or say who must.
 *
 * Both lockers -- PermanentLpLocker on BNB and PermanentV3PositionLocker on
 * Robinhood -- send the protocol's share of every LP fee harvest through
 * TreasuryRouterV3.routeLpToken, which is gated by authorizedLpLocker. Both
 * wrap that call in try/catch on purpose: a treasury that refuses the money
 * must not be able to brick a harvest. So an unauthorized locker does not
 * revert. It pays the creator in full, parks the protocol share, emits a
 * pending event, and reports success.
 *
 * Every surface a deployment checks reads healthy. Only the protocol vault
 * stays at zero, and nobody watches the protocol vault during a deployment.
 * The BSC testnet canary stranded real fees this way before this existed.
 *
 * The first locker on a fresh router goes in with one call. Once any locker is
 * authorized -- which is the case on any router that has served a previous
 * generation -- the router requires propose, then upgradeDelay, then accept.
 * That is not a failure, it is a timelock, and it has to be reported as one.
 */
export type LpLockerWiring = {
  wired: boolean;
  /** Calls the router admin still has to send, in order. */
  ownerActions: Array<{ to: string; data: string; why: string }>;
  /** Unix seconds after which acceptAuthorizedLpLocker can be sent, when timelocked. */
  acceptableAt?: bigint;
};

const ROUTER_ABI = [
  "function admin() view returns (address)",
  "function authorizedLpLocker(address) view returns (bool)",
  "function anyLpLockerAuthorized() view returns (bool)",
  "function permanentLpLocker() view returns (address)",
  "function pendingAuthorizedLpLocker() view returns (address)",
  "function pendingAuthorizedLpLockerSince() view returns (uint64)",
  "function upgradeDelay() view returns (uint64)",
  "function setAuthorizedLpLocker(address locker, bool allowed)",
  "function proposeAuthorizedLpLocker(address locker)",
  "function acceptAuthorizedLpLocker()",
  "function setPrimaryLpLocker(address newLocker)",
];

export async function wireLpLocker(options: {
  treasuryRouter: string;
  lockerAddress: string;
  senderAddress: string;
  log?: (message: string) => void;
  send?: boolean;
}): Promise<LpLockerWiring> {
  const log = options.log ?? ((message: string) => console.log(message));
  const send = options.send ?? true;
  const router = await ethers.getContractAt(ROUTER_ABI, options.treasuryRouter);
  const iface = (router as any).interface;

  if (await (router as any).authorizedLpLocker(options.lockerAddress)) {
    log(`  ok router.authorizedLpLocker[${options.lockerAddress}] = true (already set)`);
    return { wired: true, ownerActions: [] };
  }

  const timelocked = await (router as any).anyLpLockerAuthorized();
  const admin = ethers.getAddress(await (router as any).admin());
  const adminIsSender = admin.toLowerCase() === options.senderAddress.toLowerCase();

  const actions = timelocked
    ? [
        { to: options.treasuryRouter, data: iface.encodeFunctionData("proposeAuthorizedLpLocker", [options.lockerAddress]), why: "a locker is already authorized, so this is timelocked: propose first" },
        { to: options.treasuryRouter, data: iface.encodeFunctionData("acceptAuthorizedLpLocker", []), why: "accept, once upgradeDelay has passed" },
        { to: options.treasuryRouter, data: iface.encodeFunctionData("setPrimaryLpLocker", [options.lockerAddress]), why: "point the router's primary locker at this generation" },
      ]
    : [
        { to: options.treasuryRouter, data: iface.encodeFunctionData("setAuthorizedLpLocker", [options.lockerAddress, true]), why: "first locker on this router, so one call is enough" },
        { to: options.treasuryRouter, data: iface.encodeFunctionData("setPrimaryLpLocker", [options.lockerAddress]), why: "point the router's primary locker at this generation" },
      ];

  if (!adminIsSender || !send) {
    log(`\n  treasury router admin is ${admin}${adminIsSender ? "" : ", not the deployer"}.`);
    log("  THE PROTOCOL SHARE OF EVERY LP HARVEST WILL STRAND until it sends:");
    for (const action of actions) {
      log(`    to=${action.to}`);
      log(`    data=${action.data}   # ${action.why}`);
    }
    return { wired: false, ownerActions: actions };
  }

  async function submit(call: Promise<any>, label: string) {
    const tx = await call;
    log(`  submitted ${label}: ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  }

  if (timelocked) {
    const pending = ethers.getAddress(await (router as any).pendingAuthorizedLpLocker());
    if (pending.toLowerCase() !== options.lockerAddress.toLowerCase()) {
      await submit((router as any).proposeAuthorizedLpLocker(options.lockerAddress), "router.proposeAuthorizedLpLocker");
    }
    const since = await (router as any).pendingAuthorizedLpLockerSince();
    const acceptableAt = BigInt(since) + BigInt(await (router as any).upgradeDelay());
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    if (now < acceptableAt) {
      log(`  proposed. acceptAuthorizedLpLocker is sendable in ${acceptableAt - now}s; harvests strand until then.`);
      return { wired: false, ownerActions: actions.slice(1), acceptableAt };
    }
    await submit((router as any).acceptAuthorizedLpLocker(), "router.acceptAuthorizedLpLocker");
  } else {
    await submit((router as any).setAuthorizedLpLocker(options.lockerAddress, true), "router.setAuthorizedLpLocker");
  }

  await submit((router as any).setPrimaryLpLocker(options.lockerAddress), "router.setPrimaryLpLocker");
  if (!(await (router as any).authorizedLpLocker(options.lockerAddress))) {
    throw new Error("locker still not authorized after the wiring transactions");
  }
  return { wired: true, ownerActions: [] };
}
