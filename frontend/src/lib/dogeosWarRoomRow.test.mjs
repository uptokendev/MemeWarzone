import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// DogeOS (6281971) in the War Room (plan t33, spec section 4 "Removed (B8)"): a DogeOS row keeps its own chain but
// never mounts the Robinhood V3 trade panel (gen-7/MuchFi) or the BNB curve panel. It shows a fail-closed "not
// available yet" card until the gen-8 Barkswap client is wired (t22). The Robinhood panel itself refuses a DogeOS
// campaign instead of trading it as 46630. Robinhood and BNB rows are asserted next to it so they stay as they are.
//   node --test src/lib/dogeosWarRoomRow.test.mjs

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");

const DOGEOS = 6281971;
const ENV = { DEV: false, PROD: true, VITE_ALLOWED_CHAIN_IDS: "56,97,101,4663,46630,6281971" };

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

async function loadHarness(name, contents, stubs) {
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
    define: { "import.meta.env": JSON.stringify(ENV) },
  });
  // Inside the frontend package tree so Node resolves frontend/node_modules (gitignored dir, removed after()).
  const tmpDir = await mkdtemp(path.join(frontendRoot, ".mwz-dogeos-launch-path-"));
  harnessDirs.push(tmpDir);
  const outfile = path.join(tmpDir, `${name}.mjs`);
  await writeFile(outfile, compiled.outputFiles[0].text);
  return import(pathToFileURL(outfile).href);
}

const rowHarness = loadHarness(
  "dogeos-war-room-row",
  `
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { WarRoomCampaignRow } from "../components/postgrad/WarRoomCampaignRow";
export { DOGEOS_TRADE_UNAVAILABLE } from "../features/launchpad/dogeosBarkswapAdapter";
export function renderRow(campaign) {
  return renderToStaticMarkup(<MemoryRouter><WarRoomCampaignRow campaign={campaign} expanded /></MemoryRouter>);
}
`,
  { ...STUBS, ...ROW_ONLY_STUBS },
);

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

test("a DogeOS War Room row mounts no Robinhood or BNB trade panel: a fail-closed card instead", async () => {
  const { renderRow, DOGEOS_TRADE_UNAVAILABLE } = await rowHarness;
  assert.match(DOGEOS_TRADE_UNAVAILABLE, /not available yet/);
  for (const status of ["graduated", "live"]) {
    const html = renderRow(coin(DOGEOS, status));
    assert.doesNotMatch(html, /robinhood-war-room-trade-panel/, `${status}: Robinhood V3 panel mounted for 6281971`);
    assert.doesNotMatch(html, /bnb-war-room-trade-panel/, `${status}: BNB curve panel mounted for 6281971`);
    assert.doesNotMatch(html, /war-room-robinhood-bonding-trade/, `${status}: Robinhood bonding card for 6281971`);
    assert.match(html, /data-testid="war-room-dogeos-trade-unavailable"/, status);
    assert.ok(html.includes(escapeHtml(DOGEOS_TRADE_UNAVAILABLE)), status);
  }
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
