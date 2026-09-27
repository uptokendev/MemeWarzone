// The resolver worker refused every mainnet arena config ("config-unreadable") because it never told
// the validator which cluster it runs on, so ASK's win (arena-mugwhj11-9b1973) was never posted on
// chain (2026-09-27). Pinned with the real mainnet arena_config bytes.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

import { arenaClusterIdentity, configAccountToPlanner } from "./arena-operator-worker.mjs";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const account = {
  owner: new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX"),
  data: Buffer.from(fs.readFileSync(new URL("./fixtures/mainnet-arena-config.b64", import.meta.url), "utf8").trim(), "base64"),
};

test("mainnet worker reads the live arena config and its resolver", () => {
  const config = configAccountToPlanner(account, MAINNET_GENESIS, 101, PublicKey, "mainnet-beta");
  assert.ok(config, "the config the chain holds is readable");
  assert.equal(config.resolver, "8rEczXrZZMzpp3MAUbs8TWftaZcJxctydwnkHLsdWaRv");
  assert.equal(config.protocolReceiver, "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que");
});

test("a worker pointed at the wrong cluster still refuses", () => {
  assert.equal(configAccountToPlanner(account, MAINNET_GENESIS, 101, PublicKey, "devnet"), null);
  assert.equal(configAccountToPlanner(account, DEVNET_GENESIS, 101, PublicKey, "mainnet-beta"), null);
});

test("no SOLANA_CLUSTER is an explicit error, not a silent 'config-unreadable'", () => {
  assert.throws(() => configAccountToPlanner(account, MAINNET_GENESIS, 101, PublicKey, ""), /SOLANA_CLUSTER is required/);
  assert.throws(() => arenaClusterIdentity(101, "solana-mainnet"), /INVALID|not a Solana|Unsupported/i);
  assert.equal(arenaClusterIdentity(101, "mainnet-beta").environment, "production");
});
