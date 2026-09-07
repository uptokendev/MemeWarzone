from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


Path("frontend/api/lib/launchChainReadiness.js").write_text(r'''const ROBINHOOD_CHAINS = new Set([4663, 46630]);
const SOLANA_CHAINS = new Set([101, 102]);
const KNOWN_CHAINS = new Set([56, 97, 101, 102, 4663, 46630]);

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function explicitBoolean(env, keys, fallback) {
  for (const key of keys) {
    if (env[key] == null || String(env[key]).trim() === "") continue;
    return truthy(env[key]);
  }
  return fallback;
}

function first(env, keys) {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function evmFactory(chainId, env) {
  const id = Number(chainId);
  const chainSpecific = first(env, [
    `FACTORY_ADDRESS_${id}`,
    `LAUNCH_FACTORY_ADDRESS_${id}`,
    `VITE_FACTORY_ADDRESS_${id}`,
  ]);
  if (chainSpecific) return chainSpecific;
  if (id === 56) return first(env, ["FACTORY_ADDRESS", "LAUNCH_FACTORY_ADDRESS", "VITE_FACTORY_ADDRESS"]);
  return "";
}

export function isSolanaLaunchChain(chainId) {
  return SOLANA_CHAINS.has(Number(chainId));
}

export function getLaunchChainReadiness(chainId, env = process.env) {
  const id = Number(chainId);
  const known = KNOWN_CHAINS.has(id);
  const supportEnabled = explicitBoolean(env, [`CHAIN_${id}_SUPPORT_ENABLED`, `SUPPORT_ENABLED_${id}`], known);
  const creationEnabled = explicitBoolean(env, [`CHAIN_${id}_CREATION_ENABLED`, `CREATION_ENABLED_${id}`], known && !ROBINHOOD_CHAINS.has(id));

  let runtimeReady = false;
  let runtimeKind = "unsupported";
  if (SOLANA_CHAINS.has(id)) {
    runtimeKind = "solana_program";
    runtimeReady = Boolean(
      truthy(env.SOLANA_CREATE_AUTH_ENABLED) &&
      first(env, ["SOLANA_RPC_URL"]) &&
      first(env, ["SOLANA_LAUNCHPAD_PROGRAM_ID"]) &&
      first(env, ["SOLANA_ROUTE_SIGNER_PUBLIC_KEY"]) &&
      first(env, ["SOLANA_ROUTE_SIGNER_SECRET_KEY"]) &&
      first(env, ["SOLANA_CLUSTER"]) &&
      first(env, ["SOLANA_CLUSTER_HASH_HEX"])
    );
  } else if (known) {
    runtimeKind = "evm_factory";
    runtimeReady = Boolean(evmFactory(id, env));
  }

  let reason = "ready";
  if (!known || !supportEnabled) reason = "support_disabled";
  else if (!creationEnabled) reason = "creation_disabled";
  else if (!runtimeReady) reason = SOLANA_CHAINS.has(id) ? "solana_runtime_missing" : "factory_missing";

  return {
    chainId: id,
    supportEnabled: Boolean(known && supportEnabled),
    creationEnabled: Boolean(creationEnabled),
    runtimeReady,
    runtimeKind,
    creationReady: Boolean(known && supportEnabled && creationEnabled && runtimeReady),
    reason,
  };
}
''')

