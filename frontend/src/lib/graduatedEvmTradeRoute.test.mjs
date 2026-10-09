/**
 * Graduated MemeWarzone coins on BNB / Robinhood trade through the import route (founder, 2026-10-09).
 * 1. The routing decision (graduated vs bonding, switch on/off, chain) of graduatedEvmTradeRoute.mjs.
 * 2. Source pins: every in-app trade surface of a graduated EVM coin takes that decision, and the bonding-curve paths
 *    are byte-for-byte the code of the starting commit (only lines added around them).
 *   node --test src/lib/graduatedEvmTradeRoute.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRADUATED_IMPORT_ROUTE_CHAINS,
  assertGraduatedImportQuote,
  graduatedCampaignTradeItem,
  graduatedEvmTradeRoute,
  graduatedImportRouteEnabled,
} from "./graduatedEvmTradeRoute.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");
const VAULT = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const ALL_ON = {
  VITE_IMPORT_FEE_VAULT_56: VAULT,
  VITE_IMPORT_SWAP_FEE_ROUTER_56: ROUTER,
  VITE_IMPORT_SWAP_FEE_ROUTER_97: ROUTER,
  VITE_IMPORT_FEE_VAULT_4663: VAULT,
  VITE_IMPORT_SWAP_FEE_RECEIVER_4663: VAULT,
};

test("not graduated: always the bonding path, on every chain and switch state", () => {
  for (const chainId of [56, 97, 4663, 46630, 101, 1]) {
    assert.equal(graduatedEvmTradeRoute({ chainId, graduated: false }, ALL_ON), "bonding");
    assert.equal(graduatedEvmTradeRoute({ chainId, graduated: false }, {}), "bonding");
  }
});

test("switch off everywhere: graduated coins keep the direct pool trade (live unchanged)", () => {
  for (const chainId of [56, 97, 4663, 46630]) {
    assert.equal(graduatedEvmTradeRoute({ chainId, graduated: true }, {}), "direct-pool");
    assert.equal(graduatedImportRouteEnabled(chainId, {}), false);
  }
});

test("BNB 56: the import route only with an ImportFeeVault configured", () => {
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true }, { VITE_IMPORT_FEE_VAULT_56: VAULT }), "import");
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true }, { VITE_IMPORT_FEE_VAULT_56: ` ${VAULT.toUpperCase().replace("0X", "0x")} ` }), "import");
  for (const bad of ["", "0x0000000000000000000000000000000000000000", "0x123", "vault"]) {
    assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true }, { VITE_IMPORT_FEE_VAULT_56: bad }), "direct-pool", bad);
  }
  // The fee router alone (no vault) does not switch 56: the Kyber fee terms follow the vault.
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true }, { VITE_IMPORT_SWAP_FEE_ROUTER_56: ROUTER }), "direct-pool");
  // Another chain's vault does not switch 56.
  assert.equal(graduatedEvmTradeRoute({ chainId: 56, graduated: true }, { VITE_IMPORT_FEE_VAULT_4663: VAULT }), "direct-pool");
});

test("BNB testnet 97: the import route only with the ImportSwapFeeRouter configured", () => {
  assert.equal(graduatedEvmTradeRoute({ chainId: 97, graduated: true }, { VITE_IMPORT_SWAP_FEE_ROUTER_97: ROUTER }), "import");
  assert.equal(graduatedEvmTradeRoute({ chainId: 97, graduated: true }, { VITE_IMPORT_SWAP_FEE_ROUTER_56: ROUTER }), "direct-pool");
  assert.equal(graduatedEvmTradeRoute({ chainId: 97, graduated: true }, { VITE_IMPORT_SWAP_FEE_ROUTER_97: "0x0000000000000000000000000000000000000000" }), "direct-pool");
});

test("Robinhood 4663: the import route only while the Universal Router terms are the split (vault = receiver)", () => {
  assert.equal(graduatedEvmTradeRoute({ chainId: 4663, graduated: true }, { VITE_IMPORT_FEE_VAULT_4663: VAULT, VITE_IMPORT_SWAP_FEE_RECEIVER_4663: VAULT }), "import");
  assert.equal(graduatedEvmTradeRoute({ chainId: 4663, graduated: true }, { IMPORT_FEE_VAULT_4663: VAULT, IMPORT_SWAP_FEE_RECEIVER_4663: VAULT }), "import");
  // Vault set but the receiver still the old ProtocolRevenueVault: the 0.5% protocol-only terms, so not for graduates.
  assert.equal(graduatedEvmTradeRoute({ chainId: 4663, graduated: true }, { VITE_IMPORT_FEE_VAULT_4663: VAULT, VITE_IMPORT_SWAP_FEE_RECEIVER_4663: OTHER }), "direct-pool");
  assert.equal(graduatedEvmTradeRoute({ chainId: 4663, graduated: true }, { VITE_IMPORT_FEE_VAULT_4663: VAULT }), "direct-pool");
});

test("Robinhood testnet 46630 and other chains never take the import route (no fee-taking route there)", () => {
  for (const chainId of [46630, 101, 1, 8453]) {
    assert.equal(graduatedEvmTradeRoute({ chainId, graduated: true }, ALL_ON), "direct-pool");
  }
  assert.deepEqual([...GRADUATED_IMPORT_ROUTE_CHAINS], [56, 97, 4663]);
  for (const chainId of GRADUATED_IMPORT_ROUTE_CHAINS) assert.equal(graduatedEvmTradeRoute({ chainId, graduated: true }, ALL_ON), "import");
});

test("a graduated coin trades only on a quote with the creator's half; the old 0.5% protocol-only quote is refused", () => {
  assert.equal(assertGraduatedImportQuote({ feeBps: 100, creatorShareBps: 50 }).feeBps, 100);
  for (const quote of [{ feeBps: 50, creatorShareBps: 0 }, { feeBps: 50 }, { feeBps: 0, creatorShareBps: 0 }, { feeBps: 100, creatorShareBps: 101 }, null, {}]) {
    assert.throws(() => assertGraduatedImportQuote(quote), (error) => error.code === "GRADUATED_IMPORT_FEE_OFF");
  }
});

test("campaign -> ImportedTradePanel item", () => {
  const item = graduatedCampaignTradeItem({ campaign: "0xAbC0000000000000000000000000000000000001", token: OTHER, creator: VAULT, name: "Coin", symbol: "CN", logoURI: "x.png" }, 56);
  assert.deepEqual(item, {
    id: "campaign:56:0xabc0000000000000000000000000000000000001",
    chainId: 56,
    tokenAddress: OTHER,
    ownerWallet: VAULT,
    name: "Coin",
    symbol: "CN",
    imageUrl: "x.png",
    status: "passed",
  });
});

test("the BNB import API takes any BNB token: no import admission check that would refuse a MemeWarzone coin", () => {
  const api = src("../api/importSwap.js");
  assert.doesNotMatch(api, /arena_token_imports|campaign_market_state|from public\.campaigns/);
  assert.match(api, /} else if \(chainId === 56\) \{\n\s+if \(!isEvmAddress\(token\)\) throw/);
});

test("every graduated EVM trade surface takes the routing decision", () => {
  const panel = src("components/arena/ImportedTradePanel.tsx");
  assert.match(panel, /graduated = false,/);
  assert.match(panel, /\.then\(checkQuote\)/);
  assert.match(panel, /checkQuote\(await quoteImportSwap\(\{ chainId: 56,/);
  assert.match(panel, /checkQuote\(await quoteImportSwap4663\(/);
  assert.match(panel, /checkQuote\(await quoteFeeRouterTrade\(/);
  assert.match(panel, /if \(graduated && !graduatedImportRouteEnabled\(item\.chainId\)\) throw/);
  assert.match(panel, /if \(graduated\) throw new Error\("Swaps for this coin are paused/);

  const warRoom = src("components/postgrad/WarRoomTradePanel.tsx");
  assert.match(warRoom, /const graduatedImport = !isSolanaCampaign && isDexStage && graduatedImportRouteEnabled\(chainId\);/);
  assert.match(warRoom, /if \(isDexStage\) \{\n\s+\/\/ Never the fee-free pool trade[^\n]*\n\s+if \(graduatedImport\) return;/);
  assert.match(warRoom, /if \(graduatedImport\) return <ImportedTradePanel item=\{graduatedCampaignTradeItem\(campaign, chainId\)\} graduated \/>;\n\n  return \(/);

  const rh = src("components/postgrad/RobinhoodWarRoomTradePanel.tsx");
  assert.match(rh, /export function RobinhoodWarRoomTradePanel\(\{ campaign \}: \{ campaign: CampaignInfo \}\) \{\n  const chainId = useMemo/);
  assert.match(rh, /if \(route === "import"\) return <ImportedTradePanel item=\{graduatedCampaignTradeItem\(campaign, chainId\)\} graduated \/>;/);
  assert.match(rh, /return <RobinhoodWarRoomDirectTradePanel campaign=\{campaign\} \/>;/);
  assert.match(rh, /function RobinhoodWarRoomDirectTradePanel\(\{ campaign \}: \{ campaign: CampaignInfo \}\) \{\n  const \{ toast \} = useToast\(\);/);

  const page = src("pages/TokenDetails.tsx");
  assert.match(page, /const bnbGraduatedImportTrade = !isSolanaPage && !isRobinhoodPage && isDexStage && graduatedImportRouteEnabled\(chainIdForStorage\);/);
  assert.match(page, /if \(isDexStage\) \{\n\s+\/\/ Never the fee-free Topaz trade[^\n]*\n\s+if \(bnbGraduatedImportTrade\) return;/);
  assert.match(page, /\) : bnbGraduatedImportTrade \? \(\n\s+isXlUp \? \(\n\s+<section aria-label="Trade"[^\n]*data-graduated-import-trade="true">\n\s+<ImportedTradePanel item=\{graduatedImportItem\} graduated/);
  assert.match(page, /open=\{mobileTradeOpen && !rhGraduatedTrade && !bnbGraduatedImportTrade( && !solanaGraduatedImportTrade)?\}/);
  assert.equal((page.match(/<RobinhoodWarRoomTradePanel campaign=\{campaign as CampaignInfo\} \/>/g) || []).length, 2);

  // War room rows: BNB rows render WarRoomTradePanel, Robinhood graduated rows RobinhoodWarRoomTradePanel (both routed above).
  const row = src("components/postgrad/WarRoomCampaignRow.tsx");
  assert.match(row, /<RobinhoodWarRoomTradePanel campaign=\{campaign\} \/>/);
  assert.match(row, /<WarRoomTradePanel campaign=\{campaign\} \/>/);
});

/** The file at the starting commit, or null without git history (then the pins below skip). */
const BASE = "3a10c6bf";
/** The live branch head feat/evm-import-fee-split starts from (build/cross-chain-stabilization-rh-base, PR #555). */
const LIVE_BASE = "cedff5be";
function baseFile(rel, commit = BASE) {
  try {
    return execFileSync("git", ["show", `${commit}:frontend/src/${rel}`], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Every line of `before` is still in `after`, in order (lines may only have been added), except `changed`. */
function onlyAdded(before, after, changed = []) {
  const want = before.split("\n").filter((line) => !changed.includes(line));
  const have = after.split("\n");
  let at = 0;
  const missing = [];
  for (const line of want) {
    const next = have.indexOf(line, at);
    if (next < 0) missing.push(line);
    else at = next + 1;
  }
  return missing;
}

test("bonding and direct-pool code is the starting commit's, untouched", (t) => {
  if (!baseFile("lib/topazV2Trade.ts") || !baseFile("lib/topazV2Trade.ts", LIVE_BASE)) return t.skip("no git history");
  // The direct pool trade libraries and the curve trade code are not edited at all.
  // On the live branch (feat/evm-import-fee-split) the curve and pool libraries are the live head's, unchanged.
  for (const rel of ["lib/topazV2Trade.ts", "lib/robinhoodV3Trade.ts", "lib/arenaImportedTopaz.ts", "lib/arenaImportedRobinhood.ts", "lib/evmGasHeadroom.mjs", "lib/tradeBalanceReserve.ts"]) {
    assert.equal(src(rel), baseFile(rel, LIVE_BASE), rel);
  }
  // The import route libraries are the import fee change's (CI2-CI4), not edited by the graduated route.
  for (const rel of ["lib/importSwapFeeRouter.mjs", "lib/robinhoodImportSwap.mjs", "lib/importSwap.ts"]) {
    assert.equal(src(rel), baseFile(rel), rel);
  }
  // The trade panels and the token page only gained lines; the one replaced line is the mobile sheet's open flag.
  assert.deepEqual(onlyAdded(baseFile("components/postgrad/WarRoomTradePanel.tsx", LIVE_BASE), src("components/postgrad/WarRoomTradePanel.tsx")), []);
  assert.deepEqual(onlyAdded(baseFile("components/postgrad/RobinhoodWarRoomTradePanel.tsx", LIVE_BASE), src("components/postgrad/RobinhoodWarRoomTradePanel.tsx")), []);
  assert.deepEqual(
    // Against the live head (which already has the Solana graduated branch): the one replaced line is the mobile
    // sheet's open flag, which gained !bnbGraduatedImportTrade.
    onlyAdded(baseFile("pages/TokenDetails.tsx", LIVE_BASE), src("pages/TokenDetails.tsx"), [
      "          open={mobileTradeOpen && !rhGraduatedTrade && !solanaGraduatedImportTrade}",
    ]),
    [],
  );
  // The curve calls with their gas headroom, verbatim.
  const warRoom = src("components/postgrad/WarRoomTradePanel.tsx");
  for (const line of [
    "const buyGas = await gasWithHeadroom(() => campaignWrite.buyExactTokensAuthorized.estimateGas(...buyArgs, { value: maxCostWei }), LEGACY_TRADE_GAS_LIMIT);",
    "tx = await campaignWrite.buyExactTokens(amountWei, maxCostWei, overrides);",
    "const sellGas = await gasWithHeadroom(() => campaignWrite.sellExactTokensAuthorized.estimateGas(...sellArgs, {}), LEGACY_TRADE_GAS_LIMIT);",
    "tx = await campaignWrite.sellExactTokens(amountWei, minPayoutWei, overrides);",
  ]) assert.ok(warRoom.includes(line), line);
});
