import { Contract, getAddress } from "ethers";

import { sponsorshipEventId, sponsorshipRouterAddress } from "./arenaSponsorshipRuntime.mjs";

const ROUTER_ABI = [
  "function quoteSigner() view returns (address)",
  "function enabledEvents(bytes32 eventId) view returns (bool)",
  "function eventPrizeVault() view returns (address)",
];
const VAULT_ABI = ["function eventReceivers(bytes32 eventId) view returns (address)"];
const ZERO = "0x0000000000000000000000000000000000000000";

export async function verifySponsorshipDeployment({ provider, chainId, eventUuid, expectedQuoteSigner, env = process.env }) {
  if (!provider) throw new Error("Sponsorship RPC provider is unavailable");
  const routerAddress = sponsorshipRouterAddress(chainId, env);
  const eventId = sponsorshipEventId(eventUuid);
  const router = new Contract(routerAddress, ROUTER_ABI, provider);
  const [liveSignerRaw, enabled, vaultRaw] = await Promise.all([
    router.quoteSigner(),
    router.enabledEvents(eventId),
    router.eventPrizeVault(),
  ]);
  const liveSigner = getAddress(String(liveSignerRaw));
  if (expectedQuoteSigner && liveSigner !== getAddress(String(expectedQuoteSigner))) {
    throw new Error("Sponsorship router quote signer does not match server quote signer");
  }
  if (enabled !== true) throw new Error("Sponsorship event is not enabled on-chain");
  const vaultAddress = getAddress(String(vaultRaw));
  if (vaultAddress === ZERO) throw new Error("Sponsorship event prize vault is not configured");
  const vault = new Contract(vaultAddress, VAULT_ABI, provider);
  const receiver = getAddress(String(await vault.eventReceivers(eventId)));
  if (receiver === ZERO) throw new Error("Sponsorship event prize receiver is not configured");
  return { routerAddress, liveSigner, eventId, vaultAddress, receiver };
}
