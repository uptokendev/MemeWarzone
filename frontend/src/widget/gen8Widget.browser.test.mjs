// Browser smoke of the gen-8 swap widget (dist/widget/mwz-swap.js, so run `npm run build:widget` first): headless
// Chromium mounts the built widget for a gen-8 coin on a local BNB fork, a page wallet (window.ethereum backed by a
// test key on the fork) connects, buys and sells. The widget's API calls are answered by api/gen8Swap.js on a local
// server, so the swaps are the API's builds (partner fingerprint recorded) through Uniswap's real UniversalRouter.
// Skips without the built widget, the gen-8 artifacts, anvil, Playwright's Chromium or BSC_MAINNET_RPC.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import { deployGen8Local, gen8ArtifactsAvailable, gen8EnvFor, startAnvilFork, testWallets } from "../../api/lib/evmGen8LocalChain.testkit.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const WIDGET = path.resolve(dir, "../../dist/widget/mwz-swap.js");
// Exported env only (never an .env file); else BNB Chain's public RPC (reads only).
const RPC = process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.bnbchain.org";
let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}
// Chromium needs its system libraries (npx playwright install-deps); without them the test skips.
let chromiumOk = false;
if (chromium) {
  try {
    await (await chromium.launch()).close();
    chromiumOk = true;
  } catch {
    chromiumOk = false;
  }
}
const skip = !fs.existsSync(WIDGET) || !gen8ArtifactsAvailable() || !RPC || !chromiumOk ? "built widget, artifacts, anvil, a runnable Chromium or BSC_MAINNET_RPC missing" : false;

