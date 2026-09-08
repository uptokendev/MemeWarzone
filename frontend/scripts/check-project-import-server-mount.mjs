import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, Wallet, ZeroAddress } from "ethers";
import pg from "pg";
import {
  PROJECT_IMPORT_ACTIONS,
  projectImportIntent,
} from "../api/lib/projectImportSecurity.js";
import { buildWalletActionMessage } from "../api/lib/walletActionAuth.js";

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(here, "..");
const serverPath = resolve(frontendDir, "api/server.mjs");
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for project-import server mount certification");

const pool = new Pool({ connectionString: databaseUrl, ssl: false });
const tokenInterface = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
]);

const VERIFIED_TOKEN = "0x0000000000000000000000000000000000001001";
const CLAIM_TOKEN = "0x0000000000000000000000000000000000001002";
const MANUAL_TOKEN = "0x0000000000000000000000000000000000001003";
const SOLANA_MINT = "11111111111111111111111111111111";
const ownerWallet = Wallet.createRandom();
const claimOwnerWallet = Wallet.createRandom();
const wrongImporterWallet = Wallet.createRandom();
const manualImporterWallet = Wallet.createRandom();
const manualClaimantWallet = Wallet.createRandom();

function lower(value) {
  return String(value || "").toLowerCase();
}

const tokenState = new Map([
  [lower(VERIFIED_TOKEN), { name: "Mount Verified", symbol: "MNTV", decimals: 18, totalSupply: 1_000_000n, owner: ownerWallet.address }],
  [lower(CLAIM_TOKEN), { name: "Mount Claim", symbol: "MNTC", decimals: 9, totalSupply: 2_000_000n, owner: claimOwnerWallet.address }],
  [lower(MANUAL_TOKEN), { name: "Mount Manual", symbol: "MNTM", decimals: 6, totalSupply: 3_000_000n, owner: ZeroAddress }],
]);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

function rpcResult(request) {
  const id = request?.id ?? null;
  const method = String(request?.method || "");
  if (method === "eth_chainId") return { jsonrpc: "2.0", id, result: "0x38" };
  if (method === "net_version") return { jsonrpc: "2.0", id, result: "56" };
  if (method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: "0x1" };
  if (method === "eth_getCode") {
    const address = lower(request?.params?.[0]);
    return { jsonrpc: "2.0", id, result: tokenState.has(address) ? "0x60006000" : "0x" };
  }
  if (method === "eth_call") {
    const tx = request?.params?.[0] || {};
    const state = tokenState.get(lower(tx.to));
    if (!state) return { jsonrpc: "2.0", id, error: { code: -32000, message: "unknown mock token" } };
    const data = String(tx.data || "");
    const selector = data.slice(0, 10).toLowerCase();
    const functions = ["name", "symbol", "decimals", "totalSupply", "owner", "getOwner"];
    const methodName = functions.find((name) => tokenInterface.getFunction(name).selector.toLowerCase() === selector);
    if (!methodName) return { jsonrpc: "2.0", id, error: { code: -32601, message: "unknown mock eth_call" } };
    const value =
      methodName === "name" ? state.name :
      methodName === "symbol" ? state.symbol :
      methodName === "decimals" ? state.decimals :
      methodName === "totalSupply" ? state.totalSupply :
      state.owner;
    return { jsonrpc: "2.0", id, result: tokenInterface.encodeFunctionResult(methodName, [value]) };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported mock RPC method: ${method}` } };
}

const rpcServer = http.createServer(async (req, res) => {
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw.toString("utf8") || "{}");
    const result = Array.isArray(parsed) ? parsed.map(rpcResult) : rpcResult(parsed);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error?.message || error) }));
  }
});

const storageServer = http.createServer(async (req, res) => {
  await readBody(req);
  if (req.method === "POST" && String(req.url || "").startsWith("/storage/v1/object/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Key: String(req.url || "").replace(/^\/storage\/v1\/object\//, "") }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "mock storage route not found" }));
});

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function startApi({ port, rpcPort, storagePort, importsEnabled }) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: frontendDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      PG_DISABLE_SSL: "1",
      ENABLE_PROJECT_IMPORTS: importsEnabled ? "true" : "false",
      ENABLE_ARENA: "false",
      ENABLE_POSTGRAD_ARENA: "false",
      ENABLE_POSTGRAD_BATTLE: "false",
      ENABLE_POSTGRAD_TOURNAMENT: "false",
      ENABLE_POSTGRAD_LEAGUE: "false",
      API_RAILWAY_PROXY: "false",
      BNB_RPC_URL: `http://127.0.0.1:${rpcPort}`,
      SUPABASE_URL: `http://127.0.0.1:${storagePort}`,
      SUPABASE_SERVICE_ROLE_KEY: "mount-cert-service-role-key",
      SUPABASE_BUCKET: "mount-cert",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  return { child, getLogs: () => logs };
}

async function stopApi(api) {
  if (!api?.child || api.child.exitCode != null) return;
  api.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => api.child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
  ]);
  if (api.child.exitCode == null) api.child.kill("SIGKILL");
}

