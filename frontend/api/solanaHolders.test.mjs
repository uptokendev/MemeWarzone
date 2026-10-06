import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { DBC_POOL_AUTHORITY, resolveExcludeOwners } from "./solanaHolders.js";

test("DBC coins exclude the pool authority, the owner of the pool's base vault", async () => {
  const owners = await resolveExcludeOwners("Mint11111111111111111111111111111111111111", "Pool11111111111111111111111111111111111111", {
    db: {
      async query() {
        return { rows: [{ launch_type: "dbc", campaign_address: "Pool11111111111111111111111111111111111111" }] };
      },
    },
  });
  // Holders are counted by owner. DAZILLA's base vault iEd2Hg... is owned by this PDA, so it is
  // what keeps the pool out of the count (the vault's own address matched no owner: 48 for 47).
  assert.deepEqual(owners, [DBC_POOL_AUTHORITY]);
});

test("the pool authority is the DBC program's pool_authority PDA", () => {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"));
  assert.equal(pda.toBase58(), DBC_POOL_AUTHORITY);
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
