import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveEffectiveAuthority,
  parseCanonicalRobinhoodDeployments,
} from "./robinhoodStockGraduationRegistry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(root, "../..");

const NOW = new Date();
function healthyRow(overrides = {}) {
  return {
    canonical: true,
    robinhood_status: "ASSET_STATUS_ACTIVE",
    trading_halted: false,
    candidate: true,
    admin_state: "default",
    automated_health_status: "healthy",
    existing_market_support: true,
    route_enabled: true,
    oracle_feed_address: "0x0000000000000000000000000000000000000011",
    acquisition_pool_address: "0x0000000000000000000000000000000000000022",
    last_health_check_at: NOW,
    ...overrides,
  };
}

test("canonical sync accepts exact chain-4663 deployment and ignores other deployments", () => {
  const payload = {
    assets: [{
      id: "rh-uid-1",
      tokenSymbol: "NVDA",
      tokenName: "NVIDIA • Robinhood Token",
      status: "ASSET_STATUS_ACTIVE",
      deployments: [
        { chainId: 1, contractAddress: "0x0000000000000000000000000000000000000001" },
        { chainId: 4663, contractAddress: "0x0000000000000000000000000000000000000002" },
      ],
      tradingCapabilities: { market: { whole: "TRADING_STATUS_TRADABLE" } },
    }],
  };
  const rows = parseCanonicalRobinhoodDeployments(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chainId, 4663);
  assert.equal(rows[0].robinhoodAssetUid, "rh-uid-1");
  assert.equal(rows[0].symbol, "NVDA");
  assert.equal(rows[0].contractAddress, "0x0000000000000000000000000000000000000002");
});

test("malformed or fake deployment address is never imported as canonical", () => {
  const rows = parseCanonicalRobinhoodDeployments({
    assets: [{ tokenSymbol: "NVDA", tokenName: "spoof", status: "ASSET_STATUS_ACTIVE", deployments: [{ chainId: 4663, contractAddress: "NVDA" }] }],
  });
  assert.deepEqual(rows, []);
});

test("effective authority is fail-closed for noncanonical, unhealthy, halted, stale, disabled route, and missing route addresses", () => {
  assert.equal(deriveEffectiveAuthority(healthyRow(), { healthFresh: true }).enabledForGraduation, true);
  assert.equal(deriveEffectiveAuthority(healthyRow({ canonical: false }), { healthFresh: true }).enabledForGraduation, false);
  assert.equal(deriveEffectiveAuthority(healthyRow({ automated_health_status: "unhealthy" }), { healthFresh: true }).enabledForGraduation, false);
  assert.equal(deriveEffectiveAuthority(healthyRow({ trading_halted: true }), { healthFresh: true }).enabledForGraduation, false);
  assert.equal(deriveEffectiveAuthority(healthyRow(), { healthFresh: false }).enabledForGraduation, false);
  assert.equal(deriveEffectiveAuthority(healthyRow({ route_enabled: false }), { healthFresh: true }).enabledForGraduation, false);
  assert.equal(deriveEffectiveAuthority(healthyRow({ oracle_feed_address: null }), { healthFresh: true }).enabledForGraduation, false);
  assert.equal(deriveEffectiveAuthority(healthyRow({ acquisition_pool_address: null }), { healthFresh: true }).enabledForGraduation, false);
});

test("force-disabled blocks new graduations without disabling existing market support", () => {
  const decision = deriveEffectiveAuthority(healthyRow({ admin_state: "force_disabled", existing_market_support: true }), { healthFresh: true });
  assert.equal(decision.enabledForGraduation, false);
  assert.equal(decision.enabledForTrading, true);
});

test("force-enabled can admit noncandidate only when hard safety is healthy", () => {
  assert.equal(deriveEffectiveAuthority(healthyRow({ candidate: false, admin_state: "force_enabled" }), { healthFresh: true }).enabledForGraduation, true);
  assert.equal(deriveEffectiveAuthority(healthyRow({ candidate: false, admin_state: "force_enabled", canonical: false }), { healthFresh: true }).enabledForGraduation, false);
  assert.equal(deriveEffectiveAuthority(healthyRow({ candidate: false, admin_state: "force_enabled", route_enabled: false }), { healthFresh: true }).enabledForGraduation, false);
});

test("create authorization uses DB exact chain + contract lookup and ENV JSON is no longer authority", () => {
  const policy = fs.readFileSync(path.join(root, "api/dev-fix/robinhoodStockCreatePolicy.js"), "utf8");
  const registry = fs.readFileSync(path.join(root, "api/lib/robinhoodStockGraduationRegistry.js"), "utf8");
  assert.match(policy, /getRobinhoodStockGraduationAsset/);
  assert.doesNotMatch(policy, /ROBINHOOD_STOCK_TOKEN_REGISTRY_/);
  assert.match(registry, /where chain_id = \$1 and lower\(contract_address\) = lower\(\$2\)/i);
  assert.doesNotMatch(registry, /where[^;]*symbol\s*=\s*\$\d[^;]*limit 1/i);
  assert.match(policy, /stockRoutes\(asset\.contractAddress\)/);
  assert.match(policy, /Selected Stock Token graduation route is disabled onchain/);
});

test("admin overrides are version protected and audited", () => {
  const service = fs.readFileSync(path.join(root, "api/lib/robinhoodStockGraduationRegistry.js"), "utf8");
  const adminOps = fs.readFileSync(path.join(root, "api/lib/robinhoodStockGraduationAdminOps.js"), "utf8");
  const admin = fs.readFileSync(path.join(root, "api/admin/robinhoodStockGraduationRegistry.js"), "utf8");
  assert.match(service, /for update/i);
  assert.match(service, /RegistryVersionConflictError/);
  assert.match(service, /robinhood_stock_token_registry_audit/);
  assert.match(adminOps, /state_version\) !== Number\(expectedVersion\)/);
  assert.match(adminOps, /action, reason, operator_identity/);
  assert.match(admin, /requireDashboardAdmin/);
  assert.match(admin, /expectedVersion/);
  assert.match(admin, /STATE_VERSION_CONFLICT/);
});

test("public endpoint is DB-backed and server exposes frozen public/admin paths", () => {
  const publicApi = fs.readFileSync(path.join(root, "api/robinhood/stock-tokens.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "api/server.mjs"), "utf8");
  assert.match(publicApi, /listRobinhoodStockRegistry/);
  assert.match(publicApi, /source: "robinhood_stock_token_registry"/);
  assert.match(server, /\/robinhood\/stock-tokens/);
  assert.match(server, /\/admin\/robinhood\/stock-graduation-registry/);
});

test("initial eight are database seed candidates, not frontend/code authorization allowlist", () => {
  const migration = fs.readFileSync(path.join(repoRoot, "database/robinhood_stock_graduation_registry.sql"), "utf8");
  for (const symbol of ["NVDA", "SPY", "QQQ", "GOOGL", "AAPL", "MSFT", "TSLA", "COST"]) {
    assert.match(migration, new RegExp(`'${symbol}'`));
  }
  const policy = fs.readFileSync(path.join(root, "api/dev-fix/robinhoodStockCreatePolicy.js"), "utf8");
  assert.doesNotMatch(policy, /NVDA|SPY|QQQ|GOOGL|AAPL|MSFT|TSLA|COST/);
});
