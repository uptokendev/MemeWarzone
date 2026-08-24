import { defineConfig } from "@playwright/test";

const isolationEnv = {
  VITE_ENABLE_WAR_ROOM: "true",
  VITE_ENABLE_UNIFIED_MARKET_CHART: "1",
  VITE_ENABLE_TESTNET_CAMPAIGNS: "true",
  VITE_ENABLE_TESTNET_FEATURED_FEED: "true",
  VITE_DEFAULT_CHAIN_ID: "97",
  VITE_PUBLIC_RPC_56: "https://rpc-evm-56.test.mwz",
  VITE_PUBLIC_RPC_97: "https://rpc-evm-97.test.mwz",
  VITE_BSC_RPC_56: "https://rpc-evm-56.test.mwz",
  VITE_BSC_RPC_97: "https://rpc-evm-97.test.mwz",
  VITE_BSC_MAINNET_RPC: "https://rpc-evm-56.test.mwz",
  VITE_BSC_TESTNET_RPC: "https://rpc-evm-97.test.mwz",
  VITE_SOLANA_RPC: "https://rpc-solana-101.test.mwz",
  VITE_SOLANA_MAINNET_RPC: "https://rpc-solana-101.test.mwz",
  VITE_PUBLIC_RPC_SOLANA: "https://rpc-solana-101.test.mwz",
  VITE_PUBLIC_RPC_101: "https://rpc-solana-101.test.mwz",
};

const skipBuild = process.env.PLAYWRIGHT_SKIP_WEBSERVER_BUILD === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: skipBuild
      ? "node e2e/preview-spa.mjs"
      : "npx vite build && node e2e/preview-spa.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { ...process.env, ...isolationEnv },
  },
});
