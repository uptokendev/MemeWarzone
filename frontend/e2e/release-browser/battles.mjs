#!/usr/bin/env node
/**
 * E6: vote-battle durations offered in the challenge modal (6/12/24/48 h), a battle card without a
 * description, and the battle share card image with both coin images.
 *   node battles.mjs
 * Sends one vote-battle challenge (a wallet signature; no transaction) from the creator's graduated
 * RH testnet coin to another graduated RH testnet coin.
 */
import fs from "node:fs";
import path from "node:path";
import { APP, SHOTS, evmStorage, openSession, shot } from "./browser.mjs";
import { record } from "./results.mjs";

const s = await openSession({ evm: "creator", evmChainId: 46630, storage: evmStorage(46630) });
const { page } = s;
const evidence = { shots: [] };
const snap = async (n) => evidence.shots.push(await shot(page, `E6-${n}`));
const checks = {};
let battleId = null;
page.on("response", async (r) => {
  if (/\/api\/arena\/battles\/challenge/.test(r.url()) && r.request().method() === "POST") {
    try { const j = await r.json(); battleId = j?.battle?.battleId || j?.battleId || j?.battle?.id || battleId; checks.challengeResponse = { status: r.status(), battleId }; } catch {}
  }
});
try {
  await page.goto(`${APP}/warzone/battles?chainId=46630`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const c = page.getByRole("button", { name: /connect/i }).first();
  if (await c.count()) { await c.click(); await page.getByText("MetaMask").first().click().catch(() => {}); }
  await page.waitForTimeout(6000);
  await page.getByRole("button", { name: /challenge a coin/i }).first().click();
  await page.waitForTimeout(1500);
  const d = page.getByRole("dialog");
  await d.getByRole("button", { name: /Vote Battle/i }).first().click();
  await snap("1-type");
  await d.getByRole("button", { name: /^Next$/ }).first().click();
  await page.waitForTimeout(6000);
  await d.getByText("$RHA87595").first().click();
  await page.waitForTimeout(800);
  await snap("2-opponent");
  await d.getByRole("button", { name: /^Next$/ }).first().click();
  await page.waitForTimeout(1500);
  const step3 = await d.innerText();
  checks.durationsOffered = ["6 hours", "12 hours", "24 hours", "48 hours", "3 days", "7 days"].filter((l) => step3.toLowerCase().includes(l));
  checks.voteDurationsOk = JSON.stringify(checks.durationsOffered) === JSON.stringify(["6 hours", "12 hours", "24 hours", "48 hours"]);
  await d.getByRole("button", { name: "6 hours" }).click();
  const stake = d.getByPlaceholder(/Amount in/);
  await stake.fill("0.0001");
  await snap("3-terms-durations");
  await d.getByRole("button", { name: /^Next$/ }).first().click();
  await page.waitForTimeout(1500);
  checks.review = (await d.innerText()).match(/Review & confirm[\s\S]*?Mode\s*\n?\s*[^\n]+/)?.[0] || null;
  await snap("4-review");
  await d.getByRole("button", { name: /^Confirm$/ }).first().click();
  const t0 = Date.now();
  while (!checks.challengeResponse && Date.now() - t0 < 60_000) await page.waitForTimeout(1000);
  await page.waitForTimeout(4000);
  checks.toasts = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
  // Battle card(s)
  await page.keyboard.press("Escape").catch(() => {});
  await page.goto(`${APP}/warzone/battles?chainId=46630`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10000);
  for (const tab of ["UPCOMING", "MY BATTLES"]) {
    const t = page.getByRole("button", { name: new RegExp(`^${tab}$`, "i") }).first();
    if (await t.count()) { await t.click(); await page.waitForTimeout(4000); }
    const cards = page.locator("main").filter({ hasText: /RBR3859 VS \$RHA87595/i });
    checks[`cards_${tab}`] = await cards.count();
    if (await cards.count()) {
      const text = await cards.first().innerText();
      checks[`cardText_${tab}`] = text.slice(0, 600);
      await snap(`5-card-${tab.toLowerCase().replace(/\s+/g, "-")}`);
    }
  }
  checks.cardHasDescription = Object.entries(checks).some(([k, v]) => k.startsWith("cardText_") && /Release browser test coin on/.test(String(v)));
  // Share card image straight from the API
  if (battleId) {
    for (const q of [`battleId=${encodeURIComponent(battleId)}`, `id=${encodeURIComponent(battleId)}`]) {
      const res = await fetch(`http://127.0.0.1:3001/api/battle-share-card?${q}&chainId=46630`);
      checks.shareCard = { status: res.status, type: res.headers.get("content-type"), query: q };
      if (res.ok && /image/.test(res.headers.get("content-type") || "")) {
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(path.join(SHOTS, "E6-6-share-card.png"), buf);
        evidence.shots.push("E6-6-share-card.png");
        checks.shareCard.bytes = buf.length;
        break;
      }
    }
  }
  const pass = checks.voteDurationsOk && Boolean(battleId) && !checks.cardHasDescription && Boolean(checks.shareCard?.bytes);
  record("E6", pass ? "PASS" : "FAIL", { ...evidence, battleId, checks });
} catch (error) {
  await snap("error").catch(() => {});
  record("E6", "FAIL", { ...evidence, battleId, checks, error: String(error?.message || error).slice(0, 600), logs: s.logs.filter((l) => /http [45]|pageerror/.test(l) && !/ably/.test(l)).slice(-15) });
  process.exitCode = 1;
} finally {
  await s.browser.close();
}
