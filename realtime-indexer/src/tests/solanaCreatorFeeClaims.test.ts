import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeEvents } from "../solanaAnchorEvents.js";
import {
  decodeCreatorFeeClaims,
  deriveCreatorFeeVaultAddress,
  recordCreatorFeeClaims,
  resetCreatorFeeClaimsTableState,
} from "../solanaCreatorFeeClaims.js";

// Real mainnet transactions (K88), saved 2026-10-05.
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(here, "fixtures/k88-creator-fee-claims-mainnet.json"), "utf8"));
const LAUNCHPAD = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const K88 = "Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA";
const VAULT = "EGEoimrus23swhWgXEkzxdw7nP6h121rnVTMM73wwuRz";
const CREATOR = "8doLGRWZsKTGcAYg84PGo8agW4WaDdqQynByMnbtwG4R";
const tx = (prefix: string) => FIXTURE.transactions.find((t: { signature: string }) => t.signature.startsWith(prefix));

test("decodes the three K88 claims with exact lamports and the vault's running total", () => {
  const claims = ["3Scw1xQw5E", "48xkFpp5ow", "3giWhf2Cu1"].flatMap((p) => decodeCreatorFeeClaims(tx(p).meta.logMessages, LAUNCHPAD));
  assert.deepEqual(claims.map((c) => c.amountLamports), [53_990_213n, 5_685_143n, 2_265_956n]);
  assert.deepEqual(claims.map((c) => c.totalClaimedLamports), [53_990_213n, 59_675_356n, 61_941_312n]);
  for (const c of claims) {
    assert.equal(c.campaign, K88);
    assert.equal(c.creatorFeeVault, VAULT);
    assert.equal(c.creator, CREATOR);
  }
});

test("a buy and a treasury league claim hold no creator fee claim; another program cannot pass one off", () => {
  assert.deepEqual(decodeCreatorFeeClaims(tx("z4cY1KQgL9").meta.logMessages, LAUNCHPAD), []);
  assert.deepEqual(decodeCreatorFeeClaims(tx("2P2Y6TcgDz").meta.logMessages, LAUNCHPAD), []);
  // The same logs judged against a different program id yield nothing.
  assert.deepEqual(decodeCreatorFeeClaims(tx("3Scw1xQw5E").meta.logMessages, "11111111111111111111111111111111"), []);
});

test("decodeEvents is unchanged: a claim transaction still decodes to no trade/fee events (no log_index shift)", () => {
  for (const p of ["3Scw1xQw5E", "48xkFpp5ow", "3giWhf2Cu1"]) assert.equal(decodeEvents(tx(p).meta.logMessages).length, 0);
  // The buy keeps its own events in their own order.
  const kinds = decodeEvents(tx("z4cY1KQgL9").meta.logMessages).map((e) => e.kind);
  assert.ok(kinds.includes("TokensBought"));
});

test("the creator fee vault PDA derives to K88's vault", () => {
  assert.equal(deriveCreatorFeeVaultAddress(K88, LAUNCHPAD), VAULT);
});

test("recording: one insert per claim, idempotent SQL; failed tx and missing table skipped without throwing", async () => {
  resetCreatorFeeClaimsTableState();
  const seen: Array<{ text: string; values?: unknown[] }> = [];
  const db = { async query(text: string, values?: unknown[]) { seen.push({ text, values }); return { rowCount: 1, rows: [] }; } };
  const t = tx("3Scw1xQw5E");
  const n = await recordCreatorFeeClaims(db, { signature: t.signature, slot: t.slot, blockTime: new Date(t.blockTime * 1000), logMessages: t.meta.logMessages, programId: LAUNCHPAD });
  assert.equal(n, 1);
  assert.match(seen[0].text, /on conflict \(chain_id, tx_signature, log_index\) do nothing/);
  assert.deepEqual(seen[0].values?.slice(0, 6), [101, K88, CREATOR, VAULT, "53990213", "53990213"]);

  assert.equal(await recordCreatorFeeClaims(db, { signature: t.signature, slot: t.slot, blockTime: null, logMessages: t.meta.logMessages, programId: LAUNCHPAD, failed: true }), 0);
  // A transaction without a claim never touches the database.
  const before = seen.length;
  await recordCreatorFeeClaims(db, { signature: "x", slot: 1, blockTime: null, logMessages: tx("z4cY1KQgL9").meta.logMessages, programId: LAUNCHPAD });
  assert.equal(seen.length, before);

  const missing = { async query() { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } };
  assert.equal(await recordCreatorFeeClaims(missing, { signature: t.signature, slot: t.slot, blockTime: null, logMessages: t.meta.logMessages, programId: LAUNCHPAD }), 0);
  resetCreatorFeeClaimsTableState();
});
