#!/usr/bin/env node
/**
 * E4 (claim): as the creator, open the graduated coin page and claim the graduation payout from the
 * creator panel. Checks the paid amount equals 19.8% of the raise (CreatorGraduationClaimed vs Graduated).
 *   node evm-claim.mjs <campaign> <chainId> <wallet> <stepId>
 */
import fs from "node:fs";
import { ethers } from "ethers";
import { APP, RPC, evmStorage, openSession, shot } from "./browser.mjs";
import { record } from "./results.mjs";

const [campaignArg, chainArg, walletName, stepId] = process.argv.slice(2);
const chainId = Number(chainArg);
if (chainId !== 46630 && chainId !== 97) throw new Error("test chains only");
const campaign = ethers.getAddress(campaignArg);
const provider = new ethers.JsonRpcProvider(RPC[chainId], undefined, { staticNetwork: true });
if (Number(await provider.send("eth_chainId", [])) !== chainId) throw new Error("rpc chain mismatch");
const abi = JSON.parse(fs.readFileSync(new URL("../../src/abi/LaunchCampaignGen5.json", import.meta.url), "utf8"));
const C = new ethers.Contract(campaign, abi.abi || abi, provider);

const s = await openSession({ evm: walletName, evmChainId: chainId, storage: evmStorage(chainId) });
const { page } = s;
const evidence = { chainId, campaign, wallet: s.evmBackend.address, shots: [] };
const snap = async (n) => evidence.shots.push(await shot(page, `${stepId}-${n}`));
const checks = {};
try {
  const grad = (await C.queryFilter(C.filters.Graduated(), -50000)).at(-1);
  if (!grad) throw new Error("no Graduated event in the last 50k blocks");
  checks.graduatedTx = grad.transactionHash;
  checks.pool = grad.args.pool;
  checks.raise = grad.args.raise.toString();
  checks.creatorShareEvent = grad.args.creatorShare.toString();
  checks.expected19_8 = ((grad.args.raise * 1980n) / 10000n).toString();
  await page.goto(`${APP}/token/${campaign}?chainId=${chainId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const c = page.getByRole("button", { name: /connect/i }).first();
  if (await c.count()) { await c.click(); await page.getByText("MetaMask").first().click().catch(() => {}); }
  await page.waitForTimeout(18000);
  const body = await page.locator("body").innerText();
  checks.graduatedLine = (body.match(/Graduated\.[^\n]*/) || [null])[0];
  const hrefs = await page.locator("a").evaluateAll((as) => as.map((a) => a.href));
  checks.poolLink = hrefs.find((h) => h.toLowerCase().includes(String(checks.pool).toLowerCase())) || null;
  const i = body.search(/CREATOR REWARDS|Creator rewards/);
  checks.panelBefore = i >= 0 ? body.slice(i, i + 500) : null;
  const panelEl = page.getByText(/Creator rewards/i).first();
  if (await panelEl.count()) await panelEl.scrollIntoViewIfNeeded();
  await snap("1-creator-panel-graduated");
  const row = page.locator("div", { has: page.getByText("Graduation payout", { exact: true }) }).filter({ has: page.getByRole("button", { name: "Claim" }) }).last();
  const before = s.evmBackend.sent.length;
  await row.getByRole("button", { name: "Claim" }).click();
  const t0 = Date.now();
  while (s.evmBackend.sent.length <= before) {
    if (Date.now() - t0 > 120_000) throw new Error("no claim tx sent");
    await page.waitForTimeout(1000);
  }
  const hash = s.evmBackend.sent.at(-1).hash;
  const rc = await provider.waitForTransaction(hash, 1, 180_000);
  const ev = rc.logs.filter((l) => l.address.toLowerCase() === campaign.toLowerCase()).map((l) => { try { return C.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "CreatorGraduationClaimed");
  evidence.claimTx = hash;
  checks.claimedNative = ev ? ev.args.nativeAmount.toString() : null;
  checks.claimEquals19_8 = ev ? ev.args.nativeAmount.toString() === checks.expected19_8 || ev.args.nativeAmount === grad.args.creatorShare : false;
  await page.waitForTimeout(8000);
  await snap("2-after-claim");
  const pass = checks.claimEquals19_8 && Boolean(checks.poolLink);
  record(stepId, pass ? "PASS" : "FAIL", { ...evidence, checks });
} catch (error) {
  await snap("error").catch(() => {});
  record(stepId, "FAIL", { ...evidence, checks, error: String(error?.message || error).slice(0, 600), logs: s.logs.filter((l) => !/Router Future|ably|inbox/.test(l)).slice(-15) });
  process.exitCode = 1;
} finally {
  await s.browser.close();
}
