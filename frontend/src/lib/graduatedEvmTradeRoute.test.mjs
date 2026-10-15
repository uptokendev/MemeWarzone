/**
 * Graduated MemeWarzone coins on BNB / Robinhood trade through the import route (founder, 2026-10-09).
 * 1. The routing decision (graduated vs bonding, switch on/off, chain) of graduatedEvmTradeRoute.mjs.
 * 2. Source pins: every in-app trade surface of a graduated EVM coin takes that decision, and the bonding-curve paths
 *    are byte-for-byte the code of the starting commit (only lines added around them), line endings ignored, except
 *    upstream's own later commits (re-pinned) and the reviewed DogeOS hunks (DOGEOS_REVIEWED below) that are still in
 *    place (the gen-7/MuchFi trade gate was removed again: B8_REMOVED below).
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
/**
 * Upstream's own later edits, accepted by re-pinning to the upstream commit that made them (both are on
 * release/evm-gen8, merged into feat/dogeos-testnet as 126ffbc8b):
 * - 9fd750fb2 "fix(robinhood): gas price headroom ..." changed lib/evmGasHeadroom.mjs after LIVE_BASE.
 * - 594a9e585 "fix(gen8): refresh chain reads on a trade ..." is the last upstream (gen-8 / live) commit on
 *   pages/TokenDetails.tsx; gen-8 reworked the page, so the LIVE_BASE pin no longer applies there.
 */
const GAS_HEADROOM_PIN = "9fd750fb2";
const TOKEN_PAGE_PIN = "594a9e585";
/**
 * The reviewed DogeOS (6281971) commits per file (plan t12 / t13). Every line a file lost or gained since its pin must
 * be a line one of these commits itself removed or added in that file; anything else is an unreviewed edit and fails.
 */
const DOGEOS_REVIEWED = {
  "lib/tradeBalanceReserve.ts": ["0d2eb7938"],
  "components/postgrad/RobinhoodWarRoomTradePanel.tsx": ["50f618a50", "0d2eb7938"],
  "pages/TokenDetails.tsx": ["f0b60bc36", "054c6b63f", "79bdad1a6", "0d2eb7938"],
};
/**
 * A reviewed DogeOS line the release/evm-gen8 merge (126ffbc8b) re-applied onto a line gen-8 had reshaped: `was` is
 * gen-8's line it replaced, `reviewed` the line the DogeOS commit added, `now` the merged line. TokenDetails:
 * f0b60bc36's DogeOS venue label ("to MuchFi") on gen-8's progress text, which now sits under
 * `curveProgress.known ?` and so starts with "?" instead of ":" and lost its closing "}".
 */
const MERGE_REAPPLIED = {
  "pages/TokenDetails.tsx": [
    {
      was: '? `${curveProgress.pct > 0 && curveProgress.pct < 0.01 ? curveProgress.pct.toFixed(6) : curveProgress.pct.toFixed(2)}% · graduates ${isSolanaPage ? "to Meteora" : isRobinhoodPage ? "to Uniswap" : "to Topaz"} at 100%`',
      reviewed: ': `${curveProgress.pct > 0 && curveProgress.pct < 0.01 ? curveProgress.pct.toFixed(6) : curveProgress.pct.toFixed(2)}% · graduates ${isSolanaPage ? "to Meteora" : isRobinhoodPage ? "to Uniswap" : isDogeosPage ? `to ${DOGEOS_DEX_LABEL}` : "to Topaz"} at 100%`}',
      now: '? `${curveProgress.pct > 0 && curveProgress.pct < 0.01 ? curveProgress.pct.toFixed(6) : curveProgress.pct.toFixed(2)}% · graduates ${isSolanaPage ? "to Meteora" : isRobinhoodPage ? "to Uniswap" : isDogeosPage ? `to ${DOGEOS_DEX_LABEL}` : "to Topaz"} at 100%`',
    },
  ],
};
/**
 * Reviewed DogeOS lines taken out again by plan t12 and t33 (spec section 4 "Removed (B8)": the gen-7/MuchFi trade path).
 * TokenDetails: 79bdad1a6's and 0d2eb7938's isV3GraduatedTradePage gate; every site it replaced is back to
 * isRobinhoodPage, i.e. the pin's own line. Each entry must be a line a reviewed commit added (a stale entry fails)
 * and must be gone from the file (the gate cannot come back unreviewed). Only these lines leave the "lost" check;
 * the same commits' kept lines (the DOGE buy gas reserve) stay checked.
 */
