import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [entry, page, liveEntry, client, importsConfig, postgradConfig] = await Promise.all([
  read("./pages/TokenDetailsEntry.tsx"),
  read("./pages/ImportedTokenDetailsPage.tsx"),
  read("./pages/TokenDetailsLiveEntry.tsx"),
  read("./lib/projectImports.ts"),
  read("./features/projectImports/config.ts"),
  read("./features/postgrad/config.ts"),
]);

test("public token route intercepts authoritative project imports before live Token Details", () => {
  assert.match(entry, /lookupProjectImport\(routeId, importChainId\)/);
  assert.match(entry, /if \(project\) return <ImportedTokenDetailsPage item={project} \/>/);
  assert.match(entry, /return <TokenDetailsLiveEntry \/>/);
  assert.doesNotMatch(entry, /ImportedProjectDetails/);
  assert.match(client, /\/api\/project-imports/);
  assert.doesNotMatch(entry, /from .*campaign|from .*LaunchFactory|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
});

test("BNB and Solana imported identities select the temporary registration page", () => {
  assert.match(entry, /requested === BNB_CHAIN_ID \|\| requested === SOLANA_CHAIN_ID/);
  assert.match(entry, /\^0x\[a-fA-F0-9\]\{40\}\$/);
  assert.match(page, /const chainLabel = isSolana \? "Solana" : "BNB"/);
  assert.match(page, /const identityLabel = isSolana \? "Mint" : "Contract"/);
  assert.match(page, /data-project-chain="true"/);
  assert.match(page, /data-project-address="true"/);
});

test("temporary imported page renders authoritative registration profile fields", () => {
  assert.match(page, /item\.imageUrl/);
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
  assert.match(page, /item\.ownershipStatus === "ownership_verified"/);
  assert.match(page, /data-owner-verified-badge="true"/);
  assert.doesNotMatch(page, /arenaStatus|status.*passed|needs_review|verifiedAt/i);
});

test("Warzone access remains visibly locked while future experience is explained", () => {
  assert.match(page, /WARZONE ACCESS LOCKED/);
  assert.match(page, /This project is registered with MemeWarzone\./);
  assert.match(page, /The full Warzone is opening soon\./);
  assert.match(page, /full project and trading experience/);
  assert.match(page, /Battles, Tournaments and War Leagues/);
  assert.match(page, /Follow and share this project while the Warzone prepares for deployment\./);
});

test("temporary page mounts no trading, Arena, claim, paid discovery or campaign implementation", () => {
  assert.doesNotMatch(page, /from .*TokenDetails|from .*launchpad|from .*chart|from .*trading|from .*swap|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
  assert.doesNotMatch(page, /\bBUY\b|\bSELL\b|AUTO DEPLOY|UpVote|Boost|REQUEST PROJECT CLAIM|claimProject|requestProjectClaim|Arena admission|BATTLE READY|ARENA APPROVED|VERIFIED SAFE|LAUNCHED BY MEMEWARZONE|APPROVED FOR TRADING|GRADUATION MARKET APPROVED/i);
  assert.doesNotMatch(page, /\/api\/arena|\/api\/campaign|candles|lightweight-charts|TradingView|swapRouter|bondingCurve|graduationMarket/i);
});

test("imports remain independent from post-grad Arena flags", () => {
  assert.match(importsConfig, /VITE_ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(importsConfig, /VITE_ENABLE_POSTGRAD_ARENA|postGradFlags/);
  assert.doesNotMatch(entry, /postGradFlags|isPostGradRouteEnabled|VITE_ENABLE_POSTGRAD_ARENA/);
  assert.match(postgradConfig, /VITE_ENABLE_POSTGRAD_ARENA/);
});

test("ordinary token fallback preserves the original live Token Details implementation boundary", () => {
  assert.match(liveEntry, /import TokenDetails from "\.\/TokenDetails"/);
  assert.match(entry, /if \(!projectImportsEnabled\) return <TokenDetailsLiveEntry \/>/);
  assert.match(entry, /if \(project\) return <ImportedTokenDetailsPage item={project} \/>/);
  assert.match(entry, /return <TokenDetailsLiveEntry \/>/);
});
