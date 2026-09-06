#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, "..");
const outDir = resolve(frontendRoot, "../reports/create-graduation-market");
const port = Number(process.env.CREATE_CAPTURE_PORT || 4177);
const baseUrl = `http://127.0.0.1:${port}`;

mkdirSync(outDir, { recursive: true });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const VIEWPORTS = [
  { name: "320", width: 320, height: 568 },
  { name: "360", width: 360, height: 640 },
  { name: "375", width: 375, height: 667 },
  { name: "390", width: 390, height: 844 },
  { name: "412", width: 412, height: 915 },
  { name: "430", width: 430, height: 932 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
];

function quoteItems(chainId) {
  const nativeSymbol = chainId === 101 ? "SOL" : chainId === 56 || chainId === 97 ? "BNB" : "ETH";
  const native = {
    id: `native:${chainId}`,
    provider: { key: chainId === 101 ? "solana-basic" : chainId === 4663 ? "robinhood-basic" : "bnb-basic", displayName: "BASIC" },
    chainId: String(chainId),
    identityKind: "NATIVE",
    contractAddressOrMint: `native:${chainId}`,
    assetClass: "NATIVE",
    symbol: nativeSymbol,
    displayName: nativeSymbol,
    newGraduationEligible: true,
    policy: { authority: "generic", policyKey: "native", version: 1 },
  };
  if (chainId === 101) {
    return [native, { ...native, id: "sol-usdc", identityKind: "SOLANA_MINT", assetClass: "STABLECOIN", symbol: "USDC", displayName: "USD Coin", contractAddressOrMint: "UsdcMint111111111111111111111111111111111" }];
  }
  if (chainId === 56 || chainId === 97) {
    return [native, { ...native, id: "bnb-usdc", identityKind: "EVM_ADDRESS", assetClass: "STABLECOIN", symbol: "USDC", displayName: "USD Coin", contractAddressOrMint: "0x00000000000000000000000000000000000000aa" }];
  }
  return [
    native,
    { ...native, id: "rh-usdc", provider: { key: "robinhood-basic", displayName: "Robinhood BASIC" }, identityKind: "EVM_ADDRESS", assetClass: "STABLECOIN", symbol: "USDC", displayName: "USD Coin", contractAddressOrMint: "0x00000000000000000000000000000000000000bb" },
    { ...native, id: "rh-stock:nvda", provider: { key: "robinhood-stock-token", displayName: "Robinhood Stock Token Registry", authorityMode: "ROBINHOOD_STOCK_REGISTRY" }, identityKind: "EVM_ADDRESS", assetClass: "PROVIDER_RWA", symbol: "NVDA", displayName: "NVIDIA", contractAddressOrMint: "0x0000000000000000000000000000000000000aaa" },
    { ...native, id: "rh-stock:tsla", provider: { key: "robinhood-stock-token", displayName: "Robinhood Stock Token Registry", authorityMode: "ROBINHOOD_STOCK_REGISTRY" }, identityKind: "EVM_ADDRESS", assetClass: "PROVIDER_RWA", symbol: "TSLA", displayName: "Tesla", contractAddressOrMint: "0x0000000000000000000000000000000000000bbb" },
    { ...native, id: "rh-other", provider: { key: "robinhood-basic", displayName: "Robinhood BASIC" }, identityKind: "EVM_ADDRESS", assetClass: "MWZ_NATIVE", symbol: "WBTC", displayName: "Wrapped Bitcoin", contractAddressOrMint: "0x0000000000000000000000000000000000000ccc" },
  ];
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status === 404) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startVite() {
  const child = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: frontendRoot,
    env: {
      ...process.env,
      VITE_ALLOWED_CHAIN_IDS: "56,97,101,4663,46630",
      VITE_DEFAULT_CHAIN_ID: "56",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer(`${baseUrl}/create`);
  return child;
}

async function mockApis(page, chainId) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.includes("/graduation/quote-assets")) {
      const id = path.split("/quote-assets/")[1];
      if (id) {
        const item = quoteItems(chainId).find((entry) => entry.id === decodeURIComponent(id));
        return route.fulfill({ status: item ? 200 : 404, contentType: "application/json", body: JSON.stringify(item ? { ok: true, item } : { ok: false, error: "not found" }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, chainId: String(chainId), authority: "server", items: quoteItems(chainId) }),
      });
    }
    if (path.includes("ticker-availability")) {
      const ticker = url.searchParams.get("ticker") || "DOGE";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ticker, available: true, reason: "Ticker available." }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, items: [] }) });
  });
}

