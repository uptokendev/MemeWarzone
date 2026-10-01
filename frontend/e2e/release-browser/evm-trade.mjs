#!/usr/bin/env node
/**
 * E2/E3: buy then sell on a generation-5 campaign page from the real trade box, and read the quote,
 * the launch-fee line, the creator badge and (for the creator) the lock sentence and escrow panel.
 *   node evm-trade.mjs <campaign> <chainId> <wallet> <stepId> <buyNative> [sellFraction]
 * The on-chain fee of each trade is recomputed from the campaign's own quote functions at the block
 * before the trade, so the check is against the chain, not against the page.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { APP, RPC, WORK, evmStorage, openSession, shot } from "./browser.mjs";
import { record } from "./results.mjs";

const [campaignArg, chainArg, walletName, stepId, buyNative = "0.0003", sellFractionArg = "0.5"] = process.argv.slice(2);
const chainId = Number(chainArg);
if (chainId !== 46630 && chainId !== 97) throw new Error("test chains only");
const campaign = ethers.getAddress(campaignArg);
const sellFraction = Number(sellFractionArg);
const provider = new ethers.JsonRpcProvider(RPC[chainId], undefined, { staticNetwork: true });
if (Number(await provider.send("eth_chainId", [])) !== chainId) throw new Error("rpc chain mismatch");
const gen5Abi = JSON.parse(fs.readFileSync(new URL("../../src/abi/LaunchCampaignGen5.json", import.meta.url), "utf8"));
const C = new ethers.Contract(campaign, gen5Abi.abi || gen5Abi, provider);
const token = new ethers.Contract(await C.token(), ["function balanceOf(address) view returns (uint256)"], provider);

const s = await openSession({ evm: walletName, evmChainId: chainId, storage: evmStorage(chainId) });
const { page } = s;
const me = s.evmBackend.address;
const evidence = { chainId, campaign, wallet: me, shots: [] };
const snap = async (n) => evidence.shots.push(await shot(page, `${stepId}-${n}`));
const checks = {};
const bodyText = () => page.locator("body").innerText().catch(() => "");
const tradeInput = () => page.locator('input[type="text"][placeholder="0"]').filter({ visible: true }).first();

/** Wait for the page to send a transaction to the campaign (an approve to the token may come first). */
async function waitSent(before, label) {
  const t0 = Date.now();
  for (;;) {
    const mine = s.evmBackend.sent.slice(before).filter((t) => String(t.to || "").toLowerCase() === campaign.toLowerCase());
    if (mine.length) {
      const rcpt = await provider.waitForTransaction(mine[mine.length - 1].hash, 1, 180_000);
      return { hashes: s.evmBackend.sent.slice(before).map((t) => t.hash), rcpt };
    }
    if (Date.now() - t0 > 180_000) throw new Error(`${label}: no campaign transaction sent; toasts: ${(await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => [])).join(" | ")}`);
    await page.waitForTimeout(1000);
  }
}

function parse(rcpt) {
  const out = [];
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== campaign.toLowerCase()) continue;
    try { out.push(C.interface.parseLog(log)); } catch {}
  }
  return out;
}

