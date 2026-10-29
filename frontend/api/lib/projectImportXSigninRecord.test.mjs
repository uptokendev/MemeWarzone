import assert from 'node:assert/strict';
import test from 'node:test';
import { X_SIGNIN_ACTIONS, finishProjectXClaim, latestProvenXSignin, onchainCreatorOverridesListedX, projectXClaimRedirect, startProjectXClaim } from './projectImportXClaim.js';

process.env.X_OAUTH_STATE_SECRET = 'test-state-secret';
process.env.X_OAUTH_CLIENT_ID = 'client';
process.env.X_OAUTH_REDIRECT_URI = 'https://api.example/api/project-imports/image/x/callback';

const TOKEN = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const PROJECT = { id: '7d1c4a6e-0000-4000-8000-000000000001', chain_id: 56, token_address: TOKEN, ownership_status: 'ownership_pending' };

let socials = [], xUser = null;
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.startsWith('https://api.dexscreener.com/')) return { ok: true, json: async () => [{ chainId: 'bsc', baseToken: { address: TOKEN }, info: { socials } }] };
  if (href === 'https://api.x.com/2/oauth2/token') return { ok: true, json: async () => ({ access_token: 'token' }) };
  if (href.startsWith('https://api.x.com/2/users/me')) return { ok: true, json: async () => ({ data: xUser }) };
  throw new Error(`unexpected fetch ${href}`);
};
test.after(() => { globalThis.fetch = oldFetch; });

function db({ updateRow = null } = {}) {
  const queries = [];
  const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (/SELECT ownership_status/.test(sql)) return { rows: [{ ownership_status: 'ownership_pending' }] };
    if (/UPDATE public\.arena_token_imports/.test(sql)) return { rows: updateRow ? [updateRow] : [] };
    return { rows: [] };
  };
  return { queries, query, async connect() { return { query, release() {} }; } };
}

async function signIn() {
  const headers = {};
  const started = await startProjectXClaim({ req: {}, res: { setHeader(k, v) { headers[k] = v; } }, project: PROJECT, walletAddress: WALLET });
  const state = new URL(started.authorizeUrl).searchParams.get('state');
  const cookie = String(headers['Set-Cookie']).split(';')[0];
  return { started, state, req: { headers: { cookie } }, res: { setHeader() {} } };
}

function auditInserts(queries) { return queries.filter((q) => /INSERT INTO public\.wm_admin_audit_log/.test(q.sql)); }

test('a sign-in with the wrong X account is recorded with the proven account, then refused', async () => {
  socials = [{ type: 'twitter', url: 'https://x.com/ProjectAcct' }];
  xUser = { id: '42', username: 'DevPersonal', name: 'Dev', verified: false };
  const { started, state, req, res } = await signIn();
  assert.equal(started.expectedUsername, 'projectacct');
  const pool = db();
  await assert.rejects(finishProjectXClaim({ req, res, pool, state, code: 'c' }), { code: 'PROJECT_IMPORT_X_ACCOUNT_MISMATCH', actualUsername: 'devpersonal' });
  const [insert] = auditInserts(pool.queries);
  assert.equal(insert.params[0], X_SIGNIN_ACTIONS.mismatch);
  assert.equal(insert.params[1], PROJECT.id);
  const after = JSON.parse(insert.params[3]);
  assert.equal(after.xUsername, 'DevPersonal');
  assert.equal(after.xUserId, '42');
  assert.equal(after.walletAddress, WALLET);
  assert.equal(after.expectedUsername, 'projectacct');
  assert.ok(!pool.queries.some((q) => /UPDATE public\.arena_token_imports/.test(q.sql)), 'no ownership change');
});

test('with no official X listed, the sign-in only proves a contact account', async () => {
  socials = [];
  xUser = { id: '7', username: 'Contact_Me' };
  const { started, state, req, res } = await signIn();
  assert.equal(started.expectedUsername, null);
  const pool = db();
  const result = await finishProjectXClaim({ req, res, pool, state, code: 'c' });
  assert.equal(result.outcome, 'contact');
  assert.equal(result.project, null);
  assert.equal(auditInserts(pool.queries)[0].params[0], X_SIGNIN_ACTIONS.contact);
  assert.ok(!pool.queries.some((q) => /UPDATE public\.arena_token_imports/.test(q.sql)));
});

