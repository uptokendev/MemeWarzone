import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createDbcCreateHandler, serializeUnsigned } from "./create.js";
import { parseFeeChoice } from "../lib/dbc/dbcFeeChoice.mjs";
import { firstBuyExceedsCap } from "../lib/dbc/dbcFirstBuyQuote.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIGNER = Keypair.generate();
const MINT = Keypair.generate();
const CONFIG = Keypair.generate();
const POOL = Keypair.generate();
const OTHER = Keypair.generate();
const SECRET = "test-dbc-create-secret";

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(text) { this.body = JSON.parse(text); },
  };
}

function jsonReq(body, method = "POST") {
  const payload = JSON.stringify(body);
  return {
    method,
    url: "http://localhost/api/dbc/create",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload); },
  };
}

function getReq(query) {
  const params = new URLSearchParams(query);
  return { method: "GET", url: `http://localhost/api/dbc/create?${params}` };
}

function twoSignerTx(creator, mint) {
  const tx = new Transaction();
  tx.feePayer = new PublicKey(creator);
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: new PublicKey(creator), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: true, isWritable: false },
    ],
    programId: SystemProgram.programId,
    data: Buffer.alloc(0),
  }));
  return tx;
}

function memoryDb() {
  const campaigns = [];
  const metadata = [];
  const reservations = [];
  const drafts = [];
  const run = async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("begin") || sql.startsWith("commit") || sql.startsWith("rollback") || sql.includes("pg_advisory")) {
      return { rows: [] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("count(*)")) {
      const n = campaigns.filter((c) => c.creator_address === params[1] && c.launch_type === "dbc" && c.is_active).length;
      return { rows: [{ n }] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("order by created_at desc")) {
      const row = campaigns.filter((c) => c.creator_address === params[1] && c.launch_type === "dbc").at(-1);
      return { rows: row ? [{ created_at: row.created_at }] : [] };
    }
    if (sql.startsWith("insert into public.campaigns")) {
      const row = {
        chain_id: params[0], campaign_address: params[1], token_address: params[2], creator_address: params[3],
        name: params[4], symbol: params[5], logo_uri: params[6], factory_address: params[7], launch_type: "dbc",
        meta: JSON.parse(params[8] || "{}"), is_active: true, created_at: new Date(),
      };
      campaigns.push(row);
      return { rows: [row] };
    }
    if (sql.includes("from public.campaigns") && sql.includes("launch_type")) {
      const row = campaigns.find((c) => c.token_address === params[0] || c.campaign_address === params[0]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.token_metadata_registry") || sql.startsWith("update public.token_metadata_registry")) {
      metadata.push({ params });
      return { rows: [{ id: metadata.length }] };
    }
    if (sql.includes("from public.token_metadata_registry")) return { rows: [] };
    if (sql.includes("from public.ticker_reservations") && sql.includes("draft_id is null")) {
      const row = reservations.find((r) => r.normalized_ticker === params[2] && !r.draft_id);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("from public.ticker_reservations") && sql.includes("draft_id::text")) {
      const row = reservations.find((r) => String(r.draft_id) === String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("insert into public.ticker_reservations")) {
      const row = {
        id: params[0], draft_id: null, creator_wallet: params[1], chain_id: params[2], cluster: params[3],
        original_ticker: params[4], normalized_ticker: params[5], status: "SOFT_RESERVED", metadata: { source: "dbc_create" },
      };
      reservations.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("update public.ticker_reservations")) {
      const row = reservations.find((r) => String(r.id) === String(params[0]));
      if (row) Object.assign(row, { status: "LIVE", campaign_pda: params[1], mint: params[2] });
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("from public.campaign_drafts") && sql.includes("where id::text")) {
      return { rows: drafts.filter((d) => String(d.id) === String(params[0])) };
    }
    if (sql.includes("from public.campaign_drafts") && sql.includes("creator_wallet")) {
      return { rows: drafts.filter((d) => d.creator_wallet === params[0] && d.launch_type === "dbc") };
    }
    if (sql.startsWith("update public.campaign_drafts") && sql.includes("status = 'scheduled'")) {
      const row = drafts.find((d) => String(d.id) === String(params[0]));
      if (row) {
        row.status = "scheduled";
        row.scheduled_launch_at = params[1];
        row.launch_type = "dbc";
        row.dbc_fee_choice = params[2] ?? row.dbc_fee_choice;
      }
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("update public.campaign_drafts") && sql.includes("status = 'deployed'")) {
      const row = drafts.find((d) => String(d.id) === String(params[0]));
      if (row) Object.assign(row, { status: "deployed", campaign_address: params[1], token_address: params[2] });
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("insert into public.prepare_mode_notifications") || sql.includes("savepoint") || sql.includes("notification")) {
      return { rows: [] };
    }
    return { rows: [] };
  };
  return {
    query: run,
    connect: async () => ({ query: run, release() {} }),
    campaigns,
    metadata,
    reservations,
    drafts,
  };
}

function handlerFor(db, extra = {}) {
  return createDbcCreateHandler({
    env: {
      DBC_LAUNCH_ENABLED: "true",
      SOLANA_CLUSTER: "devnet",
      SOLANA_ROUTE_SIGNER_SECRET_KEY: SECRET,
      SOLANA_RPC_URL: "http://127.0.0.1:8899",
    },
    db,
    now: extra.now || (() => new Date("2026-09-29T12:00:00Z")),
    requireWalletActionAuth: async () => true,
    readSolUsdMicros: async () => 150_000_000n,
    solPriceStep: () => ({ stepIndex: 253, stepUsdMicros: 150_000_000n }),
    ladder: {
      ensureLaunchConfig: async ({ creatorFeeMode, targetUsdMicros }) => ({
        configAddress: CONFIG.publicKey.toBase58(),
        creatorFeeMode,
        targetUsdMicros,
        configParams: { tokenSupply: { preMigrationTokenSupply: 1_000_000_000_000000n }, curve: [], sqrtStartPrice: 1 },
      }),
    },
    buildCreatePoolTransaction: async ({ creatorWallet, mint, firstBuyLamports }) => ({
      tx: twoSignerTx(creatorWallet, mint),
      pool: POOL.publicKey.toBase58(),
      firstBuyLamports,
    }),
    readPool: extra.readPool || (async () => ({
      config: new PublicKey(CONFIG.publicKey.toBase58()),
      creator: new PublicKey(SIGNER.publicKey.toBase58()),
      poolCreator: new PublicKey(SIGNER.publicKey.toBase58()),
      baseMint: new PublicKey(MINT.publicKey.toBase58()),
    })),
    poolOwner: extra.poolOwner || (async () => "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"),
    quoteFirstBuyOnConfig: extra.quoteFirstBuyOnConfig || ((_, paid) => {
      const lamports = BigInt(paid || 0);
      if (lamports <= 0n) return { tokensOut: 0n, totalSupply: 1_000_000_000n, bps: 0n, afterFeeLamports: 0n };
      return { tokensOut: 1n, totalSupply: 1_000_000_000n, bps: 10n, afterFeeLamports: lamports };
    }),
    ...extra,
  });
}

async function post(handle, body) {
  const res = fakeRes();
  await handle(jsonReq(body), res);
  return res;
}

test("fee choice keep maps to creator; others to platform", () => {
  assert.equal(parseFeeChoice("keep").creatorFeeMode, "creator");
  assert.equal(parseFeeChoice("holders").creatorFeeMode, "platform");
  assert.equal(parseFeeChoice("buyback").creatorFeeMode, "platform");
  assert.equal(parseFeeChoice("split", 40).creatorFeeMode, "platform");
  assert.equal(parseFeeChoice("nope").ok, false);
});

test("first buy cap is 70% of supply for every creator (founder 2026-10-08, was 10%)", () => {
  assert.equal(firstBuyExceedsCap({ bps: 7000n }), false);
  assert.equal(firstBuyExceedsCap({ bps: 7001n }), true);
});

test("preflight / begin / authorize / finalize write campaign and metadata", async () => {
  const db = memoryDb();
  const handle = handlerFor(db);
  const pre = await post(handle, { operation: "preflight", creatorWallet: SIGNER.publicKey.toBase58(), targetUsd: 30000 });
  assert.equal(pre.body.ok, true);
  assert.equal(pre.body.preflight.allowed, true);

  const begun = await post(handle, {
    operation: "begin",
    creatorWallet: SIGNER.publicKey.toBase58(),
    ticker: "DBCSTEP",
    auth: { walletAddress: SIGNER.publicKey.toBase58() },
  });
  assert.equal(begun.body.ok, true);
  assert.ok(begun.body.sessionToken);

  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "DBC Step",
    symbol: "DBCSTEP",
    description: "hello",
    logoUrl: "https://example.com/logo.png",
    website: "https://example.com",
    x: "https://x.com/memewarzone",
    targetUsd: 30000,
    feeChoice: "keep",
    firstBuyLamports: "0",
  });
  assert.equal(auth.body.ok, true);
  assert.equal(auth.body.signerCount, 2);
  assert.ok(auth.body.transaction);
  assert.ok(auth.body.finalizeToken);

  const fin = await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: "sig111" });
  assert.equal(fin.body.ok, true);
  assert.equal(db.campaigns.length, 1);
  assert.equal(db.campaigns[0].launch_type, "dbc");
  assert.equal(db.campaigns[0].meta.dbc.feeChoice, "keep");
  assert.equal(db.campaigns[0].meta.dbc.firstBuyLamports, "0");
  assert.ok(db.metadata.length >= 1);
  assert.equal(db.reservations[0].status, "LIVE");
});

