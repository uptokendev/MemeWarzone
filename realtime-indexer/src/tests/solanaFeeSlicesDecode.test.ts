import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

import { decodeEvents } from "../solanaAnchorEvents.js";

// The deployed launchpad's IDL (sha 6ad69298, identical to target/idl at the certified build).
const here = path.dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(fs.readFileSync(path.resolve(here, "../../../scripts/solana/idl/memewarzone_solana.json"), "utf8"));

const u8 = (value: number) => Buffer.from([value]);
function u64(value: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; }
const disc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const fieldsOf = (name: string) => idl.types.find((t: { name: string }) => t.name === name).type.fields.map((f: { name: string }) => f.name);

test("FeeSlicesAccrued decodes every slice into its own field (creator sits between monthly and recruiter)", () => {
  assert.deepEqual(fieldsOf("FeeSlicesAccrued"), [
    "campaign", "trader", "side", "route_profile", "fee_lamports", "weekly_league_lamports", "monthly_league_lamports",
    "creator_lamports", "recruiter_lamports", "airdrop_lamports", "squad_lamports", "protocol_lamports",
  ]);
  const [campaign, trader] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const payload = Buffer.concat([
    disc("FeeSlicesAccrued"), campaign.toBuffer(), trader.toBuffer(), u8(0), u8(2),
    u64(20_000n), u64(2_250n), u64(5_250n), u64(1_000n), u64(3_000n), u64(0n), u64(500n), u64(8_000n),
  ]);
  const [event] = decodeEvents([`Program data: ${payload.toString("base64")}`]) as any[];
  assert.equal(event.kind, "FeeSlicesAccrued");
  assert.equal(event.campaign, campaign.toBase58());
  assert.equal(event.trader, trader.toBase58());
  assert.equal(event.routeProfile, 2);
  assert.equal(event.feeLamports, 20_000n);
  assert.equal(event.weekly, 2_250n);
  assert.equal(event.monthly, 5_250n);
  assert.equal(event.creator, 1_000n);
  assert.equal(event.recruiter, 3_000n);
  assert.equal(event.airdrop, 0n);
  assert.equal(event.squad, 500n);
  assert.equal(event.protocol, 8_000n);
});

test("FeeSlicesRouted (graduation) is its own kind with the gross amount, never an escrow accrual", () => {
  assert.deepEqual(fieldsOf("FeeSlicesRouted"), [
    "campaign", "trader", "side", "route_profile", "gross_lamports", "fee_lamports", "weekly_league_lamports",
    "monthly_league_lamports", "creator_lamports", "recruiter_lamports", "airdrop_lamports", "squad_lamports", "protocol_lamports",
  ]);
  const [campaign, trader] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const payload = Buffer.concat([
    disc("FeeSlicesRouted"), campaign.toBuffer(), trader.toBuffer(), u8(2), u8(0),
    u64(9_000_000n), u64(90_000n), u64(0n), u64(0n), u64(0n), u64(13_500n), u64(0n), u64(2_250n), u64(74_250n),
  ]);
  const [event] = decodeEvents([`Program data: ${payload.toString("base64")}`]) as any[];
  assert.equal(event.kind, "FeeSlicesRouted");
  assert.equal(event.grossLamports, 9_000_000n);
  assert.equal(event.feeLamports, 90_000n);
  assert.equal(event.recruiter, 13_500n);
  assert.equal(event.squad, 2_250n);
  assert.equal(event.protocol, 74_250n);
});

test("FeeSlicesAccrued from the launchpad before the 2026-09-24 upgrade (no creator field) still decodes exactly", () => {
  const [campaign, trader] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const payload = Buffer.concat([
    disc("FeeSlicesAccrued"), campaign.toBuffer(), trader.toBuffer(), u8(0), u8(0),
    u64(20_000n), u64(2_250n), u64(5_250n), u64(2_500n), u64(0n), u64(500n), u64(9_500n),
  ]);
  assert.equal(payload.length, 130);
  const [event] = decodeEvents([`Program data: ${payload.toString("base64")}`]) as any[];
  assert.equal(event.kind, "FeeSlicesAccrued");
  assert.equal(event.creator, 0n);
  assert.equal(event.recruiter, 2_500n);
  assert.equal(event.airdrop, 0n);
  assert.equal(event.squad, 500n);
  assert.equal(event.protocol, 9_500n);
});
