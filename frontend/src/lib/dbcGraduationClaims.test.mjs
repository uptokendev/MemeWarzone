import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { DBC_JUPITER_LOCK_PROGRAM_ID } from "../../shared/dbcEconomics.mjs";
import {
  DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
  creatorClaimAllowedPrograms,
  deriveDbcLockerEscrow,
} from "./dbcGraduationClaims.mjs";
import { DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS } from "./dbcTrade.mjs";

test("creator claims allow DBC, Jupiter Lock, and DAMM v2", () => {
  const allowed = creatorClaimAllowedPrograms();
  assert.ok(DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS.has(DBC_JUPITER_LOCK_PROGRAM_ID));
  assert.ok(allowed.has(DBC_JUPITER_LOCK_PROGRAM_ID));
  assert.ok(DBC_CREATOR_CLAIM_EXTRA_PROGRAMS.some((id) => String(id).startsWith("cpamdp")));
});

test("locker escrow is derived from the virtual pool (deterministic)", () => {
  const pool = Keypair.generate().publicKey;
  const a = deriveDbcLockerEscrow(pool);
  const b = deriveDbcLockerEscrow(pool);
  assert.equal(a.toBase58(), b.toBase58());
  assert.notEqual(a.toBase58(), pool.toBase58());
});
