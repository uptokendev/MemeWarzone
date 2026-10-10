// DogeOS chain-list guard (plan t23, spec section 6).
//
// The chain lists stay hand-kept, so this test reads the tree: every non-test, non-comment line in
// the app, API, indexer, migrations and scripts/lib that names 46630 must also carry DogeOS
// (6281971 or a DogeOS chain-id reference) on the same line or within 3 lines, or be listed in
// scripts/dogeos-chain-list-exceptions.json. Launch-path checks that name Robinhood through a helper
// instead of the literal are pinned by INDIRECT_LAUNCH_PATH_CHECKS below.
//
// Run: node --test scripts/dogeos-chain-list-guard.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_PATHS = [
  "frontend/src",
  "frontend/api",
  "frontend/scripts",
  "frontend/shared",
  "realtime-indexer/src",
  "db/migrations",
  "scripts/lib",
];
const WINDOW = 3;
const RH_TESTNET = /(?<!\d)46630(?!\d)/;
/** A DogeOS chain reference: the literal, an isDogeos* helper, or a DOGEOS_*CHAIN_ID constant. */
const DOGEOS_REF = /(?<!\d)6281971(?!\d)|\bisDogeos\w*|\bDOGEOS_\w*CHAIN_ID\b/;

const EXCEPTIONS_PATH = "scripts/dogeos-chain-list-exceptions.json";

/**
 * Robinhood-family checks on the launch path (and chain identity) that do not use the literal 46630,
 * from the t10-t21 commits. Every code line containing `anchor` must have a DogeOS reference within
 * `window` lines (0 = the gate itself names DogeOS; otherwise the distance to its own DogeOS
 * branch, kept tight so removing that branch fails). `isRobinhoodChainId` / ROBINHOOD_CHAIN_IDS
 * never gain 6281971 (global constraint), so each of these sites carries its own DogeOS branch.
 */
