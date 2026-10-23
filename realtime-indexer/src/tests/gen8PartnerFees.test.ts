// Gen-8 widget partner ledger (evm/gen8PartnerFees.ts): the indexer's copies of the share maths and the build
// fingerprint must give the same numbers as the API's (frontend/api/lib/financeGen8.js gen8PartnerShareRaw,
// frontend/api/lib/importSwapFingerprint.js evmFingerprint, frontend/shared/evmGen8Swap.mjs GEN8_REFERRER_WIDGET).
// The attribution itself runs against real SQL in gen8PartnerFees.integration.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GEN8_PARTNER_BPS_OF_VOLUME, GEN8_REFERRER_WIDGET, evmFingerprint, gen8PartnerShareRaw } from "../evm/gen8PartnerFees.js";

const api = await import("../../../frontend/api/lib/financeGen8.js");
const fp = await import("../../../frontend/api/lib/importSwapFingerprint.js");
const swap = await import("../../../frontend/shared/evmGen8Swap.mjs");

test("one source of numbers: bps, widget tag, share and fingerprint equal the API's", () => {
  assert.equal(GEN8_PARTNER_BPS_OF_VOLUME, api.GEN8_PARTNER_BPS_OF_VOLUME);
  assert.equal(GEN8_PARTNER_BPS_OF_VOLUME, 25n, "0.25% of volume");
  assert.equal(GEN8_REFERRER_WIDGET, String(swap.GEN8_REFERRER_WIDGET).toLowerCase());
  const cases: Array<[bigint, bigint]> = [
    [0n, 0n],
    [1n, 1n],
    [399n, 10n],
    [400n, 10n],
    [10_000n, 1_000n],
    [1_000_000_000_000_000_000n, 5_000_000_000_000_000n], // 1 ETH at a 0.5% protocol slice
    [1_234_567_890_123_456_789n, 6_172_839_450_617_283n],
    [2n ** 200n, 2n ** 190n],
    [1_000_000n, 1n], // capped at the protocol slice
    [1_000_000n, 0n],
  ];
  for (const [curveAmount, protocol] of cases) {
    assert.equal(gen8PartnerShareRaw({ curveAmount, protocol }), api.gen8PartnerShareRaw({ curveAmount, protocol }), `curve ${curveAmount} protocol ${protocol}`);
  }
  assert.equal(gen8PartnerShareRaw({ curveAmount: 1_000_000_000_000_000_000n, protocol: 10n ** 18n }), 2_500_000_000_000_000n, "floor(curve x 25 / 10000)");
  assert.equal(gen8PartnerShareRaw({ curveAmount: 399n, protocol: 10n }), 0n, "floors to 0 below 400 wei");
  const txs: Array<[string | null, string | null, bigint | string | number | null]> = [
    ["0x00000000000000000000000000000000000000AA", "0x1234ABCD", 0n],
    ["0x00000000000000000000000000000000000000aa", "0x1234abcd", "1000000000000000000"],
    ["0x00000000000000000000000000000000000000aa", "0x", 7],
    [null, "0x12", 0n],
    ["0x00000000000000000000000000000000000000aa", null, 0n],
    ["0x00000000000000000000000000000000000000aa", "0x12", "not a number"],
  ];
  for (const [to, data, value] of txs) assert.equal(evmFingerprint(to, data, value), fp.evmFingerprint(to, data, value), `${to} ${data} ${value}`);
  assert.equal(evmFingerprint("0x00000000000000000000000000000000000000AA", "0x1234ABCD", 0n), evmFingerprint("0x00000000000000000000000000000000000000aa", "0x1234abcd", 0n), "case-insensitive, as recorded");
});

test("the production paste carries exactly the migration's statements", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const body = (file: string) => {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const start = text.indexOf("CREATE TABLE IF NOT EXISTS public.gen8_partner_fees");
    return text.slice(start, text.indexOf("COMMIT;", start));
  };
  const migration = body("db/migrations/20261022_000010_gen8_partner_fees.sql");
  assert.ok(migration.length > 1000);
  assert.equal(body("database/prod_apply_gen8_partner_fees.sql"), migration);
});