test("a first buy above 70% is refused", async () => {
  const db = memoryDb();
  const handle = handlerFor(db, {
    quoteFirstBuyOnConfig: () => ({ tokensOut: 1n, totalSupply: 10n, bps: 7001n, afterFeeLamports: 1n }),
  });
  const begun = await post(handle, {
    operation: "begin",
    creatorWallet: SIGNER.publicKey.toBase58(),
    ticker: "CAPTEST",
    auth: {},
  });
  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Cap",
    symbol: "CAPTEST",
    targetUsd: 30000,
    feeChoice: "holders",
    firstBuyLamports: "1000000000",
  });
  assert.equal(auth.body.ok, false);
  assert.equal(auth.body.code, "DBC_FIRST_BUY_CAP");
  assert.match(auth.body.error, /more than 70% of supply/);
});

test("any creator may take 65% at launch", async () => {
  const db = memoryDb();
  const handle = handlerFor(db, {
    quoteFirstBuyOnConfig: () => ({ tokensOut: 1n, totalSupply: 10n, bps: 6500n, afterFeeLamports: 1n }),
  });
  const begun = await post(handle, {
    operation: "begin",
    creatorWallet: SIGNER.publicKey.toBase58(),
    ticker: "CAPTEST",
    auth: {},
  });
  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Cap",
    symbol: "CAPTEST",
    targetUsd: 30000,
    feeChoice: "holders",
    firstBuyLamports: "1000000000",
  });
  assert.notEqual(auth.body.code, "DBC_FIRST_BUY_CAP");
});