const B8_REMOVED = {
  "pages/TokenDetails.tsx": [
    "// Graduated-trade surfaces only: DogeOS graduates into MuchFi (V3) and trades through the Robinhood V3 panel,",
    "// never the Topaz/BNB V2 box. Text and price branches keep isRobinhoodPage / isDogeosPage.",
    "const isV3GraduatedTradePage = isRobinhoodPage || isDogeosPage;",
    "const isTopazTradingActive = isSolanaPage || isV3GraduatedTradePage",
    "isV3GraduatedTradePage &&",
    "const rhGraduatedTrade = isV3GraduatedTradePage && (contractGraduated || isUniswapTradingActive);",
    "const bnbGraduatedImportTrade = !isSolanaPage && !isV3GraduatedTradePage && isDexStage && graduatedImportRouteEnabled(chainIdForStorage);",
    ") : isV3GraduatedTradePage && (contractGraduated || isUniswapTradingActive) ? (",
    "enabled: hasValidCampaignAddress && contractGraduatedEarly && !isSolanaPage && !isV3GraduatedTradePage,",
    "// indexed DEX price, which is the post-swap pool spot. DogeOS (MuchFi V3) graduates the same way.",
    "if (isV3GraduatedTradePage && contractGraduatedEarly) {",
    "isV3GraduatedTradePage,",
    "if (isV3GraduatedTradePage && unifiedNative) {",
    'if (isV3GraduatedTradePage && isDexStage) return "—";',
  ],
  // Plan t33: the Robinhood panel no longer trades DogeOS as a MuchFi V3 coin. It keeps 6281971's own id only to
  // refuse it (an added line), so the direct panel's network and venue names are Robinhood's constants again and the
  // MuchFi wording and DOGEOS_DEX_LABEL import are gone. The chain-aware native symbol and gas reserve stay checked.
  "components/postgrad/RobinhoodWarRoomTradePanel.tsx": [
    'import { DOGEOS_DEX_LABEL } from "@/lib/dogeosPresentation.mjs";',
    "// DogeOS keeps its own chain (MuchFi market); only an unknown id falls back to Robinhood testnet.",
    "// Robinhood: ETH on Robinhood V3. DogeOS: DOGE on MuchFi. Same V3 trade path underneath.",
    'const networkName = isDogeosChainId(chainId) ? "DogeOS" : "Robinhood";',
    'const venueLabel = isDogeosChainId(chainId) ? DOGEOS_DEX_LABEL : "Robinhood V3";',
  ],
};
const REPO_ROOT = path.resolve(here, "..", "..", "..");
function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}
function baseFile(rel, commit = BASE) {
  try {
    return git(["show", `${commit}:frontend/src/${rel}`]);
  } catch {
    return null;
  }
}
/**
 * LF line endings. Git blobs are LF; a Windows checkout (core.autocrlf=true) has CRLF in some files, which failed the
 * byte pins on line endings alone and hid real pin violations behind them. The pins compare code, not line endings.
 */
const lf = (text) => (text == null ? text : text.replace(/\r\n/g, "\n"));

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

/** Removed and added lines of a one-file `-U0` diff, trimmed (a hunk re-indented by the merge stays the same hunk). */
function diffLines(diff) {
  const removed = [];
  const added = [];
  let inHunk = false;
  for (const line of lf(diff).split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("-")) removed.push(line.slice(1).trim());
    else if (inHunk && line.startsWith("+")) added.push(line.slice(1).trim());
  }
  return { removed, added };
}

/**
 * How `rel` (working tree, line endings ignored) differs from `pin` beyond its reviewed DogeOS commits:
 * - removed: lines it lost since the pin that no reviewed commit removed;
 * - added: lines it gained since the pin that no reviewed commit added;
 * - lost: lines the reviewed commits added (and did not remove again) that are no longer in the file, so a reviewed
 *   replacement cannot be swapped for something else.
 * All empty = every change since the pin is a reviewed DogeOS hunk, still in place. Lines compare trimmed and as a set
 * (a re-indented hunk is the same hunk). A reviewed commit that does not touch `rel` contributes nothing, so a wrong
 * hash only makes the check stricter.
 */
function unreviewedSince(pin, rel) {
  const file = `frontend/src/${rel}`;
  const now = diffLines(git(["diff", "--no-color", "--no-ext-diff", "-U0", "--ignore-cr-at-eol", pin, "--", file]));
  const reviewed = { removed: new Set(), added: new Set() };
  for (const commit of DOGEOS_REVIEWED[rel]) {
    assert.match(git(["log", "-1", "--format=%s", commit]), /^(feat|fix)\(dogeos\): /, `${commit} is not a DogeOS commit`);
    const own = diffLines(git(["show", "--no-color", "--no-ext-diff", "-U0", "--format=", commit, "--", file]));
    for (const line of own.removed) reviewed.removed.add(line);
    for (const line of own.added) reviewed.added.add(line);
  }
  for (const { was, reviewed: line, now: merged } of MERGE_REAPPLIED[rel] || []) {
    assert.ok(reviewed.added.has(line), `${rel}: MERGE_REAPPLIED names a line no reviewed commit added: ${line}`);
    reviewed.removed.add(was);
    reviewed.added.delete(line);
    reviewed.added.add(merged);
  }
  const have = new Set(lf(src(rel)).split("\n").map((line) => line.trim()));
  for (const line of B8_REMOVED[rel] || []) {
    assert.ok(reviewed.added.has(line), `${rel}: B8_REMOVED names a line no reviewed commit added: ${line}`);
    assert.ok(!have.has(line), `${rel}: a B8-removed gen-7/MuchFi line is back: ${line}`);
    reviewed.added.delete(line);
  }
  return {
    removed: now.removed.filter((line) => !reviewed.removed.has(line)),
    added: now.added.filter((line) => !reviewed.added.has(line)),
    lost: [...reviewed.added].filter((line) => !reviewed.removed.has(line) && !have.has(line)),
  };
}