test('the official X account verifies ownership and writes its audit row in the same transaction', async () => {
  socials = [{ type: 'twitter', url: 'https://x.com/ProjectAcct' }];
  xUser = { id: '99', username: 'projectacct' };
  const { state, req, res } = await signIn();
  const pool = db({ updateRow: { ...PROJECT, ownership_status: 'ownership_verified', project_owner_wallet: WALLET } });
  const result = await finishProjectXClaim({ req, res, pool, state, code: 'c' });
  assert.equal(result.outcome, 'verified');
  const sqls = pool.queries.map((q) => q.sql.trim().split(/\s+/).slice(0, 3).join(' '));
  const begin = sqls.indexOf('BEGIN'), update = pool.queries.findIndex((q) => /UPDATE public\.arena_token_imports/.test(q.sql));
  const insert = pool.queries.findIndex((q) => /INSERT INTO public\.wm_admin_audit_log/.test(q.sql)), commit = sqls.indexOf('COMMIT');
  assert.ok(begin < update && update < insert && insert < commit, sqls.join(' | '));
  assert.equal(pool.queries[insert].params[0], X_SIGNIN_ACTIONS.verified);
});

test('manual review reads only this wallet\'s recent mismatch/contact sign-ins', async () => {
  const pool = db();
  assert.equal(await latestProvenXSignin(pool, { projectId: PROJECT.id, walletAddress: WALLET }), null);
  const { sql, params } = pool.queries[0];
  assert.match(sql, /after->>'walletAddress' = \$3/);
  assert.deepEqual(params[1], [X_SIGNIN_ACTIONS.mismatch, X_SIGNIN_ACTIONS.contact]);
  assert.equal(params[2], WALLET);
  assert.equal(await latestProvenXSignin(pool, { projectId: null, walletAddress: WALLET }), null);
  const row = { action: X_SIGNIN_ACTIONS.contact, after: { xUsername: 'Contact_Me', xUserId: '7', walletAddress: WALLET }, created_at: new Date().toISOString() };
  const found = await latestProvenXSignin({ query: async () => ({ rows: [row] }) }, { projectId: PROJECT.id, walletAddress: WALLET });
  assert.equal(found.xUsername, 'Contact_Me');
});

test('redirect carries the outcome and only a valid X handle', () => {
  const contact = new URL(projectXClaimRedirect({ ok: true, tokenAddress: TOKEN, chainId: 56, outcome: 'contact', xUsername: 'Contact_Me' }));
  assert.equal(contact.searchParams.get('claim'), 'x_contact');
  assert.equal(contact.searchParams.get('xHandle'), 'Contact_Me');
  const bad = new URL(projectXClaimRedirect({ ok: false, tokenAddress: TOKEN, chainId: 56, errorCode: 'X', xUsername: '<script>' }));
  assert.equal(bad.searchParams.get('claim'), 'x_failed');
  assert.equal(bad.searchParams.get('xHandle'), null);
});

test('Solana: a DexScreener X match does not beat a different on-chain creator; Pump metadata and EVM are unchanged', async () => {
  const creator = 'Hkh8KebWxAVvyDtCwE2RwDkZoDqWrghWjxbGFxthhkdT';
  const resolve = async ({ signedWallet }) => ({ automaticOwnershipAvailable: true, currentAuthority: creator, signedWalletMatchesAuthority: signedWallet === creator });
  const base = { chainId: 101, source: 'dexscreener_token_profile', tokenAddress: 'M', resolve };
  assert.equal(await onchainCreatorOverridesListedX({ ...base, walletAddress: 'someoneElse' }), creator);
  assert.equal(await onchainCreatorOverridesListedX({ ...base, walletAddress: creator }), null);
  assert.equal(await onchainCreatorOverridesListedX({ ...base, walletAddress: 'x', resolve: async () => ({ automaticOwnershipAvailable: false, currentAuthority: null }) }), null);
  let called = false;
  const spy = async () => { called = true; return {}; };
  assert.equal(await onchainCreatorOverridesListedX({ ...base, source: 'pump_metaplex_metadata', walletAddress: 'x', resolve: spy }), null);
  assert.equal(await onchainCreatorOverridesListedX({ ...base, chainId: 56, walletAddress: 'x', resolve: spy }), null);
  assert.equal(called, false);
});