async function waitForHealth(baseUrl, api) {
  for (let i = 0; i < 80; i += 1) {
    if (api.child.exitCode != null) throw new Error(`API exited before health check passed\n${api.getLogs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 125));
  }
  throw new Error(`Timed out waiting for API health\n${api.getLogs()}`);
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { raw: text }; }
  return { response, body };
}

async function issueAuth({ wallet, action, chainId = 56, token, projectId = null, body = null, imageDigest = null }) {
  const walletAddress = lower(wallet.address);
  const nonce = crypto.randomBytes(18).toString("hex");
  await pool.query(
    `INSERT INTO public.auth_nonces(chain_id,address,nonce,expires_at,used_at)
     VALUES($1,$2,$3,NOW()+interval '10 minutes',NULL)
     ON CONFLICT(chain_id,address)
     DO UPDATE SET nonce=EXCLUDED.nonce, expires_at=EXCLUDED.expires_at, used_at=NULL`,
    [chainId, walletAddress, nonce],
  );
  const intent = projectImportIntent({ action, chainId, token, projectId, body, imageDigest });
  const message = buildWalletActionMessage({
    action,
    walletAddress,
    chainId,
    nonce,
    extraLines: intent.extraLines,
  });
  const signature = await wallet.signMessage(message);
  return { action, walletAddress, chainId, nonce, message, signature };
}

async function postJson(baseUrl, path, body, method = "POST") {
  return jsonFetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function assertCampaignTableAbsent(label) {
  const result = await pool.query(`SELECT to_regclass('public.campaigns') AS campaigns_table`);
  assert.equal(result.rows[0]?.campaigns_table, null, `${label}: project import flow fabricated a campaigns table`);
}

const png1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

let apiOn = null;
let apiOff = null;
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.auth_nonces (
    chain_id integer NOT NULL,
    address text NOT NULL,
    nonce text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    PRIMARY KEY(chain_id,address)
  )`);
  await pool.query(`TRUNCATE TABLE public.arena_token_imports, public.auth_nonces`);
  await assertCampaignTableAbsent("before certification");
  await pool.query(
    `INSERT INTO public.arena_token_imports(chain_id,token_address,owner_wallet,name,symbol,ownership_status)
     VALUES(101,$1,'','Mounted Solana Lookup','MSOL','ownership_pending')`,
    [SOLANA_MINT],
  );

  const rpcPort = await listen(rpcServer);
  const storagePort = await listen(storageServer);
  const onPort = await reservePort();
  const offPort = await reservePort();
  const baseOn = `http://127.0.0.1:${onPort}`;
  const baseOff = `http://127.0.0.1:${offPort}`;

  apiOn = startApi({ port: onPort, rpcPort, storagePort, importsEnabled: true });
  await waitForHealth(baseOn, apiOn);

  const root = await jsonFetch(`${baseOn}/`);
  assert.equal(root.response.status, 200, "existing root API route did not start");
  assert.equal(root.body?.service, "MemeWarzone API");

  const solLookup = await jsonFetch(`${baseOn}/api/project-imports?chainId=101&tokenAddress=${encodeURIComponent(SOLANA_MINT)}`);
  assert.equal(solLookup.response.status, 200, `Solana project lookup failed: ${JSON.stringify(solLookup.body)}`);
  assert.equal(solLookup.body?.project?.chainId, 101);
  assert.equal(solLookup.body?.project?.tokenAddress, SOLANA_MINT);

  for (const unsupported of [97, 102, 4663, 46630]) {
    const result = await jsonFetch(`${baseOn}/api/project-imports?chainId=${unsupported}&tokenAddress=${encodeURIComponent(VERIFIED_TOKEN)}`);
    assert.equal(result.response.status, 400, `unsupported chain ${unsupported} did not fail closed`);
    assert.equal(result.body?.code, "UNSUPPORTED_CHAIN", `unexpected unsupported-chain result for ${unsupported}`);
  }

  const createAuth = await issueAuth({
    wallet: ownerWallet,
    action: PROJECT_IMPORT_ACTIONS.create,
    token: VERIFIED_TOKEN,
    body: { operation: "create" },
  });
  const created = await postJson(baseOn, "/api/project-imports", { chainId: 56, tokenAddress: VERIFIED_TOKEN, auth: createAuth });
  assert.equal(created.response.status, 201, `create route did not complete through mounted handler: ${JSON.stringify(created.body)}`);
  assert.equal(created.body?.project?.ownershipStatus, "ownership_verified");
  assert.equal(lower(created.body?.project?.projectOwnerWallet), lower(ownerWallet.address));

  const bnbLookup = await jsonFetch(`${baseOn}/api/project-imports?chainId=56&tokenAddress=${VERIFIED_TOKEN}`);
  assert.equal(bnbLookup.response.status, 200, `BNB project lookup failed: ${JSON.stringify(bnbLookup.body)}`);
  assert.equal(bnbLookup.body?.project?.id, created.body?.project?.id);

  const wrongCreateAuth = await issueAuth({
    wallet: wrongImporterWallet,
    action: PROJECT_IMPORT_ACTIONS.create,
    token: CLAIM_TOKEN,
    body: { operation: "create" },
  });
  const claimSeed = await postJson(baseOn, "/api/project-imports", { chainId: 56, tokenAddress: CLAIM_TOKEN, auth: wrongCreateAuth });
  assert.equal(claimSeed.response.status, 201, `claim seed create failed: ${JSON.stringify(claimSeed.body)}`);
  assert.equal(claimSeed.body?.project?.ownershipStatus, "ownership_pending");
  const claimAuth = await issueAuth({
    wallet: claimOwnerWallet,
    action: PROJECT_IMPORT_ACTIONS.claim,
    token: CLAIM_TOKEN,
    projectId: claimSeed.body.project.id,
    body: { operation: "claim" },
  });
  const claimed = await postJson(baseOn, "/api/project-imports/claim", { chainId: 56, tokenAddress: CLAIM_TOKEN, auth: claimAuth });
  assert.equal(claimed.response.status, 200, `claim route did not complete through mounted handler: ${JSON.stringify(claimed.body)}`);
  assert.equal(claimed.body?.project?.ownershipStatus, "ownership_verified");
  assert.equal(lower(claimed.body?.project?.projectOwnerWallet), lower(claimOwnerWallet.address));

  const manualCreateAuth = await issueAuth({
    wallet: manualImporterWallet,
    action: PROJECT_IMPORT_ACTIONS.create,
    token: MANUAL_TOKEN,
    body: { operation: "create" },
  });
  const manualSeed = await postJson(baseOn, "/api/project-imports", { chainId: 56, tokenAddress: MANUAL_TOKEN, auth: manualCreateAuth });
  assert.equal(manualSeed.response.status, 201, `manual-claim seed create failed: ${JSON.stringify(manualSeed.body)}`);
  assert.equal(manualSeed.body?.project?.ownershipStatus, "ownership_pending");
  const manualAuth = await issueAuth({
    wallet: manualClaimantWallet,
    action: PROJECT_IMPORT_ACTIONS.manualClaim,
    token: MANUAL_TOKEN,
    projectId: manualSeed.body.project.id,
    body: { note: null },
  });
  const manualClaim = await postJson(baseOn, "/api/project-imports/manual-claim", { chainId: 56, tokenAddress: MANUAL_TOKEN, note: null, auth: manualAuth });
  assert.equal(manualClaim.response.status, 200, `manual-claim route did not complete through mounted handler: ${JSON.stringify(manualClaim.body)}`);
  assert.equal(manualClaim.body?.project?.ownershipStatus, "ownership_manual_review");
  assert.equal(lower(manualClaim.body?.project?.manualClaimWallet), lower(manualClaimantWallet.address));
  assert.equal(manualClaim.body?.project?.projectOwnerWallet, null);

  const metadata = {
    description: "Mounted metadata update",
    website: "https://example.test",
    x_url: "https://x.com/mountcert",
    telegram_url: "https://t.me/mountcert",
  };
  const metadataAuth = await issueAuth({
    wallet: ownerWallet,
    action: PROJECT_IMPORT_ACTIONS.metadata,
    token: VERIFIED_TOKEN,
    projectId: created.body.project.id,
    body: metadata,
  });
  const patched = await postJson(baseOn, "/api/project-imports", {
    chainId: 56,
    tokenAddress: VERIFIED_TOKEN,
    metadata,
    auth: metadataAuth,
  }, "PATCH");
  assert.equal(patched.response.status, 200, `metadata PATCH did not complete through mounted handler: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body?.project?.description, metadata.description);
  assert.equal(patched.body?.project?.website, metadata.website);

  const imageDigest = crypto.createHash("sha256").update(png1x1).digest("hex");
  const imageAuth = await issueAuth({
    wallet: ownerWallet,
    action: PROJECT_IMPORT_ACTIONS.image,
    token: VERIFIED_TOKEN,
    projectId: created.body.project.id,
    imageDigest,
  });
  const form = new FormData();
  form.append("file", new Blob([png1x1], { type: "image/png" }), "logo.png");
  for (const [key, value] of Object.entries(imageAuth)) form.append(key, String(value));
  const image = await jsonFetch(`${baseOn}/api/project-imports/image?chainId=56&tokenAddress=${VERIFIED_TOKEN}`, {
    method: "POST",
    body: form,
  });
  assert.equal(image.response.status, 200, `image route did not reach security/storage/persistence path: ${JSON.stringify(image.body)}`);
  assert.match(String(image.body?.project?.imageUrl || ""), /\/storage\/v1\/object\/public\/mount-cert\/project-imports\//);
  const imageDb = await pool.query(`SELECT image_url FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1`, [lower(VERIFIED_TOKEN)]);
  assert.equal(imageDb.rows[0]?.image_url, image.body?.project?.imageUrl, "image URL was not persisted on imported project row");

  await assertCampaignTableAbsent("after successful import mutations");

  await stopApi(apiOn);
  apiOn = null;
  apiOff = startApi({ port: offPort, rpcPort, storagePort, importsEnabled: false });
  await waitForHealth(baseOff, apiOff);
  const disabled = await jsonFetch(`${baseOff}/api/project-imports?chainId=56&tokenAddress=${VERIFIED_TOKEN}`);
  assert.equal(disabled.response.status, 404, `imports-off lookup did not fail closed: ${JSON.stringify(disabled.body)}`);
  assert.equal(disabled.body?.code, "PROJECT_IMPORTS_DISABLED");
  const disabledCreate = await postJson(baseOff, "/api/project-imports", { chainId: 56, tokenAddress: VERIFIED_TOKEN });
  assert.equal(disabledCreate.response.status, 404, `imports-off create did not fail closed: ${JSON.stringify(disabledCreate.body)}`);
  assert.equal(disabledCreate.body?.code, "PROJECT_IMPORTS_DISABLED");
  const disabledImage = await jsonFetch(`${baseOff}/api/project-imports/image?chainId=56&tokenAddress=${VERIFIED_TOKEN}`, { method: "POST", body: new FormData() });
  assert.equal(disabledImage.response.status, 404, `imports-off image path did not fail closed: ${JSON.stringify(disabledImage.body)}`);
  assert.equal(disabledImage.body?.code, "PROJECT_IMPORTS_DISABLED");

  await assertCampaignTableAbsent("after imports-off checks");
  console.log("project import real-server mount certification: PASS");
} catch (error) {
  if (apiOn) console.error("\n--- imports-on API log ---\n" + apiOn.getLogs());
  if (apiOff) console.error("\n--- imports-off API log ---\n" + apiOff.getLogs());
  throw error;
} finally {
  await stopApi(apiOn);
  await stopApi(apiOff);
  await closeServer(rpcServer);
  await closeServer(storageServer);
  await pool.end();
}
