#!/usr/bin/env node

const BASE_URL = (process.env.API_BASE_URL || process.env.VITE_SECURITY_API_BASE || process.env.VITE_REALTIME_API_BASE || "http://127.0.0.1:3001").replace(/\/+$/, "");
const CHAIN_ID = Number(process.env.CHECK_CHAIN_ID || process.env.VITE_DEFAULT_CHAIN_ID || process.env.VITE_TARGET_CHAIN_ID || 97);
const WALLET_ADDRESS = process.env.CHECK_WALLET_ADDRESS || "0x0000000000000000000000000000000000000001";
const CAMPAIGN_ADDRESS = process.env.CHECK_CAMPAIGN_ADDRESS || "0x0000000000000000000000000000000000000002";
const FACTORY_ADDRESS = process.env.CHECK_FACTORY_ADDRESS || process.env.VITE_FACTORY_ADDRESS_97 || process.env.VITE_FACTORY_ADDRESS || WALLET_ADDRESS;
const MUTATE = String(process.env.SECURITY_SMOKE_MUTATE || "").trim() === "1";

function url(path) {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { __nonJson: text.slice(0, 500) };
  }
}

async function check(name, method, path, body, options = {}) {
  const res = await fetch(url(path), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-admin-email": process.env.SECURITY_SMOKE_ADMIN_EMAIL || "smoke@memewar.zone",
      // Everything except status, creator profile and launch eligibility needs
      // the ops key or a Command Center bearer with security.view/manage.
      ...(process.env.DASHBOARD_OPS_KEY ? { "x-ops-key": process.env.DASHBOARD_OPS_KEY } : {}),
      ...(process.env.SECURITY_SMOKE_BEARER ? { authorization: `Bearer ${process.env.SECURITY_SMOKE_BEARER}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await readJson(res);
  const allowedStatuses = options.allowedStatuses || [200];
  const ok = allowedStatuses.includes(res.status) && !json.__nonJson;
  return { name, method, path, status: res.status, ok, json };
}

const readOnlyChecks = [
  ["Security status", "GET", "/api/security/status", null],
  ["Security creators", "GET", "/api/security/creators", null],
  ["Security clusters", "GET", "/api/security/clusters", null],
  ["Manual review queue", "GET", "/api/security/manual-review", null],
  ["Mass deployer alerts", "GET", "/api/security/mass-deployers", null],
  ["Audit log", "GET", "/api/security/audit-log", null],
  ["BNB sync jobs", "GET", "/api/security/contracts/sync-jobs?chain=bnb", null],
  ["Creator profile", "GET", `/api/security/creator/${WALLET_ADDRESS}/profile`, null],
  ["Creator launch eligibility", "GET", `/api/security/creator/${WALLET_ADDRESS}/launch-eligibility`, null, { allowedStatuses: [200, 403] }],
  ["Launch preflight create", "POST", "/api/launchpad/preflight-create", { walletAddress: WALLET_ADDRESS, chainId: CHAIN_ID, factoryAddress: FACTORY_ADDRESS }, { allowedStatuses: [200, 403] }],
  ["Launch preflight buy", "POST", "/api/launchpad/preflight-buy", { walletAddress: WALLET_ADDRESS, campaignAddress: CAMPAIGN_ADDRESS, chainId: CHAIN_ID }, { allowedStatuses: [200, 403] }],
  ["Launch preflight sell", "POST", "/api/launchpad/preflight-sell", { walletAddress: WALLET_ADDRESS, campaignAddress: CAMPAIGN_ADDRESS, chainId: CHAIN_ID }, { allowedStatuses: [200, 403] }],
  ["Routing status", "GET", `/api/routing/status?chainId=${CHAIN_ID}&walletAddress=${WALLET_ADDRESS}&factoryAddress=${FACTORY_ADDRESS}`, null],
  ["Create route authorization", "POST", "/api/routing/create-authorization", { walletAddress: WALLET_ADDRESS, chainId: CHAIN_ID, factoryAddress: FACTORY_ADDRESS }, { allowedStatuses: [200, 403, 503] }],
  ["Trade route authorization", "POST", "/api/routing/trade-authorization", { walletAddress: WALLET_ADDRESS, chainId: CHAIN_ID, campaignAddress: CAMPAIGN_ADDRESS }, { allowedStatuses: [200, 403, 503] }],
];

const mutatingChecks = [
  ["Queue creator tier sync", "POST", `/api/security/creator/${WALLET_ADDRESS}/tier`, { tier: "New", reason: "security smoke test" }],
  ["Queue creator manual review sync", "POST", `/api/security/creator/${WALLET_ADDRESS}/manual-review`, { required: false, reason: "security smoke test" }],
  ["Queue wallet restriction sync", "POST", `/api/security/wallet/${WALLET_ADDRESS}/restrict`, { restricted: false, reason: "security smoke test" }],
  ["Queue campaign pause sync", "POST", "/api/security/contracts/pause-campaign", { campaign: CAMPAIGN_ADDRESS, field: "paused", paused: false, reason: "security smoke test" }],
];

const checks = MUTATE ? [...readOnlyChecks, ...mutatingChecks] : readOnlyChecks;
let failures = 0;

console.log(`Security API smoke test: ${BASE_URL}`);
console.log(`chainId=${CHAIN_ID} wallet=${WALLET_ADDRESS} campaign=${CAMPAIGN_ADDRESS}`);
console.log(`mutatingChecks=${MUTATE ? "enabled" : "disabled"}`);

for (const args of checks) {
  try {
    const result = await check(...args);
    const marker = result.ok ? "OK" : "FAIL";
    if (!result.ok) failures += 1;
    const code = result.json?.code ? ` code=${result.json.code}` : "";
    const queued = result.json?.queued ? " queued=true" : "";
    console.log(`${marker} ${result.method} ${result.path} -> ${result.status}${code}${queued} :: ${result.name}`);
    if (!result.ok) console.log(JSON.stringify(result.json, null, 2));
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${args[1]} ${args[2]} :: ${args[0]}`);
    console.log(String(error?.message || error));
  }
}

if (failures > 0) {
  console.error(`\n${failures} security smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll security smoke checks returned expected JSON statuses.");