test("fee choice keep uses creator config mode", async () => {
  const db = memoryDb();
  let seenMode = null;
  const handle = handlerFor(db, {
    ladder: {
      ensureLaunchConfig: async ({ creatorFeeMode }) => {
        seenMode = creatorFeeMode;
        return {
          configAddress: CONFIG.publicKey.toBase58(),
          configParams: { tokenSupply: { preMigrationTokenSupply: 1n }, curve: [], sqrtStartPrice: 1 },
        };
      },
    },
  });
  const begun = await post(handle, { operation: "begin", creatorWallet: SIGNER.publicKey.toBase58(), ticker: "KEEPMOD", auth: {} });
  await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Keep",
    symbol: "KEEPMOD",
    targetUsd: 30000,
    feeChoice: "keep",
  });
  assert.equal(seenMode, "creator");
});

test("finalize refuses a pool with a different config, creator or mint", async () => {
  const db = memoryDb();
  const handle = handlerFor(db, {
    readPool: async () => ({
      config: OTHER.publicKey,
      creator: OTHER.publicKey,
      poolCreator: OTHER.publicKey,
      baseMint: OTHER.publicKey,
    }),
  });
  const begun = await post(handle, { operation: "begin", creatorWallet: SIGNER.publicKey.toBase58(), ticker: "MISMATCH", auth: {} });
  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Mismatch",
    symbol: "MISMATCH",
    targetUsd: 30000,
    feeChoice: "keep",
  });
  const fin = await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: "x" });
  assert.equal(fin.body.ok, false);
  assert.equal(fin.body.code, "DBC_POOL_CONFIG");
});

