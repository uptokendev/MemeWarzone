import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { ethers } from "ethers";

import {
  DOGE_BUY_RESERVE_FLOOR_WEI,
  DOGE_LAUNCH_RESERVE_FLOOR_WEI,
  DOGEOS_L1_GAS_PRICE_ORACLE,
  barkLaunchCalldataBytes,
  dogeosReserveFromFees,
  encodeGetL1FeeCall,
  representativeL1Payload,
} from "../../shared/dogeosGasReserve.mjs";

// The app side of the live DogeOS gas reserve (barkswap plan t34, founder decision A 2026-10-17): the sync reserves
// every existing caller reads are the DogeOS floors (0.05 DOGE buy, 0.2 DOGE launch) and BNB / Robinhood stay exactly as
// they were; the live read (shared/dogeosGasReserve.mjs, tested in shared/dogeosGasReserve.test.mjs) runs on the
// chain's read provider for DogeOS only; the launch balance check uses it with the launch's own strings; the trade panel
// and the launch options keep back the live amount and say how much.
//   node --test src/lib/dogeosGasReserve.test.mjs

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");
const read = (rel) => readFileSync(path.join(srcRoot, rel), "utf8");

const DOGEOS = 6281971;
const ENV = { DEV: false, PROD: true, VITE_ALLOWED_CHAIN_IDS: "56,97,101,4663,46630,6281971" };
const L2_PRICE = 15_680_108n;
const LAUNCH_L1_FEE_HIGH = 2_736_164_285_306_660_820n; // the dearest launch at the 2026-10-14 oracle (t27 report)
const USER = ethers.getAddress(`0x${"7004".padStart(40, "0")}`);

// The read provider is the network edge: getReadProvider(chainId) serves the test's fake for that chain.
const STUBS = {
  "@/lib/readProvider":
    "export function getReadProvider(chainId) { const p = globalThis.__mwzReadProviders?.[chainId]; if (!p) throw new Error('no read provider'); return p; }",
};
function stubPlugin(stubs) {
  return {
    name: "dogeos-reserve-stubs",
    setup(b) {
      for (const spec of Object.keys(stubs)) {
        const filter = new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
        b.onResolve({ filter }, () => ({ path: spec, namespace: "dogeos-reserve-stub" }));
      }
      b.onLoad({ filter: /.*/, namespace: "dogeos-reserve-stub" }, (args) => ({ contents: stubs[args.path], loader: "js", resolveDir: dir }));
    },
  };
}

const ENTRY = `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as tradeBalanceReserve from "./tradeBalanceReserve.ts";
import * as live from "./dogeosGasReserve.ts";
import * as launch from "../components/create/EvmGen8LaunchOptions";
import { useDogeosGasReserve } from "../hooks/useDogeosGasReserve";
export { tradeBalanceReserve, live, launch };
export function renderReserve(chainId, kind) {
  function R() {
    const wei = useDogeosGasReserve(chainId, kind);
    return createElement("i", null, wei == null ? "none" : wei.toString());
  }
  return renderToStaticMarkup(createElement(R));
}
`;

const harnessDirs = [];
after(async () => {
  await Promise.all(harnessDirs.map((tmp) => rm(tmp, { recursive: true, force: true })));
});
let harnessPromise = null;
function harness() {
  harnessPromise ||= (async () => {
    const compiled = await build({
      absWorkingDir: dir,
      stdin: { contents: ENTRY, resolveDir: dir, sourcefile: "dogeos-gas-reserve.tsx", loader: "tsx" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      packages: "external",
      jsx: "automatic",
      alias: { "@": srcRoot },
      loader: { ".json": "json" },
      plugins: [stubPlugin(STUBS)],
      define: { "import.meta.env": JSON.stringify(ENV) },
    });
    // Inside the frontend package tree so Node resolves frontend/node_modules (gitignored dir, removed after()).
    const tmpDir = await mkdtemp(path.join(frontendRoot, ".mwz-dogeos-launch-path-"));
    harnessDirs.push(tmpDir);
    const outfile = path.join(tmpDir, "dogeos-gas-reserve.mjs");
    await writeFile(outfile, compiled.outputFiles[0].text);
    return import(pathToFileURL(outfile).href);
  })();
  return harnessPromise;
}

/** A fake of the app's read provider (ethers JsonRpcProvider): send(method, params) and getBalance(address). */
function fakeReadProvider({ l1FeeWei = 0n, gasPriceWei = L2_PRICE, balanceWei = 10n ** 18n, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      if (fail) throw new Error("rpc down");
      if (method === "eth_gasPrice") return `0x${gasPriceWei.toString(16)}`;
      if (method === "eth_call" && params[0].to === DOGEOS_L1_GAS_PRICE_ORACLE) {
        return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [typeof l1FeeWei === "function" ? l1FeeWei(params[0].data) : l1FeeWei]);
      }
      throw new Error(`unexpected ${method}`);
    },
    async getBalance(address) {
      calls.push({ method: "getBalance", params: [address] });
      return balanceWei;
    },
  };
}
function serve(providers) {
  globalThis.__mwzReadProviders = providers;
}