test("bonding and direct-pool code is the starting commit's, untouched", (t) => {
  if (!baseFile("lib/topazV2Trade.ts") || !baseFile("lib/topazV2Trade.ts", LIVE_BASE)) return t.skip("no git history");
  // The direct pool trade libraries and the curve trade code are not edited at all.
  // On the live branch (feat/evm-import-fee-split) the curve and pool libraries are the live head's, unchanged.
  for (const rel of ["lib/topazV2Trade.ts", "lib/arenaImportedTopaz.ts"]) {
    assert.equal(lf(src(rel)), baseFile(rel, LIVE_BASE), rel);
  }
  // Robinhood gas headroom: exactly upstream's own change (9fd750fb2), nothing since.
  assert.equal(lf(src("lib/evmGasHeadroom.mjs")), baseFile("lib/evmGasHeadroom.mjs", GAS_HEADROOM_PIN), "lib/evmGasHeadroom.mjs");
  // Merged with build/evm-gen7 (release/evm-gen7-live): these three carry gen-7's own edits (the env-selected
  // RobinhoodV3NativeSwapAdapterV2, the gen-7 launch gas reserve) and are exactly gen-7's at the starting commit,
  // except the reviewed DogeOS 0.01 DOGE buy reserve in tradeBalanceReserve.ts. The Robinhood V3 trade library is
  // the starting commit's again: the MuchFi V3 trade branch (isV3TradeChainId, DogeOS-only env names, fee 10000)
  // was removed by plan t12 (spec section 4 "Removed (B8)"). No other line of either file may differ.
  for (const rel of ["lib/arenaImportedRobinhood.ts", "lib/robinhoodV3Trade.ts"]) {
    assert.equal(lf(src(rel)), baseFile(rel), rel);
  }
  assert.deepEqual(
    unreviewedSince(BASE, "lib/tradeBalanceReserve.ts"),
    { removed: [], added: [], lost: [] },
    "lib/tradeBalanceReserve.ts: changed outside the reviewed DogeOS hunks",
  );
  // The import route libraries are the import fee change's (CI2-CI4), not edited by the graduated route.
  for (const rel of ["lib/importSwapFeeRouter.mjs", "lib/robinhoodImportSwap.mjs", "lib/importSwap.ts"]) {
    assert.equal(lf(src(rel)), baseFile(rel), rel);
  }
  // The trade panels and the token page only gained lines. The only lines they lost are reviewed DogeOS replacements
  // (the Robinhood panel's ETH / "Robinhood" text and gas reserve became chain-aware; the token page's labels became
  // chain helpers and its buy gas reserve chain-aware; its graduated-trade gates are isRobinhoodPage again, B8_REMOVED
  // above). The token page is pinned to upstream's gen-8 version (TOKEN_PAGE_PIN), so its old LIVE_BASE exceptions
  // (mobile sheet open flag, gen-7 spot) are upstream's.
  const warRoomPanel = "components/postgrad/WarRoomTradePanel.tsx";
  assert.deepEqual(onlyAdded(baseFile(warRoomPanel, LIVE_BASE), lf(src(warRoomPanel))), []);
  // Added lines stay free there (as before), but a reviewed DogeOS replacement must still be in place (lost).
  for (const [pin, rel] of [[LIVE_BASE, "components/postgrad/RobinhoodWarRoomTradePanel.tsx"], [TOKEN_PAGE_PIN, "pages/TokenDetails.tsx"]]) {
    const { removed, lost } = unreviewedSince(pin, rel);
    assert.deepEqual({ removed, lost }, { removed: [], lost: [] }, `${rel}: lost lines outside the reviewed DogeOS hunks`);
  }
  // The curve calls with their gas headroom, verbatim.
  const warRoom = src("components/postgrad/WarRoomTradePanel.tsx");
  for (const line of [
    "const buyGas = await gasWithHeadroom(() => campaignWrite.buyExactTokensAuthorized.estimateGas(...buyArgs, { value: maxCostWei }), LEGACY_TRADE_GAS_LIMIT);",
    "tx = await campaignWrite.buyExactTokens(amountWei, maxCostWei, overrides);",
    "const sellGas = await gasWithHeadroom(() => campaignWrite.sellExactTokensAuthorized.estimateGas(...sellArgs, {}), LEGACY_TRADE_GAS_LIMIT);",
    "tx = await campaignWrite.sellExactTokens(amountWei, minPayoutWei, overrides);",
  ]) assert.ok(warRoom.includes(line), line);
});
