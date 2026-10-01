/**
 * Browser session helpers: a Chromium page on the local vite app with a real test wallet injected.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installEvmWallet, installSolanaWallet, makeEvmBackend, makeSolanaBackend } from "./walletBridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "../../..");
export const APP = process.env.MWZ_APP_URL || "http://127.0.0.1:5173";
export const SHOTS = path.join(REPO, "reports/browser-release");
export const WORK = process.env.MWZ_BROWSER_WORK || path.join(os.homedir(), "mwz-browser");
const MAIN = process.env.MWZ_MAIN_REPO || "/mnt/e/network/Zakelijk/MemeWarzone";
fs.mkdirSync(SHOTS, { recursive: true });

export const wallets = JSON.parse(fs.readFileSync(path.join(WORK, "wallets.json"), "utf8"));
const rootEnv = Object.fromEntries(
  fs.readFileSync(path.join(MAIN, ".env"), "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const heliusKey = (fs.readFileSync(path.join(MAIN, "frontend/.env.local"), "utf8").match(/SOLANA_RPC_URL=.*api-key=([^&"\s]+)/) || [])[1];
export const RPC = {
  46630: "https://rpc.testnet.chain.robinhood.com",
  97: rootEnv.BSC_TESTNET_RPC,
  devnet: process.env.MWZ_DEVNET_RPC || (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : "https://api.devnet.solana.com"),
};

export async function openSession({ evm, evmChainId = 46630, sol, storage = {}, headless = true } = {}) {
  // WSL without sudo: Chromium's NSS/ALSA libraries unpacked from their .debs (apt-get download).
  const libs = process.env.MWZ_PW_LIBS || path.join(os.homedir(), "pwlibs/root/usr/lib/x86_64-linux-gnu");
  const env = fs.existsSync(libs) ? { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : process.env;
  const browser = await chromium.launch({ headless, env });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "UTC" });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`.slice(0, 400)); });
  page.on("response", (r) => { if (r.status() >= 400 && /\/api\//.test(r.url())) logs.push(`[http ${r.status()}] ${r.request().method()} ${r.url().replace(/api-key=[^&]+/, "api-key=***")}`.slice(0, 300)); });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e?.message || e).slice(0, 400)}`));
  let evmBackend = null;
  let solBackend = null;
  if (evm) {
    evmBackend = makeEvmBackend({ privateKey: wallets.evm[evm].pk, rpcByChain: { 46630: RPC[46630], 97: RPC[97] }, initialChainId: evmChainId, log: (s) => logs.push(s) });
    await installEvmWallet(page, evmBackend);
  }
  if (sol) {
    solBackend = await makeSolanaBackend({ secretKey: wallets.sol[sol].secret, rpcUrl: RPC.devnet, log: (s) => logs.push(s) });
    await installSolanaWallet(page, solBackend);
  }
  // Logo storage is Supabase in production and is not part of this test. The create page refuses a
  // data: URL for the on-chain logoURI (correctly), so answer the upload with a short hosted URL that
  // the local vite server serves. Everything else in the create flow is the real API.
  await page.route(/\/api\/upload\?/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const kind = new URL(route.request().url()).searchParams.get("kind") || "logo";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, url: `${APP}/images/mw.png?mwz-test=${kind}-${Date.now()}` }) });
  });
  await page.addInitScript((kv) => {
    try {
      for (const [k, v] of Object.entries(kv)) window.localStorage.setItem(k, v);
    } catch {}
  }, storage);
  return { browser, context, page, logs, evmBackend, solBackend };
}

export function evmStorage(chainId) {
  return {
    "mwz:active_wallet_kind": "bnb",
    "mwz:selected_feed_chain_id": String(chainId),
    "mwz:last_featured_chain_id": String(chainId),
    "mwz:last_evm_chain_id": String(chainId),
    "mwz:token_details_chain_id": String(chainId),
  };
}

export function solStorage() {
  return {
    "mwz:active_wallet_kind": "solana",
    "mwz:selected_feed_chain_id": "101",
    "mwz:last_featured_chain_id": "101",
  };
}

export async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return `${name}.png`;
}