test("sync reserves: DogeOS floors 0.05 / 0.2 DOGE; BNB and Robinhood exactly as before", async () => {
  const { tradeBalanceReserve: r, launch } = await harness();
  assert.equal(r.DOGE_BUY_GAS_RESERVE_WEI, DOGE_BUY_RESERVE_FLOOR_WEI);
  assert.equal(r.DOGE_LAUNCH_GAS_RESERVE_WEI, DOGE_LAUNCH_RESERVE_FLOOR_WEI);
  assert.equal(r.evmBuyGasReserveWeiForChain(DOGEOS), 5n * 10n ** 16n);
  assert.equal(launch.gen8LaunchGasReserveWei(DOGEOS), 2n * 10n ** 17n);
  for (const [id, buy, launchWei] of [
    [56, 500_000_000_000_000n, 5_000_000_000_000_000n],
    [97, 500_000_000_000_000n, 5_000_000_000_000_000n],
    [4663, 200_000_000_000_000n, 2_000_000_000_000_000n],
    [46630, 200_000_000_000_000n, 2_000_000_000_000_000n],
  ]) {
    assert.equal(r.evmBuyGasReserveWeiForChain(id), buy, `buy ${id}`);
    assert.equal(launch.gen8LaunchGasReserveWei(id), launchWei, `launch ${id}`);
    assert.equal(launch.gen8LaunchBalanceMessage(10n ** 17n, id), r.evmLaunchBalanceMessage(10n ** 17n, id === 4663 || id === 46630 ? "ETH" : id === 56 || id === 97 ? "BNB" : "", id === 4663 || id === 46630), `message ${id}`);
    assert.equal(launch.gen8LaunchBalanceMessage(0n, id, 99n * 10n ** 18n), launch.gen8LaunchBalanceMessage(0n, id), `a live reserve is ignored off DogeOS (${id})`);
  }
});

test("live reserve: DogeOS reads the chain's read provider; other chains get null and no read", async () => {
  const { live } = await harness();
  live.clearDogeosGasReserveCache();
  const offChain = fakeReadProvider();
  serve({ 56: offChain, 97: offChain, 4663: offChain, 46630: offChain, 101: offChain });
  for (const id of [56, 97, 101, 4663, 46630]) {
    assert.equal(await live.dogeosLiveGasReserveWei({ chainId: id, kind: "buy" }), null, String(id));
    assert.equal(await live.dogeosLiveGasReserveWei({ chainId: id, kind: "launch" }), null, String(id));
    assert.equal(live.dogeosGasReserveFloorWei(id, "buy"), null);
  }
  assert.deepEqual(offChain.calls, []);

  const doge = fakeReadProvider({ l1FeeWei: 39_348_292_944_445_076n });
  serve({ [DOGEOS]: doge });
  const buy = await live.dogeosLiveGasReserveWei({ chainId: DOGEOS, kind: "buy" });
  assert.equal(buy, dogeosReserveFromFees({ kind: "buy", l1FeeWei: 39_348_292_944_445_076n, gasLimit: 1_000_000n, gasPriceWei: L2_PRICE }));
  assert.ok(buy > DOGE_BUY_RESERVE_FLOOR_WEI);
  assert.deepEqual(doge.calls.map((c) => c.method).sort(), ["eth_call", "eth_gasPrice"]);
  assert.equal(live.dogeosGasReserveFloorWei(DOGEOS, "buy"), DOGE_BUY_RESERVE_FLOOR_WEI);
  assert.equal(live.dogeosGasReserveFloorWei(DOGEOS, "launch"), DOGE_LAUNCH_RESERVE_FLOOR_WEI);

  // a passed provider wins over the chain's read provider
  live.clearDogeosGasReserveCache();
  const own = fakeReadProvider({ l1FeeWei: 10n ** 17n });
  assert.equal(await live.dogeosLiveGasReserveWei({ chainId: DOGEOS, kind: "buy", provider: own }), dogeosReserveFromFees({ kind: "buy", l1FeeWei: 10n ** 17n, gasLimit: 1_000_000n, gasPriceWei: L2_PRICE }));
  assert.equal(own.calls.length, 2);

  // failed read, or no read provider at all: the floor
  live.clearDogeosGasReserveCache();
  serve({ [DOGEOS]: fakeReadProvider({ fail: true }) });
  assert.equal(await live.dogeosLiveGasReserveWei({ chainId: DOGEOS, kind: "buy" }), DOGE_BUY_RESERVE_FLOOR_WEI);
  serve({});
  assert.equal(await live.dogeosLiveGasReserveWei({ chainId: DOGEOS, kind: "launch" }), DOGE_LAUNCH_RESERVE_FLOOR_WEI);
});

