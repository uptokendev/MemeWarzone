/**
 * Hand a generation's Ownable contracts to the Safe, and prove it.
 *
 * Every deployment script leaves its contracts owned by the deployer so the
 * script can configure them, and says the transfer is a separate deliberate
 * step. This is that step. It refuses on mainnet unless the new owner is a
 * contract (a Safe), checks every address is owned by the sender before it
 * sends anything, and reads each owner back afterwards -- retrying, because
 * BSC's public nodes lag their own confirmed transactions.
 *
 *   CONFIRM_OWNERSHIP_TRANSFER=I_UNDERSTAND_MAINNET \
 *   NEW_OWNER=0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7 \
 *   OWNABLE_CONTRACTS=0xfactory,0xleague,0xwarPool \
 *     npx hardhat run scripts/transfer-evm-ownership-to-safe.ts --network bscMainnet
 */
import { ethers, network } from "hardhat";

const CONFIRM: Record<string, string> = {
  bscMainnet: "I_UNDERSTAND_MAINNET",
  robinhoodMainnet: "I_UNDERSTAND_MAINNET",
  bscTestnet: "I_UNDERSTAND_TESTNET",
  robinhoodTestnet: "I_UNDERSTAND_TESTNET",
  hardhat: "I_UNDERSTAND_REHEARSAL",
  localhost: "I_UNDERSTAND_REHEARSAL",
};

const OWNABLE_ABI = ["function owner() view returns (address)", "function transferOwnership(address newOwner)"];

export async function transferOwnershipToSafe(options: {
  contracts: string[];
  newOwner: string;
  senderAddress: string;
  requireContractOwner: boolean;
  log?: (message: string) => void;
}) {
  const log = options.log ?? ((m: string) => console.log(m));
  const newOwner = ethers.getAddress(options.newOwner);
  if (newOwner === ethers.ZeroAddress) throw new Error("NEW_OWNER is the zero address");
  if (options.requireContractOwner) {
    const code = await ethers.provider.getCode(newOwner);
    if (!code || code === "0x") throw new Error(`NEW_OWNER ${newOwner} has no code; on mainnet the owner must be the Safe`);
  }
  const targets = options.contracts.map((a) => ethers.getAddress(a));
  if (targets.length === 0) throw new Error("OWNABLE_CONTRACTS is empty");

  // Every check before any send, so a bad list costs nothing.
  for (const address of targets) {
    const c = await ethers.getContractAt(OWNABLE_ABI, address);
    const owner = ethers.getAddress(await (c as any).owner());
    if (owner.toLowerCase() === newOwner.toLowerCase()) {
      log(`  ${address} already owned by ${newOwner}`);
      continue;
    }
    if (owner.toLowerCase() !== options.senderAddress.toLowerCase()) {
      throw new Error(`${address} is owned by ${owner}, not the sender ${options.senderAddress}; nothing was sent`);
    }
  }

  for (const address of targets) {
    const c = await ethers.getContractAt(OWNABLE_ABI, address);
    if ((await (c as any).owner()).toLowerCase() === newOwner.toLowerCase()) continue;
    const tx = await (c as any).transferOwnership(newOwner);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`transferOwnership on ${address} failed`);
    log(`  ${address} transferOwnership -> ${newOwner}: ${tx.hash}`);
  }

  for (const address of targets) {
    const c = await ethers.getContractAt(OWNABLE_ABI, address);
    let owner = ethers.getAddress(await (c as any).owner());
    for (let i = 0; i < 8 && owner.toLowerCase() !== newOwner.toLowerCase(); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      owner = ethers.getAddress(await (c as any).owner());
    }
    if (owner.toLowerCase() !== newOwner.toLowerCase()) throw new Error(`${address} still owned by ${owner} after transfer`);
    log(`  ok ${address} owner = ${owner}`);
  }
}

async function main() {
  const expected = CONFIRM[network.name];
  if (!expected) throw new Error(`Unsupported network ${network.name}`);
  if (String(process.env.CONFIRM_OWNERSHIP_TRANSFER || "").trim() !== expected) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_OWNERSHIP_TRANSFER=${expected}.`);
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer for this network.");
  const contracts = String(process.env.OWNABLE_CONTRACTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`[ownership] network=${network.name} sender=${await deployer.getAddress()} newOwner=${process.env.NEW_OWNER} contracts=${contracts.length}`);
  await transferOwnershipToSafe({
    contracts,
    newOwner: String(process.env.NEW_OWNER || "").trim(),
    senderAddress: await deployer.getAddress(),
    requireContractOwner: expected === "I_UNDERSTAND_MAINNET",
  });
  console.log("[ownership] done; the sender owns none of these any more");
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
