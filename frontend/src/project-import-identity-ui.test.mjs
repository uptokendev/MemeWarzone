import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [home, details, commandCenter, coinRow, importPage, resolverAdapters] = await Promise.all([
  read("./components/home/ImportedProjectsOverlay.tsx"),
  read("./pages/ImportedTokenDetailsPage.tsx"),
  read("./pages/command-center/CommandCenterCoins.tsx"),
  read("./components/postgrad/CommandCenterCoinRow.tsx"),
  read("./pages/ProjectImport.tsx"),
  read("../api/lib/projectImportResolverAdapters.js"),
]);

test("homepage imported project card consumes resolved name and $symbol", () => {
  assert.match(home, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(home, /item\.symbol \? `\$\$\{item\.symbol\}` : ""/);
});

test("temporary imported TokenDetails consumes resolved name and $symbol", () => {
  assert.match(details, /data-project-name="true"/);
  assert.match(details, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(details, /data-project-ticker="true">\$\{item\.symbol\}/);
});

test("Command Center consumes imported name and formats resolved ticker as $symbol", () => {
  assert.match(commandCenter, /name: project\.name \|\| project\.symbol \|\| "Imported project"/);
  assert.match(commandCenter, /ticker: project\.symbol \|\| "\?\?\?"/);
  assert.match(coinRow, /isImported[\s\S]*item\.ticker && item\.ticker !== "\?\?\?" \? `\$\$\{item\.ticker\}` : item\.name/);
  assert.match(coinRow, />\{displayedTicker\}<\/div>/);
});

test("generic placeholders are display fallbacks only when resolved identity is absent", () => {
  assert.match(home, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(details, /item\.name \|\| item\.symbol \|\| "Imported project"/);
  assert.match(coinRow, /item\.ticker !== "\?\?\?"/);
});

test("BNB wrong wallet uses the real resolved current authority and blocks automatic claim", () => {
  assert.match(resolverAdapters, /currentAuthority:\s*raw\.ownership\?\.currentOwner \?\? null/);
  assert.match(resolverAdapters, /signedWalletMatchesAuthority:\s*Boolean\(raw\.ownership\?\.automaticOwnershipVerified\)/);
  assert.match(importPage, /wrongAuthorityWallet=evidence\?\.automaticOwnershipAvailable===true&&Boolean\(evidence\.currentAuthority\)&&!evidence\.signedWalletMatchesAuthority/);
  assert.match(importPage, /WRONG WALLET CONNECTED/);
  assert.match(importPage, /This memecoin is controlled by wallet \{expectedAuthorityShort\}\. Connect that wallet to verify ownership\./);
  assert.match(importPage, /!ownerVerified&&evidence\?\.signedWalletMatchesAuthority\?<Button[\s\S]*CLAIM CURRENT OWNERSHIP/);
});

test("Solana wrong wallet uses the real resolved mint authority and blocks automatic claim", () => {
  assert.match(resolverAdapters, /currentAuthority:\s*raw\.mintAuthority \?\? null/);
  assert.match(resolverAdapters, /signedWalletMatchesAuthority:\s*Boolean\(raw\.verified\)/);
  assert.match(importPage, /data-import-wrong-wallet-warning="true"/);
  assert.match(importPage, /Connected: \{connectedWalletShort\}/);
  assert.match(importPage, /wrongAuthorityWallet\?"REGISTER MEMECOIN":<>REGISTER &amp; VERIFY MEMECOIN<\/>/);
});

test("expected and connected wallet addresses use first-four last-four shortening", () => {
  assert.match(importPage, /address\.slice\(0, 4\)/);
  assert.match(importPage, /address\.slice\(-4\)/);
  assert.match(importPage, /`\$\{address\.slice\(0, 4\)\}\.\.\.\$\{address\.slice\(-4\)\}`/);
  assert.match(importPage, /expectedAuthorityShort=wrongAuthorityWallet\?shortenWallet\(evidence\?\.currentAuthority\):""/);
  assert.match(importPage, /connectedWalletShort=shortenWallet\(connectedWallet\)/);
});

test("correct authority wallet keeps the normal ownership verification flow", () => {
  assert.match(importPage, /!ownerVerified&&evidence\?\.signedWalletMatchesAuthority\?<Button[^>]*[\s\S]*CLAIM CURRENT OWNERSHIP/);
  assert.match(importPage, /wrongAuthorityWallet\?"Reconnect with the current authority wallet shown above before claiming automatic ownership\.":"Current authority exists and this connected wallet matches that authority\."/);
});

test("automatic ownership unavailable preserves manual review without inventing an expected wallet", () => {
  assert.match(importPage, /evidence\?\.automaticOwnershipAvailable===false\?"AUTOMATIC OWNERSHIP VERIFICATION UNAVAILABLE"/);
  assert.match(importPage, /evidence\?\.automaticOwnershipAvailable===false&&!conflictingVerified\?<Button[\s\S]*REQUEST PROJECT CLAIM/);
  assert.match(importPage, /wrongAuthorityWallet=evidence\?\.automaticOwnershipAvailable===true/);
});

test("no-wallet import UX remains connect-first", () => {
  assert.match(importPage, /disabled=\{!validAddress\|\|!connected\|\|working\}/);
  assert.match(importPage, /Connect a wallet to resolve ownership evidence\./);
});