test("no live-coin limit or cooldown: a fourth live DBC coin right after the third is allowed (founder 2026-10-10)", async () => {
  const db = memoryDb();
  for (let i = 0; i < 3; i += 1) {
    db.campaigns.push({
      creator_address: SIGNER.publicKey.toBase58(),
      launch_type: "dbc",
      is_active: true,
      created_at: new Date("2026-01-01T00:00:00Z"),
    });
  }
  const handle = handlerFor(db);
  const pre = await post(handle, { operation: "preflight", creatorWallet: SIGNER.publicKey.toBase58(), targetUsd: 30000 });
  assert.equal(pre.body.preflight.allowed, true);
  assert.equal(pre.body.preflight.liveLimitReached, false);
  assert.equal(pre.body.preflight.cooldownActive, false);
  assert.equal(pre.body.preflight.creatorLiveBondingCount, 3);
});

test("built transaction is 2 signers for every target, with and without first buy", async () => {
  const db = memoryDb();
  const handle = handlerFor(db);
  const sizes = {};
  for (const targetUsd of [30000, 50000, 150]) {
    for (const firstBuyLamports of ["0", "1000000"]) {
      const begun = await post(handle, {
        operation: "begin",
        creatorWallet: SIGNER.publicKey.toBase58(),
        ticker: `T${targetUsd}${firstBuyLamports === "0" ? "A" : "B"}`.slice(0, 12),
        auth: {},
      });
      const auth = await post(handle, {
        operation: "authorize",
        sessionToken: begun.body.sessionToken,
        mint: MINT.publicKey.toBase58(),
        name: "Size",
        symbol: "SIZE",
        targetUsd,
        feeChoice: "keep",
        firstBuyLamports,
      });
      assert.equal(auth.body.ok, true, auth.body.error);
      assert.equal(auth.body.signerCount, 2);
      const authorized = Transaction.from(Buffer.from(auth.body.transaction, "base64"));
      assert.equal(authorized.compileMessage().header.numRequiredSignatures, 2);
      const raw = Buffer.from(auth.body.transaction, "base64");
      sizes[`${targetUsd}:${firstBuyLamports}`] = raw.length;
      const tx = twoSignerTx(SIGNER.publicKey.toBase58(), MINT.publicKey.toBase58());
      const compiled = tx.compileMessage();
      assert.equal(compiled.header.numRequiredSignatures, 2);
      assert.ok(serializeUnsigned(tx).length > 0);
    }
  }
  console.log("DBC create tx sizes (injected 2-signer envelope)", sizes);
});

test("authorize refuses a scheduled draft before the time and accepts after", async () => {
  const db = memoryDb();
  db.drafts.push({
    id: "draft-lock",
    creator_wallet: SIGNER.publicKey.toBase58(),
    ticker: "LOCKME",
    name: "Lock",
    launch_type: "dbc",
    status: "scheduled",
    scheduled_launch_at: "2026-09-29T13:00:00Z",
  });
  db.reservations.push({
    id: "res-lock",
    draft_id: "draft-lock",
    creator_wallet: SIGNER.publicKey.toBase58(),
    normalized_ticker: "LOCKME",
    chain_id: 101,
    cluster: "devnet",
    status: "SOFT_RESERVED",
    metadata: { source: "dbc_create" },
  });
  const locked = handlerFor(db, { now: () => new Date("2026-09-29T12:00:00Z") });
  const begunLocked = await post(locked, {
    operation: "begin",
    creatorWallet: SIGNER.publicKey.toBase58(),
    ticker: "LOCKME",
    draftId: "draft-lock",
    auth: {},
  });
  assert.equal(begunLocked.body.code, "DBC_SCHEDULED_LOCKED");

  const open = handlerFor(db, { now: () => new Date("2026-09-29T13:01:00Z") });
  const begunOpen = await post(open, {
    operation: "begin",
    creatorWallet: SIGNER.publicKey.toBase58(),
    ticker: "LOCKME",
    draftId: "draft-lock",
    auth: {},
  });
  assert.equal(begunOpen.body.ok, true);
  const auth = await post(open, {
    operation: "authorize",
    sessionToken: begunOpen.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Lock",
    symbol: "LOCKME",
    targetUsd: 30000,
    feeChoice: "keep",
    draftId: "draft-lock",
  });
  assert.equal(auth.body.ok, true, auth.body.error);
});

