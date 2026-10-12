import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.PG_DISABLE_SSL ||= "1";

const security = await import("./security-current-time.js");
const detector = await import("./creator-cluster-detector.js");
const indexer = await import("../../scripts/run-creator-funding-indexer.mjs");

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

test("creator protection applies only to buy route actions", () => {
  assert.equal(security.isCreatorBuyAction(0), true);
  assert.equal(security.isCreatorBuyAction(1), true);
  assert.equal(security.isCreatorBuyAction(2), false);
  assert.equal(security.isCreatorBuyAction(3), false);
});

test("creator cap reserves the conservative native amount", () => {
  assert.equal(
    security.requestedCreatorBuyWei({ action: 0, amount: 100n, limit: 250n }),
    250n,
    "buyExactTokens must reserve maxCost",
  );
  assert.equal(
    security.requestedCreatorBuyWei({ action: 1, amount: 300n, limit: 100n }),
    300n,
    "buyExactBnb must reserve msg.value/action amount",
  );
  assert.equal(security.requestedCreatorBuyWei({ action: 2, amount: 300n, limit: 100n }), 0n);
});

test("route authorization reserves before signing", async () => {
  const source = await read("./route-auth.js");
  const preflightIndex = source.indexOf("evaluateTradePreflight({ walletAddress, campaignAddress, chainId, action })");
  const reserveIndex = source.indexOf("reserveCreatorClusterBuyAuthorization({");
  const signIndex = source.indexOf("signTradeAuthorization({");

  assert.ok(preflightIndex >= 0, "route must pass action to creator protection preflight");
  assert.ok(reserveIndex > preflightIndex, "reservation must follow safety preflight");
  assert.ok(signIndex > reserveIndex, "route signature must not be created before cap reservation");
  assert.match(source, /CREATOR_CLUSTER_BUY_CAP_EXCEEDED|capReservation\.code/);
});

test("RPC indexer recognizes only monitored direct native funding", () => {
  const creator = "0x1111111111111111111111111111111111111111";
  const wallet = "0x2222222222222222222222222222222222222222";
  const activeCreators = new Set([creator]);
  const base = {
    hash: `0x${"a".repeat(64)}`,
    from: creator,
    to: wallet,
    input: "0x",
    value: "0x16345785d8a0000",
  };

  const candidate = indexer.creatorFundingCandidate(base, activeCreators, 1n);
  assert.equal(candidate.creator, creator);
  assert.equal(candidate.wallet, wallet);
  assert.equal(candidate.valueWei, 100_000_000_000_000_000n);

  assert.equal(indexer.creatorFundingCandidate({ ...base, input: "0x1234" }, activeCreators, 1n), null);
  assert.equal(
    indexer.creatorFundingCandidate(
      { ...base, from: "0x3333333333333333333333333333333333333333" },
      activeCreators,
      1n,
    ),
    null,
  );
  assert.equal(indexer.creatorFundingCandidate({ ...base, value: "0x0" }, activeCreators, 1n), null);
});

test("creator funding detection uses persisted RPC evidence, not explorer APIs", async () => {
  const [securitySource, detectorSource, indexerSource, packageSource, migrationSource] = await Promise.all([
    read("./security-current-time.js"),
    read("./creator-cluster-detector.js"),
    read("../../scripts/run-creator-funding-indexer.mjs"),
    read("../../package.json"),
    read("../../../db/migrations/20260730_000002_creator_funding_indexer.sql"),
  ]);

  assert.equal(typeof security.creatorClusterFundingDetectorConfigured, "function");
  assert.equal(typeof detector.persistDirectFundingCluster, "function");
  assert.doesNotMatch(securitySource, /detectDirectCreatorFunding/);
  assert.doesNotMatch(securitySource, /CREATOR_CLUSTER_BUY_LOCKED/);
  assert.match(securitySource, /creatorLinked: directCreator/);
  assert.match(securitySource, /buyerClusterId: null/);
  assert.match(
    securitySource,
    /BNB no longer applies wallet-cluster or direct-funding links/,
    "BNB buys must not lock a wallet because it shares a cluster or received creator funding",
  );

  assert.match(detectorSource, /public\.creator_funding_edges/);
  assert.match(detectorSource, /public\.creator_funding_indexer_state/);
  assert.match(detectorSource, /CREATOR_CLUSTER_MAX_INDEXER_AGE_SECONDS/);
  assert.match(detectorSource, /CREATOR_CLUSTER_MAX_INDEXER_LAG_BLOCKS/);
  assert.match(detectorSource, /public\.wallet_clusters/);
  assert.match(detectorSource, /public\.cluster_members/);
  assert.match(detectorSource, /public\.wallet_risk_profiles/);
  assert.match(detectorSource, /set-wallet-cluster/);
  assert.match(detectorSource, /set-cluster-risk/);
  assert.doesNotMatch(detectorSource, /ETHERSCAN_API_KEY|BSCSCAN_API_KEY|api\.etherscan|api\.bscscan/);

  assert.match(indexerSource, /eth_getBlockByNumber/);
  assert.match(indexerSource, /"finalized"/);
  assert.match(indexerSource, /eth_getTransactionReceipt/);
  assert.match(indexerSource, /public\.campaign_drafts/);
  assert.match(indexerSource, /public\.campaigns/);
  assert.match(indexerSource, /pg_try_advisory_lock/);
  assert.match(indexerSource, /on conflict \(chain_id, tx_hash\)/);
  assert.match(packageSource, /worker:creator-funding-indexer/);
  assert.match(migrationSource, /create table if not exists public\.creator_funding_indexer_state/);
  assert.match(migrationSource, /create table if not exists public\.creator_funding_edges/);
  assert.match(migrationSource, /enable row level security/);
  assert.match(migrationSource, /revoke all on table public\.creator_funding_edges from anon, authenticated/);
});

