import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Wallet } from "ethers";
import { buildWalletActionMessage, requireWalletActionAuth } from "./walletActionAuth.js";
import {
  PROJECT_IMPORT_ACTIONS,
  PROJECT_IMPORT_OWNERSHIP,
  assertNoImportSideEffectMutation,
  assertVerifiedProjectOwner,
  projectImportIntent,
  requireProjectImportWalletAuth,
  sanitizeProjectImportMetadataPatch,
  sha256Hex,
} from "./projectImportSecurity.js";
import { claimCanonicalProjectOwnership, createCanonicalProjectImport } from "./projectImportOwnershipCoordinator.js";
import { inspectImageFile, PROJECT_IMPORT_IMAGE_LIMITS } from "./imageFileValidation.js";

const CHAIN = 56;
const OTHER_CHAIN = 97;
const TOKEN = "0x1111111111111111111111111111111111111111";
const OTHER_TOKEN = "0x2222222222222222222222222222222222222222";

function response() {
  return { statusCode: 200, body: null, headersSent: false, headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(raw) { this.body = raw ? JSON.parse(String(raw)) : null; this.headersSent = true; } };
}

class NoncePool {
  constructor() { this.rows = new Map(); }
  add({ chainId, wallet, nonce, expiresAt = Date.now() + 60_000 }) {
    this.rows.set(`${Number(chainId)}:${String(wallet).toLowerCase()}:${nonce}`, { expiresAt, used: false });
  }
  async query(sql, params) {
    assert.match(String(sql), /update public\.auth_nonces/i);
    const [chainId, wallet, nonce] = params;
    const row = this.rows.get(`${Number(chainId)}:${String(wallet).toLowerCase()}:${String(nonce)}`);
    if (!row || row.used || row.expiresAt <= Date.now()) return { rows: [] };
    row.used = true;
    return { rows: [{ expires_at: new Date(row.expiresAt).toISOString() }] };
  }
}

async function signedAuth({ wallet, pool, action, chainId = CHAIN, token = TOKEN, body = null, projectId = null, imageDigest = null, expiresAt }) {
  const nonce = randomUUID();
  const intent = projectImportIntent({ action, chainId, token, body, projectId, imageDigest });
  pool.add({ chainId, wallet: wallet.address, nonce, expiresAt });
  const message = buildWalletActionMessage({ action, walletAddress: wallet.address, chainId, nonce, extraLines: intent.extraLines });
  return { action, walletAddress: wallet.address, chainId, nonce, message, signature: await wallet.signMessage(message) };
}

async function authorize({ pool, wallet, auth, action, chainId = CHAIN, token = TOKEN, body = null, projectId = null, imageDigest = null }) {
  const res = response();
  const result = await requireProjectImportWalletAuth({ res, pool, auth, expectedWallet: wallet.address, chainId, token, action, body, projectId, imageDigest, routeLabel: "project-import-security-test" });
  return { result, res };
}

class MemoryStore {
  constructor() { this.projects = new Map(); this.queues = new Map(); this.nextId = 1; }
  async withIdentityLock(key, fn) {
    const prior = this.queues.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.queues.set(key, queued);
    await prior;
    try { return await fn(); } finally { release(); if (this.queues.get(key) === queued) this.queues.delete(key); }
  }
  async findByIdentity(identity) { return this.projects.get(identity.key) || null; }
  async insertCanonical(row) {
    const key = `${row.chain_id}:${row.token_address}`;
    assert.equal(this.projects.has(key), false);
    const project = { id: String(this.nextId++), arena_status: "locked", arena_eligible: false, campaign_id: null, payout: null, rewards: null, creator_economics: null, graduation_eligible: false, ...row };
    this.projects.set(key, project);
    return project;
  }
  async persistVerifiedOwner({ project, identity, ownerWallet, expectedOwnershipStatus, expectedOwnerWallet }) {
    const current = this.projects.get(identity.key);
    const currentOwner = current?.project_owner_wallet ?? null;
    if (!current || current.id !== project.id || current.ownership_status !== expectedOwnershipStatus || currentOwner !== expectedOwnerWallet) return null;
    const updated = { ...current, project_owner_wallet: ownerWallet.toLowerCase(), ownership_status: PROJECT_IMPORT_OWNERSHIP.verified };
    this.projects.set(identity.key, updated);
    return updated;
  }
}

function png1x1() {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(buf, 0);
  Buffer.from("IHDR", "ascii").copy(buf, 12);
  buf.writeUInt32BE(1, 16); buf.writeUInt32BE(1, 20);
  return buf;
}

test("valid project import auth uses strict nonce-backed wallet proof even when legacy user writes are open", async () => {
  const previous = process.env.API_AUTH_ENFORCE_USER_WRITES;
  process.env.API_AUTH_ENFORCE_USER_WRITES = "0";
  try {
    const wallet = Wallet.createRandom();
    const pool = new NoncePool();
    const auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.create });
    const result = await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.create });
    assert.ok(result.result);
    assert.equal(result.result.legacy, false);
    assert.equal(result.res.headersSent, false);
  } finally {
    if (previous === undefined) delete process.env.API_AUTH_ENFORCE_USER_WRITES;
    else process.env.API_AUTH_ENFORCE_USER_WRITES = previous;
  }
});