const INDIRECT_LAUNCH_PATH_CHECKS = [
  // t13 launch path: gen-7 + V3 graduation family
  { file: "frontend/src/lib/launchpadClient.ts", anchor: "productChain === ROBINHOOD_TESTNET_CHAIN_ID", window: 0, why: "EVM fallback read chain" },
  { file: "frontend/src/lib/launchpadClient.ts", anchor: "evmReadChainId === ROBINHOOD_TESTNET_CHAIN_ID", window: 0, why: "USD graduation-target read" },
  { file: "frontend/src/lib/launchpadClient.ts", anchor: "const isRobinhoodBuy =", window: 0, why: "V3-family buy path" },
  { file: "frontend/src/features/launchpad/robinhoodAdapter.ts", anchor: "if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return chainId;", window: 2, why: "adapter chain id, never the 46630 default" },
  { file: "frontend/src/features/launchpad/useLaunchpadAdapter.ts", anchor: "if (chainId === 4663 || chainId === 46630) return \"robinhood\";", window: 2, why: "adapter selection" },
  { file: "frontend/src/pages/Create.tsx", anchor: "const robinhoodSelected = isRobinhoodChain(", window: 0, why: "create page launch family" },
  { file: "frontend/src/components/create/EvmGen6LaunchOptions.tsx", anchor: "const isRobinhood = isRobinhoodChainId(", window: 0, why: "launch options and gas reserve" },
  { file: "frontend/src/lib/lpFeeHarvest.ts", anchor: "return isRobinhoodChainId(chainId)", window: 0, why: "V3 locker harvest" },
  { file: "frontend/src/lib/robinhoodV3Trade.ts", anchor: "return isRobinhoodChainId(chainId) ||", window: 0, why: "post-graduation V3 trade gate" },
  { file: "frontend/src/pages/TokenDetailsLiveEntry.tsx", anchor: "return isRobinhoodChainId(chainId) ||", window: 0, why: "V3-family token page entry" },
  { file: "frontend/src/pages/TokenDetails.tsx", anchor: "const isRobinhoodPage = isRobinhoodChainId(chainIdForStorage);", window: 2, why: "graduated V3 trade box gate" },
  { file: "frontend/src/lib/tradeBalanceReserve.ts", anchor: "evmBuyGasReserveWei(isRobinhoodChainId(chainId))", window: 1, why: "buy gas reserve" },
  { file: "frontend/src/components/postgrad/RobinhoodWarRoomTradePanel.tsx", anchor: "id === ROBINHOOD_TESTNET_CHAIN_ID ||", window: 0, why: "War Room panel never defaults DogeOS to 46630" },
  { file: "frontend/src/components/postgrad/WarRoomCampaignRow.tsx", anchor: "const isRobinhoodRow =", window: 0, why: "War Room V3 row" },
  // t16 route authorization
  { file: "frontend/api/dev-fix/routeAuthorizationSigner.js", anchor: "[ROBINHOOD_TESTNET_CHAIN_ID, [[4, 3], [6, 5], [7, 6]]]", window: 3, why: "generation pairs" },
  // t14 / t15 API symbol, price and V3 locker
  { file: "frontend/api/lib/chainNative.js", anchor: "if (isRobinhoodChainId(id)) return \"ETH\";", window: 1, why: "nativeSymbolFor" },
  { file: "frontend/api/lib/arenaMarketSnapshot.js", anchor: "if (isRobinhoodChainId(chainId)) return resolveEthUsdPrice();", window: 1, why: "native USD price, no BNB fallthrough" },
  { file: "frontend/api/dashboard/lp-fees.js", anchor: "return isRobinhoodChain(chainId) ||", window: 0, why: "V3 locker fee path" },
  { file: "frontend/api/dev-fix/airdrop-preview.js", anchor: "const robinhood = isRobinhood(chainId);", window: 1, why: "airdrop symbol, no BNB fallthrough" },
  // t10 / t12 chain identity
  { file: "frontend/src/lib/chainConfig.ts", anchor: "if (isRobinhoodChainId(chainId)) return \"ETH\";", window: 1, why: "getNativeSymbol" },
  { file: "frontend/src/lib/chainConfig.ts", anchor: "if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) return \"https://explorer.testnet.chain.robinhood.com/tx/\";", window: 2, why: "getExplorerTxBase" },
  { file: "frontend/src/hooks/useNativeUsdPrice.ts", anchor: "if (isRobinhoodChainId(id)) return \"eth\";", window: 1, why: "native USD price hook" },
  // t11 feed isolation and chain selection
  { file: "frontend/src/lib/feedChainConfig.ts", anchor: "selected === ROBINHOOD_TESTNET_CHAIN_ID && isAllowedChainId(ROBINHOOD_TESTNET_CHAIN_ID)", window: 3, why: "isolated feed list" },
  { file: "frontend/src/lib/feedChainConfig.ts", anchor: "active === ROBINHOOD_TESTNET_CHAIN_ID ||", window: 0, why: "explicit selection beats the dev fallback" },
  { file: "frontend/src/components/common/ChainFeedSwitch.tsx", anchor: "if (chainId === ROBINHOOD_TESTNET_CHAIN_ID && isAllowedChainId(ROBINHOOD_TESTNET_CHAIN_ID))", window: 1, why: "chain switch" },
  { file: "frontend/src/components/home/DraftCampaignGrid.tsx", anchor: "if (selectedChainId === ROBINHOOD_TESTNET_CHAIN_ID) return [ROBINHOOD_TESTNET_CHAIN_ID];", window: 1, why: "draft grid isolation" },
  { file: "frontend/src/lib/searchClient.ts", anchor: "ROBINHOOD_TESTNET_CHAIN_ID, DOGEOS_TESTNET_CHAIN_ID]", window: 0, why: "search chains" },
];

function isTestPath(file) {
  return /\.(test|spec)\.[^/]+$/.test(file) || /\.test\.register\./.test(file) || /(^|\/)(tests?|__tests__)\//.test(file);
}

/**
 * The code part of each line: whole-line comments become "", trailing line comments and inline
 * block comments are removed. A block comment counts only when its line starts with "/*" (so a
 * glob such as "src/**" inside a string never blanks the rest of a file).
 */
