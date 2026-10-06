import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenInWalletLinks, isMobileBrowser } from "./mobileWalletLinks.mjs";

const PAGE = "https://app.memewar.zone/token/101/AbC123?tab=trades";

function byId(links) {
  return Object.fromEntries(links.map((link) => [link.id, link.href]));
}

test("each wallet link reopens the exact page in that wallet", () => {
  const hrefs = byId(buildOpenInWalletLinks({ currentUrl: PAGE }));
  const encoded = encodeURIComponent(PAGE);
  const ref = encodeURIComponent("https://app.memewar.zone");

  assert.equal(hrefs.phantom, `https://phantom.com/ul/browse/${encoded}?ref=${ref}`);
  assert.equal(hrefs.solflare, `https://solflare.com/ul/v1/browse/${encoded}?ref=${ref}`);
  assert.equal(hrefs.metamask, "https://link.metamask.io/dapp/app.memewar.zone/token/101/AbC123?tab=trades");
  assert.equal(hrefs.trust, `https://link.trustwallet.com/open_url?coin_id=60&url=${encoded}`);
  assert.equal(hrefs.okx, `okx://wallet/dapp/url?dappUrl=${encoded}`);
});

test("the modal's chain filter limits the list to wallets that work for that chain", () => {
  assert.deepEqual(buildOpenInWalletLinks({ currentUrl: PAGE, filter: "solana" }).map((l) => l.id), ["phantom", "solflare"]);
  assert.deepEqual(buildOpenInWalletLinks({ currentUrl: PAGE, filter: "evm" }).map((l) => l.id), ["metamask", "trust", "okx"]);
  assert.equal(buildOpenInWalletLinks({ currentUrl: PAGE }).length, 5);
});

test("the last wallet the visitor picked moves to the top", () => {
  const ids = buildOpenInWalletLinks({ currentUrl: PAGE, lastUsedId: "trust" }).map((l) => l.id);
  assert.deepEqual(ids, ["trust", "phantom", "solflare", "metamask", "okx"]);
  const unknown = buildOpenInWalletLinks({ currentUrl: PAGE, lastUsedId: "nope" }).map((l) => l.id);
  assert.deepEqual(unknown, ["phantom", "solflare", "metamask", "trust", "okx"]);
});

test("no links for a page URL that is not http(s)", () => {
  assert.deepEqual(buildOpenInWalletLinks({ currentUrl: "" }), []);
  assert.deepEqual(buildOpenInWalletLinks({ currentUrl: "javascript:alert(1)" }), []);
  assert.deepEqual(buildOpenInWalletLinks({ currentUrl: "file:///etc/passwd" }), []);
});

test("phones and tablets count as mobile, desktops do not", () => {
  assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" }), true);
  assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0 Mobile Safari/537.36" }), true);
  assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 5 }), true);
  assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 0 }), false);
  assert.equal(isMobileBrowser({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0" }), false);
  assert.equal(isMobileBrowser(undefined), false);
});
