#!/usr/bin/env node
/**
 * S1: Meteora DBC launch (SOL pairing) from the real create page on devnet, signed by a throwaway
 * Phantom-shaped wallet (keys stay in Node; the RPC genesis hash must be devnet's).
 *   node sol-create.mjs [walletName]
 */
import fs from "node:fs";
import path from "node:path";
import { APP, REPO, WORK, openSession, shot, solStorage } from "./browser.mjs";
import { record } from "./results.mjs";

const walletName = process.argv[2] || "creator";
const s = await openSession({ sol: walletName, storage: solStorage() });
const { page } = s;
const evidence = { cluster: "devnet", wallet: s.solBackend.address, shots: [] };
const snap = async (n) => evidence.shots.push(await shot(page, `S1-${n}`));
const next = () => page.getByRole("button", { name: /^Next$/ }).click();
const checks = {};
try {
  await page.goto(`${APP}/create?chainId=101`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /connect/i }).first().click();
  await page.getByRole("dialog").getByText(/Phantom/).first().click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /Direct deploy/i }).click();
  await snap("1-path");
  await next();
  await page.setInputFiles("input[type=file]", path.join(REPO, "frontend/public/images/mw.png"));
  const ticker = `RBS${String(Date.now()).slice(-4)}`;
  await page.getByPlaceholder("WhatIsThisForACoin").fill(`Release Browser SOL ${ticker.slice(-4)}`);
  await page.getByPlaceholder("TICKER").fill(ticker);
  evidence.ticker = ticker;
  await page.waitForTimeout(3000);
  await snap("2-identity");
  await next();
  await page.getByPlaceholder("What should visitors know?").fill("Release browser test coin on Solana devnet (Meteora DBC).");
  await next();
  await page.waitForTimeout(5000);
  const step4 = page.locator('[data-testid="create-step-4"]');
  checks.step4 = (await step4.innerText()).slice(0, 2000);
  const test = step4.getByRole("button", { name: /^\$150 / });
  if (await test.count()) await test.click();
  await step4.getByRole("button", { name: /^SOL\b/ }).first().click().catch(() => {});
  await step4.getByText("Keep it", { exact: true }).click();
  await step4.getByPlaceholder(/SOL amount/).fill("0.01");
  await page.waitForTimeout(3000);
  checks.firstBuyLine = (await step4.innerText()).match(/About [^\n]*of supply[^\n]*/)?.[0] || null;
  await step4.evaluate((el) => { const sc = el.querySelector(".overflow-y-auto"); if (sc) sc.scrollTop = 0; });
  await snap("4a-bond-top");
  await step4.evaluate((el) => { const sc = el.querySelector(".overflow-y-auto"); if (sc) sc.scrollTop = sc.scrollHeight; });
  await snap("4b-bond-fee-firstbuy");
  await next();
  await page.waitForTimeout(1500);
  await snap("5-graduation");
  await next();
  await page.waitForTimeout(2000);
  checks.review = await page.getByTestId("create-review").innerText();
  await snap("6-review");
  const before = s.solBackend.sent.length;
  await page.getByRole("button", { name: /Deploy now/ }).click();
  const t0 = Date.now();
  const toasts = new Set();
  while (!/\/token\/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(page.url())) {
    if (Date.now() - t0 > 300_000) throw new Error(`no token page after deploy; toasts: ${[...toasts].join(" | ")}`);
    for (const t of await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => [])) toasts.add(t.replace(/\s+/g, " ").slice(0, 300));
    await page.waitForTimeout(1000);
  }
  evidence.toasts = [...toasts];
  evidence.tokenUrl = page.url();
  evidence.mint = page.url().match(/\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/)[1];
  evidence.signatures = s.solBackend.sent.slice(before);
  const lines = [];
  for (let i = 0; i < 6; i++) {
    const body = await page.locator("body").innerText().catch(() => "");
    lines.push({ t: new Date().toISOString(), line: (body.match(/Launch fee:[^\n]*/) || [null])[0] });
    if (i === 1) await snap("7a-token-page-launch-fee");
    await page.waitForTimeout(5000);
  }
  evidence.feeLines = lines;
  await snap("7-token-page");
  fs.writeFileSync(path.join(WORK, "coin-devnet.json"), JSON.stringify({ ...evidence, checks }, null, 1));
  record("S1", evidence.mint ? "PASS" : "FAIL", { ...evidence, checks: { ...checks, step4: undefined } });
} catch (error) {
  await snap("error").catch(() => {});
  record("S1", "FAIL", { ...evidence, checks: { ...checks, step4: checks.step4?.slice(0, 600) }, error: String(error?.message || error).slice(0, 800), logs: s.logs.filter((l) => !/Router Future|ably|inbox/.test(l)).slice(-25) });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(WORK, "S1-console.log"), s.logs.join("\n"));
  await s.browser.close();
}