test("buy message names the amount kept back, rounded up to 0.01 DOGE", async () => {
  const { live } = await harness();
  assert.equal(live.dogeosBuyReserveMessage(59_045_000_000_000_000n, "DOGE"), "Not enough DOGE. Keep about 0.06 DOGE for network fees.");
  assert.equal(live.dogeosBuyReserveMessage(DOGE_BUY_RESERVE_FLOOR_WEI, "DOGE"), "Not enough DOGE. Keep about 0.05 DOGE for network fees.");
});

test("launch message and balance check: DogeOS keeps back the live reserve for the launch's own strings", async () => {
  const { live, launch } = await harness();
  assert.equal(launch.gen8LaunchBalanceMessage(0n, DOGEOS), "Not enough DOGE. A launch needs about 0.2 DOGE for network fees.");
  assert.equal(
    launch.gen8LaunchBalanceMessage(12_345_678_000_000_000_000n, DOGEOS, 4_104_432_599_379_725_545n),
    "Not enough DOGE. A launch keeps about 4.11 DOGE for network fees. Your first buy can be up to 12.3456 DOGE.",
  );

  // 2026-10-14's oracle: the floor is far too little; the check asks the oracle for the launch's own size
  live.clearDogeosGasReserveCache();
  const strings = {
    name: "Much Wow",
    symbol: "WOW",
    logoURI: "https://vrnsbguutnwgtekcexls.supabase.co/storage/v1/object/public/campaign-logos/wow.png",
    xAccount: "https://x.com/muchwow",
    website: "",
    extraLink: "",
  };
  const asked = [];
  const provider = fakeReadProvider({ l1FeeWei: (data) => (asked.push(data), LAUNCH_L1_FEE_HIGH), balanceWei: 5n * 10n ** 18n });
  serve({ [DOGEOS]: provider });
  const reserve = dogeosReserveFromFees({ kind: "launch", l1FeeWei: LAUNCH_L1_FEE_HIGH, gasLimit: 8_000_000n, gasPriceWei: L2_PRICE });
  assert.ok(reserve > 4n * 10n ** 18n);
  await assert.rejects(
    launch.assertEvmGen8LaunchBalance({ chainId: DOGEOS, account: USER, valueWei: 10n ** 18n, launchStrings: strings }),
    (error) => {
      assert.equal(error.message, launch.gen8LaunchBalanceMessage(5n * 10n ** 18n - reserve, DOGEOS, reserve));
      assert.match(error.message, /A launch keeps about 4\.11 DOGE for network fees/);
      return true;
    },
  );
  assert.equal(asked[0], encodeGetL1FeeCall(representativeL1Payload(barkLaunchCalldataBytes(strings) + 128)));
  // the same first buy fits once the oracle is cheap again (today's fee: the 0.2 floor binds)
  live.clearDogeosGasReserveCache();
  serve({ [DOGEOS]: fakeReadProvider({ l1FeeWei: 119_281_117_292_503_475n, balanceWei: 10n ** 18n + DOGE_LAUNCH_RESERVE_FLOOR_WEI }) });
  await launch.assertEvmGen8LaunchBalance({ chainId: DOGEOS, account: USER, valueWei: 10n ** 18n, launchStrings: strings });
  serve({ [DOGEOS]: fakeReadProvider({ l1FeeWei: 119_281_117_292_503_475n, balanceWei: 10n ** 18n + DOGE_LAUNCH_RESERVE_FLOOR_WEI - 1n }) });
  await assert.rejects(launch.assertEvmGen8LaunchBalance({ chainId: DOGEOS, account: USER, valueWei: 10n ** 18n }), /A launch keeps about 0\.2 DOGE for network fees/);

  // Robinhood: the sync reserve, no oracle read
  const rh = fakeReadProvider({ balanceWei: 10n ** 16n + 2_000_000_000_000_000n });
  serve({ 46630: rh });
  await launch.assertEvmGen8LaunchBalance({ chainId: 46630, account: USER, valueWei: 10n ** 16n, launchStrings: strings });
  assert.deepEqual(rh.calls.map((c) => c.method), ["getBalance"]);
  serve({ 46630: fakeReadProvider({ balanceWei: 10n ** 16n + 2_000_000_000_000_000n - 1n }) });
  await assert.rejects(launch.assertEvmGen8LaunchBalance({ chainId: 46630, account: USER, valueWei: 10n ** 16n }), /A launch keeps about 0\.002 ETH for gas\./);
});