test("legacy non-project-import wallet auth remains open when global user-write enforcement is off", async () => {
  const previous = process.env.API_AUTH_ENFORCE_USER_WRITES;
  process.env.API_AUTH_ENFORCE_USER_WRITES = "0";
  try {
    const wallet = Wallet.createRandom();
    const res = response();
    const result = await requireWalletActionAuth({
      res,
      pool: null,
      auth: null,
      expectedWallet: wallet.address,
      chainId: CHAIN,
      action: "legacy_non_import_test",
      routeLabel: "legacy-non-import-test",
    });
    assert.ok(result);
    assert.equal(result.legacy, true);
    assert.equal(res.headersSent, false);
  } finally {
    if (previous === undefined) delete process.env.API_AUTH_ENFORCE_USER_WRITES;
    else process.env.API_AUTH_ENFORCE_USER_WRITES = previous;
  }
});

test("create replay and exact intent binding", async () => {
  const wallet = Wallet.createRandom(); const pool = new NoncePool();
  const auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.create });
  assert.ok((await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.create })).result);
  const replay = await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.create });
  assert.equal(replay.result, null); assert.equal(replay.res.body.code, "NONCE_INVALID");
});

test("canonical create race gives first writer no owner authority", async () => {
  const store = new MemoryStore(); const a = Wallet.createRandom(); const b = Wallet.createRandom();
  const [x, y] = await Promise.all([
    createCanonicalProjectImport({ store, chainId: CHAIN, token: TOKEN, importerWallet: a.address }),
    createCanonicalProjectImport({ store, chainId: CHAIN, token: TOKEN, importerWallet: b.address }),
  ]);
  assert.equal(store.projects.size, 1); assert.equal(Number(x.existing) + Number(y.existing), 1);
  const row = [...store.projects.values()][0];
  assert.equal(row.project_owner_wallet, null); assert.equal(row.ownership_status, PROJECT_IMPORT_OWNERSHIP.pending);
  assert.throws(() => assertVerifiedProjectOwner(row, { wallet: row.imported_by_wallet, chainId: CHAIN, token: TOKEN }), /not verified/i);
});

test("wrong first importer cannot capture ownership; real owner recovers", async () => {
  const store = new MemoryStore(); const wrong = Wallet.createRandom(); const real = Wallet.createRandom();
  await createCanonicalProjectImport({ store, chainId: CHAIN, token: TOKEN, importerWallet: wrong.address });
  const claimed = await claimCanonicalProjectOwnership({ store, chainId: CHAIN, token: TOKEN, claimantWallet: real.address, currentOwnerProof: real.address });
  assert.equal(claimed.claimed, true);
  assertVerifiedProjectOwner(claimed.project, { wallet: real.address, chainId: CHAIN, token: TOKEN });
  assert.throws(() => assertVerifiedProjectOwner(claimed.project, { wallet: wrong.address, chainId: CHAIN, token: TOKEN }), /not the verified/i);
});

test("two real-owner claims race to one transition and repeat is idempotent", async () => {
  const store = new MemoryStore(); const real = Wallet.createRandom();
  await createCanonicalProjectImport({ store, chainId: CHAIN, token: TOKEN, importerWallet: Wallet.createRandom().address });
  const [a, b] = await Promise.all([
    claimCanonicalProjectOwnership({ store, chainId: CHAIN, token: TOKEN, claimantWallet: real.address, currentOwnerProof: real.address }),
    claimCanonicalProjectOwnership({ store, chainId: CHAIN, token: TOKEN, claimantWallet: real.address, currentOwnerProof: real.address }),
  ]);
  assert.equal(Number(a.claimed) + Number(b.claimed), 1); assert.equal(Number(a.replay) + Number(b.replay), 1);
  assert.equal([...store.projects.values()][0].project_owner_wallet, real.address.toLowerCase());
});

test("claim replay, stale nonce, wrong chain and altered contract fail closed", async () => {
  const wallet = Wallet.createRandom();
  let pool = new NoncePool(); let auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, projectId: "p1" });
  assert.ok((await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, projectId: "p1" })).result);
  assert.equal((await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, projectId: "p1" })).res.body.code, "NONCE_INVALID");
  pool = new NoncePool(); auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, expiresAt: Date.now() - 1 });
  assert.equal((await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim })).res.body.code, "NONCE_INVALID");
  pool = new NoncePool(); auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, chainId: CHAIN });
  assert.equal((await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, chainId: OTHER_CHAIN })).res.body.code, "CHAIN_MISMATCH");
  pool = new NoncePool(); auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, token: TOKEN });
  assert.equal((await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, token: OTHER_TOKEN })).res.body.code, "MESSAGE_MISMATCH");
});

