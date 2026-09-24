/**
 * Deploy the EVM sponsorship rail on one chain: EventPrizeVaultV1 + WarzoneSponsorshipRouterV1.
 *
 * Neither contract was part of the 2026-09-23/24 generation deployments, so
 * ARENA_SPONSORSHIP_* could never be switched on. Tests: test/WarzoneSponsorshipV1.spec.ts.
 *
 * Wiring order matters and is done here in one run: deploy both with the
 * deployer as owner, vault.setRouter(router) (owner-only), then hand both to
 * SPONSORSHIP_OWNER. Per-event operations afterwards -- router.setEventEnabled
 * and vault.setEventReceiver -- are owner-only, so whoever SPONSORSHIP_OWNER
 * is signs one transaction per sponsored event. That is a product decision,
 * not a default this script makes: it refuses to run without it.
 *
 * Money: 70% of every sponsorship is credited to the event in the vault
 * (pulled by the event receiver), 20% to SPONSORSHIP_MARKETING_RECEIVER, 10%
 * to the chain's ProtocolRevenueVault (the capped protocol wallet).
 *
 *   SPONSORSHIP_OWNER=0x… SPONSORSHIP_QUOTE_SIGNER=0x… SPONSORSHIP_MARKETING_RECEIVER=0x… \
 *   npx hardhat run scripts/deploy-evm-sponsorship-v1.ts --network bscMainnet|robinhoodMainnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { transferOwnershipToSafe } from "./transfer-evm-ownership-to-safe";

const ROOT = path.resolve(__dirname, "..");
export const PROFILES: Record<string, { dir: string; protocolRevenueVault: string; safe: string }> = {
  "56": { dir: "bnb", protocolRevenueVault: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c", safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7" },
  "4663": { dir: "robinhood", protocolRevenueVault: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7" },
};

export async function deploySponsorshipV1(inputs: { deployerAddress: string; finalOwner: string; quoteSigner: string; marketingReceiver: string; protocolReceiver: string; log?: (m: string) => void }) {
  const log = inputs.log || (() => {});
  const provider = ethers.provider;
  for (const [label, addr] of [["finalOwner", inputs.finalOwner], ["quoteSigner", inputs.quoteSigner], ["marketingReceiver", inputs.marketingReceiver], ["protocolReceiver", inputs.protocolReceiver]] as const) {
    if (!ethers.isAddress(addr) || addr === ethers.ZeroAddress) throw new Error(`${label} must be a non-zero address`);
  }
  if ((await provider.getCode(inputs.protocolReceiver)) === "0x") throw new Error("protocolReceiver has no code; expected the chain's ProtocolRevenueVault");
  if (ethers.getAddress(inputs.quoteSigner) === ethers.getAddress(inputs.deployerAddress)) throw new Error("quoteSigner must not be the deployer");

  const vault = await (await ethers.getContractFactory("EventPrizeVaultV1")).deploy(inputs.deployerAddress);
  await vault.waitForDeployment();
  const router = await (await ethers.getContractFactory("WarzoneSponsorshipRouterV1")).deploy(inputs.deployerAddress, inputs.quoteSigner, await vault.getAddress(), inputs.marketingReceiver, inputs.protocolReceiver);
  await router.waitForDeployment();
  await (await vault.setRouter(await router.getAddress())).wait();
  log(`vault ${await vault.getAddress()}  router ${await router.getAddress()}  vault.router wired`);

  await transferOwnershipToSafe({ contracts: [await vault.getAddress(), await router.getAddress()], newOwner: inputs.finalOwner, senderAddress: inputs.deployerAddress, requireContractOwner: false, log });

  // Read back what was written, not what was intended.
  const [vaultOwner, routerOwner, wiredRouter, signer, marketing, protocol, paused] = await Promise.all([vault.owner(), router.owner(), vault.router(), router.quoteSigner(), router.marketingReceiver(), router.protocolReceiver(), router.paymentsPaused()]);
  const want = ethers.getAddress(inputs.finalOwner);
  if (ethers.getAddress(vaultOwner) !== want || ethers.getAddress(routerOwner) !== want) throw new Error(`ownership did not move: vault ${vaultOwner}, router ${routerOwner}`);
  if (ethers.getAddress(wiredRouter) !== ethers.getAddress(await router.getAddress())) throw new Error("vault.router is not the router");
  if (ethers.getAddress(signer) !== ethers.getAddress(inputs.quoteSigner)) throw new Error("quoteSigner mismatch");
  if (ethers.getAddress(marketing) !== ethers.getAddress(inputs.marketingReceiver) || ethers.getAddress(protocol) !== ethers.getAddress(inputs.protocolReceiver)) throw new Error("receiver mismatch");
  return { vault: await vault.getAddress(), router: await router.getAddress(), owner: want, quoteSigner: ethers.getAddress(signer), marketingReceiver: ethers.getAddress(marketing), protocolReceiver: ethers.getAddress(protocol), paymentsPaused: paused };
}

async function main() {
  const chainId = String((await ethers.provider.getNetwork()).chainId);
  const profile = PROFILES[chainId];
  if (!profile) throw new Error(`no mainnet profile for chain ${chainId}`);
  const recordPath = path.join(ROOT, "deployments", profile.dir, "mainnet.sponsorship-v1.json");
  if (fs.existsSync(recordPath)) throw new Error(`${recordPath} exists -- already deployed on this chain`);
  const need = (n: string) => { const v = String(process.env[n] || "").trim(); if (!v) throw new Error(`${n} is required (see the header: this is a product decision, not a default)`); return v; };
  const finalOwner = need("SPONSORSHIP_OWNER");
  const quoteSigner = need("SPONSORSHIP_QUOTE_SIGNER");
  const marketingReceiver = need("SPONSORSHIP_MARKETING_RECEIVER");
  const [deployer] = await ethers.getSigners();
  console.log(`[sponsorship] chain ${chainId} (${network.name})  deployer ${deployer.address} ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);
  console.log(`[sponsorship] owner ${finalOwner}${ethers.getAddress(finalOwner) === profile.safe ? " (Safe: one Safe tx per sponsored event)" : " (EOA: per-event ops without the Safe)"}  signer ${quoteSigner}  marketing ${marketingReceiver}  protocol ${profile.protocolRevenueVault}`);
  const result = await deploySponsorshipV1({ deployerAddress: deployer.address, finalOwner, quoteSigner, marketingReceiver, protocolReceiver: profile.protocolRevenueVault, log: (m) => console.log(`[sponsorship] ${m}`) });
  const record = { network: network.name, chainId: Number(chainId), deployedAt: new Date().toISOString(), deployer: deployer.address, ...result, env: {
    api: { [`WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS_${chainId}`]: result.router, [`ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS_${chainId}`]: result.quoteSigner, ARENA_SPONSORSHIP_QUOTE_SIGNER_PRIVATE_KEY: "<key of the signer>", [`ARENA_SPONSORSHIP_PRICING_VERSION_${chainId}`]: "1", [`ARENA_SPONSORSHIP_NATIVE_USD_MICROS_${chainId}`]: "<native price in USD micros>", [`ARENA_SPONSORSHIP_NATIVE_USD_UPDATED_AT_${chainId}`]: "<unix seconds>", [`ARENA_SPONSORSHIP_PRICE_MAX_AGE_SECONDS_${chainId}`]: "<seconds>", ARENA_SPONSORSHIP_V1: "true", ARENA_SPONSORSHIP_PRICING: "true" },
    perEvent: ["router.setEventEnabled(eventId, true)", "vault.setEventReceiver(eventId, receiver)  -- both owner-only"],
  } };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[sponsorship] wrote ${recordPath}`);
  console.log(JSON.stringify(record.env, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
