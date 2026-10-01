#!/usr/bin/env node
/**
 * E1: create a generation-6 coin from the real create page with a real testnet wallet.
 *   node evm-create.mjs <46630|97> [prefix]
 * Writes reports/browser-release/<prefix>-*.png and records the result; prints the campaign address.
 */
import fs from "node:fs";
import path from "node:path";
import { APP, REPO, SHOTS, WORK, evmStorage, openSession, shot } from "./browser.mjs";
import { record } from "./results.mjs";

const chainId = Number(process.argv[2] || 46630);
if (chainId !== 46630 && chainId !== 97) throw new Error("test chains only");
const prefix = process.argv[3] || (chainId === 46630 ? "E1-rh" : "E1-bsc");
const walletName = process.argv[4] || (chainId === 46630 ? "creator" : "creator97");
const stepId = process.argv[5] || (chainId === 46630 ? "E1" : "E1-bsc");
const firstBuy = chainId === 46630 ? "0.0004" : "0.0004";
const feeChoice = chainId === 46630 ? "Split" : "Keep it";

const s = await openSession({ evm: walletName, evmChainId: chainId, storage: evmStorage(chainId) });
const { page } = s;
const evidence = { chainId, wallet: s.evmBackend.address, shots: [] };
const snap = async (n) => evidence.shots.push(await shot(page, `${prefix}-${n}`));
const next = () => page.getByRole("button", { name: /^Next$/ }).click();
const checks = {};
try {
  await page.goto(`${APP}/create?chainId=${chainId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /connect/i }).first().click();
  await page.getByText("MetaMask").first().click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /Direct deploy/i }).click();
  await snap("1-path");
  await next();
  await page.setInputFiles("input[type=file]", path.join(REPO, "frontend/public/images/mw.png"));
  const ticker = `RB${chainId === 46630 ? "R" : "B"}${String(Date.now()).slice(-4)}`;
  await page.getByPlaceholder("WhatIsThisForACoin").fill(`Release Browser ${chainId === 46630 ? "RH" : "BSC"} ${ticker.slice(-4)}`);
  await page.getByPlaceholder("TICKER").fill(ticker);
  evidence.ticker = ticker;
  await page.waitForTimeout(2500);
  await snap("2-identity");
  await next();
  await page.getByPlaceholder("What should visitors know?").fill(`Release browser test coin on ${chainId === 46630 ? "Robinhood" : "BNB"} testnet.`);
  await snap("3-story");
  await next();
  const step4 = page.locator('[data-testid="create-step-4"]');
  await step4.getByRole("button", { name: /^\$6 / }).click();
  await page.waitForTimeout(4000);
  // Limits shown for the first buy
  const limitText = await step4.getByText(/Most you can buy now/).innerText();
  checks.limitLine = limitText;
  checks.limitIsTargetHalf = /half of the graduation target/.test(limitText);
  // Also show the 10% supply limit wording at a large target
  await step4.getByRole("button", { name: /^\$30K / }).click();
  await page.waitForTimeout(3000);
  checks.limitAt30k = await step4.getByText(/Most you can buy now/).innerText();
  checks.limitIsSupply10 = /10% of the supply/.test(checks.limitAt30k);
  await step4.getByRole("button", { name: /^\$6 / }).click();
  await page.waitForTimeout(3000);
  const picker = ["Keep it", "Give it to holders", "Split", "Buyback and burn"];
  checks.feeOptions = [];
  for (const label of picker) if (await step4.getByText(label, { exact: true }).count()) checks.feeOptions.push(label);
  await step4.getByText(feeChoice, { exact: true }).click();
  if (feeChoice === "Split") {
    const pct = step4.locator('input[type=number][max="99"]');
    await pct.fill("40");
    checks.splitPctInput = await pct.inputValue();
  }
  await page.getByTestId("evm-first-buy-input").fill(firstBuy);
  await page.waitForTimeout(1500);
  checks.firstBuyLine = await step4.getByText(/of supply for/).innerText().catch(() => "");
  await step4.evaluate((el) => { const sc = el.querySelector(".overflow-y-auto"); if (sc) sc.scrollTop = 0; });
  await snap("4a-bond-top");
  await step4.evaluate((el) => { const sc = el.querySelector(".overflow-y-auto"); if (sc) sc.scrollTop = sc.scrollHeight; });
  await snap("4b-bond-fee-firstbuy");
  await next();
  await page.waitForTimeout(3000);
  await snap("5-market");
  const step5Next = page.getByRole("button", { name: /^Next$/ });
  if (await step5Next.isDisabled().catch(() => false)) {
    // Pick the native quote if nothing is selected.
    await page.getByText(/^ETH$|^BNB$/).first().click().catch(() => {});
  }
  await next();
  await page.waitForTimeout(2000);
  const review = await page.getByTestId("create-review").innerText();
  checks.review = review;
  checks.reviewHasFee = /Creator fee/.test(review);
  checks.reviewHasFirstBuy = /First buy/.test(review) && !/First buy\s*None/.test(review);
  await snap("6-review");
  const before = s.evmBackend.sent.length;
  await page.getByRole("button", { name: /Deploy now/ }).click();
  // Wait until the page leaves /create for the token page.
  const t0 = Date.now();
  const toasts = new Set();
  while (!/\/token\/0x[0-9a-fA-F]{40}/.test(page.url())) {
    if (Date.now() - t0 > 240_000) throw new Error(`no token page after deploy; toasts: ${[...toasts].join(" | ")}`);
    for (const t of await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => [])) toasts.add(t.replace(/\s+/g, " ").slice(0, 300));
    await page.waitForTimeout(1000);
  }
  evidence.toasts = [...toasts];
  // E2 (first half): the launch-fee line must count down during the first 60 s.
  const feeLines = [];
  for (let i = 0; i < 6; i++) {
    const body = await page.locator("body").innerText().catch(() => "");
    const m = body.match(/Launch fee:[^\n]*/);
    feeLines.push({ t: new Date().toISOString(), line: m ? m[0] : null });
    if (i === 1) await snap("7a-launch-fee-countdown");
    await page.waitForTimeout(5000);
  }
  evidence.feeLines = feeLines;
  const url = page.url();
  evidence.tokenUrl = url;
  evidence.campaign = url.match(/\/token\/(0x[0-9a-fA-F]{40})/)[1];
  evidence.txs = s.evmBackend.sent.slice(before).map((t) => t.hash);
  await snap("7-token-page");
  const pass = checks.limitIsTargetHalf && checks.limitIsSupply10 && checks.feeOptions.length === 4 && checks.reviewHasFee && checks.reviewHasFirstBuy && evidence.txs.length >= 1;
  record(stepId, pass ? "PASS" : "FAIL", { ...evidence, checks });
  fs.writeFileSync(path.join(WORK, `coin-${chainId}.json`), JSON.stringify({ ...evidence, checks }, null, 1));
} catch (error) {
  await snap("error").catch(() => {});
  record(stepId, "FAIL", { ...evidence, checks, error: String(error?.message || error).slice(0, 800), logs: s.logs.slice(-25) });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(WORK, `${prefix}-console.log`), s.logs.join("\n"));
  await s.browser.close();
}
