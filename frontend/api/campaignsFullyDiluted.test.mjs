import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./campaigns-base.js", import.meta.url), "utf8");

test("gen-6 EVM coins list, sort and filter at price x total supply; older coins keep price x sold", () => {
  assert.match(source, /export const EVM_GEN6_TOTAL_SUPPLY_WHOLE = 1_000_000_000;/);
  assert.match(source, /c\.chain_id in \(56, 97, 4663, 46630\) and coalesce\(c\.factory_generation, 0\) >= 6/);
  assert.match(source, /then coalesce\(cc\.price_c, ts\.last_price_bnb\) \* \$\{EVM_FULLY_DILUTED_SUPPLY_SQL\}\s+else coalesce\(cc\.mcap_c, ts\.marketcap_bnb\)/);
  assert.match(source, /when b\.fully_diluted_supply is not null\s+then coalesce\(ath\.ath_price_bnb \* b\.fully_diluted_supply, b\.marketcap_bnb\)/);
  // mcap sort and the USD filters read calc.marketcap_bnb, so they follow the same basis.
  assert.match(source, /"mcap_desc"\) return "coalesce\(calc\.marketcap_bnb, 0\) desc/);
  assert.match(source, /calc\.marketcap_bnb \* \$6::numeric\) >= \$7::numeric/);
  assert.match(source, /fullyDilutedSupply: row\.fully_diluted_supply != null/);
});
