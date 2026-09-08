import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../../db/migrations/202609080003_bnb_postgrad_quote_identity.sql", import.meta.url);

test("post-grad DEX normalization retains exact quote token and quote amount", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /quote_token_address text generated always as/i);
  assert.match(sql, /lower\(token0_address\)=lower\(token_address\) then token1_address/i);
  assert.match(sql, /lower\(token1_address\)=lower\(token_address\) then token0_address/i);
  assert.match(sql, /add column if not exists quote_token_address text/i);
  assert.match(sql, /new\.quote_amount_raw := new\.native_amount_raw/i);
  assert.match(sql, /"quoteTokenAddress"/);
  assert.match(sql, /"quoteAmountRaw"/);
  assert.match(sql, /raise exception 'DEX trade quote identity unavailable/i);
});
