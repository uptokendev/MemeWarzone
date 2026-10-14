// D9: a generation 8 coin trades in its own V4 pool before and after graduation, never through the import route.
import assert from "node:assert/strict";
import test from "node:test";
import { graduatedEvmTradeRoute } from "./graduatedEvmTradeRoute.mjs";

test("gen-8 coins take the gen8_pool path; every other coin keeps its route", () => {
  const importOn = { VITE_IMPORT_FEE_VAULT_56: "0x1111111111111111111111111111111111111111" };
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true, generation: 8 }, importOn), "gen8_pool");
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: false, generation: 8 }, importOn), "gen8_pool");
  assert.equal(graduatedEvmTradeRoute({ chainId: 4663, graduated: true, generation: "8" }, {}), "gen8_pool");
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true, generation: 7 }, importOn), "import");
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true }, importOn), "import");
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true }, {}), "direct-pool");
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: false }, importOn), "bonding");
});