try {
  await page.goto(`${APP}/token/${campaign}?chainId=${chainId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const c = page.getByRole("button", { name: /connect/i }).first();
  if (await c.count()) {
    await c.click();
    await page.getByText("MetaMask").first().click().catch(() => {});
  }
  await page.waitForTimeout(10000);
  let body = await bodyText();
  checks.launchFeeLine = (body.match(/Launch fee:[^\n]*/) || [null])[0];
  checks.creatorBadge = (body.match(/Creator (holds|has)[^\n]*/) || [null])[0];
  const isCreator = (await C.creator()).toLowerCase() === me.toLowerCase();
  checks.isCreator = isCreator;
  if (isCreator) checks.lockSentence = (body.match(/As the creator, your buys are locked[^\n]*/) || [null])[0];
  await snap("1-page");

  // ---- buy
  await page.getByRole("tab", { name: /^Buy$/ }).first().click().catch(() => {});
  await tradeInput().fill(buyNative);
  await page.waitForTimeout(5000);
  body = await bodyText();
  checks.buyPay = (body.match(/Pay: [^\n]*/) || [null])[0];
  checks.buyReceive = (body.match(/Receive: [^\n]*/) || [null])[0];
  await snap("2-buy-quote");
  const balBefore = await token.balanceOf(me);
  let before = s.evmBackend.sent.length;
  await page.getByRole("button", { name: /^Buy [$A-Z0-9]+$|^BUY$|^Buy$/i }).filter({ visible: true }).last().click();
  const buy = await waitSent(before, "buy");
  evidence.buyTxs = buy.hashes;
  const bought = parse(buy.rcpt).find((e) => e.name === "TokensPurchased");
  const escrowed = parse(buy.rcpt).find((e) => e.name === "CreatorBuyEscrowed");
  const pre = buy.rcpt.blockNumber - 1;
  if (bought) {
    const quoteAtPre = await C.quoteBuyExactTokens(bought.args.amountOut, { blockTag: pre });
    const feeBpsPre = await C.currentTradeFeeBps({ blockTag: pre });
    checks.buy = { amountOut: bought.args.amountOut.toString(), cost: bought.args.cost.toString(), quoteAtPrevBlock: quoteAtPre.toString(), feeBpsAtPrevBlock: Number(feeBpsPre) };
    checks.buyCostEqualsCampaignQuote = bought.args.cost === quoteAtPre;
  }
  if (isCreator) {
    checks.creatorBuyEscrowed = escrowed ? escrowed.args.amount.toString() : null;
    checks.walletTokenDelta = ((await token.balanceOf(me)) - balBefore).toString();
    checks.landedInEscrow = Boolean(escrowed) && (await token.balanceOf(me)) === balBefore;
  }
  await page.waitForTimeout(8000);
  await snap("3-after-buy");

  // ---- sell (not for the creator's escrowed buy; sells from the wallet balance)
  const bal = await token.balanceOf(me);
  if (!isCreator && bal > 0n && sellFraction > 0) {
    const sellAmt = (bal * BigInt(Math.round(sellFraction * 1000))) / 1000n;
    await page.getByRole("tab", { name: /^Sell$/ }).first().click();
    await page.waitForTimeout(1500);
    // The sell box opens in native units; switch it to token units to sell an exact token amount.
    const toToken = page.getByRole("button", { name: /^Switch to \$/ }).filter({ visible: true }).first();
    if (await toToken.count()) await toToken.click();
    await page.waitForTimeout(800);
    await tradeInput().fill(ethers.formatEther(sellAmt));
    await page.waitForTimeout(5000);
    body = await bodyText();
    checks.sellQuote = (body.match(/(Receive|You get|Get|Payout)[^\n]*/g) || []).slice(0, 4);
    await snap("4-sell-quote");
    before = s.evmBackend.sent.length;
    await page.getByRole("button", { name: /^Sell [$A-Z0-9]+$|^SELL$|^Sell$/i }).filter({ visible: true }).last().click();
    const sell = await waitSent(before, "sell");
    evidence.sellTxs = sell.hashes;
    const sold = parse(sell.rcpt).find((e) => e.name === "TokensSold");
    if (sold) {
      const q = await C.quoteSellExactTokens(sold.args.amountIn, { blockTag: sell.rcpt.blockNumber - 1 });
      const feeBps = await C.currentTradeFeeBps({ blockTag: sell.rcpt.blockNumber - 1 });
      checks.sell = { amountIn: sold.args.amountIn.toString(), payout: sold.args.payout.toString(), quoteAtPrevBlock: q.toString(), feeBpsAtPrevBlock: Number(feeBps) };
      checks.sellPayoutEqualsCampaignQuote = sold.args.payout === q;
    }
    await page.waitForTimeout(6000);
    await snap("5-after-sell");
  }
  body = await bodyText();
  checks.creatorBadgeAfter = (body.match(/Creator (holds|has)[^\n]*/) || [null])[0];
  const panel = body.indexOf("CREATOR REWARDS") >= 0 ? body.indexOf("CREATOR REWARDS") : body.indexOf("Creator rewards");
  if (panel >= 0) checks.creatorPanel = body.slice(panel, panel + 700);
  fs.writeFileSync(path.join(WORK, `${stepId}.json`), JSON.stringify({ ...evidence, checks }, null, 1));
  const tradeOk = checks.buyCostEqualsCampaignQuote && (isCreator ? checks.landedInEscrow && Boolean(checks.lockSentence) : checks.sellPayoutEqualsCampaignQuote);
  record(stepId, tradeOk ? "PASS" : "FAIL", { ...evidence, checks });
} catch (error) {
  await snap("error").catch(() => {});
  record(stepId, "FAIL", { ...evidence, checks, error: String(error?.message || error).slice(0, 800), logs: s.logs.filter((l) => !/Router Future|ably|inbox/.test(l)).slice(-20) });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(WORK, `${stepId}-console.log`), s.logs.join("\n"));
  await s.browser.close();
}
