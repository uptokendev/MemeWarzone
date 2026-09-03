import { expect, test, type Page } from "@playwright/test";

import {
  BNB_CAMPAIGN,
  BNB_NAME,
  BNB_SYMBOL,
  SOLANA_MINT,
  SOLANA_NAME,
  SOLANA_SYMBOL,
} from "./fixtures/campaigns";
import {
  apiChainIds,
  hasSolanaRpc,
  installNetworkStubs,
  tokenApiChainIds,
  type RequestLedger,
} from "./fixtures/network";
import { injectMetaMask, injectPhantom, readWalletActions } from "./fixtures/wallets";

async function waitForApp(page: Page, heading: string | RegExp) {
  await page.getByRole("heading", { name: heading }).first().waitFor({ state: "visible", timeout: 20_000 });
}

function unique(ids: number[]) {
  return [...new Set(ids)];
}

function isBnbFamily(ids: number[]) {
  return ids.length > 0 && ids.every((id) => id === 56 || id === 97);
}

function isSolanaFamily(ids: number[]) {
  return ids.length > 0 && ids.every((id) => id === 101);
}

async function clickFeed(page: Page, label: "BNB" | "Solana") {
  await page.getByRole("button", { name: label, exact: true }).click();
}

async function fillAndSubmitBuy(page: Page) {
  const amount = page.locator('input[placeholder="0"]').first();
  if (!(await amount.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
  await amount.fill("0.1");

  const buy = page.getByRole("button", { name: /^Buy/ }).last();
  if ((await buy.count()) === 0) return false;
  if (!(await buy.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
  if (await buy.isEnabled({ timeout: 3_000 }).catch(() => false)) {
    await buy.click();
    return true;
  }
  return false;
}

async function assertWrongChainCta(page: Page, pattern: RegExp) {
  const visible = page.getByText(pattern).first();
  if (await visible.isVisible().catch(() => false)) {
    await expect(visible).toBeVisible();
    return;
  }
  await fillAndSubmitBuy(page);
  if (await visible.isVisible().catch(() => false)) {
    await expect(visible).toBeVisible();
    return;
  }
  const safety = page.getByRole("button", { name: /Safety/i }).first();
  if (await safety.isVisible().catch(() => false)) await safety.click();
  await expect(page.getByText(pattern).first()).toBeVisible({ timeout: 10_000 });
}

test.describe("Gate S cross-chain isolation", () => {
  test("homepage feed follows latch and switch without mixing Solana into BNB", async ({ page }) => {
    await injectPhantom(page);
    const ledger = await installNetworkStubs(page);
    await page.goto("/");
    await waitForApp(page, "Explore Coins");

    // Startup can legitimately include the configured default-chain request before
    // injected-wallet discovery finishes. Exercise real transitions instead of
    // requiring a same-value Solana click to refetch an already-selected feed.
    const beforeBnb = ledger.requests.length;
    await clickFeed(page, "BNB");
    await expect.poll(() => {
      const after = ledger.requests.slice(beforeBnb);
      return unique(
        after
          .filter((row) => row.pathname === "/api/campaigns" && row.chainId != null)
          .map((row) => row.chainId as number),
      );
    }).not.toContain(101);
    await expect.poll(() => {
      const after = ledger.requests.slice(beforeBnb);
      return unique(
        after
          .filter((row) => row.pathname === "/api/campaigns" && row.chainId != null)
          .map((row) => row.chainId as number),
      ).length;
    }).toBeGreaterThan(0);

    const bnbAfterSwitch = unique(
      ledger.requests
        .slice(beforeBnb)
        .filter((row) => row.pathname === "/api/campaigns" && row.chainId != null)
        .map((row) => row.chainId as number),
    );
    expect(isBnbFamily(bnbAfterSwitch)).toBeTruthy();

    const beforeSolana = ledger.requests.length;
    await clickFeed(page, "Solana");
    await expect.poll(() => {
      const after = ledger.requests.slice(beforeSolana);
      return unique(
        after
          .filter((row) => row.pathname === "/api/campaigns" && row.chainId != null)
          .map((row) => row.chainId as number),
      );
    }).toEqual([101]);

    const solanaAfterSwitch = ledger.requests.slice(beforeSolana);
    const featuredSolana = unique(
      solanaAfterSwitch
        .filter((row) => row.pathname === "/api/featured" && row.chainId != null)
        .map((row) => row.chainId as number),
    );
    if (featuredSolana.length) expect(featuredSolana).toEqual([101]);

    const beforeReturnToBnb = ledger.requests.length;
    await clickFeed(page, "BNB");
    await expect.poll(() => {
      const after = ledger.requests.slice(beforeReturnToBnb);
      return unique(
        after
          .filter((row) => row.pathname === "/api/campaigns" && row.chainId != null)
          .map((row) => row.chainId as number),
      );
    }).not.toContain(101);
    await expect.poll(() => {
      const after = ledger.requests.slice(beforeReturnToBnb);
      return unique(
        after
          .filter((row) => row.pathname === "/api/campaigns" && row.chainId != null)
          .map((row) => row.chainId as number),
      ).length;
    }).toBeGreaterThan(0);
  });

  test("BNB Token Details stay EVM with Phantom and stale chainId=101", async ({ page }) => {
    await injectPhantom(page);
    const ledger = await installNetworkStubs(page);
    await page.goto(`/token/${BNB_CAMPAIGN}?chainId=101`);
    await waitForApp(page, BNB_NAME);

    await expect(page.getByText("BNB", { exact: true }).nth(0)).toBeVisible();
    await expect(page.locator('input[placeholder="0"]').first()).toBeVisible();
    await expect(page.getByText("SOL", { exact: true })).toHaveCount(0);

    const tokenIds = unique(tokenApiChainIds(ledger));
    if (tokenIds.length) expect(isBnbFamily(tokenIds)).toBeTruthy();
    expect(tokenIds).not.toContain(101);

    await assertWrongChainCta(page, /Connect BNB|Connect wallet/i);
    const actions = await readWalletActions(page);
    expect(actions.solanaSigns).toEqual([]);
  });

  test("Solana Token Details stay Solana with MetaMask connected", async ({ page }) => {
    await injectMetaMask(page, { evmChainId: 97 });
    const ledger = await installNetworkStubs(page);
    await page.goto(`/token/${SOLANA_MINT}`);
    await waitForApp(page, SOLANA_NAME);

    await expect(page.getByText("SOL", { exact: true }).first()).toBeVisible();
    await expect(page.locator('input[placeholder="0"]').first()).toBeVisible();

    const tokenIds = unique(tokenApiChainIds(ledger));
    if (tokenIds.length) expect(isSolanaFamily(tokenIds)).toBeTruthy();
    expect(tokenIds).not.toContain(56);
    expect(tokenIds).not.toContain(97);

    await assertWrongChainCta(page, /Solana wallet|Connect Solana|not a Solana/i);
    const actions = await readWalletActions(page);
    expect(actions.ethSends).toEqual([]);
  });

  test("War Room expanded campaign keeps campaign.chainId for metrics and trade adapter", async ({ page }) => {
    await injectPhantom(page);
    const ledger: RequestLedger = await installNetworkStubs(page);
    await page.goto("/war-room");
    await waitForApp(page, "War Trade Room");

    await expect.poll(() => unique(apiChainIds(ledger, "/api/war-room")).concat(unique(apiChainIds(ledger, "/api/campaigns")))).toContain(101);

    const beforeSwitch = ledger.requests.length;
    await clickFeed(page, "BNB");
    await expect(page.getByText(BNB_SYMBOL).first()).toBeVisible({ timeout: 15_000 });

    const feedAfterSwitch = unique(
      ledger.requests
        .slice(beforeSwitch)
        .filter((row) => (row.pathname === "/api/war-room" || row.pathname === "/api/campaigns") && row.chainId != null)
        .map((row) => row.chainId as number),
    );
    expect(feedAfterSwitch).not.toContain(101);
    expect(isBnbFamily(feedAfterSwitch.length ? feedAfterSwitch : [97])).toBeTruthy();

    await page.getByText(BNB_SYMBOL).first().click();
    await expect(page.getByText("Trade").first()).toBeVisible();
    await expect(page.getByText("Open token details").first()).toBeVisible();
    await expect(page.getByText("BNB", { exact: true }).first()).toBeVisible();

    const tokenIds = unique(tokenApiChainIds(ledger));
    if (tokenIds.length) {
      expect(tokenIds).not.toContain(101);
      expect(isBnbFamily(tokenIds)).toBeTruthy();
    }
    expect(hasSolanaRpc(ledger)).toBeFalsy();

    await fillAndSubmitBuy(page);
    await expect(page.getByText(/Connect wallet|Invalid amount|Enter a BNB/i).first()).toBeVisible({ timeout: 10_000 });
    const actions = await readWalletActions(page);
    expect(actions.solanaSigns).toEqual([]);
  });
});