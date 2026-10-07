import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SOLANA_GENESIS } from "../../../src/lib/solanaArenaLayout.mjs";
import { DBC_TARGET_USD_MICROS } from "../../../shared/dbcEconomics.mjs";
import { handleDbcLaunchConfig, dbcLaunchDisabledPayload } from "../../dbc/launch-config.js";
import { createDbcConfigLadder, diffOnChainConfig } from "./dbcConfigLadder.js";
import { buildLaunchConfigParams } from "./dbcLaunchConfigParams.mjs";

const DEVNET = SOLANA_GENESIS.devnet;
const COLLECTOR = Keypair.generate();
const PAYER = Keypair.generate();

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(text) { this.body = JSON.parse(text); },
  };
}

function fakeReq({ query = {}, method = "GET" } = {}) {
  const params = new URLSearchParams(query);
  return { method, url: `http://localhost/api/dbc/launch-config?${params}` };
}

function memoryDb() {
  const rows = [];
  let id = 1;
  let chain = Promise.resolve();
  const run = async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("begin") || sql.startsWith("commit") || sql.startsWith("rollback")) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: true }] };
    if (sql.startsWith("select") && sql.includes("from public.dbc_launch_configs")) {
      const found = rows.filter((r) => (
        r.cluster === params[0]
        && r.quote_mint === params[1]
        && String(r.target_usd_micros) === String(params[2])
        && Number(r.step_index) === Number(params[3])
        && r.creator_fee_mode === params[4]
        && r.params_hash === params[5]
      ));
      return { rows: found };
    }
    if (sql.startsWith("insert")) {
      const row = {
        id: id++,
        cluster: params[0],
        quote_mint: params[1],
        target_usd_micros: params[2],
        step_index: params[3],
        step_usd_micros: params[4],
        creator_fee_mode: params[5],
        params_hash: params[6],
        config_address: params[7],
        threshold_lamports: params[8],
        total_token_supply: params[9],
        create_signature: params[10],
        created_at: params[11],
        status: "pending",
        verified_at: null,
      };
      rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update") && sql.includes("status = 'failed'")) {
      const row = rows.find((r) => r.id === params[0]);
      if (row) {
        row.status = "failed";
        if (params[1]) row.create_signature = params[1];
      }
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("update") && sql.includes("status = 'active'")) {
      const row = rows.find((r) => r.id === params[0]);
      if (row) {
        row.status = "active";
        row.create_signature = params[1];
        row.verified_at = params[2];
      }
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  };
  return {
    rows,
    query: run,
    async connect() {
      let releaseHold;
      const prev = chain;
      const hold = new Promise((r) => { releaseHold = r; });
      chain = hold;
      await prev;
      return {
        query: run,
        release() { releaseHold(); },
      };
    },
  };
}