test("due-drafts returns only the wallet's own due DBC drafts", async () => {
  const db = memoryDb();
  db.drafts.push({
    id: "mine-due",
    creator_wallet: SIGNER.publicKey.toBase58(),
    ticker: "MINE",
    name: "Mine",
    launch_type: "dbc",
    status: "scheduled",
    scheduled_launch_at: "2026-09-29T11:00:00Z",
    slug: "mine",
  });
  db.drafts.push({
    id: "theirs-due",
    creator_wallet: OTHER.publicKey.toBase58(),
    ticker: "THEIRS",
    name: "Theirs",
    launch_type: "dbc",
    status: "scheduled",
    scheduled_launch_at: "2026-09-29T11:00:00Z",
    slug: "theirs",
  });
  db.drafts.push({
    id: "mine-future",
    creator_wallet: SIGNER.publicKey.toBase58(),
    ticker: "FUTURE",
    name: "Future",
    launch_type: "dbc",
    status: "scheduled",
    scheduled_launch_at: "2026-09-30T11:00:00Z",
    slug: "future",
  });
  const handle = handlerFor(db);
  const res = fakeRes();
  await handle(getReq({ due: "1", wallet: SIGNER.publicKey.toBase58() }), res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].id, "mine-due");
  assert.equal(res.body.copy, "Your launch time has arrived. Deploy now to go live.");
});

test("malformed firstBuyLamports is 400, not 500", async () => {
  const db = memoryDb();
  const handle = handlerFor(db);
  const begun = await post(handle, {
    operation: "begin",
    creatorWallet: SIGNER.publicKey.toBase58(),
    ticker: "BADBUY",
    auth: {},
  });
  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Bad",
    symbol: "BADBUY",
    targetUsd: 30000,
    feeChoice: "keep",
    firstBuyLamports: "1.5",
  });
  assert.equal(auth.statusCode, 400);
  assert.equal(auth.body.code, "DBC_BAD_FIRST_BUY");
});

test("authorize re-checks creator limits after begin", async () => {
  const db = memoryDb();
  const handle = handlerFor(db);
  const begun = await post(handle, {
    operation: "begin",
    creatorWallet: SIGNER.publicKey.toBase58(),
    ticker: "RACE4",
    auth: {},
  });
  assert.equal(begun.body.ok, true);
  for (let i = 0; i < 3; i += 1) {
    db.campaigns.push({
      creator_address: SIGNER.publicKey.toBase58(),
      launch_type: "dbc",
      is_active: true,
      created_at: new Date(),
    });
  }
  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Race",
    symbol: "RACE4",
    targetUsd: 30000,
    feeChoice: "keep",
  });
  assert.notEqual(auth.body.code, "DBC_CREATOR_LAUNCH_LIMIT");
  assert.notEqual(auth.body.code, "DBC_CREATOR_COOLDOWN");
});

test("finalize fails closed when owner, config, creator or mint is missing", async () => {
  async function finalizeWith(extra) {
    const db = memoryDb();
    const handle = handlerFor(db, extra);
    const begun = await post(handle, {
      operation: "begin",
      creatorWallet: SIGNER.publicKey.toBase58(),
      ticker: `FIN${Math.random().toString(36).slice(2, 8)}`,
      auth: {},
    });
    const auth = await post(handle, {
      operation: "authorize",
      sessionToken: begun.body.sessionToken,
      mint: MINT.publicKey.toBase58(),
      name: "Fin",
      symbol: "FIN",
      targetUsd: 30000,
      feeChoice: "keep",
    });
    return post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: "x" });
  }
  const missingOwner = await finalizeWith({ poolOwner: async () => null });
  assert.equal(missingOwner.body.code, "DBC_POOL_OWNER");
  const missingConfig = await finalizeWith({
    readPool: async () => ({
      creator: SIGNER.publicKey,
      poolCreator: SIGNER.publicKey,
      baseMint: MINT.publicKey,
    }),
  });
  assert.equal(missingConfig.body.code, "DBC_POOL_CONFIG");
});

