/**
 * The two Safe calls that open one event to sponsorship on BNB or Robinhood:
 *   router.setEventEnabled(eventId, true)
 *   vault.setEventReceiver(eventId, receiver)
 *
 * eventId is keccak256("warzone-sponsorship-event:<sponsorship_events.id>"), exactly what the API
 * signs quotes against (frontend/api/lib/arenaSponsorshipRuntime.mjs sponsorshipEventId). The
 * sponsorship_events row may be inserted before or after the Safe executes: an enabled eventId
 * without a row takes nothing, because the API never quotes an event it cannot load.
 *
 * The receiver is who may pull the event's 70% share. EventPrizeVaultV1.claimEventPrize requires
 * msg.sender == receiver, so the receiver must be able to START a call: the Safe (it can execute the
 * claim) or a wallet you control. A contract such as a league treasury can receive value but can
 * never call claimEventPrize -- the share would be locked forever. The generator refuses every
 * contract address in our deployment records for that chain (the Safe excepted).
 *
 *   npx ts-node scripts/make-sponsorship-event-batch.ts <sponsorship_events.id uuid> <56|4663> <receiver>
 *
 * Writes deployments/<bnb|robinhood>/mainnet.sponsorship-event-<uuid8>.safe-batch.json.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

import { buildBatch } from "./make-safe-batch";

const EVENT_ID_PREFIX = "warzone-sponsorship-event:";
const RECORDS: Record<number, { dir: string; file: string }> = {
  56: { dir: "bnb", file: "mainnet.sponsorship-v1.json" },
  4663: { dir: "robinhood", file: "mainnet.sponsorship-v1.json" },
};

export function sponsorshipEventId(eventUuid: string): string {
  const value = String(eventUuid || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`sponsorship_events.id must be a uuid, got "${value}"`);
  }
  return ethers.id(`${EVENT_ID_PREFIX}${value}`);
}

export function sponsorshipEventBatch(input: { chainId: number; router: string; vault: string; eventUuid: string; receiver: string; forbiddenReceivers?: string[] }) {
  const eventId = sponsorshipEventId(input.eventUuid);
  if (!ethers.isAddress(input.receiver) || input.receiver === ethers.ZeroAddress) throw new Error("receiver must be a non-zero address");
  const receiver = ethers.getAddress(input.receiver);
  if ((input.forbiddenReceivers || []).some((a) => ethers.getAddress(a) === receiver)) {
    throw new Error(`receiver ${receiver} is one of our deployed contracts; it could never call claimEventPrize and the event share would be locked. Use the Safe or a wallet.`);
  }
  const batch = buildBatch(
    input.chainId,
    `Open sponsorship event ${input.eventUuid.slice(0, 8)}`,
    `Enable sponsorship event ${input.eventUuid} (eventId ${eventId}); its 70% event share is claimable by ${receiver}.`,
    [
      { contract: "WarzoneSponsorshipRouterV1", to: input.router, fn: "setEventEnabled", args: [eventId, true] },
      { contract: "EventPrizeVaultV1", to: input.vault, fn: "setEventReceiver", args: [eventId, receiver] },
    ],
  );
  return { eventId, receiver, batch };
}

if (require.main === module) {
  const [eventUuid, chainIdRaw, receiver] = process.argv.slice(2);
  const chainId = Number(chainIdRaw);
  const rec = RECORDS[chainId];
  if (!eventUuid || !rec || !receiver) {
    console.error("usage: npx ts-node scripts/make-sponsorship-event-batch.ts <sponsorship_events.id uuid> <56|4663> <receiver>");
    process.exit(2);
  }
  const record = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "deployments", rec.dir, rec.file), "utf8"));
  // Every contract we deployed on this chain (the records' addresses), minus accounts that can sign.
  const signerKeys = /^(safe|owner|finalOwner|deployer|quoteSigner|signer|resolver|routeAuthority|boostSigner|operator)$/i;
  const forbidden = new Set<string>();
  const walk = (value: unknown, key = ""): void => {
    if (typeof value === "string" && ethers.isAddress(value) && !signerKeys.test(key)) forbidden.add(ethers.getAddress(value));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
  };
  const dir = path.resolve(__dirname, "..", "deployments", rec.dir);
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("mainnet") && n.endsWith(".json") && !n.includes("safe-batch"))) {
    try { walk(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch { /* not a record */ }
  }
  forbidden.delete(ethers.getAddress(String(record.owner)));
  const { eventId, batch } = sponsorshipEventBatch({ chainId, router: record.router, vault: record.vault, eventUuid, receiver, forbiddenReceivers: [...forbidden] });
  const out = path.resolve(__dirname, "..", "deployments", rec.dir, `mainnet.sponsorship-event-${eventUuid.slice(0, 8)}.safe-batch.json`);
  fs.writeFileSync(out, `${JSON.stringify(batch, null, 2)}\n`);
  console.log(`eventId  ${eventId}`);
  console.log(`router   ${record.router}  setEventEnabled(eventId, true)`);
  console.log(`vault    ${record.vault}  setEventReceiver(eventId, ${ethers.getAddress(receiver)})`);
  console.log(`wrote    ${out}`);
}