function fakeChain({ mismatch = false, creations = { n: 0 } } = {}) {
  const onChain = new Map();
  return {
    creations,
    connection: {
      async getGenesisHash() { return DEVNET; },
      async confirmTransaction() { return { value: { err: null } }; },
      async sendTransaction() { return "sig"; },
    },
    async sendTransaction(_conn, _tx, signers) {
      creations.n += 1;
      const config = signers[1].publicKey;
      onChain.set(config.toBase58(), { config, signers });
      return `sig-${creations.n}`;
    },
    client: {
      partner: {
        async createConfig(params) {
          return { feePayer: null, params };
        },
      },
      state: {
        async getPoolConfig(address) {
          const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], 118_000_000n, "creator");
          const extra = { feeClaimer: COLLECTOR.publicKey, leftoverReceiver: COLLECTOR.publicKey, quoteMint: new PublicKey("So11111111111111111111111111111111111111112") };
          const fields = (await import("./dbcConfigLadder.js")).expectedOnChainFields(built.configParams, extra);
          if (mismatch) fields.creatorTradingFeePercentage = 99;
          return {
            quoteMint: extra.quoteMint,
            feeClaimer: extra.feeClaimer,
            leftoverReceiver: extra.leftoverReceiver,
            collectFeeMode: fields.collectFeeMode,
            migrationOption: fields.migrationOption,
            activationType: fields.activationType,
            tokenDecimal: fields.tokenDecimal,
            tokenType: fields.tokenType,
            partnerPermanentLockedLiquidityPercentage: fields.partnerPermanentLockedLiquidityPercentage,
            partnerLiquidityPercentage: fields.partnerLiquidityPercentage,
            creatorPermanentLockedLiquidityPercentage: fields.creatorPermanentLockedLiquidityPercentage,
            creatorLiquidityPercentage: fields.creatorLiquidityPercentage,
            creatorTradingFeePercentage: fields.creatorTradingFeePercentage,
            tokenUpdateAuthority: fields.tokenUpdateAuthority,
            migrationFeePercentage: fields.migrationFeePercentage,
            creatorMigrationFeePercentage: fields.creatorMigrationFeePercentage,
            migrationQuoteThreshold: built.configParams.migrationQuoteThreshold,
            sqrtStartPrice: built.configParams.sqrtStartPrice,
            preMigrationTokenSupply: built.configParams.tokenSupply.preMigrationTokenSupply,
            postMigrationTokenSupply: built.configParams.tokenSupply.postMigrationTokenSupply,
            migratedCollectFeeMode: fields.migratedCollectFeeMode,
            migratedDynamicFee: fields.migratedDynamicFee,
            migratedPoolFeeBps: fields.migratedPoolFeeBps,
            enableFirstSwapWithMinFee: fields.enableFirstSwapWithMinFee,
            poolCreationFee: built.configParams.poolCreationFee,
            poolFees: built.configParams.poolFees,
            lockedVestingConfig: built.configParams.lockedVesting,
            curve: built.configParams.curve,
          };
        },
      },
    },
  };
}

function ladderFor(db, chain, extra = {}) {
  return createDbcConfigLadder({
    db,
    connection: chain.connection,
    payer: PAYER,
    feeClaimer: COLLECTOR.publicKey,
    cluster: "devnet",
    client: chain.client,
    sendTransaction: chain.sendTransaction,
    confirmTransaction: async () => {},
    env: { SOLANA_CLUSTER: "devnet", DBC_FEE_COLLECTOR: COLLECTOR.publicKey.toBase58(), ...extra.env },
    ...extra,
  });
}

test("ensureLaunchConfig creates once and returns the active row", async () => {
  const db = memoryDb();
  const chain = fakeChain();
  const ladder = ladderFor(db, chain);
  const a = await ladder.ensureLaunchConfig({
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 241,
    stepUsdMicros: 118_000_000n,
    creatorFeeMode: "creator",
  });
  const b = await ladder.ensureLaunchConfig({
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 241,
    stepUsdMicros: 118_000_000n,
    creatorFeeMode: "creator",
  });
  assert.equal(a.status, "active");
  assert.equal(b.configAddress, a.configAddress);
  assert.equal(chain.creations.n, 1);
});

test("readback mismatch marks the row failed and it is not served", async () => {
  const db = memoryDb();
  const chain = fakeChain({ mismatch: true });
  const ladder = ladderFor(db, chain);
  const args = {
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 241,
    stepUsdMicros: 118_000_000n,
    creatorFeeMode: "creator",
  };
  await assert.rejects(() => ladder.ensureLaunchConfig(args), (err) => err.code === "DBC_CONFIG_MISMATCH");
  assert.equal(db.rows[0].status, "failed");
  assert.equal(db.rows.filter((r) => r.status === "active").length, 0);
  await assert.rejects(() => ladder.ensureLaunchConfig(args), (err) => err.code === "DBC_CONFIG_FAILED");
  assert.equal(chain.creations.n, 1);
});

