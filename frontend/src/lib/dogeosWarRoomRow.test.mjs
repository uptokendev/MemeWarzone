import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// DogeOS (6281971) in the War Room (plan t33 / t22, spec section 4): a DogeOS row keeps its own chain but never mounts
// the Robinhood V3 trade panel (gen-7/MuchFi) or the BNB curve panel. With the app's gen-8 Barkswap config it mounts
// the gen-8 trade panel on 6281971 (the coin's Barkswap pool); while the coin's gen-8 state is unknown, and on a draft,
// it says "Launches on Barkswap"; without the config it shows the fail-closed "not available yet" card. The Robinhood
// panel itself refuses a DogeOS campaign instead of trading it as 46630. Robinhood and BNB rows are asserted next to it
// so they stay as they are.
//   node --test src/lib/dogeosWarRoomRow.test.mjs

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");

const DOGEOS = 6281971;
const ENV = { DEV: false, PROD: true, VITE_ALLOWED_CHAIN_IDS: "56,97,101,4663,46630,6281971" };
// The app's gen-8 Barkswap config (evmGen8Client.mjs): launcher + plugin; router / quoter / WDOGE are Barkswap's defaults.
const BARK_ENV = {
  ...ENV,
  VITE_EVM_GEN8_LAUNCHER_6281971: "0xf5059a5D33d5853360D16C683c16e67980206f36",
  VITE_EVM_GEN8_PLUGIN_6281971: "0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8",
};

// Heavy or browser-only modules become markers: the test sees which panel a row mounts, nothing else.
const STUBS = {
  "@/components/token/ContinuousMarketChartPanel": "export function ContinuousMarketChartPanel() { return null; }",
  "@/components/token/AthBar": "export function AthBar() { return null; }",
  "@/components/common/ChainFeedSwitch": "export function setSelectedFeedChainId() {}",
  "@/components/postgrad/WarRoomTradePanel":
    'import { createElement } from "react"; export function WarRoomTradePanel() { return createElement("div", { "data-stub": "bnb-war-room-trade-panel" }); }',
  "@/components/arena/ImportedTradePanel":
    'import { createElement } from "react"; export function ImportedTradePanel() { return createElement("div", { "data-stub": "imported-trade-panel" }); }',
  "@/components/postgrad/RobinhoodBeatTheMarketCard": "export function RobinhoodBeatTheMarketCard() { return null; }",
  "@/contexts/WalletContext":
    "export function useWallet() { return { isConnected: false, account: null, chainId: null, provider: null, signer: null }; }",
  "@/hooks/use-toast": "export function useToast() { return { toast() {} }; }",
  "@/lib/robinhoodImportSwap.mjs": "export async function resolveImportPool() { return null; }",
  "@/lib/readProvider": "export function getReadProvider() { return null; }",
  "@/lib/robinhoodV3Trade":
    "const refuse = async () => { throw new Error('not in this test'); };\n" +
    "export const ensureRobinhoodV3SellAllowance = refuse, executeRobinhoodV3Buy = refuse, executeRobinhoodV3Sell = refuse,\n" +
    "  quoteRobinhoodV3Buy = refuse, quoteRobinhoodV3Sell = refuse, resolveRobinhoodV3Route = refuse;",
};
const ROW_ONLY_STUBS = {
  "@/components/postgrad/RobinhoodWarRoomTradePanel":
    'import { createElement } from "react"; export function RobinhoodWarRoomTradePanel() { return createElement("div", { "data-stub": "robinhood-war-room-trade-panel" }); }',
  // The gen-8 panel is the token page's (its trades are tested in barkswapSwap.test.mjs): a marker with its chain and venue.
  "@/components/evm/Gen8TradePanel":
    'import { createElement } from "react"; export function Gen8TradePanel(p) { return createElement("div", { "data-stub": "gen8-trade-panel", "data-chain": String(p.chainId), "data-venue": String(p.state?.gen8?.venue) }); }',
  // The coin's gen-8 state (GET /api/evm/campaign-state): whatever the test serves, and the chain it was asked for.
  "@/hooks/useGen8Coin":
    "export function useGen8Coin(chainId, address) { globalThis.__mwzGen8Asked = [...(globalThis.__mwzGen8Asked || []), chainId]; return { state: chainId ? globalThis.__mwzGen8State ?? null : null, refresh() {} }; }",
};