test("production create.js does not monkeypatch the SDK config reader", () => {
  const src = readFileSync(new URL("./create.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /getPoolConfigForNewPool\s*=/);
});

test("existing-job guards skip DBC rows", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const indexer = readFileSync(path.join(root, "realtime-indexer/src/solanaIndexer.ts"), "utf8");
  const reconciler = readFileSync(path.join(root, "realtime-indexer/src/solanaGraduationReconciler.ts"), "utf8");
  const registry = readFileSync(path.join(root, "frontend/api/dev-fix/campaign-registry.js"), "utf8");
  const fees = readFileSync(path.join(root, "frontend/api/solanaCreatorFees.js"), "utf8");
  const live = readFileSync(path.join(root, "frontend/src/pages/TokenDetailsLiveEntry.tsx"), "utf8");
  assert.match(indexer, /coalesce\(launch_type, 'launchpad'\) <> 'dbc'/);
  assert.match(reconciler, /coalesce\(launch_type, 'launchpad'\) <> 'dbc'/);
  assert.match(registry, /launchType \|\| row\?\.launch_type \|\| "launchpad"\) !== "dbc"/);
  assert.match(fees, /coalesce\(launch_type, 'launchpad'\) <> 'dbc'/);
  // A DBC coin renders the shared token page in DBC mode; that page must not run the
  // launchpad curve read or the graduation handoff for it.
  assert.match(live, /<TokenDetails[\s\S]*?dbcLive=\{isSolanaRoute && dbcCoin \? dbcCoin : null\}/);
  const details = readFileSync(path.join(root, "frontend/src/pages/TokenDetails.tsx"), "utf8");
  assert.match(details, /if \(!isSolanaPage \|\| isDbcPage \|\| !campaign\?\.campaign\) \{\n\s+setSolanaCurve\(null\)/);
  assert.match(details, /if \(!isSolanaPage \|\| isDbcPage \|\| !solanaCurveClosed\) return;/);
  assert.match(live, /fetchDbcToken/);
});

const MAINNET_ENV = {
  DBC_LAUNCH_ENABLED: "true",
  SOLANA_CLUSTER: "mainnet-beta",
  SOLANA_ROUTE_SIGNER_SECRET_KEY: SECRET,
  SOLANA_RPC_URL: "http://127.0.0.1:8899",
};
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

test("buyback is offered for a coin paired with USDC too", async () => {
  const handle = handlerFor(memoryDb());
  const res = await post(handle, {
    operation: "quote-first-buy",
    targetUsd: 30000,
    feeChoice: "buyback",
    firstBuyLamports: "1000000",
    quoteMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
});

test("a stock launch is priced by the stock step and names Meteora's DBC badge on the pool", async () => {
  const seen = {};
  const handle = handlerFor(memoryDb(), {
    env: MAINNET_ENV,
    stockPriceStep: async (_conn, quote) => {
      seen.stockQuote = quote.symbol;
      return { stepIndex: 275, stepUsdMicros: 231_109_000n };
    },
    ladder: {
      ensureLaunchConfig: async (args) => {
        seen.ladder = args;
        return {
          configAddress: CONFIG.publicKey.toBase58(),
          creatorFeeMode: args.creatorFeeMode,
          targetUsdMicros: args.targetUsdMicros,
          configParams: { tokenSupply: { preMigrationTokenSupply: 1_000_000_000_000000n }, curve: [], sqrtStartPrice: 1 },
        };
      },
    },
    buildCreatePoolTransaction: async (args) => {
      seen.pool = args;
      return { tx: twoSignerTx(args.creatorWallet, args.mint), pool: POOL.publicKey.toBase58() };
    },
  });
  const begun = await post(handle, { operation: "begin", creatorWallet: SIGNER.publicKey.toBase58(), ticker: "STOCKY", auth: {} });
  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: "Stocky",
    symbol: "STOCKY",
    targetUsd: 30000,
    feeChoice: "keep",
    quoteMint: NVDAX,
  });
  assert.equal(auth.body.ok, true, JSON.stringify(auth.body));
  assert.equal(seen.stockQuote, "NVDAx");
  assert.equal(seen.ladder.stepUsdMicros, 231_109_000n);
  assert.equal(seen.ladder.quoteMint, NVDAX);
  assert.equal(seen.pool.tokenBadge, "mfacWnGh1Kn5ttHMMaNZhRZbCjvGrDQyDyZgqaR9vBM");
});

test("a stock the chain says cannot be used is refused with the reason", async () => {
  const { DbcStockQuoteError } = await import("../lib/dbc/dbcStockQuote.mjs");
  const handle = handlerFor(memoryDb(), {
    env: MAINNET_ENV,
    stockPriceStep: async () => { throw new DbcStockQuoteError("The issuer has paused this stock token. Pick another pairing.", "DBC_QUOTE_PAUSED"); },
  });
  const res = await post(handle, { operation: "quote-first-buy", targetUsd: 30000, feeChoice: "keep", firstBuyLamports: "0", quoteMint: NVDAX });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "DBC_QUOTE_PAUSED");
});