test("a confirm failure after send persists failed and does not create again", async () => {
  const db = memoryDb();
  const chain = fakeChain();
  const ladder = ladderFor(db, chain, {
    confirmTransaction: async () => { throw new Error("confirm dropped"); },
  });
  const args = {
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 241,
    stepUsdMicros: 118_000_000n,
    creatorFeeMode: "creator",
  };
  await assert.rejects(() => ladder.ensureLaunchConfig(args), (err) => err.code === "DBC_CONFIG_FAILED");
  assert.equal(db.rows[0].status, "failed");
  await assert.rejects(() => ladder.ensureLaunchConfig(args), (err) => err.code === "DBC_CONFIG_FAILED");
  assert.equal(chain.creations.n, 1);
});

test("an error before the transaction is sent does not insert a row", async () => {
  const db = memoryDb();
  const chain = fakeChain();
  chain.client.partner.createConfig = async () => { throw new Error("build failed"); };
  const ladder = ladderFor(db, chain);
  await assert.rejects(() => ladder.ensureLaunchConfig({
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 241,
    stepUsdMicros: 118_000_000n,
    creatorFeeMode: "creator",
  }));
  assert.equal(chain.creations.n, 0);
  assert.equal(db.rows.length, 0);
});

test("two concurrent calls create the config once", async () => {
  const db = memoryDb();
  const chain = fakeChain();
  const ladder = ladderFor(db, chain);
  const args = {
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 241,
    stepUsdMicros: 118_000_000n,
    creatorFeeMode: "creator",
  };
  const [a, b] = await Promise.all([ladder.ensureLaunchConfig(args), ladder.ensureLaunchConfig(args)]);
  assert.equal(a.configAddress, b.configAddress);
  assert.equal(chain.creations.n, 1);
});

