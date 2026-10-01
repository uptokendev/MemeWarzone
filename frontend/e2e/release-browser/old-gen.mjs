#!/usr/bin/env node
/** E5: an older-generation testnet coin page still renders the old UI (no generation-6 lines). */
import { ethers } from "ethers";
import { APP, RPC, evmStorage, openSession, shot } from "./browser.mjs";
import { record } from "./results.mjs";
const [campaign, chainArg = "46630", stepId = "E5"] = process.argv.slice(2);
const chainId = Number(chainArg);
const provider = new ethers.JsonRpcProvider(RPC[chainId], undefined, { staticNetwork: true });
const c = new ethers.Contract(campaign, ["function factory() view returns (address)", "function launched() view returns (bool)", "function token() view returns (address)"], provider);
const factory = await c.factory().catch(() => null);
const f = factory ? new ethers.Contract(factory, ["function FACTORY_GENERATION() view returns (uint256)", "function CAMPAIGN_GENERATION() view returns (uint256)"], provider) : null;
const gens = f ? [Number(await f.FACTORY_GENERATION().catch(() => 0)), Number(await f.CAMPAIGN_GENERATION().catch(() => 0))] : null;
const s = await openSession({ evm: "buyer", evmChainId: chainId, storage: evmStorage(chainId) });
const { page } = s;
const evidence = { chainId, campaign, factory, generations: gens, launched: await c.launched().catch(() => null), shots: [] };
try {
  await page.goto(`${APP}/token/${campaign}?chainId=${chainId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const btn = page.getByRole("button", { name: /connect/i }).first();
  if (await btn.count()) { await btn.click(); await page.getByText("MetaMask").first().click().catch(() => {}); }
  await page.waitForTimeout(18000);
  const body = await page.locator("body").innerText();
  const checks = {
    title: (body.match(/Robinhood Acceptance[^\n]*/i) || body.match(/\n([A-Z0-9 ]{6,})\n/) || [null])[0],
    hasGen5Badge: await page.getByTestId("evm-gen5-creator-badge").count() > 0,
    hasGen5Notes: await page.getByTestId("evm-gen5-trade-notes").count() > 0,
    hasLaunchFeeLine: /Launch fee:/.test(body),
    hasTradeBox: /\bBUY\b|\bBuy\b/.test(body),
    stage: (body.match(/(Bonding · Robinhood|Graduated · Uniswap|Bonding)/) || [null])[0],
    pageErrors: s.logs.filter((l) => /pageerror/.test(l)).slice(0, 5),
  };
  evidence.shots.push(await shot(page, `${stepId}-old-generation-page`));
  const pass = !checks.hasGen5Badge && !checks.hasGen5Notes && !checks.hasLaunchFeeLine && checks.hasTradeBox && checks.pageErrors.length === 0;
  record(stepId, pass ? "PASS" : "FAIL", { ...evidence, checks });
} finally {
  await s.browser.close();
}
