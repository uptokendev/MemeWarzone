import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Wallet } from "ethers";
import { buildWalletActionMessage } from "./walletActionAuth.js";
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
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(raw) { this.body = raw ? JSON.parse(String(raw)) : null; this.headersSent = true; },
  };
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
  const result = await requireProjectImportWalletAuth({
    res, pool, auth, expectedWallet: wallet.address, chainId, token, action, body, projectId, imageDigest,
    routeLabel: "project-import-security-test",
  });
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
    const project = {
      id: String(this.nextId++), state_version: 0,
      arena_status: "locked", arena_eligible: false, campaign_id: null,
      payout: null, rewards: null, creator_economics: null, graduation_eligible: false,
      ...row,
    };
    this.projects.set(key, project);
    return project;
  }
  async persistVerifiedOwner({ project, identity, ownerWallet, expectedOwnershipStatus, expectedStateVersion }) {
    const current = this.projects.get(identity.key);
    if (!current || current.id !== project.id || current.ownership_status !== expectedOwnershipStatus || current.state_version !== expectedStateVersion) return null;
    const updated = { ...current, owner_wallet: ownerWallet.toLowerCase(), ownership_status: PROJECT_IMPORT_OWNERSHIP.verified, state_version: current.state_version + 1 };
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

test("create replay and exact intent binding", async () => {
  const wallet = Wallet.createRandom();
  const pool = new NoncePool();
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
  assert.equal(row.owner_wallet, null); assert.equal(row.ownership_status, PROJECT_IMPORT_OWNERSHIP.unverified);
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
  assert.equal([...store.projects.values()][0].state_version, 1);
});

test("signed claim replay, stale nonce, wrong chain, altered contract all fail", async () => {
  const wallet = Wallet.createRandom();
  {
    const pool = new NoncePool(); const auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, projectId: "p1" });
    assert.ok((await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, projectId: "p1" })).result);
    const replay = await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, projectId: "p1" });
    assert.equal(replay.res.body.code, "NONCE_INVALID");
  }
  {
    const pool = new NoncePool(); const auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, expiresAt: Date.now() - 1 });
    const stale = await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim }); assert.equal(stale.res.body.code, "NONCE_INVALID");
  }
  {
    const pool = new NoncePool(); const auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, chainId: CHAIN });
    const wrong = await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, chainId: OTHER_CHAIN }); assert.equal(wrong.res.body.code, "CHAIN_MISMATCH");
  }
  {
    const pool = new NoncePool(); const auth = await signedAuth({ wallet, pool, action: PROJECT_IMPORT_ACTIONS.claim, token: TOKEN });
    const altered = await authorize({ pool, wallet, auth, action: PROJECT_IMPORT_ACTIONS.claim, token: OTHER_TOKEN });
    assert.ok(["MESSAGE_MISMATCH", "INVALID_SIGNATURE"].includes(altered.res.body.code));
  }
});

test("metadata auth binds body and blocks identity Arena and financial fields", async () => {
  const owner = Wallet.createRandom(); const pool = new NoncePool();
  const body = { description: "alpha", website: "https://example.test" };
  const auth = await signedAuth({ wallet: owner, pool, action: PROJECT_IMPORT_ACTIONS.metadata, projectId: "p1", body });
  const altered = await authorize({ pool, wallet: owner, auth, action: PROJECT_IMPORT_ACTIONS.metadata, projectId: "p1", body: { ...body, description: "bravo" } });
  assert.equal(altered.res.body.code, "MESSAGE_MISMATCH");
  assert.deepEqual(sanitizeProjectImportMetadataPatch(body), body);
  for (const key of ["tokenAddress","chainId","arenaStatus","arenaEligible","campaignId","payout","rewards","creatorEconomics","graduationEligible","imageUrl"]) {
    assert.throws(() => sanitizeProjectImportMetadataPatch({ [key]: "x" }), /not editable/i);
  }
  const baseline = { chain_id: CHAIN, token_address: TOKEN, arena_status: "locked", arena_eligible: false, campaign_id: null, payout: null, rewards: null, creator_economics: null, graduation_eligible: false };
  assert.equal(assertNoImportSideEffectMutation(baseline, { ...baseline, description: "safe" }), true);
  assert.throws(() => assertNoImportSideEffectMutation(baseline, { ...baseline, arena_eligible: true }), /protected field/i);
});

test("metadata and image require ownership_verified exact wallet; suspended/pending/manual fail", async () => {
  const owner = Wallet.createRandom(); const other = Wallet.createRandom();
  const base = { chain_id: CHAIN, token_address: TOKEN, owner_wallet: owner.address.toLowerCase() };
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
  const replay = await authorize({ pool, wallet: owner, auth, action: PROJECT_IMPORT_ACTIONS.image, projectId: "p1", imageDigest: digest });
  assert.equal(replay.res.body.code, "NONCE_INVALID");
});

test("suspended owner cannot reclaim or edit", async () => {
  const store = new MemoryStore(); const owner = Wallet.createRandom();
  await createCanonicalProjectImport({ store, chainId: CHAIN, token: TOKEN, importerWallet: owner.address });
  const row = [...store.projects.values()][0];
  store.projects.set(`${CHAIN}:${TOKEN}`, { ...row, owner_wallet: owner.address.toLowerCase(), ownership_status: PROJECT_IMPORT_OWNERSHIP.suspended, state_version: 3 });
  await assert.rejects(claimCanonicalProjectOwnership({ store, chainId: CHAIN, token: TOKEN, claimantWallet: owner.address, currentOwnerProof: owner.address }), /suspended/i);
  assert.throws(() => assertVerifiedProjectOwner([...store.projects.values()][0], { wallet: owner.address, chainId: CHAIN, token: TOKEN }), /not verified/i);
});