test("a persisted failed config is 503 on the HTTP route", async () => {
  const db = memoryDb();
  const chain = fakeChain({ mismatch: true });
  const ladder = ladderFor(db, chain);
  const args = {
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 241,
    stepUsdMicros: 118_000_000n,
    creatorFeeMode: "creator",
  };
  await assert.rejects(() => ladder.ensureLaunchConfig(args));
  const res = fakeRes();
  await handleDbcLaunchConfig(fakeReq({ query: { chainId: "101", targetUsd: "30000", creatorFeeMode: "creator" } }), res, {
    env: { DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet", DBC_FEE_COLLECTOR: COLLECTOR.publicKey.toBase58() },
    cluster: "devnet",
    ladder,
    async readSolUsdMicros() { return 118_000_000n; },
    solPriceStep: () => ({ stepIndex: 241, stepUsdMicros: 118_000_000n }),
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "DBC_CONFIG_FAILED");
});

test("flag off returns the disabled payload; bad target/mode 400; $150 refused off devnet; stale price 503", async () => {
  const disabled = fakeRes();
  await handleDbcLaunchConfig(fakeReq({ query: { chainId: "101", targetUsd: "30000", creatorFeeMode: "creator" } }), disabled, {
    env: { DBC_LAUNCH_ENABLED: "false", SOLANA_CLUSTER: "devnet" },
  });
  assert.equal(disabled.statusCode, 200);
  assert.deepEqual(disabled.body, dbcLaunchDisabledPayload());

  const badTarget = fakeRes();
  await handleDbcLaunchConfig(fakeReq({ query: { chainId: "101", targetUsd: "999", creatorFeeMode: "creator" } }), badTarget, {
    env: { DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet" },
  });
  assert.equal(badTarget.statusCode, 400);

  const badMode = fakeRes();
  await handleDbcLaunchConfig(fakeReq({ query: { chainId: "101", targetUsd: "30000", creatorFeeMode: "nope" } }), badMode, {
    env: { DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet" },
  });
  assert.equal(badMode.statusCode, 400);

  const testTarget = fakeRes();
  await handleDbcLaunchConfig(fakeReq({ query: { chainId: "101", targetUsd: "150", creatorFeeMode: "creator" } }), testTarget, {
    env: { DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "mainnet-beta" },
    cluster: "mainnet-beta",
  });
  assert.equal(testTarget.statusCode, 400);
  assert.equal(testTarget.body.code, "DBC_TEST_TARGET_REFUSED");

  const stale = fakeRes();
  await handleDbcLaunchConfig(fakeReq({ query: { chainId: "101", targetUsd: "30000", creatorFeeMode: "creator" } }), stale, {
    env: { DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet" },
    cluster: "devnet",
    async readSolUsdMicros() { throw new Error("SOL/USD unavailable from every source: x"); },
  });
  assert.equal(stale.statusCode, 503);
  assert.equal(stale.body.code, "DBC_PRICE_STALE");
});

test("diffOnChainConfig reports a field mismatch", () => {
  const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], 118_000_000n, "creator");
  const extra = { feeClaimer: COLLECTOR.publicKey, leftoverReceiver: COLLECTOR.publicKey };
  const onChain = {
    ...built.configParams,
    quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
    feeClaimer: COLLECTOR.publicKey,
    leftoverReceiver: COLLECTOR.publicKey,
    migrationFeePercentage: built.configParams.migrationFee.feePercentage,
    creatorMigrationFeePercentage: built.configParams.migrationFee.creatorFeePercentage,
    preMigrationTokenSupply: built.configParams.tokenSupply.preMigrationTokenSupply,
    postMigrationTokenSupply: built.configParams.tokenSupply.postMigrationTokenSupply,
    migratedCollectFeeMode: built.configParams.migratedPoolFee.collectFeeMode,
    migratedDynamicFee: built.configParams.migratedPoolFee.dynamicFee,
    migratedPoolFeeBps: built.configParams.migratedPoolFee.poolFeeBps,
    lockedVestingConfig: built.configParams.lockedVesting,
    creatorTradingFeePercentage: 0,
  };
  const mismatches = diffOnChainConfig(onChain, built.configParams, extra);
  assert.ok(mismatches.some((m) => String(m.path).includes("creatorTradingFeePercentage")));
});

test("readback ignores the program's zero-liquidity padding of the curve (20-point fixed array)", async () => {
  // Devnet 2026-09-28: a real config read back 20 curve points (15 built + 5 zero padding) and was
  // marked failed. The padding is not part of the curve.
  const { default: BN } = await import("bn.js");
  const built = buildLaunchConfigParams(DBC_TARGET_USD_MICROS[30000], 118_000_000n, "creator");
  const extra = { feeClaimer: COLLECTOR.publicKey, leftoverReceiver: COLLECTOR.publicKey };
  const padding = Array.from({ length: 20 - built.configParams.curve.length }, () => ({ sqrtPrice: new BN(0), liquidity: new BN(0) }));
  const onChain = {
    ...built.configParams,
    curve: [...built.configParams.curve, ...padding],
    quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
    feeClaimer: COLLECTOR.publicKey,
    leftoverReceiver: COLLECTOR.publicKey,
    migrationFeePercentage: built.configParams.migrationFee.feePercentage,
    creatorMigrationFeePercentage: built.configParams.migrationFee.creatorFeePercentage,
    preMigrationTokenSupply: built.configParams.tokenSupply.preMigrationTokenSupply,
    postMigrationTokenSupply: built.configParams.tokenSupply.postMigrationTokenSupply,
    migratedCollectFeeMode: built.configParams.migratedPoolFee.collectFeeMode,
    migratedDynamicFee: built.configParams.migratedPoolFee.dynamicFee,
    migratedPoolFeeBps: built.configParams.migratedPoolFee.poolFeeBps,
    lockedVestingConfig: built.configParams.lockedVesting,
  };
  const mismatches = diffOnChainConfig(onChain, built.configParams, extra);
  assert.deepEqual(mismatches.filter((m) => String(m.path).startsWith("curve")), []);
});

/** A mainnet chain that echoes back the config it was asked to create, with a chosen quote token flag. */
function stockChain({ quoteTokenFlag }) {
  const created = [];
  const MAINNET = SOLANA_GENESIS["mainnet-beta"];
  return {
    created,
    connection: {
      async getGenesisHash() { return MAINNET; },
    },
    async sendTransaction(_conn, tx, signers) {
      created.push({ params: tx.params, config: signers[1].publicKey.toBase58() });
      return `sig-${created.length}`;
    },
    client: {
      partner: { async createConfig(params) { return { feePayer: null, params }; } },
      state: {
        async getPoolConfig() {
          const p = created.at(-1).params;
          return {
            ...p,
            quoteTokenFlag,
            migrationFeePercentage: p.migrationFee.feePercentage,
            creatorMigrationFeePercentage: p.migrationFee.creatorFeePercentage,
            preMigrationTokenSupply: p.tokenSupply.preMigrationTokenSupply,
            postMigrationTokenSupply: p.tokenSupply.postMigrationTokenSupply,
            migratedCollectFeeMode: p.migratedPoolFee.collectFeeMode,
            migratedDynamicFee: p.migratedPoolFee.dynamicFee,
            migratedPoolFeeBps: p.migratedPoolFee.poolFeeBps,
            lockedVestingConfig: p.lockedVesting,
          };
        },
      },
    },
  };
}

test("a stock quote config names Meteora's DBC badge and reads back as Token-2022", async () => {
  const { NVDAX_MINT } = await import("../../../shared/dbcQuotes.mjs");
  const { dbcTokenBadgeAddress } = await import("./dbcStockQuote.mjs");
  const args = {
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000],
    stepIndex: 275,
    stepUsdMicros: 231_109_000n,
    creatorFeeMode: "creator",
    quoteMint: NVDAX_MINT,
  };
  const good = stockChain({ quoteTokenFlag: 1 });
  const ladder = ladderFor(memoryDb(), good, { cluster: "mainnet-beta", env: { SOLANA_CLUSTER: "mainnet-beta" } });
  const row = await ladder.ensureLaunchConfig(args);
  assert.equal(row.status, "active");
  const sent = good.created[0].params;
  assert.equal(sent.tokenBadge.toBase58(), dbcTokenBadgeAddress(NVDAX_MINT).toBase58());
  assert.equal(sent.tokenBadge.toBase58(), "mfacWnGh1Kn5ttHMMaNZhRZbCjvGrDQyDyZgqaR9vBM"); // read on mainnet 2026-09-29
  assert.equal(sent.quoteMint.toBase58(), NVDAX_MINT);
  // v2: a $30K market cap raises $30K x 13 / 98 of NVDAx at its price per 10^8 raw units (rounded up;
  // buildCurve's decimal round trip may move it by a unit).
  const usd = (30_000_000_000n * 13n + 97n) / 98n;
  const want = (usd * 100_000_000n + 231_109_000n - 1n) / 231_109_000n;
  const got = BigInt(sent.migrationQuoteThreshold.toString());
  assert.ok(got >= want - 2n && got <= want + 2n, `${got} vs ${want}`);

  const wrongFlag = stockChain({ quoteTokenFlag: 0 });
  const ladder2 = ladderFor(memoryDb(), wrongFlag, { cluster: "mainnet-beta", env: { SOLANA_CLUSTER: "mainnet-beta" } });
  await assert.rejects(() => ladder2.ensureLaunchConfig(args), (err) => err.code === "DBC_CONFIG_MISMATCH"
    && err.mismatches.some((m) => m.path === "quoteTokenFlag"));
});

test("a SOL config names no badge", async () => {
  const chain = fakeChain();
  let seen;
  const original = chain.client.partner.createConfig;
  chain.client.partner.createConfig = async (params) => { seen = params; return original(params); };
  await ladderFor(memoryDb(), chain).ensureLaunchConfig({
    targetUsdMicros: DBC_TARGET_USD_MICROS[30000], stepIndex: 241, stepUsdMicros: 118_000_000n, creatorFeeMode: "creator",
  });
  assert.equal("tokenBadge" in seen, false);
});
