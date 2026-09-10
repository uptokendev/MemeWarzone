import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [entry, page, liveEntry, client, importsConfig, postgradConfig] = await Promise.all([
  read("./pages/TokenDetailsEntry.tsx"),
  read("./pages/ImportedProjectDetails.tsx"),
  read("./pages/TokenDetailsLiveEntry.tsx"),
  read("./lib/projectImports.ts"),
  read("./features/projectImports/config.ts"),
  read("./features/postgrad/config.ts"),
]);

test("public token route intercepts authoritative project imports before live Token Details", () => {
  assert.match(entry, /lookupProjectImport\(routeId, importChainId\)/);
  assert.match(entry, /if \(project\) return <ImportedProjectDetails/);
  assert.match(entry, /return <TokenDetailsLiveEntry \/>/);
  assert.match(entry, /import ImportedProjectDetails from "\.\/ImportedProjectDetails"/);
  assert.doesNotMatch(entry, /imageUrl/);
  assert.match(client, /\/api\/project-imports/);
  assert.doesNotMatch(entry, /from .*campaign|from .*LaunchFactory|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
});

test("pending ownership refreshes from the authoritative API without a hard reload", () => {
  assert.match(entry, /project\.ownershipStatus !== "ownership_pending" && project\.ownershipStatus !== "ownership_manual_review"/);
  assert.match(entry, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 10_000\)/);
  assert.match(entry, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(entry, /document\.addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(entry, /key=\{`\$\{project\.id\}:\$\{project\.ownershipStatus\}:\$\{project\.ownershipVerifiedAt \|\| ""\}`\}/);
});

test("BNB, Solana and feature-gated Robinhood imported identities select the dedicated project page", () => {
  assert.match(entry, /requested === BNB_CHAIN_ID \|\| requested === SOLANA_CHAIN_ID \|\| \(requested === 4663 && projectImportRobinhoodEnabled\)/);
  assert.match(entry, /\^0x\[a-fA-F0-9\]\{40\}\$/);
  assert.match(page, /item\.chainId===4663\?"Robinhood":"BNB"/);
  assert.match(page, /identityLabel=solana\?"Mint":"Contract"/);
  assert.match(page, /data-project-chain="true"/);
  assert.match(page, /data-project-address="true"/);
});

test("image-less authoritative import renders incomplete registration state", () => {
  assert.match(page, /if\(!String\(item\.imageUrl\|\|""\)\.trim\(\)\)/);
  assert.match(page, /PROJECT REGISTRATION INCOMPLETE/);
  assert.match(page, /A project image is required before this registration becomes public\./);
  assert.match(page, /No trading, Arena actions or claims are available from this incomplete registration\./);
  assert.match(page, /data-project-registration-incomplete="true"/);
});

test("completed imported page renders project identity, profile and share fields", () => {
  assert.match(page, /data-project-image="true"/);
  assert.match(page, /data-project-name="true"/);
  assert.match(page, /data-project-ticker="true"/);
  assert.match(page, /data-project-description="true"/);
  assert.match(page, /data-project-socials="true"/);
  assert.match(page, /Website/);
  assert.match(page, />X<\/a>/);
  assert.match(page, /Telegram/);
  assert.match(page, /data-project-share="true"/);
  assert.match(page, /data-imported-badge="true"/);
});

test("OWNER VERIFIED derives only from authoritative project ownership state", () => {
  assert.match(page, /item\.ownershipStatus==="ownership_verified"/);
  assert.match(page, /data-owner-verified-badge="true"/);
  assert.match(page, /projectOwnerWallet/);
  assert.doesNotMatch(page, /arenaStatus|status.*passed|needs_review|verifiedAt/i);
});

test("verified owner can manage profile and image but registrar identity is not edit authority", () => {
  assert.match(page, /ownerConnected/);
  assert.match(page, /canEdit=ownerVerified&&ownerConnected/);
  assert.match(page, /data-owner-edit-controls="true"/);
  assert.match(page, /data-owner-image-edit="true"/);
  assert.match(page, /data-owner-profile-editor="true"/);
  assert.doesNotMatch(page, /importedByWallet/);
});

test("manual review is visible and cannot be requested twice from the project page", () => {
  assert.match(page, /OWNERSHIP REVIEW REQUESTED/);
  assert.match(page, /item\.ownershipStatus!=="ownership_manual_review"/);
  assert.match(page, /REQUEST PROJECT CLAIM/);
});

test("Warzone access remains visibly locked", () => {
  assert.match(page, /WARZONE ACCESS LOCKED/);
  assert.match(page, /This project is registered with MemeWarzone\./);
  assert.match(page, /Battles, Tournaments and War Leagues are opening soon\./);
  assert.match(page, /No trading, claims, Arena actions or launch deployment are enabled from this page\./);
});

test("imported page mounts no trading, Arena, paid discovery or campaign implementation", () => {
  assert.doesNotMatch(page, /from .*TokenDetails|from .*launchpad|from .*chart|from .*trading|from .*swap|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
  assert.doesNotMatch(page, /\bBUY\b|\bSELL\b|AUTO DEPLOY|UpVote|Boost|Arena admission|BATTLE READY|ARENA APPROVED|VERIFIED SAFE|LAUNCHED BY MEMEWARZONE|APPROVED FOR TRADING|GRADUATION MARKET APPROVED/i);
  assert.doesNotMatch(page, /\/api\/arena|\/api\/campaign|candles|lightweight-charts|TradingView|swapRouter|bondingCurve|graduationMarket/i);
});

test("imports remain independent from post-grad Arena flags", () => {
  assert.match(importsConfig, /VITE_ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(importsConfig, /VITE_ENABLE_POSTGRAD_ARENA|postGradFlags/);
  assert.doesNotMatch(entry, /postGradFlags|isPostGradRouteEnabled|VITE_ENABLE_POSTGRAD_ARENA/);
  assert.match(postgradConfig, /VITE_ENABLE_POSTGRAD_ARENA/);
});

test("ordinary token fallback preserves original live Token Details boundary", () => {
  assert.match(liveEntry, /import TokenDetails from "\.\/TokenDetails"/);
  assert.match(entry, /if \(!projectImportsEnabled\) return <TokenDetailsLiveEntry \/>/);
  assert.match(entry, /if \(project\) return <ImportedProjectDetails/);
  assert.match(entry, /return <TokenDetailsLiveEntry \/>/);
});