test("contract sync worker uses the database terminal status", async () => {
  const source = await read("../../scripts/run-contract-sync-worker.mjs");
  assert.match(source, /markJob\(job\.id, "succeeded"/);
  assert.doesNotMatch(source, /markJob\(job\.id, "confirmed"/);
  assert.match(source, /set-wallet-cluster/);
  assert.match(source, /set-cluster-risk/);
});

test("legacy campaigns bypass only the new cluster-specific layer", async () => {
  const source = await read("./security-current-time.js");

  assert.match(source, /isLegacyProtectionInterfaceUnavailable/);
  assert.match(source, /legacyCampaign:\s*true/);
  assert.match(source, /source:\s*"legacy_campaign"/);
  assert.match(source, /nestedRevertData\(error\)/);
  assert.match(source, /if \(nestedRevertData\(error\)\) return false/);
});

test("cap accounting fails closed cleanly", async () => {
  const source = await read("./security-current-time.js");
  const connectIndex = source.indexOf("client = await pool.connect()");
  const catchIndex = source.indexOf("CREATOR_CLUSTER_CAP_CHECK_UNAVAILABLE", connectIndex);

  assert.match(source, /const RESERVATION_GRACE_SECONDS = 2 \* 60/);
  assert.ok(connectIndex >= 0, "database connection must be inside the guarded reservation path");
  assert.ok(catchIndex > connectIndex, "database failures must return a structured creator protection denial");
  assert.match(source, /client\?\.release\(\)/);
});

test("token-based routes resolve to canonical campaign contracts before trading", async () => {
  const [clientSource, pageSource] = await Promise.all([
    read("../../src/lib/launchpadClient.ts"),
    read("../../src/pages/TokenDetails.tsx"),
  ]);

  assert.match(clientSource, /export async function resolveCanonicalCampaignAddress/);
  assert.match(clientSource, /candidate\.token\(\)/);
  assert.match(clientSource, /candidate\.creator\(\)/);
  assert.match(clientSource, /fetchDbCampaigns\(chainId, 500\)/);

  for (const operation of ["buyTokens", "sellTokens"]) {
    const start = clientSource.indexOf("const " + operation + " = useCallback");
    const endMarker = operation === "buyTokens" ? "const sellTokens = useCallback" : "const finalizeCampaign = useCallback";
    const end = clientSource.indexOf(endMarker, start + 20);
    const source = clientSource.slice(start, end > start ? end : undefined);
    const resolveIndex = source.indexOf("await resolveCanonicalCampaignAddress(");
    const contractIndex = source.indexOf("new Contract(normalizedCampaign");
    const preflightIndex = source.indexOf(operation === "buyTokens" ? "fetchLaunchpadBuyPreflight" : "fetchLaunchpadSellPreflight");

    assert.ok(resolveIndex >= 0, operation + " must resolve token URLs to the campaign contract");
    assert.ok(contractIndex > resolveIndex, operation + " must resolve before constructing the write contract");
    assert.ok(preflightIndex > resolveIndex, operation + " must resolve before protection preflight");
  }

  assert.match(pageSource, /await buyTokens\(campaign\.campaign,/);
  assert.match(pageSource, /await sellTokens\(campaign\.campaign,/);
});

test("server canonicalizes token routes before preflight, cap reservation, and signing", async () => {
  const [securitySource, routeSource, clientSource] = await Promise.all([
    read("./security-current-time.js"),
    read("./route-auth.js"),
    read("../../src/lib/launchpadClient.ts"),
  ]);

  assert.match(securitySource, /export async function resolveCanonicalTradeCampaignAddress/);
  assert.match(securitySource, /public\.campaigns/);
  assert.match(securitySource, /public\.campaign_drafts/);
  assert.match(securitySource, /verifyCampaignIdentity/);
  assert.match(securitySource, /canonicalCampaignAddress:\s*campaign/);
  assert.match(securitySource, /campaignResolutionSource:\s*resolution\.source/);

  const evaluateStart = securitySource.indexOf("export async function evaluateTradePreflight");
  const evaluateEnd = securitySource.indexOf("export async function reserveCreatorClusterBuyAuthorization", evaluateStart);
  const evaluateSource = securitySource.slice(evaluateStart, evaluateEnd);
  const canonicalCampaignIndex = evaluateSource.indexOf("const campaign = resolution.campaignAddress;");
  const canonicalPreflightIndex = evaluateSource.indexOf(
    "const legacyBase = await legacySecurity.evaluateTradePreflight",
    canonicalCampaignIndex,
  );
  assert.ok(
    canonicalCampaignIndex >= 0 && canonicalPreflightIndex > canonicalCampaignIndex,
    "the valid trade path must use the resolved campaign before reading campaign state",
  );

  const tradeStart = routeSource.indexOf("export async function routingTradeAuthorization");
  const tradeSource = routeSource.slice(tradeStart);
  assert.match(tradeSource, /const canonicalCampaignAddress = normalizeAddress\(tradePreflight\.canonicalCampaignAddress\)/);
  assert.match(tradeSource, /reserveCreatorClusterBuyAuthorization\(\{[\s\S]*campaignAddress: canonicalCampaignAddress/);
  assert.match(tradeSource, /signTradeAuthorization\(\{[\s\S]*campaignAddress: canonicalCampaignAddress/);

  const resolverStart = clientSource.indexOf("export async function resolveCanonicalCampaignAddress");
  const resolverEnd = clientSource.indexOf("function isDecodeResultError", resolverStart);
  const resolverSource = clientSource.slice(resolverStart, resolverEnd);
  assert.ok(
    resolverSource.indexOf("fetchDbCampaigns(chainId, 500)") < resolverSource.indexOf("candidate.token()"),
    "frontend must prefer the canonical DB mapping before probing an arbitrary contract",
  );
  assert.match(resolverSource, /candidate\.creator\(\)/);
});

test("custom contract reverts cannot be classified as missing methods", async () => {
  const source = await read("../../src/lib/launchpadClient.ts");
  const start = source.indexOf("export function isUnsupportedContractMethod");
  const end = source.indexOf("function buildMetadataURI", start);
  assert.ok(start >= 0 && end > start, "strict method support classifier must exist");
  const classifier = source.slice(start, end);

  assert.match(classifier, /findNestedRevertData\(error\)/);
  assert.doesNotMatch(classifier, /execution reverted/);
  assert.doesNotMatch(classifier, /missing revert data/);
  assert.doesNotMatch(classifier, /invalid opcode/);
  assert.match(classifier, /function selector was not recognized/);
});

test("centered creator protection dialog is globally wired", async () => {
  const [app, api, apiBase, dialog] = await Promise.all([
    read("../../src/App.tsx"),
    read("../../src/lib/recruiterApi.ts"),
    read("../../src/lib/apiBase.ts"),
    read("../../src/components/token/CreatorProtectionDialog.tsx"),
  ]);

  assert.match(app, /<CreatorProtectionDialog\s*\/>/);
  assert.match(api, /mwz:creatorProtectionBlocked/);
  assert.match(apiBase, /notifyCreatorProtectionResponse/);
  assert.match(apiBase, /mwz:creatorProtectionBlocked/);
  assert.match(apiBase, /CREATOR_PROTECTION_DIALOG_CODES/);
  assert.match(apiBase, /CREATOR_CLUSTER_BUY_LOCKED/);
  assert.doesNotMatch(apiBase, /if \(!code\.startsWith\("CREATOR_"\)\) return;/);
  assert.match(dialog, /Creator-Linked Wallet/);
  assert.match(dialog, /Tier \$\{tierNumber\} Creator Buy Protection/);
  assert.doesNotMatch(dialog, /Switch wallet/i);
});