Path("frontend/src/components/create/CreateChainReadinessGate.tsx").write_text(r'''import { useEffect, useMemo, useState } from "react";
import Create from "@/pages/Create";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { apiFetch } from "@/lib/apiBase";
import { getActiveChainId, getChainLabel, ROBINHOOD_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";

type LaunchChainReadiness = {
  chainId: number;
  supportEnabled: boolean;
  creationEnabled: boolean;
  runtimeReady: boolean;
  creationReady: boolean;
  reason?: string;
  readyForCoreFlow?: boolean;
};

export function CreateChainReadinessGate() {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const chainId = useMemo(() => {
    const solanaSelected = Boolean(
      solanaWallet.isSolanaConnected && solanaWallet.solanaAccount &&
      (getActiveChainId(wallet.chainId) === SOLANA_CHAIN_ID || !wallet.isConnected)
    );
    return solanaSelected ? SOLANA_CHAIN_ID : getActiveChainId(wallet.chainId);
  }, [solanaWallet.isSolanaConnected, solanaWallet.solanaAccount, wallet.chainId, wallet.isConnected]);

  const [state, setState] = useState<{ loading: boolean; readiness: LaunchChainReadiness | null }>({ loading: true, readiness: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, readiness: null });
    apiFetch(`/api/routing/status?chainId=${encodeURIComponent(String(chainId))}`, { method: "GET", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        setState({
          loading: false,
          readiness: {
            chainId,
            supportEnabled: body?.supportEnabled === true,
            creationEnabled: body?.creationEnabled === true,
            runtimeReady: body?.runtimeReady === true,
            creationReady: body?.creationReady === true && body?.readyForCoreFlow === true,
            readyForCoreFlow: body?.readyForCoreFlow === true,
            reason: String(body?.readinessReason || body?.reason || "unavailable"),
          },
        });
      })
      .catch(() => { if (!cancelled) setState({ loading: false, readiness: null }); });
    return () => { cancelled = true; };
  }, [chainId]);

  if (state.loading) {
    return <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground" data-testid="creation-readiness-loading">Checking launch readiness…</div>;
  }

  if (!state.readiness?.creationReady) {
    const robinhood = chainId === ROBINHOOD_CHAIN_ID;
    return (
      <div className="mx-auto max-w-3xl p-6" data-testid="creation-readiness-blocked">
        <div className="rounded-xl border border-orange-400/30 bg-orange-500/5 p-5">
          <h1 className="font-retro text-xl text-foreground">{robinhood ? "Robinhood launching soon" : `${getChainLabel(chainId)} creation unavailable`}</h1>
          <p className="mt-2 text-sm text-muted-foreground">New creator deployment is disabled until the chain runtime is fully deployed and enabled. Wallet, read-only and historical support remain available.</p>
        </div>
      </div>
    );
  }

  return <Create />;
}
''')

replace_once("frontend/src/App.tsx", 'import Create from "./pages/Create";', 'import { CreateChainReadinessGate } from "@/components/create/CreateChainReadinessGate";')
replace_once("frontend/src/App.tsx", '<Route path="/create" element={<Create />} />', '<Route path="/create" element={<CreateChainReadinessGate />} />')

replace_once("frontend/api/dev-fix/route-auth.js", 'import { defaultEvmChainId } from "../lib/defaultEvmChain.js";', 'import { defaultEvmChainId } from "../lib/defaultEvmChain.js";\nimport { getLaunchChainReadiness, isSolanaLaunchChain } from "../lib/launchChainReadiness.js";')
replace_once("frontend/api/dev-fix/route-auth.js", '  const chainId = parsePositiveInt(q.chainId || process.env.VITE_DEFAULT_CHAIN_ID || process.env.VITE_TARGET_CHAIN_ID, defaultEvmChainId());\n  const signer = getSigner();', '''  const chainId = parsePositiveInt(q.chainId || process.env.VITE_DEFAULT_CHAIN_ID || process.env.VITE_TARGET_CHAIN_ID, defaultEvmChainId());
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (isSolanaLaunchChain(chainId)) {
    return json(res, 200, {
      ok: true,
      chainId,
      status: launchReadiness.creationReady ? "ready" : "blocked",
      readyForCoreFlow: launchReadiness.creationReady,
      ...launchReadiness,
      readinessReason: launchReadiness.reason,
      authority: "server_runtime",
    });
  }
  const signer = getSigner();''')
replace_once("frontend/api/dev-fix/route-auth.js", '  const readyForCoreFlow = Boolean(signer && factoryAddress && rpcUrlConfigured && onchain.routeAuthority && matchesOnchain);', '  const readyForCoreFlow = Boolean(launchReadiness.creationReady && signer && factoryAddress && rpcUrlConfigured && onchain.routeAuthority && matchesOnchain);')
replace_once("frontend/api/dev-fix/route-auth.js", '  const factoryAddress = normalizeAddress(body.factoryAddress);\n  const chainId = parsePositiveInt(body.chainId, 0);', '''  const factoryAddress = normalizeAddress(body.factoryAddress);
  const chainId = parsePositiveInt(body.chainId, 0);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) {
    return json(res, 503, { error: "Creator deployment is not enabled for this chain.", code: "CHAIN_CREATION_NOT_READY", ...launchReadiness });
  }''')
replace_once("frontend/api/dev-fix/route-auth.js", '    readyForCoreFlow,', '    readyForCoreFlow,\n    ...launchReadiness,\n    readinessReason: launchReadiness.reason,')