async function fillIdentity(page) {
  await page.locator('input[type="file"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await page.getByPlaceholder("WhatIsThisForACoin").fill("DogeBrigade");
  await page.getByPlaceholder("TICKER").fill("DOGE");
  await page.waitForTimeout(700);
}

async function clickNext(page) {
  const next = page.locator("button.mwz-button-orange", { hasText: /^Next$/ }).first();
  await next.click({ timeout: 15000 });
}

async function walkToStep(page, targetStep) {
  console.log(`  walk -> step ${targetStep}`);
  await page.getByRole("button", { name: /Draft mode/i }).click();
  if (targetStep === 1) return;
  await clickNext(page);
  await page.getByTestId("create-step-2").waitFor();
  if (targetStep === 2) return;
  await fillIdentity(page);
  await clickNext(page);
  await page.getByTestId("create-step-3").waitFor();
  if (targetStep === 3) return;
  await page.getByPlaceholder("What should visitors know?").fill("A warzone meme coin for the brigade.");
  await clickNext(page);
  await page.getByTestId("create-step-4").waitFor();
  if (targetStep === 4) return;
  await clickNext(page);
  await page.getByTestId("graduation-market-step").waitFor();
  if (targetStep === 5) return;
  await clickNext(page);
  await page.getByTestId("create-review").waitFor();
}

async function shot(page, name) {
  const file = resolve(outDir, `${name}.png`);
  const viewport = page.viewportSize();
  const fullPage = !viewport || viewport.width >= 768;
  await page.screenshot({ path: file, fullPage });
  return file;
}

const CHAINS = [
  { id: 101, label: "solana" },
  { id: 56, label: "bnb" },
  { id: 4663, label: "robinhood" },
];

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME || "/home/patrick/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const files = [];
  try {
    for (const chain of CHAINS) {
      console.log("chain", chain.label);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await mockApis(page, chain.id);
      await page.goto(`${baseUrl}/create?chainId=${chain.id}`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-step-1").waitFor();

      await walkToStep(page, 1);
      files.push(await shot(page, `${chain.label}-step1-path`));
      await walkToStep(page, 5);
      files.push(await shot(page, `${chain.label}-step5-graduation-market`));
      if (chain.id === 4663) {
        await page.getByTestId("graduation-category-STOCKS_ETFS").click();
        await page.getByTestId("quote-asset-NVDA").click();
        files.push(await shot(page, `${chain.label}-step5-stocks`));
        await page.getByTestId("graduation-category-STABLECOINS").click();
        files.push(await shot(page, `${chain.label}-step5-stables`));
        await page.getByTestId("quote-asset-USDC").click();
        await page.getByTestId("graduation-category-CRYPTO").click();
        files.push(await shot(page, `${chain.label}-step5-other`));
        await page.getByTestId("graduation-category-STOCKS_ETFS").click();
        await page.getByTestId("quote-asset-NVDA").click();
      }
      await clickNext(page);
      await page.getByTestId("create-review").waitFor();
      files.push(await shot(page, `${chain.label}-step6-review`));
      await context.close();
    }

    const proof = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await proof.newPage();
    await mockApis(page, 4663);
    await page.goto(`${baseUrl}/create?chainId=4663`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("create-step-1").waitFor();
    await walkToStep(page, 1);
    files.push(await shot(page, "six-step-1"));
    await clickNext(page);
    await page.getByTestId("create-step-2").waitFor();
    await fillIdentity(page);
    files.push(await shot(page, "six-step-2"));
    await clickNext(page);
    await page.getByTestId("create-step-3").waitFor();
    await page.getByPlaceholder("What should visitors know?").fill("A warzone meme coin for the brigade.");
    files.push(await shot(page, "six-step-3"));
    await clickNext(page);
    await page.getByTestId("create-step-4").waitFor();
    files.push(await shot(page, "six-step-4"));
    await clickNext(page);
    await page.getByTestId("graduation-market-step").waitFor();
    files.push(await shot(page, "six-step-5"));
    await clickNext(page);
    await page.getByTestId("create-review").waitFor();
    files.push(await shot(page, "six-step-6"));
    await proof.close();

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const vpPage = await context.newPage();
      await mockApis(vpPage, 4663);
      await vpPage.goto(`${baseUrl}/create?chainId=4663`, { waitUntil: "domcontentloaded" });
      await vpPage.getByTestId("create-step-1").waitFor();
      await walkToStep(vpPage, 5);
      await vpPage.getByTestId("graduation-category-STOCKS_ETFS").click();
      await vpPage.getByTestId("quote-asset-NVDA").click();
      files.push(await shot(vpPage, `responsive-${viewport.name}-step5`));
      await clickNext(vpPage).catch(async () => {
        await vpPage.locator("button.mwz-button-orange").last().click();
      });
      await vpPage.getByTestId("create-review").waitFor();
      files.push(await shot(vpPage, `responsive-${viewport.name}-step6`));
      await context.close();
    }

    writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2));
    console.log(`Wrote ${files.length} screenshots to ${outDir}`);
  } finally {
    await browser.close();
    vite.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
