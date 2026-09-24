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
 * The receiver is who may pull the event's 70% share (EventPrizeVaultV1.claimEventPrize is
 * receiver-only). For a league season that is naturally the chain's MonthlyLeagueTreasury
 * (it has receive()); for a tournament, the wallet that pays its prizes. Founder's choice.
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

export function sponsorshipEventBatch(input: { chainId: number; router: string; vault: string; eventUuid: string; receiver: string }) {
  const eventId = sponsorshipEventId(input.eventUuid);
  if (!ethers.isAddress(input.receiver) || input.receiver === ethers.ZeroAddress) throw new Error("receiver must be a non-zero address");
  const receiver = ethers.getAddress(input.receiver);
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
  const { eventId, batch } = sponsorshipEventBatch({ chainId, router: record.router, vault: record.vault, eventUuid, receiver });
  const out = path.resolve(__dirname, "..", "deployments", rec.dir, `mainnet.sponsorship-event-${eventUuid.slice(0, 8)}.safe-batch.json`);
  fs.writeFileSync(out, `${JSON.stringify(batch, null, 2)}\n`);
  console.log(`eventId  ${eventId}`);
  console.log(`router   ${record.router}  setEventEnabled(eventId, true)`);
  console.log(`vault    ${record.vault}  setEventReceiver(eventId, ${ethers.getAddress(receiver)})`);
  console.log(`wrote    ${out}`);
}