test("hook: DogeOS starts at the floor (the live read replaces it in an effect); other chains get null", async () => {
  const { renderReserve } = await harness();
  assert.equal(renderReserve(DOGEOS, "buy"), `<i>${DOGE_BUY_RESERVE_FLOOR_WEI}</i>`);
  assert.equal(renderReserve(DOGEOS, "launch"), `<i>${DOGE_LAUNCH_RESERVE_FLOOR_WEI}</i>`);
  for (const id of [56, 97, 4663, 46630, 101]) assert.equal(renderReserve(id, "buy"), "<i>none</i>", String(id));
  const hook = read("hooks/useDogeosGasReserve.ts");
  assert.match(hook, /dogeosLiveGasReserveWei\(\{ chainId, kind \}\)/);
  assert.match(hook, /setVisibleInterval\(run, DOGEOS_RESERVE_CACHE_MS\)/);
});

test("wiring: the gen-8 trade panel and the launch surfaces keep back the live DogeOS reserve; other chains unchanged", () => {
  const panel = read("components/evm/Gen8TradePanel.tsx");
  assert.match(panel, /const dogeosGasReserve = useDogeosGasReserve\(chainId, "buy"\);/);
  assert.match(panel, /const gasReserve = dogeos \? \(dogeosGasReserve \?\? evmBuyGasReserveWeiForChain\(chainId\)\) : evmBuyGasReserveWei\(robinhood\);/);
  // before signing a DogeOS buy: a fresh read (cached 30 s) on the panel's read provider
  assert.match(panel, /if \(dogeos && side === "buy" && balances\) \{\s*const fresh = \(await dogeosLiveGasReserveWei\(\{ chainId, kind: "buy", provider: readProvider \}\)\) \?\? gasReserve;\s*if \(amountRaw \+ fresh > balances\.nativeRaw\) \{\s*toast\.error\(dogeosBuyReserveMessage\(fresh, native\)\);\s*return;/);
  assert.equal((panel.match(/dogeos \? dogeosBuyReserveMessage\(gasReserve, native\)/g) || []).length, 2);
  // the BNB / Robinhood words stay
  assert.match(panel, /`Not enough \$\{native\}\. Keep about \$\{ethers\.formatEther\(gasReserve\)\} \$\{native\} for gas\.`/);
  assert.match(panel, /`Not enough \$\{native\} \(about \$\{ethers\.formatEther\(gasReserve\)\} \$\{native\} stays for gas\)\.`/);

  const options = read("components/create/EvmGen8LaunchOptions.tsx");
  assert.match(options, /const gasReserveWei = useDogeosGasReserve\(chainId, "launch"\) \?\? gen8LaunchGasReserveWei\(chainId\);/);
  assert.match(options, /gen8LaunchBalanceMessage\(maxByBalance, chainId, gasReserveWei\)/);
  assert.match(options, /gen8LaunchBalanceMessage\(0n, chainId, gasReserveWei\)/);

  // the create and push-live pages pass the launch's strings so the check prices its real size
  const create = read("pages/Create.tsx");
  assert.match(create, /await assertEvmGen8LaunchBalance\(\{\s*chainId: Number\(chainId\),\s*account: wallet\.account \|\| "",\s*valueWei: gen8FirstBuyWei,\s*launchStrings: \{/);
  const push = read("pages/PushDraftLive.tsx");
  assert.match(push, /await assertEvmGen8LaunchBalance\(\{\s*chainId,\s*account: wallet\.account,\s*valueWei: firstBuyValueWei,\s*launchStrings: \{/);

  // the Robinhood war-room panel refuses DogeOS before it reads a reserve; it keeps the sync selector
  const war = read("components/postgrad/RobinhoodWarRoomTradePanel.tsx");
  assert.match(war, /const buyGasReserveWei = evmBuyGasReserveWeiForChain\(chainId\);/);
  assert.doesNotMatch(war, /useDogeosGasReserve|dogeosLiveGasReserveWei/);
});