replace_once("frontend/api/dev-fix/drafts-base.js", 'import { requireDraftActionAuth } from "./draft-auth.js";', 'import { requireDraftActionAuth } from "./draft-auth.js";\nimport { getLaunchChainReadiness } from "../lib/launchChainReadiness.js";')
replace_once("frontend/api/dev-fix/drafts-base.js", '  const body = await readJson(req);\n  const chainId = Number(body.chainId || process.env.VITE_TARGET_CHAIN_ID || 97);', '''  const body = await readJson(req);
  const chainId = Number(body.chainId || process.env.VITE_TARGET_CHAIN_ID || 97);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) {
    return json(res, 503, { error: "Creator deployment is not enabled for this chain.", code: "CHAIN_CREATION_NOT_READY", ...launchReadiness });
  }''')

replace_once("frontend/api/dev-fix/solana-direct-create.js", 'import { emitNotification } from "../lib/notifications.js";', 'import { emitNotification } from "../lib/notifications.js";\nimport { getLaunchChainReadiness } from "../lib/launchChainReadiness.js";')
for old, new in [
    ('async function handlePreflight(body, res) {\n  const creatorWallet = validateCreatorWallet(body.creatorWallet);\n  const chainId = Number(body.chainId || 101);', '''async function handlePreflight(body, res) {
  const creatorWallet = validateCreatorWallet(body.creatorWallet);
  const chainId = Number(body.chainId || 101);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) throw new SolanaDirectCreateError("Creator deployment is not enabled for this chain.", { code: "CHAIN_CREATION_NOT_READY", httpStatus: 503 });'''),
    ('async function handleBegin(body, res) {\n  const creatorWallet = validateCreatorWallet(body.creatorWallet);\n  const chainId = Number(body.chainId || 101);', '''async function handleBegin(body, res) {
  const creatorWallet = validateCreatorWallet(body.creatorWallet);
  const chainId = Number(body.chainId || 101);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) throw new SolanaDirectCreateError("Creator deployment is not enabled for this chain.", { code: "CHAIN_CREATION_NOT_READY", httpStatus: 503 });'''),
    ('  const chainId = Number(session.chainId);\n  const ticker = normalizeTicker(session.ticker);', '''  const chainId = Number(session.chainId);
  const launchReadiness = getLaunchChainReadiness(chainId);
  if (!launchReadiness.creationReady) throw new SolanaDirectCreateError("Creator deployment is not enabled for this chain.", { code: "CHAIN_CREATION_NOT_READY", httpStatus: 503 });
  const ticker = normalizeTicker(session.ticker);'''),
]:
    replace_once("frontend/api/dev-fix/solana-direct-create.js", old, new)

replace_once("frontend/api/graduation/quote-assets.js", 'import { decorateQuoteAsset, filterCreatorGraduationAssets } from "../lib/approvedQuoteCatalog.js";', 'import { decorateQuoteAsset, filterCreatorGraduationAssets } from "../lib/approvedQuoteCatalog.js";\nimport { getLaunchChainReadiness } from "../lib/launchChainReadiness.js";')
replace_once("frontend/api/graduation/quote-assets.js", '      const detail = await getGraduationQuoteAssetDetail(id);\n      if (!detail?.item?.newGraduationEligible) {', '''      const detail = await getGraduationQuoteAssetDetail(id);
      const detailReadiness = getLaunchChainReadiness(Number(detail?.item?.chainId || 0));
      if (!detailReadiness.creationReady) return json(res, 404, { ok: false, error: "Quote asset not available while chain creation is disabled", code: "CHAIN_CREATION_NOT_READY" });
      if (!detail?.item?.newGraduationEligible) {''')
replace_once("frontend/api/graduation/quote-assets.js", '    if (!chainId) return json(res, 400, { ok: false, error: "chainId is required", code: "CHAIN_ID_REQUIRED" });\n    const catalogItems = await listGraduationQuoteAssets({ chainId });', '''    if (!chainId) return json(res, 400, { ok: false, error: "chainId is required", code: "CHAIN_ID_REQUIRED" });
    const launchReadiness = getLaunchChainReadiness(Number(chainId));
    if (!launchReadiness.creationReady) {
      return json(res, 200, { ok: true, chainId, authority: "server_runtime", eligibility: "new_graduation_only", creationReady: false, readinessReason: launchReadiness.reason, items: [], updatedAt: new Date().toISOString() });
    }
    const catalogItems = await listGraduationQuoteAssets({ chainId });''')

