import assert from "node:assert/strict";
import test from "node:test";
import { autoImportEnabled, autoImportMissing, systemImporter } from "./importAutoImport.js";

const ENV = { SOLANA_IMPORT_FEE_COLLECTOR: "F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw" };

test("on with the 1% split, off by setting; importer is our collector / fee vault", () => {
  assert.equal(autoImportEnabled({}), false);
  assert.equal(autoImportEnabled(ENV), true);
  assert.equal(autoImportEnabled({ ...ENV, IMPORT_AUTO_IMPORT: "false" }), false);
  assert.equal(systemImporter(101, ENV), ENV.SOLANA_IMPORT_FEE_COLLECTOR);
  assert.equal(systemImporter(56, { IMPORT_FEE_VAULT_56: "0x00000000000000000000000000000000000000aa" }), "0x00000000000000000000000000000000000000aa");
  assert.equal(systemImporter(56, {}), null);
});

test("imports coins without a page through the injected pipeline; refusals and outages are recorded for a later retry", async () => {
  const writes = [];
  const db = { query: async (sql, params) => {
    if (/select distinct c.token_address/.test(sql)) return { rows: [{ token_address: "A" }, { token_address: "B" }, { token_address: "C" }] };
    writes.push(params);
    return { rows: [] };
  } };
  const importProject = async ({ tokenAddress, importerWallet }) => {
    assert.equal(importerWallet, ENV.SOLANA_IMPORT_FEE_COLLECTOR);
    if (tokenAddress === "B") throw Object.assign(new Error("still bonding"), { code: "PROJECT_IMPORT_STILL_BONDING" });
    if (tokenAddress === "C") throw Object.assign(new Error("rpc down"), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE" });
    return { created: true };
  };
  const out = await autoImportMissing({ db, chainId: 101, env: ENV, importProject });
  assert.deepEqual(out, { chainId: 101, imported: 1, refused: 1, errors: 1 });
  assert.deepEqual(writes.map((p) => [p[1], p[2]]), [["A", "imported"], ["B", "refused"], ["C", "error"]]);
});