// Go-live canary (CREATE_CANARY_WALLETS): only listed creator wallets may create.
function canaryHandler(db, canaryWallets) {
  return handlerFor(db, {
    env: {
      DBC_LAUNCH_ENABLED: "true",
      SOLANA_CLUSTER: "devnet",
      SOLANA_ROUTE_SIGNER_SECRET_KEY: SECRET,
      SOLANA_RPC_URL: "http://127.0.0.1:8899",
      ...(canaryWallets == null ? {} : { CREATE_CANARY_WALLETS: canaryWallets }),
    },
  });
}

async function beginAndAuthorize(handle, ticker) {
  const begun = await post(handle, { operation: "begin", creatorWallet: SIGNER.publicKey.toBase58(), ticker, auth: {} });
  assert.equal(begun.body.ok, true);
  const auth = await post(handle, {
    operation: "authorize",
    sessionToken: begun.body.sessionToken,
    mint: MINT.publicKey.toBase58(),
    name: ticker,
    symbol: ticker,
    targetUsd: 30000,
    feeChoice: "keep",
    firstBuyLamports: "0",
  });
  assert.equal(auth.body.ok, true);
  return { sessionToken: begun.body.sessionToken, finalizeToken: auth.body.finalizeToken };
}

test("canary: an allowlisted wallet runs the whole DBC create", async () => {
  const db = memoryDb();
  const handle = canaryHandler(db, ` ${OTHER.publicKey.toBase58()} , ${SIGNER.publicKey.toBase58()} `);
  const pre = await post(handle, { operation: "preflight", creatorWallet: SIGNER.publicKey.toBase58(), targetUsd: 30000 });
  assert.equal(pre.body.ok, true);
  const { finalizeToken } = await beginAndAuthorize(handle, "CANARY");
  const fin = await post(handle, { operation: "finalize", finalizeToken, signature: "sigcanary" });
  assert.equal(fin.body.ok, true);
  assert.equal(db.campaigns.length, 1);
});

test("canary: a wallet not on the list gets 403 CREATE_CANARY_ONLY at every DBC create step", async () => {
  const db = memoryDb();
  // Tokens issued while creation was open are refused once the canary is on.
  const open = canaryHandler(db, "");
  const { sessionToken, finalizeToken } = await beginAndAuthorize(open, "LATER");
  const handle = canaryHandler(db, OTHER.publicKey.toBase58());
  const wallet = SIGNER.publicKey.toBase58();
  const refusals = [
    { operation: "preflight", creatorWallet: wallet, targetUsd: 30000 },
    { operation: "begin", creatorWallet: wallet, ticker: "NOPE", auth: {} },
    { operation: "authorize", sessionToken, mint: MINT.publicKey.toBase58(), name: "N", symbol: "N", targetUsd: 30000, feeChoice: "keep" },
    { operation: "finalize", finalizeToken, signature: "x" },
    { operation: "schedule", creatorWallet: wallet, draftId: "d1", scheduledLaunchAt: 1, auth: {} },
  ];
  for (const body of refusals) {
    const res = await post(handle, body);
    assert.equal(res.statusCode, 403, body.operation);
    assert.equal(res.body.code, "CREATE_CANARY_ONLY", body.operation);
    assert.equal(res.body.error, "Launches open soon. Creation is limited to the launch team for a short test.");
  }
  assert.equal(db.campaigns.length, 0);
});

test("canary: unset or empty CREATE_CANARY_WALLETS leaves DBC create unchanged", async () => {
  for (const value of [undefined, "", " , "]) {
    const db = memoryDb();
    const handle = canaryHandler(db, value);
    const { finalizeToken } = await beginAndAuthorize(handle, "OPEN");
    const fin = await post(handle, { operation: "finalize", finalizeToken, signature: "sigopen" });
    assert.equal(fin.body.ok, true);
  }
});