function codeLines(text, file) {
  const sql = file.endsWith(".sql");
  const out = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (inBlock) {
      out.push("");
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      out.push("");
      if (!trimmed.slice(2).includes("*/")) inBlock = true;
      continue;
    }
    if (sql) {
      out.push(raw.replace(/--.*$/, "").replace(/\/\*.*?\*\//g, ""));
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      out.push("");
      continue;
    }
    out.push(raw.replace(/\/\*.*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/, "$1"));
  }
  return out;
}

const fileCache = new Map();
function readTracked(file) {
  if (!fileCache.has(file)) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    fileCache.set(file, { raw: text.split(/\r?\n/), code: codeLines(text, file) });
  }
  return fileCache.get(file);
}

function hasDogeosNear(code, lineNo, window = WINDOW) {
  for (let i = Math.max(1, lineNo - window); i <= Math.min(code.length, lineNo + window); i += 1) {
    if (DOGEOS_REF.test(code[i - 1])) return true;
  }
  return false;
}

/** Every in-scope 46630 code line, with whether rule (a) covers it. */
function scanHits() {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-n", "-I", "-e", "46630", "--", ...SCAN_PATHS], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status !== 1) throw error; // 1 = no match
  }
  const hits = [];
  for (const row of out.split(/\r?\n/)) {
    const match = /^(.+?):(\d+):/.exec(row);
    if (!match) continue;
    const [, file, n] = match;
    if (isTestPath(file)) continue;
    const lineNo = Number(n);
    const { raw, code } = readTracked(file);
    if (!RH_TESTNET.test(code[lineNo - 1] ?? "")) continue; // comment-only mention
    hits.push({ file, lineNo, text: raw[lineNo - 1].trim(), covered: hasDogeosNear(code, lineNo) });
  }
  return hits;
}

function loadExceptions() {
  return JSON.parse(readFileSync(resolve(ROOT, EXCEPTIONS_PATH), "utf8"));
}

const where = (hit) => `${hit.file}:${hit.lineNo}: ${hit.text}`;

function resolveHits(hits, config) {
  const used = new Set();
  const failures = [];
  for (const hit of hits) {
    if (hit.covered) continue;
    const exception = config.exceptions.find((e) => e.file === hit.file && hit.text.includes(e.pattern));
    if (exception) {
      used.add(exception);
      continue;
    }
    const sibling = config.dogeosSiblings.find((e) => e.file === hit.file && hit.text.includes(e.pattern));
    if (sibling) {
      used.add(sibling);
      continue;
    }
    failures.push(where(hit));
  }
  return { used, failures };
}

test("comment stripping and test-path filter behave as the scan expects", () => {
  const ts = codeLines(
    [
      "const A = [56, 46630]; // trailing 6281971",
      "// 46630 whole-line comment",
      "/**",
      " * 46630 in a doc block",
      " */",
      "const url = \"https://rpc.example\"; const B = 46630;",
      "const glob = \"src/**/*.ts\"; const C = 46630;",
    ].join("\n"),
    "x.ts",
  );
  assert.equal(ts[0].includes("46630"), true);
  assert.equal(ts[0].includes("6281971"), false, "a trailing comment must not count as DogeOS");
  assert.deepEqual(ts.slice(1, 5), ["", "", "", ""]);
  assert.equal(ts[5].includes("46630"), true, "'://' is not a comment");
  assert.equal(ts[6].includes("46630"), true, "a glob in a string must not open a block comment");
  const sql = codeLines("-- 46630 note\ncheck (chain_id in (4663, 46630)) -- 6281971", "x.sql");
  assert.equal(sql[0], "");
  assert.equal(sql[1].includes("6281971"), false);
  assert.equal(isTestPath("frontend/src/lib/a.test.mjs"), true);
  assert.equal(isTestPath("realtime-indexer/src/tests/a.ts"), true);
  assert.equal(isTestPath("frontend/api/campaigns/upsert.test.register.mjs"), true);
  assert.equal(isTestPath("frontend/src/lib/chainConfig.ts"), false);
  assert.equal(DOGEOS_REF.test("x === 62819710"), false);
  assert.equal(DOGEOS_REF.test("if (isDogeosChainId(id))"), true);
  assert.equal(DOGEOS_REF.test("chainId === DOGEOS_TESTNET_CHAIN_ID"), true);
});