Path("frontend/api/lib/launchChainReadiness.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { getLaunchChainReadiness } from "./launchChainReadiness.js";
const evm = (id) => ({ [`CHAIN_${id}_SUPPORT_ENABLED`]: "true", [`CHAIN_${id}_CREATION_ENABLED`]: "true", [`FACTORY_ADDRESS_${id}`]: "0x1111111111111111111111111111111111111111" });
const sol = { CHAIN_101_SUPPORT_ENABLED: "true", CHAIN_101_CREATION_ENABLED: "true", SOLANA_CREATE_AUTH_ENABLED: "true", SOLANA_RPC_URL: "https://rpc.example", SOLANA_LAUNCHPAD_PROGRAM_ID: "program", SOLANA_ROUTE_SIGNER_PUBLIC_KEY: "pub", SOLANA_ROUTE_SIGNER_SECRET_KEY: "secret", SOLANA_CLUSTER: "mainnet-beta", SOLANA_CLUSTER_HASH_HEX: "11".repeat(32) };
test("BNB enabled + valid runtime", () => assert.equal(getLaunchChainReadiness(56, evm(56)).creationReady, true));
test("Solana enabled + valid runtime", () => assert.equal(getLaunchChainReadiness(101, sol).creationReady, true));
test("Robinhood creationEnabled=false", () => assert.equal(getLaunchChainReadiness(4663, { ...evm(4663), CHAIN_4663_CREATION_ENABLED: "false" }).creationReady, false));
test("Robinhood missing factory", () => assert.equal(getLaunchChainReadiness(4663, { CHAIN_4663_SUPPORT_ENABLED: "true", CHAIN_4663_CREATION_ENABLED: "true" }).reason, "factory_missing"));
test("Robinhood later enabled without code rewrite", () => assert.equal(getLaunchChainReadiness(4663, evm(4663)).creationReady, true));
test("blocked Robinhood does not disable BNB/Solana", () => { assert.equal(getLaunchChainReadiness(4663, { ...evm(4663), CHAIN_4663_CREATION_ENABLED: "false" }).creationReady, false); assert.equal(getLaunchChainReadiness(56, evm(56)).creationReady, true); assert.equal(getLaunchChainReadiness(101, sol).creationReady, true); });
test("frontend override cannot enable Robinhood", () => { const s = getLaunchChainReadiness(4663, { VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY: "true", VITE_FACTORY_ADDRESS_4663: "0x1111111111111111111111111111111111111111" }); assert.equal(s.creationReady, false); assert.equal(s.reason, "creation_disabled"); });
test("supportEnabled=false blocks", () => assert.equal(getLaunchChainReadiness(56, { ...evm(56), CHAIN_56_SUPPORT_ENABLED: "false" }).creationReady, false));
''')

Path("frontend/api/lib/launchChainReadinessIntegration.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const app = read("../../src/App.tsx");
const gate = read("../../src/components/create/CreateChainReadinessGate.tsx");
const routeAuth = read("../dev-fix/route-auth.js");
const drafts = read("../dev-fix/drafts-base.js");
const solana = read("../dev-fix/solana-direct-create.js");
const picker = read("../graduation/quote-assets.js");
test("creator UI is readiness gated", () => { assert.match(app, /CreateChainReadinessGate/); assert.match(gate, /\/api\/routing\/status\?chainId=/); assert.match(gate, /creationReady === true && body\?\.readyForCoreFlow === true/); });
test("direct deploy respects readiness", () => { assert.match(routeAuth, /CHAIN_CREATION_NOT_READY/); assert.match(solana, /CHAIN_CREATION_NOT_READY/); });
test("draft deploy respects readiness", () => assert.match(drafts, /getLaunchChainReadiness\(chainId\)/));
test("picker respects readiness and stays empty", () => { assert.match(picker, /creationReady: false/); assert.match(picker, /items: \[\]/); assert.match(picker, /newGraduationEligible/); });
test("blocked Robinhood safe UI preserves public support", () => { assert.match(gate, /Robinhood launching soon/); assert.match(gate, /Wallet, read-only and historical support remain available/); });
''')

Path(".github/workflows/launch-chain-readiness-guard.yml").write_text(r'''name: Launch Chain Readiness Guard
on:
  pull_request:
    branches: [build/cross-chain-stabilization-rh-base]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  readiness:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci --prefix frontend --no-audit --no-fund
      - run: node --test frontend/api/lib/launchChainReadiness.test.mjs
      - run: node --test frontend/api/lib/launchChainReadinessIntegration.test.mjs
      - run: node --test frontend/api/lib/approvedQuoteCatalog.test.mjs frontend/api/lib/quoteAssetCatalog.test.mjs
      - run: npm --prefix frontend run check:api-imports
      - run: npm --prefix frontend run build
''')

Path(".github/workflows/agent6-readiness-bootstrap.yml").unlink(missing_ok=True)
Path("scripts/agent6-readiness-bootstrap.py").unlink(missing_ok=True)
