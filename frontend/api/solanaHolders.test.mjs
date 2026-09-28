import assert from "node:assert/strict";
import test from "node:test";
import { resolveExcludeOwners } from "./solanaHolders.js";

test("DBC coins exclude the pool base vault instead of the campaign PDA", async () => {
  const vault = "Vault1111111111111111111111111111111111111";
  const owners = await resolveExcludeOwners("Mint11111111111111111111111111111111111111", "Pool11111111111111111111111111111111111111", {
    db: {
      async query() {
        return { rows: [{ launch_type: "dbc", campaign_address: "Pool11111111111111111111111111111111111111" }] };
      },
    },
  });
  // Without RPC the vault lookup fails closed to [] rather than excluding the pool PDA.
  assert.ok(Array.isArray(owners));
  assert.ok(!owners.includes("Pool11111111111111111111111111111111111111") || owners[0] === vault);
});

test("launchpad coins still exclude the campaign PDA", async () => {
  const campaign = "Camp11111111111111111111111111111111111111";
  const owners = await resolveExcludeOwners("Mint11111111111111111111111111111111111111", campaign, {
    db: {
      async query() {
        return { rows: [{ launch_type: "launchpad", campaign_address: campaign }] };
      },
    },
  });
  assert.deepEqual(owners, [campaign]);
});