test("every hand-kept 46630 site carries 6281971 or a named exception", () => {
  const hits = scanHits();
  assert.ok(hits.length > 100, `scan found only ${hits.length} 46630 sites; the git grep scope is broken`);
  assert.ok(hits.some((hit) => hit.covered), "no 46630 site carries 6281971; the coverage rule is broken");
  const { failures } = resolveHits(hits, loadExceptions());
  assert.deepEqual(
    failures,
    [],
    `46630 sites without 6281971 within ${WINDOW} lines and without an entry in ${EXCEPTIONS_PATH}:\n  ${failures.join("\n  ")}`,
  );
});

test("exceptions file: every entry names a global-constraint category and a reason", () => {
  const config = loadExceptions();
  const categories = Object.keys(config.categories);
  for (const name of [
    "indexer-active-or-mainnet-only",
    "stock-quote-catalog",
    "imports-and-jobs",
    "recruiter",
    "finance-fee-routing",
    "sub-project-3",
    "robinhood-only",
  ]) {
    assert.ok(categories.includes(name), `category ${name} missing`);
  }
  for (const entry of config.exceptions) {
    const label = `${entry.file} :: ${entry.pattern}`;
    assert.ok(categories.includes(entry.category), `${label}: unknown category ${entry.category}`);
    assert.ok(String(entry.reason || "").trim().length > 0, `${label}: reason missing`);
    assert.ok(String(entry.pattern || "").length > 0, `${label}: pattern missing`);
    assert.ok(existsSync(resolve(ROOT, entry.file)), `${label}: file does not exist`);
  }
  for (const entry of config.dogeosSiblings) {
    const label = `${entry.file} :: ${entry.pattern}`;
    assert.ok(String(entry.reason || "").trim().length > 0, `${label}: reason missing`);
    assert.ok(String(entry.sibling || "").length > 0, `${label}: sibling missing`);
    assert.equal(entry.category, undefined, `${label}: a sibling is coverage, not an exception category`);
  }
});

test("exceptions file has no stale entries", () => {
  const config = loadExceptions();
  const { used } = resolveHits(scanHits(), config);
  const stale = [];
  for (const entry of config.exceptions) {
    if (!used.has(entry)) stale.push(`exception ${entry.file} :: ${entry.pattern}`);
  }
  for (const entry of config.dogeosSiblings) {
    if (!used.has(entry)) stale.push(`sibling ${entry.file} :: ${entry.pattern}`);
    const siblingFile = entry.siblingFile || entry.file;
    const { raw, code } = readTracked(siblingFile);
    const present = raw.some((line, i) => line.includes(entry.sibling) && DOGEOS_REF.test(code[i]));
    if (!present) stale.push(`sibling DogeOS branch gone: ${siblingFile} :: ${entry.sibling}`);
  }
  assert.deepEqual(stale, [], `stale entries in ${EXCEPTIONS_PATH} (pattern no longer matches an uncovered 46630 site, or the DogeOS sibling branch is gone):\n  ${stale.join("\n  ")}`);
});

test("indirect launch-path Robinhood checks reference isDogeosChainId or 6281971", () => {
  const failures = [];
  for (const check of INDIRECT_LAUNCH_PATH_CHECKS) {
    assert.ok(Number.isInteger(check.window) && check.window >= 0 && check.window <= WINDOW, `${check.file}: window must be 0..${WINDOW}`);
    const { raw, code } = readTracked(check.file);
    const lines = raw.map((line, i) => (line.includes(check.anchor) && code[i].trim() ? i + 1 : 0)).filter(Boolean);
    if (!lines.length) {
      failures.push(`${check.file}: anchor not found (${check.why}): ${check.anchor}`);
      continue;
    }
    for (const lineNo of lines) {
      if (!hasDogeosNear(code, lineNo, check.window)) {
        failures.push(`${check.file}:${lineNo} (${check.why}) has no DogeOS branch within ${check.window} lines: ${raw[lineNo - 1].trim()}`);
      }
    }
  }
  assert.deepEqual(failures, [], `indirect launch-path checks without DogeOS:\n  ${failures.join("\n  ")}`);
});
