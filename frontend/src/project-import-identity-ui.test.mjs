import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [home, details, commandCenter, coinRow, importPage, claimDialog, resolverAdapters] = await Promise.all([
  read("./components/home/ImportedProjectsOverlay.tsx"),
  read("./pages/ImportedTokenDetailsPage.tsx"),
  read("./pages/command-center/CommandCenterCoins.tsx"),
  read("./components/postgrad/CommandCenterCoinRow.tsx"),
  read("./pages/ProjectImport.tsx"),
  read("./components/imports/ProjectXClaimDialog.tsx"),
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

test("registration is intentionally ownership-neutral", () => {
  assert.match(importPage, /Your wallet signs the import request only\. It does not need to own the token\./);
  assert.match(importPage, /Project ownership can be claimed separately later\./);
  assert.match(importPage, /createProjectImport/);
  assert.doesNotMatch(importPage, /resolveProjectEvmAuthority|claimProjectImport|REQUEST MANUAL REVIEW/);
});

test("BNB and Robinhood claim UI resolves the current EVM owner and only enables instant verification on a wallet match", () => {
  assert.match(claimDialog, /resolveProjectEvmAuthority\(item, connectedWallet\)/);
  assert.match(claimDialog, /authority\?\.available && authority\.matchesConnected && connectedWallet/);
  assert.match(claimDialog, /data-project-owner-wallet-option="true"/);
  assert.match(claimDialog, /Your connected \{evmChainLabel\} wallet matches the current contract owner\./);
  assert.match(claimDialog, /CONNECT \{evmChainLabel\.toUpperCase\(\)\} OWNER WALLET/);
  assert.match(claimDialog, /VERIFY \{evmChainLabel\.toUpperCase\(\)\} OWNER WALLET/);
});

test("ownerless EVM tokens fall back to X or manual review without inventing ownership", () => {
  assert.match(claimDialog, /does not expose an active owner\(\)\/getOwner\(\) wallet/);
  assert.match(claimDialog, /Use the official X account if available, or request manual review below/);
  assert.match(resolverAdapters, /currentAuthority:\s*registrationOnly \? null : raw\.ownership\?\.currentOwner \?\? null/);
  assert.match(resolverAdapters, /currentAuthority:raw\.ownership\?\.currentOwner\?\?null/);
});

test("Solana claim UI verifies current project authority after registration", () => {
  assert.match(claimDialog, /Solana project authority wallet/);
  assert.match(claimDialog, /verifyPumpCreatorWallet/);
  assert.match(claimDialog, /claimProjectImport\(\{item,auth\}\)/);
  assert.match(claimDialog, /Recorded project authority:/);
  assert.match(claimDialog, /VERIFY PROJECT AUTHORITY/);
  assert.match(resolverAdapters, /resolveSolanaProjectAuthority/);
});

test("official X and manual-review ownership fallbacks remain separate from registration", () => {
  assert.match(claimDialog, /VERIFY WITH X/);
  assert.match(claimDialog, /REQUEST MANUAL REVIEW/);
  assert.match(claimDialog, /This does not verify ownership automatically\./);
  assert.match(claimDialog, /project_import_manual_claim/);
  assert.match(claimDialog, /Not the owner\? Close this window\. The real owner can claim it later\./);
});

test("no-wallet import UX remains connect-first without resolving ownership evidence", () => {
  assert.match(importPage, /disabled=\{!validAddress \|\| !connected \|\| working\}/);
  assert.match(importPage, /Connect a wallet to submit the import\./);
  assert.match(importPage, /IMPORT MEMECOIN/);
});