test("lookup returns the coin's created time for the token page's Deployed tile", async () => {
  const db = memoryDb();
  const createdAt = new Date("2026-10-01T14:11:33.116Z");
  db.campaigns.push({
    chain_id: 101, campaign_address: POOL.publicKey.toBase58(), token_address: MINT.publicKey.toBase58(),
    creator_address: SIGNER.publicKey.toBase58(), name: "MWZDONOTBUY", symbol: "MWZDNB", launch_type: "dbc",
    meta: { dbc: { config: CONFIG.publicKey.toBase58() } }, is_active: true, created_at: createdAt,
  });
  const res = fakeRes();
  await handlerFor(db)(getReq({ token: MINT.publicKey.toBase58() }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pool, POOL.publicKey.toBase58());
  assert.equal(res.body.createdAt, "2026-10-01T14:11:33.116Z");

  const { readFileSync: read } = await import("node:fs");
  const source = read(new URL("./create.js", import.meta.url), "utf8");
  assert.match(source, /coalesce\(c\.created_at_chain, c\.created_at\) as created_at/);
});

test("live lookup reports tokens sold on the curve from the pool's base reserve and its config", async () => {
  const db = memoryDb();
  db.campaigns.push({
    chain_id: 101, campaign_address: POOL.publicKey.toBase58(), token_address: MINT.publicKey.toBase58(),
    creator_address: SIGNER.publicKey.toBase58(), name: "DAZILLA", symbol: "DAZILLA", launch_type: "dbc",
    meta: { dbc: { config: CONFIG.publicKey.toBase58() } }, is_active: true, created_at: new Date(),
  });
  // DAZILLA on mainnet 2026-10-06: config 6GdLrN... swap 546.68M + migration 211.01M, base reserve 488.47M.
  const handle = handlerFor(db, {
    readPool: async () => ({
      config: CONFIG.publicKey,
      quoteReserve: 35_110_079_047n,
      baseReserve: 488_465_660_118_496n,
      migrationQuoteThreshold: 124_408_396_605n,
    }),
    readConfig: async () => ({ swapBaseAmount: 546_677_609_369_617n, migrationBaseThreshold: 211_005_592_715_516n }),
  });
  const res = fakeRes();
  await handle(getReq({ token: MINT.publicKey.toBase58(), live: "1" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.poolLive.curveTokensRaw, "546677609369617");
  assert.equal(res.body.poolLive.curveSoldTokensRaw, "269217541966637", "757.68M placed - 488.47M left = 269.22M sold");
  assert.equal(res.body.poolLive.baseReserveRaw, "488465660118496");
  assert.equal(res.body.poolLive.progressBps, 2822);
});

test("the live first-buy quote reports the 70% cap, the same for every wallet", async () => {
  const db = memoryDb();
  const handle = handlerFor(db, {
    quoteFirstBuyOnConfig: (_, paid) => ({ tokensOut: 1n, totalSupply: 10n, bps: BigInt(paid) > 1_000_000_000n ? 7001n : 6500n, afterFeeLamports: 1n }),
  });
  const within = await post(handle, { operation: "quote-first-buy", targetUsd: 30000, feeChoice: "keep", firstBuyLamports: "1000000000", creatorWallet: SIGNER.publicKey.toBase58() });
  assert.equal(within.body.ok, true);
  assert.equal(within.body.capBps, "7000");
  assert.equal(within.body.exceedsCap, false);
  const over = await post(handle, { operation: "quote-first-buy", targetUsd: 30000, feeChoice: "keep", firstBuyLamports: "2000000000" });
  assert.equal(over.body.capBps, "7000");
  assert.equal(over.body.exceedsCap, true);
  // The SOL that buys exactly the cap comes back for the create page's MAX button.
  assert.match(String(within.body.capLamports), /^\d+$/);
});

test("the $15K target is gone (founder 2026-10-08): only $30K and $50K graduation market caps", async () => {
  const db = memoryDb();
  const handle = handlerFor(db);
  const begun = await post(handle, { operation: "begin", creatorWallet: SIGNER.publicKey.toBase58(), ticker: "OLD15K", auth: {} });
  const auth = await post(handle, {
    operation: "authorize", sessionToken: begun.body.sessionToken, mint: MINT.publicKey.toBase58(),
    name: "Old", symbol: "OLD15K", targetUsd: 15000, feeChoice: "keep", firstBuyLamports: "0",
  });
  assert.equal(auth.body.ok, false);
});
