import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  FLUSH_OPERATOR_FILL_DISC,
  ROUTE_STATE_DISC,
  decodeRouteState,
  flushOperatorFillInstruction,
  shouldFlushProtocolVault,
} from "./solanaProtocolFlush.js";

test("flush_operator_fill discriminator matches the IDL", () => {
  assert.deepEqual([...FLUSH_OPERATOR_FILL_DISC], [214, 255, 187, 192, 41, 196, 67, 58]);
});

test("route_state decodes operator, overflow and cap accounting", () => {
  const [authority, operator, overflow] = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey);
  const data = Buffer.alloc(129);
  ROUTE_STATE_DISC.copy(data, 0);
  authority.toBuffer().copy(data, 8);
  operator.toBuffer().copy(data, 40);
  overflow.toBuffer().copy(data, 72);
  data.writeBigUInt64LE(10_000_000_000n, 104);
  data.writeBigUInt64LE(155_526n, 112);
  data.writeBigUInt64LE(77_190_000n, 120);
  const view = decodeRouteState(data);
  assert.equal(view?.operator, operator.toBase58());
  assert.equal(view?.overflowTreasury, overflow.toBase58());
  assert.equal(view?.capUsdMicros, 10_000_000_000n);
  assert.equal(view?.filledUsdMicros, 155_526n);
  assert.equal(view?.nativeUsdMicros, 77_190_000n);
  const wrong = Buffer.from(data);
  wrong[0] ^= 1;
  assert.equal(decodeRouteState(wrong), null);
});

test("flushes only above the minimum and once per interval", () => {
  const base = { rentMinimumLamports: 900_000n, minLamports: 50_000_000n, nowMs: 10_000_000, intervalMs: 3_600_000 };
  assert.equal(shouldFlushProtocolVault({ ...base, vaultLamports: 560_153_000n, lastAttemptMs: 0 }), true);
  assert.equal(shouldFlushProtocolVault({ ...base, vaultLamports: 40_000_000n, lastAttemptMs: 0 }), false);
  assert.equal(shouldFlushProtocolVault({ ...base, vaultLamports: 560_153_000n, lastAttemptMs: 9_000_000 }), false);
});

test("instruction lists operator, route_state, protocol_vault, overflow -- all writable, none signing", () => {
  const keys = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
  const ix = flushOperatorFillInstruction({ treasuryProgram: keys[0], routeState: keys[1], protocolVault: keys[2], operator: keys[3], overflowTreasury: keys[4] });
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [keys[3], keys[1], keys[2], keys[4]].map((k: PublicKey) => k.toBase58()));
  assert.ok(ix.keys.every((k) => k.isWritable && !k.isSigner));
  assert.deepEqual([...ix.data], [...FLUSH_OPERATOR_FILL_DISC]);
});