function stubPlugin(stubs) {
  return {
    name: "war-room-stubs",
    setup(b) {
      for (const spec of Object.keys(stubs)) {
        const filter = new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
        b.onResolve({ filter }, () => ({ path: spec, namespace: "war-room-stub" }));
      }
      b.onLoad({ filter: /.*/, namespace: "war-room-stub" }, (args) => ({ contents: stubs[args.path], loader: "js", resolveDir: dir }));
    },
  };
}

const harnessDirs = [];
after(async () => {
  await Promise.all(harnessDirs.map((tmp) => rm(tmp, { recursive: true, force: true })));
});

async function loadHarness(name, contents, stubs, env = ENV) {
  const compiled = await build({
    absWorkingDir: dir,
    stdin: { contents, resolveDir: dir, sourcefile: `${name}.tsx`, loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    alias: { "@": srcRoot },
    loader: { ".json": "json" },
    plugins: [stubPlugin(stubs)],
    define: { "import.meta.env": JSON.stringify(env) },
  });
  // Inside the frontend package tree so Node resolves frontend/node_modules (gitignored dir, removed after()).
  const tmpDir = await mkdtemp(path.join(frontendRoot, ".mwz-dogeos-launch-path-"));
  harnessDirs.push(tmpDir);
  const outfile = path.join(tmpDir, `${name}.mjs`);
  await writeFile(outfile, compiled.outputFiles[0].text);
  return import(pathToFileURL(outfile).href);
}

const ROW_ENTRY = `
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { WarRoomCampaignRow, DOGEOS_LAUNCHES_ON } from "../components/postgrad/WarRoomCampaignRow";
export { DOGEOS_TRADE_UNAVAILABLE } from "../features/launchpad/dogeosBarkswapAdapter";
export { DOGEOS_LAUNCHES_ON };
export function renderRow(campaign) {
  return renderToStaticMarkup(<MemoryRouter><WarRoomCampaignRow campaign={campaign} expanded /></MemoryRouter>);
}
`;
const rowHarness = loadHarness("dogeos-war-room-row", ROW_ENTRY, { ...STUBS, ...ROW_ONLY_STUBS });
const barkRowHarness = loadHarness("dogeos-war-room-row-bark", ROW_ENTRY, { ...STUBS, ...ROW_ONLY_STUBS }, BARK_ENV);

const panelHarness = loadHarness(
  "dogeos-war-room-panel",
  `
import { renderToStaticMarkup } from "react-dom/server";
import { RobinhoodWarRoomTradePanel } from "../components/postgrad/RobinhoodWarRoomTradePanel";
export { DOGEOS_TRADE_UNAVAILABLE } from "../features/launchpad/dogeosBarkswapAdapter";
export function renderPanel(campaign) {
  return renderToStaticMarkup(<RobinhoodWarRoomTradePanel campaign={campaign} />);
}
`,
  STUBS,
);

const coin = (chainId, status) => ({
  id: 1,
  campaign: "0x00000000000000000000000000000000000c0001",
  token: "0x00000000000000000000000000000000000c0002",
  creator: "0x00000000000000000000000000000000000c0003",
  name: "Test Coin",
  symbol: "TEST",
  logoURI: "",
  xAccount: "",
  website: "",
  extraLink: "",
  chainId,
  status,
  isActive: status === "live",
});

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

test("without the Barkswap config a DogeOS War Room row mounts no trade panel: a fail-closed card instead", async () => {
  const { renderRow, DOGEOS_TRADE_UNAVAILABLE } = await rowHarness;
  globalThis.__mwzGen8State = { token: "0x00000000000000000000000000000000000c0002", gen8: { venue: "barkswap" } };
  globalThis.__mwzGen8Asked = [];
  assert.match(DOGEOS_TRADE_UNAVAILABLE, /not available yet/);
  for (const status of ["graduated", "live"]) {
    const html = renderRow(coin(DOGEOS, status));
    assert.doesNotMatch(html, /robinhood-war-room-trade-panel/, `${status}: Robinhood V3 panel mounted for 6281971`);
    assert.doesNotMatch(html, /bnb-war-room-trade-panel/, `${status}: BNB curve panel mounted for 6281971`);
    assert.doesNotMatch(html, /war-room-robinhood-bonding-trade/, `${status}: Robinhood bonding card for 6281971`);
    assert.match(html, /data-testid="war-room-dogeos-trade-unavailable"/, status);
    assert.ok(html.includes(escapeHtml(DOGEOS_TRADE_UNAVAILABLE)), status);
    assert.doesNotMatch(html, /gen8-trade-panel/, status);
  }
  // no coin state is asked for without the config
  assert.ok(globalThis.__mwzGen8Asked.every((id) => id === null), String(globalThis.__mwzGen8Asked));
});

test("with the Barkswap config a DogeOS War Room row mounts the gen-8 trade panel on 6281971, never Robinhood or BNB", async () => {
  const { renderRow, DOGEOS_LAUNCHES_ON } = await barkRowHarness;
  assert.equal(DOGEOS_LAUNCHES_ON, "Launches on Barkswap");
  globalThis.__mwzGen8State = { token: "0x00000000000000000000000000000000000c0002", gen8: { venue: "barkswap" } };
  for (const status of ["graduated", "live"]) {
    globalThis.__mwzGen8Asked = [];
    const html = renderRow(coin(DOGEOS, status));
    assert.match(html, /data-stub="gen8-trade-panel" data-chain="6281971" data-venue="barkswap"/, status);
    assert.match(html, /data-testid="war-room-dogeos-trade"/, status);
    assert.doesNotMatch(html, /robinhood-war-room-trade-panel|bnb-war-room-trade-panel|war-room-robinhood-bonding-trade|war-room-dogeos-trade-unavailable/, status);
    assert.deepEqual(globalThis.__mwzGen8Asked, [DOGEOS], `${status}: the coin state is asked on 6281971 only`);
  }
  // the coin's gen-8 state is not known yet (not launched, or loading): where it launches, no panel
  globalThis.__mwzGen8State = null;
  const pending = renderRow(coin(DOGEOS, "live"));
  assert.match(pending, /data-testid="war-room-dogeos-launches-on"/);
  assert.ok(pending.includes(DOGEOS_LAUNCHES_ON));
  assert.doesNotMatch(pending, /gen8-trade-panel|robinhood-war-room-trade-panel|bnb-war-room-trade-panel/);
});

test("a DogeOS draft row says it launches on Barkswap; other drafts do not", async () => {
  const { renderRow, DOGEOS_LAUNCHES_ON } = await barkRowHarness;
  const draft = (chainId) => ({ ...coin(chainId, "draft"), isActive: false, draftStatus: "draft" });
  const html = renderRow(draft(DOGEOS));
  assert.match(html, /data-testid="war-room-dogeos-draft-venue"/);
  assert.ok(html.includes(DOGEOS_LAUNCHES_ON));
  assert.doesNotMatch(html, /gen8-trade-panel|war-room-dogeos-trade/);
  for (const chainId of [97, 46630]) assert.doesNotMatch(renderRow(draft(chainId)), /war-room-dogeos-draft-venue|Launches on/, String(chainId));
});

test("Robinhood and BNB War Room rows keep their panels", async () => {
  const { renderRow } = await rowHarness;
  for (const chainId of [4663, 46630]) {
    assert.match(renderRow(coin(chainId, "graduated")), /robinhood-war-room-trade-panel/, String(chainId));
    const bonding = renderRow(coin(chainId, "live"));
    assert.match(bonding, /data-testid="war-room-robinhood-bonding-trade"/, String(chainId));
    assert.match(bonding, /This coin trades in ETH on Robinhood Chain\. Buy and sell it on its token page\./, String(chainId));
    assert.doesNotMatch(bonding, /war-room-dogeos-trade-unavailable/, String(chainId));
  }
  for (const chainId of [56, 97]) {
    for (const status of ["graduated", "live"]) {
      const html = renderRow(coin(chainId, status));
      assert.match(html, /bnb-war-room-trade-panel/, `${chainId} ${status}`);
      assert.doesNotMatch(html, /robinhood-war-room-trade-panel|war-room-dogeos-trade-unavailable/, `${chainId} ${status}`);
    }
  }
});

test("the Robinhood War Room panel refuses a DogeOS campaign instead of trading it as 46630", async () => {
  const { renderPanel, DOGEOS_TRADE_UNAVAILABLE } = await panelHarness;
  const dogeos = renderPanel(coin(DOGEOS, "graduated"));
  assert.match(dogeos, /data-war-room-trade-unavailable="dogeos"/);
  assert.ok(dogeos.includes(escapeHtml(DOGEOS_TRADE_UNAVAILABLE)));
  assert.doesNotMatch(dogeos, /Robinhood|Connect .* wallet|imported-trade-panel/);
  // Robinhood still gets its direct V3 panel (the import route is off without env)
  const robinhood = renderPanel(coin(46630, "graduated"));
  assert.doesNotMatch(robinhood, /data-war-room-trade-unavailable/);
  assert.match(robinhood, /Robinhood V3/);
  assert.match(robinhood, /Connect Robinhood wallet/);
});
