// ATH reads the fee-free candle price (price_h) before the fill-polluted h. RH 0xe35a showed an
// $878.66 ATH from a live candle whose h was a fee-inclusive fill.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("campaigns, featured and War Room ATH use max(coalesce(price_h, h))", () => {
  for (const [file, pattern] of [
    ["./campaigns-base.js", /max\(coalesce\(tc\.price_h, tc\.h\)\) as ath_price_bnb/],
    ["./featured.js", /max\(coalesce\(tc\.price_h, tc\.h\)\) AS ath_price/],
    ["./warRoom.js", /max\(coalesce\(tc\.price_h, tc\.h\)\) as ath_price_bnb/],
  ]) {
    const src = read(file);
    assert.match(src, pattern, file);
    assert.doesNotMatch(src, /max\(tc\.h\)/i, file);
  }
});

test("War Room current price/MC on the EVM curve is token_stats spot, not the last fill; Solana and graduated unchanged", () => {
  const src = read("./warRoom.js");
  assert.match(
    src,
    /case when latest\.price_bnb is not null and b\.chain_id <> 101 and b\.graduated_at_chain is null and b\.last_price_bnb is not null\s+then b\.last_price_bnb else latest\.price_bnb end as latest_price_bnb/,
  );
  assert.match(src, /when b\.chain_id = 101 then null\s+when latest\.price_bnb is not null and b\.graduated_at_chain is null and b\.last_price_bnb is not null\s+then b\.last_price_bnb \* coalesce/);
});
