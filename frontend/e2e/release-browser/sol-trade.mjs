#!/usr/bin/env node
/**
 * S2/S3: buy then sell a DBC coin on devnet from the real trade box; read the anti-sniper line, the
 * quote, and (for the creator) the lock sentence and the creator panel.
 *   node sol-trade.mjs <mint> <wallet> <stepId> <buySol> [sellFraction]
 */
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { APP, WORK, openSession, shot, solStorage } from "./browser.mjs";
import { record } from "./results.mjs";

const [mint, walletName, stepId, buySol = "0.02", sellFractionArg = "0.5"] = process.argv.slice(2);
const sellFraction = Number(sellFractionArg);
const s = await openSession({ sol: walletName, storage: solStorage() });
const { page } = s;
const conn = s.solBackend.connection;
const me = new PublicKey(s.solBackend.address);
const evidence = { cluster: "devnet", mint, wallet: me.toBase58(), shots: [] };
const snap = async (n) => evidence.shots.push(await shot(page, `${stepId}-${n}`));
const checks = {};
const body = () => page.locator("body").innerText().catch(() => "");
const tradeInput = () => page.locator('input[type="text"][placeholder="0"]').filter({ visible: true }).first();

async function tokenBalance() {
  const accs = await conn.getParsedTokenAccountsByOwner(me, { mint: new PublicKey(mint) });
  return accs.value.reduce((n, a) => n + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}
async function lastSig() {
  return (await conn.getSignaturesForAddress(me, { limit: 1 }))[0]?.signature || null;
}
async function waitNewSig(prev, label) {
  const t0 = Date.now();
  for (;;) {
    const sig = await lastSig();
    if (sig && sig !== prev) {
      const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (st.value?.confirmationStatus) return { sig, err: st.value.err };
    }
    if (Date.now() - t0 > 150_000) throw new Error(`${label}: no new signature; toasts: ${(await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => [])).join(" | ")}`);
    await page.waitForTimeout(2000);
  }
}

try {
  await page.goto(`${APP}/token/${mint}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const c = page.getByRole("button", { name: /connect/i }).first();
  if (await c.count()) { await c.click(); await page.getByRole("dialog").getByText(/Phantom/).first().click().catch(() => {}); }
  await page.waitForTimeout(12000);
  let t = await body();
  checks.antiSniperLine = (t.match(/Launch fee:[^\n]*/) || [null])[0];
  checks.creatorBadge = (t.match(/Creator holds[^\n]*/) || [null])[0];
  checks.lockSentence = (t.match(/As the creator, your buys are locked[^\n]*/) || [null])[0];
  await snap("1-page");

  // buy
  await tradeInput().fill(buySol);
  await page.waitForTimeout(5000);
  t = await body();
  checks.buyPay = (t.match(/Pay: [^\n]*/) || [null])[0];
  checks.buyReceive = (t.match(/Receive: [^\n]*/) || [null])[0];
  await snap("2-buy-quote");
  const bal0 = await tokenBalance();
  let prev = await lastSig();
  await page.getByRole("button", { name: /^Buy [$A-Z0-9]+$|^BUY$|^Buy$/i }).filter({ visible: true }).last().click();
  const buy = await waitNewSig(prev, "buy");
  evidence.buySig = buy.sig;
  checks.buyErr = buy.err;
  await page.waitForTimeout(6000);
  const bal1 = await tokenBalance();
  checks.walletTokenDeltaBuy = (bal1 - bal0).toString();
  await snap("3-after-buy");

  // sell
  if (sellFraction > 0 && bal1 > 0n) {
    const amt = (bal1 * BigInt(Math.round(sellFraction * 1000))) / 1000n;
    await page.getByRole("tab", { name: /^Sell$/ }).first().click();
    await page.waitForTimeout(1500);
    const toToken = page.getByRole("button", { name: /^Switch to \$/ }).filter({ visible: true }).first();
    if (await toToken.count()) await toToken.click();
    await page.waitForTimeout(800);
    const decimals = (await conn.getParsedAccountInfo(new PublicKey(mint))).value?.data?.parsed?.info?.decimals ?? 6;
    const whole = Number(amt) / 10 ** decimals;
    await tradeInput().fill(String(Math.floor(whole)));
    await page.waitForTimeout(5000);
    t = await body();
    checks.sellQuote = (t.match(/(Payout|Receive)[^\n]*/g) || []).slice(0, 3);
    await snap("4-sell-quote");
    prev = await lastSig();
    await page.getByRole("button", { name: /^Sell [$A-Z0-9]+$|^SELL$|^Sell$/i }).filter({ visible: true }).last().click();
    const sell = await waitNewSig(prev, "sell");
    evidence.sellSig = sell.sig;
    checks.sellErr = sell.err;
    await page.waitForTimeout(6000);
    checks.walletTokenDeltaSell = ((await tokenBalance()) - bal1).toString();
    await snap("5-after-sell");
  }
  t = await body();
  const i = t.search(/CREATOR REWARDS|Creator rewards/);
  if (i >= 0) checks.creatorPanel = t.slice(i, i + 900);
  checks.creatorBadgeAfter = (t.match(/Creator holds[^\n]*/) || [null])[0];
  const ok = !checks.buyErr && (sellFraction > 0 ? !checks.sellErr && Boolean(evidence.sellSig) : true);
  record(stepId, ok ? "PASS" : "FAIL", { ...evidence, checks });
} catch (error) {
  await snap("error").catch(() => {});
  record(stepId, "FAIL", { ...evidence, checks, error: String(error?.message || error).slice(0, 800), logs: s.logs.filter((l) => !/Router Future|ably|inbox/.test(l)).slice(-20) });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(WORK, `${stepId}-console.log`), s.logs.join("\n"));
  await s.browser.close();
}