test("metadata auth binds the project token and protects identity Arena and finance", async () => {
  const owner = Wallet.createRandom();
  const body = { description: "alpha", website: "https://example.test", x_url: "https://x.com/test", telegram_url: "https://t.me/test" };
  let pool = new NoncePool();
  let auth = await signedAuth({ wallet: owner, pool, action: PROJECT_IMPORT_ACTIONS.metadata, projectId: "p1", body, token: TOKEN });
  assert.equal((await authorize({ pool, wallet: owner, auth, action: PROJECT_IMPORT_ACTIONS.metadata, projectId: "p1", body, token: OTHER_TOKEN })).res.body.code, "MESSAGE_MISMATCH");
  pool = new NoncePool();
  auth = await signedAuth({ wallet: owner, pool, action: PROJECT_IMPORT_ACTIONS.metadata, projectId: "p1", body });
  assert.ok((await authorize({ pool, wallet: owner, auth, action: PROJECT_IMPORT_ACTIONS.metadata, projectId: "p1", body: { ...body, description: "bravo" } })).result);
  assert.deepEqual(sanitizeProjectImportMetadataPatch(body), body);
  for (const key of ["tokenAddress","chainId","arenaStatus","arenaEligible","campaignId","payout","rewards","creatorEconomics","graduationEligible","image_url","name","symbol","decimals"]) {
    assert.throws(() => sanitizeProjectImportMetadataPatch({ [key]: "x" }), /not editable/i);
  }
  const baseline = { chain_id: CHAIN, token_address: TOKEN, arena_status: "locked", arena_eligible: false, campaign_id: null, payout: null, rewards: null, creator_economics: null, graduation_eligible: false };
  assert.equal(assertNoImportSideEffectMutation(baseline, { ...baseline, description: "safe" }), true);
  assert.throws(() => assertNoImportSideEffectMutation(baseline, { ...baseline, arena_eligible: true }), /protected field/i);
});

test("metadata and image require verified project owner; pending/manual/suspended/forged fail", async () => {
  const owner = Wallet.createRandom(); const other = Wallet.createRandom();
  const base = { chain_id: CHAIN, token_address: TOKEN, project_owner_wallet: owner.address.toLowerCase() };
  const verified = { ...base, ownership_status: PROJECT_IMPORT_OWNERSHIP.verified };
  assertVerifiedProjectOwner(verified, { wallet: owner.address, chainId: CHAIN, token: TOKEN });
  assert.throws(() => assertVerifiedProjectOwner(verified, { wallet: other.address, chainId: CHAIN, token: TOKEN }), /not the verified/i);
  for (const status of [PROJECT_IMPORT_OWNERSHIP.pending, PROJECT_IMPORT_OWNERSHIP.manualReview, PROJECT_IMPORT_OWNERSHIP.suspended]) {
    assert.throws(() => assertVerifiedProjectOwner({ ...base, ownership_status: status }, { wallet: owner.address, chainId: CHAIN, token: TOKEN }), /not verified/i);
  }
  const image = png1x1();
  assert.equal(inspectImageFile(image, { declaredMime: "image/png", ...PROJECT_IMPORT_IMAGE_LIMITS }).mime, "image/png");
  assert.throws(() => inspectImageFile(image, { declaredMime: "image/jpeg", ...PROJECT_IMPORT_IMAGE_LIMITS }), /MIME mismatch/i);
  const digest = sha256Hex(image.toString("base64")); const pool = new NoncePool();
  const auth = await signedAuth({ wallet: owner, pool, action: PROJECT_IMPORT_ACTIONS.image, projectId: "p1", imageDigest: digest });
  assert.ok((await authorize({ pool, wallet: owner, auth, action: PROJECT_IMPORT_ACTIONS.image, projectId: "p1", imageDigest: digest })).result);
  assert.equal((await authorize({ pool, wallet: owner, auth, action: PROJECT_IMPORT_ACTIONS.image, projectId: "p1", imageDigest: digest })).res.body.code, "NONCE_INVALID");
});

test("suspended owner cannot reclaim or edit", async () => {
  const store = new MemoryStore(); const owner = Wallet.createRandom();
  await createCanonicalProjectImport({ store, chainId: CHAIN, token: TOKEN, importerWallet: owner.address });
  const row = [...store.projects.values()][0];
  store.projects.set(`${CHAIN}:${TOKEN}`, { ...row, project_owner_wallet: owner.address.toLowerCase(), ownership_status: PROJECT_IMPORT_OWNERSHIP.suspended });
  await assert.rejects(claimCanonicalProjectOwnership({ store, chainId: CHAIN, token: TOKEN, claimantWallet: owner.address, currentOwnerProof: owner.address }), /suspended/i);
  assert.throws(() => assertVerifiedProjectOwner([...store.projects.values()][0], { wallet: owner.address, chainId: CHAIN, token: TOKEN }), /not verified/i);
});
