import { test, expect, type Page } from '@playwright/test';

const mint = '7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump';
const wallet = '9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H';

async function openImport(page: Page) {
  await page.goto(`/?wallet=${wallet}`);
  await expect(page.getByText('1. Choose chain')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Solana', exact: true })).toBeVisible();
}

async function submitSolana(page: Page) {
  await page.getByLabel('3. Contract Address').fill(mint);
  await page.getByRole('button', { name: 'IMPORT MEMECOIN', exact: true }).click();
}

test('registration is generic, ownership-neutral, and Robinhood stays independently gated', async ({ page }) => {
  await openImport(page);
  await expect(page.getByText(/Your wallet signs the import request only\. It does not need to own the token\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'BNB', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Solana', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Robinhood', exact: true })).toHaveCount(0);
});

test('Solana registration posts one signed Project Import request and pending ownership routes to Claim Memecoin', async ({ page }) => {
  let posts = 0;
  let resolves = 0;
  await page.route('**/api/project-imports/resolve', async route => {
    resolves += 1;
    await route.fulfill({ status: 500, json: { error: 'registration should not call client resolve' } });
  });
  await page.route('**/api/project-imports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    const body = route.request().postDataJSON();
    expect(body.chainId).toBe(101);
    expect(body.tokenAddress).toBe(mint);
    expect(body.auth.action).toBe('project_import_create');
    expect(body.auth.walletAddress).toBe(wallet);
    await route.fulfill({ json: { created: true, project: { id: 'fixture', chainId: 101, tokenAddress: mint, ownershipStatus: 'ownership_pending' } } });
  });
  await openImport(page);
  await submitSolana(page);
  await expect.poll(() => posts).toBe(1);
  expect(resolves).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/token/${mint}\\?chainId=101&claim=prompt`));
});

test('verified registration omits the ownership-claim prompt', async ({ page }) => {
  await page.route('**/api/project-imports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ json: { created: true, project: { id: 'fixture', chainId: 101, tokenAddress: mint, ownershipStatus: 'ownership_verified', projectOwnerWallet: wallet } } });
  });
  await openImport(page);
  await submitSolana(page);
  await expect(page).toHaveURL(new RegExp(`/token/${mint}\\?chainId=101$`));
});

test('server outage remains visible and retryable without fabricating approval', async ({ page }) => {
  await page.route('**/api/project-imports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 503, json: { error: 'Service unavailable' } });
  });
  await openImport(page);
  await submitSolana(page);
  const error = page.locator('[data-import-error="true"]');
  await expect(error).toContainText('IMPORT CHECK TEMPORARILY UNAVAILABLE');
  await expect(error).toContainText('Nothing has been approved');
  await expect(page.getByRole('button', { name: 'RETRY IMPORT', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).searchParams.get('wallet')).toBe(wallet);
});

test('wallet-auth failure is explicit and does not navigate', async ({ page }) => {
  await page.route('**/api/project-imports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 401, json: { error: 'bad signature' } });
  });
  await openImport(page);
  await submitSolana(page);
  await expect(page.locator('[data-import-error="true"]')).toContainText('WALLET VERIFICATION REQUIRED');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).searchParams.get('wallet')).toBe(wallet);
});

test('wrong-family contract address is explained inline and cannot submit', async ({ page }) => {
  await openImport(page);
  await page.getByLabel('3. Contract Address').fill('0x1111111111111111111111111111111111111111');
  await expect(page.getByRole('alert')).toContainText('not valid for the selected chain');
  await expect(page.getByRole('button', { name: 'IMPORT MEMECOIN', exact: true })).toBeDisabled();
});

test('explicit BNB selection requires an EVM wallet instead of silently using Solana', async ({ page }) => {
  await openImport(page);
  await page.getByRole('button', { name: 'BNB', exact: true }).click();
  await expect(page.getByRole('button', { name: 'CONNECT BNB WALLET', exact: true })).toBeVisible();
  await page.getByLabel('3. Contract Address').fill('0x1111111111111111111111111111111111111111');
  await expect(page.getByRole('button', { name: 'IMPORT MEMECOIN', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Solana', exact: true }).click();
  await page.getByLabel('3. Contract Address').fill(mint);
  await expect(page.getByRole('button', { name: 'IMPORT MEMECOIN', exact: true })).toBeEnabled();
});