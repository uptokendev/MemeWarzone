import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

import { decodeEvents } from "../solanaAnchorEvents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(fs.readFileSync(path.resolve(here, "../../../target/idl/memewarzone_solana.json"), "utf8"));

function u64(value: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; }
function i64(value: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(value); return b; }
function u128(value: bigint) { const b = Buffer.alloc(16); b.writeBigUInt64LE(value & 0xffffffffffffffffn); b.writeBigUInt64LE(value >> 64n, 8); return b; }

test("CampaignGraduated decoder follows the program IDL field order exactly", () => {
  const type = idl.types.find((t: { name: string }) => t.name === "CampaignGraduated");
  assert.ok(type, "IDL has CampaignGraduated");
  const fields = type.type.fields.map((f: { name: string }) => f.name);
  assert.deepEqual(fields, [
    "campaign", "creator", "mint", "meteora_pool", "meteora_position", "quote_mint", "quote_config_id",
    "liquidity_tokens", "liquidity_lamports", "liquidity_quote_raw", "finalize_fee_lamports", "creator_payout_lamports",
    "burned_unsold_curve_tokens", "burned_unused_liquidity_tokens", "creator_reserve_tokens", "final_spot_nano_lamports", "graduated_at",
  ], "the decoder below is written against this order; update both together");

  const keys = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  const quoteConfigId = Buffer.from("ab".repeat(16) + "cd".repeat(16), "hex");
  const payload = Buffer.concat([
    createHash("sha256").update("event:CampaignGraduated").digest().subarray(0, 8),
    ...keys.map((k) => k.toBuffer()),
    quoteConfigId,
    u64(1_000_000n), u64(2_000_000_000n), u64(3_000n),
    u64(40_000n), u64(50_000n), u64(60_000n), u64(70_000n), u64(80_000n),
    u128(123_456_789_012_345_678_901n),
    i64(1_789_000_000n),
  ]);
  const [event] = decodeEvents([`Program data: ${payload.toString("base64")}`]) as any[];
  assert.ok(event, "decoded");
  assert.equal(event.kind, "CampaignGraduated");
  assert.equal(event.campaign, keys[0].toBase58());
  assert.equal(event.meteoraPosition, keys[4].toBase58());
  assert.equal(event.quoteMint, keys[5].toBase58());
  assert.equal(event.quoteConfigId, quoteConfigId.toString("hex"));
  assert.equal(event.liquidityTokens, 1_000_000n);
  assert.equal(event.liquidityLamports, 2_000_000_000n);
  assert.equal(event.liquidityQuoteRaw, 3_000n);
  assert.equal(event.finalizeFeeLamports, 40_000n);
  assert.equal(event.creatorPayoutLamports, 50_000n);
  assert.equal(event.burnedUnsoldCurveTokens, 60_000n);
  assert.equal(event.burnedUnusedLiquidityTokens, 70_000n);
  assert.equal(event.creatorReserveTokens, 80_000n);
  assert.equal(event.finalSpotNanoLamports, 123_456_789_012_345_678_901n);
  assert.equal(event.graduatedAt, 1_789_000_000n);
});