test("gen-8 widget in a browser: connect, buy, sell (approval + Permit2 permit) against the API's builds", { skip, timeout: 600_000 }, async () => {
  const chainId = 56;
  const fork = await startAnvilFork({ rpc: RPC, port: 8793, chainId });
  const provider = fork.provider();
  const saved = { ...process.env };
  let server = null;
  let browser = null;
  try {
    const local = await deployGen8Local(provider, { poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", display: true });
    Object.assign(process.env, gen8EnvFor(local, chainId));
    const client = await import("../lib/evmGen8Client.mjs");
    const { gen8CreateAuthorization } = await import("../../api/dev-fix/evmGen8CreateAuthorization.js");
    const { GEN8_TARGET_FAST_USD } = await import("../../shared/evmGen8.mjs");
    const wallets = testWallets(provider, 10);
    const creator = wallets[3];
    const trader = wallets[8];
    const launcher = client.gen8LauncherFor(chainId);
    const auth = await gen8CreateAuthorization(
      client.gen8CreateAuthorizationBody({ chainId, walletAddress: creator.address, launcher, name: "Widget Coin", symbol: "WDGT", logoURI: "https://example.com/w.png", targetUsd: GEN8_TARGET_FAST_USD, feeChoice: "keep" }),
      { signer: local.apiSigner, getProvider: async () => provider, evaluateCreatePreflight: async () => ({ allowed: true }), getRouteDecision: async () => ({}), logRouteAuthorization: async () => {} },
    );
    assert.equal(auth.status, 200);
    const { launched } = await client.launchGen8Coin({ signer: creator, chainId, launcher, authorization: auth.body });
    await provider.send("evm_increaseTime", [61]);
    await provider.send("evm_mine", []);

    // The widget's API, answered by api/gen8Swap.js against the fork.
    const api = await import("../../api/gen8Swap.js");
    const recorded = [];
    const deps = { getProvider: async () => provider, readPartner: async (id) => (id === "testpartner" ? { id } : null), rememberPartnerSwap: async (row) => recorded.push(row) };
    const routes = { "/api/widget/swap/gen8/token": api.gen8SwapTokenCore, "/api/widget/swap/gen8/balances": api.gen8SwapBalancesCore, "/api/widget/swap/gen8/quote": api.gen8SwapQuoteCore, "/api/widget/swap/gen8/build": api.gen8SwapBuildCore, "/api/widget/swap/gen8/status": api.gen8SwapStatusCore };
    const page = `<!doctype html><html><body><div id="mwz-swap"></div><script src="/widget/mwz-swap.js"></script></body></html>`;
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      res.setHeader("access-control-allow-origin", "*");
      if (url.pathname === "/") return res.end(page);
      if (url.pathname === "/widget/mwz-swap.js") {
        res.setHeader("content-type", "application/javascript");
        return res.end(fs.readFileSync(WIDGET));
      }
      const core = routes[url.pathname];
      if (!core) return res.writeHead(404).end();
      let body = "";
      for await (const c of req) body += c;
      const input = req.method === "POST" ? JSON.parse(body || "{}") : Object.fromEntries(url.searchParams);
      try {
        const out = await core(input, deps);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, ...out }));
      } catch (error) {
        res.writeHead(error.status || 500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: String(error.message) }));
      }
    });
    await new Promise((r) => server.listen(8794, "127.0.0.1", r));

    browser = await chromium.launch();
    const pageCtx = await browser.newPage();
    // window.ethereum backed by the trader's key on the fork
    await pageCtx.exposeFunction("__walletRpc", async (method, params) => {
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_requestAccounts") return [trader.address];
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_sendTransaction") {
        const t = params[0];
        const sent = await trader.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value || "0x0") });
        return sent.hash;
      }
      if (method === "eth_signTypedData_v4") {
        const typed = JSON.parse(params[1]);
        const { EIP712Domain, ...types } = typed.types;
        return trader.signTypedData(typed.domain, types, typed.message);
      }
      throw new Error(`unexpected wallet method ${method}`);
    });
    await pageCtx.addInitScript(() => {
      window.ethereum = { request: ({ method, params }) => window.__walletRpc(method, params || []) };
    });
    await pageCtx.goto("http://127.0.0.1:8794/");
    await pageCtx.evaluate(([token]) => window.MemeWarzoneSwap.mount("#mwz-swap", { chainId: 56, token, apiBase: "http://127.0.0.1:8794", partner: "testpartner" }), [launched.token]);
    const box = pageCtx.locator("#mwz-swap");
    await box.locator('[data-k="title"]').filter({ hasText: "Swap WDGT" }).waitFor({ timeout: 30_000 });
    await box.locator('[data-k="go"]').click(); // connect
    await box.locator('[data-k="balance"]').filter({ hasText: "Balance" }).waitFor({ timeout: 30_000 });

    const coin = new ethers.Contract(launched.token, ["function balanceOf(address) view returns (uint256)"], provider);
    await box.locator('[data-k="amount"]').fill("0.2");
    await box.locator('[data-k="out"]').filter({ hasText: "WDGT" }).waitFor({ timeout: 30_000 });
    await box.locator('[data-k="go"]').click();
    await box.locator('[data-k="msg"]').filter({ hasText: "Swap confirmed" }).waitFor({ timeout: 120_000 });
    const bought = BigInt(await coin.balanceOf(trader.address));
    assert.ok(bought > 0n, "the widget buy landed");
    assert.equal(recorded.length, 1, "partner build recorded");

    await box.locator('[data-k="sell"]').click();
    await box.locator('[data-k="amount"]').fill(ethers.formatUnits(bought / 2n, 18));
    await box.locator('[data-k="out"]').filter({ hasText: "BNB" }).waitFor({ timeout: 30_000 });
    await box.locator('[data-k="go"]').click();
    await box.locator('[data-k="msg"]').filter({ hasText: "Swap confirmed" }).waitFor({ timeout: 120_000 });
    assert.equal(BigInt(await coin.balanceOf(trader.address)), bought - bought / 2n, "the widget sell landed (approval + permit + swap)");
    assert.equal(recorded.length, 2);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await fork.stop();
  }
});
