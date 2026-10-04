import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:test";

const { harvestSolanaLpFees, solanaMainnetHarvestBlocker } = await import("../solanaLpFees.js");
const { registerLpFeesRoutes } = await import("../lpFeesRoutes.js");
const { pool } = await import("../db.js");

const TREASURY = "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que";
const DEPLOYER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
const HUKFOF = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";

const env = (value?: string) => (value === undefined ? {} : { SOLANA_PROTOCOL_TREASURY_ADDRESS: value }) as NodeJS.ProcessEnv;

test("mainnet harvest refuses when SOLANA_PROTOCOL_TREASURY_ADDRESS is unset or blank", () => {
  assert.match(String(solanaMainnetHarvestBlocker(env())), /not set/);
  assert.match(String(solanaMainnetHarvestBlocker(env("   "))), /not set/);
});

test("mainnet harvest refuses the deployer, HuKfoF, the operator and invalid addresses", () => {
  assert.match(String(solanaMainnetHarvestBlocker(env(DEPLOYER))), /deployer/);
  assert.match(String(solanaMainnetHarvestBlocker(env(HUKFOF))), /HuKfoF/);
  assert.match(String(solanaMainnetHarvestBlocker(env(TREASURY), TREASURY)), /operator/);
  assert.match(String(solanaMainnetHarvestBlocker(env("not-an-address"))), /not a valid/);
});

test("mainnet harvest runs with the live protocol_vault PDA as treasury", () => {
  assert.equal(solanaMainnetHarvestBlocker(env(TREASURY), "BZd4Tfo8gDurVGGJKxwFqRjBwYQPS634m4yH5zsKQcGf"), null);
});

type Handler = (req: unknown, res: unknown, next: (error?: unknown) => void) => void;

function collectHandler(): Handler {
  const posts = new Map<string, Handler>();
  const app = { get() {}, post(path: string, handler: Handler) { posts.set(path, handler); } };
  registerLpFeesRoutes(app as never);
  const handler = posts.get("/api/dashboard/lp-fees/collect");
  assert.ok(handler);
  return handler;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: null as Record<string, unknown> | null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: Record<string, unknown>) { res.body = body; return res; },
  };
  return res;
}

async function post(body: Record<string, unknown>) {
  const res = fakeRes();
  await new Promise<void>((resolve, reject) => {
    const original = res.json;
    res.json = (payload) => { const out = original(payload); resolve(); return out; };
    collectHandler()({ body, query: {}, headers: {} }, res, (error) => (error ? reject(error) : resolve()));
  });
  return res;
}

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

const MAINNET_BODY = { chainId: 101, environment: "production", solanaCluster: "mainnet-beta", pair: "DjoARyfuTTeSEJo9KbqgMS1xnG56c5Dc5xntDRNcBaBR" };

test("manual collect on mainnet answers 503 and never touches the database when the treasury is unset or the deployer", async () => {
  const originalQuery = pool.query;
  let queries = 0;
  (pool as { query: unknown }).query = async () => { queries += 1; return { rows: [] }; };
  try {
    for (const treasury of [undefined, DEPLOYER, HUKFOF]) {
      await withEnv({ RUNTIME_ENVIRONMENT: "production", SOLANA_CLUSTER: "mainnet-beta", SOLANA_PROTOCOL_TREASURY_ADDRESS: treasury, SOLANA_VOTE_TREASURY_ADDRESS: TREASURY }, async () => {
        const res = await post(MAINNET_BODY);
        assert.equal(res.statusCode, 503);
        assert.match(String(res.body?.error), /Harvest refused/);
      });
    }
    assert.equal(queries, 0, "no harvest logic ran");
  } finally {
    (pool as { query: unknown }).query = originalQuery;
  }
});

test("manual collect on mainnet with a valid treasury reaches the harvest (operator key missing here, so 503 from the harvest itself)", async () => {
  await withEnv({
    RUNTIME_ENVIRONMENT: "production",
    SOLANA_CLUSTER: "mainnet-beta",
    SOLANA_PROTOCOL_TREASURY_ADDRESS: TREASURY,
    SOLANA_HARVEST_OPERATOR_SECRET: undefined,
    SOLANA_TREASURY_OPERATOR_SECRET: undefined,
    SOLANA_OPERATOR_SECRET: undefined,
    SOLANA_OPERATOR_KEYPAIR: undefined,
    SOLANA_GRADUATION_OPERATOR_KEYPAIR: undefined,
  }, async () => {
    const res = await post(MAINNET_BODY);
    assert.equal(res.statusCode, 503);
    assert.match(String(res.body?.error), /operator key is not configured/);
  });
});

test("one Solana harvest at a time: a second call while one is in flight gets 409", async () => {
  // Throwaway key generated in the test; it never signs anything (the fake pool stops the harvest first).
  const operator = Keypair.generate();
  let release: (value: { rows: unknown[] }) => void = () => {};
  const fakePool = { query: () => new Promise<{ rows: unknown[] }>((resolve) => { release = resolve; }) };
  await withEnv({ SOLANA_HARVEST_OPERATOR_SECRET: JSON.stringify([...operator.secretKey]), SOLANA_PROTOCOL_TREASURY_ADDRESS: TREASURY }, async () => {
    const first = harvestSolanaLpFees({ pool: fakePool as never, pair: "A" });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(harvestSolanaLpFees({ pool: fakePool as never, pair: "B" }), (error: { status?: number; message?: string }) => error.status === 409 && /still running/.test(String(error.message)));
    release({ rows: [] });
    await assert.rejects(first, (error: { status?: number }) => error.status === 404);
    // Lock released: the next call runs (and stops at the same not-found row).
    const third = harvestSolanaLpFees({ pool: fakePool as never, pair: "C" });
    await new Promise((resolve) => setImmediate(resolve));
    release({ rows: [] });
    await assert.rejects(third, (error: { status?: number }) => error.status === 404);
  });
});

test("harvest refuses when the treasury it would pay differs from the one the route checked", async () => {
  const operator = Keypair.generate();
  const fakePool = { query: async () => { throw new Error("must not query"); } };
  await withEnv({ SOLANA_HARVEST_OPERATOR_SECRET: JSON.stringify([...operator.secretKey]), SOLANA_PROTOCOL_TREASURY_ADDRESS: undefined, SOLANA_VOTE_TREASURY_ADDRESS: undefined }, async () => {
    await assert.rejects(
      harvestSolanaLpFees({ pool: fakePool as never, pair: "A", expectedProtocolTreasury: TREASURY }),
      (error: { status?: number; message?: string }) => error.status === 503 && /not the checked/.test(String(error.message)),
    );
  });
});
