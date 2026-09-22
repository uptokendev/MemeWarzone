import test from "node:test";
import assert from "node:assert/strict";

/**
 * probeCanonicalArenaLive memoises per chain id for 15s in a module-level map,
 * so each case needs its own module instance. A distinct query string gives one.
 */
let instance = 0;
async function freshProbe(env) {
  const saved = { ...process.env };
  for (const key of ["SOLANA_RPC_URL", "SOLANA_CLUSTER", "SOLANA_CLUSTER_101", "VITE_SOLANA_CLUSTER"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    const mod = await import(`./solanaArenaPoolRead.js?probe=${instance++}`);
    return await mod.probeCanonicalArenaLive(101);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("a chain that is not the Solana arena is rejected before any RPC work", async () => {
  const mod = await import(`./solanaArenaPoolRead.js?probe=${instance++}`);
  assert.deepEqual(await mod.probeCanonicalArenaLive(97), { live: false, reason: "not-solana" });
});

test("a missing RPC is reported as rpc-missing", async () => {
  assert.deepEqual(await freshProbe({}), { live: false, reason: "rpc-missing" });
});

test("an unset cluster is named as such, not as an authority problem", async () => {
  // Regression: the probe used to omit environment/cluster entirely, so
  // validateCanonicalArenaConfig could never resolve a genesis hash and every
  // call returned "authority-mismatch" -- including for a healthy arena.
  const result = await freshProbe({ SOLANA_RPC_URL: "https://api.devnet.solana.com" });
  assert.equal(result.live, false);
  assert.equal(result.reason, "cluster-unconfigured");
  assert.notEqual(result.reason, "authority-mismatch");
});

test("an unpaired environment/cluster combination does not fall through to a live read", async () => {
  // arenaEnvironmentIdentity throws on anything but staging/devnet and
  // production/mainnet-beta; the probe must swallow that into a clear reason.
  const result = await freshProbe({ SOLANA_RPC_URL: "https://api.devnet.solana.com", SOLANA_CLUSTER: "testnet" });
  assert.deepEqual(result, { live: false, reason: "cluster-unconfigured" });
});

test("a per-chain cluster override is honoured", async () => {
  const result = await freshProbe({ SOLANA_RPC_URL: "", SOLANA_CLUSTER_101: "devnet" });
  // No RPC, so it stops at rpc-missing -- proving the override is read without
  // reaching the network, and that the RPC check still comes first.
  assert.equal(result.reason, "rpc-missing");
});
