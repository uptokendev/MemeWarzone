import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [entry, page, claimDialog, liveEntry, client, importsConfig, postgradConfig] = await Promise.all([
  read("./pages/TokenDetailsEntry.tsx"),
  read("./pages/ImportedProjectDetails.tsx"),
  read("./components/imports/ProjectXClaimDialog.tsx"),
  read("./pages/TokenDetailsLiveEntry.tsx"),
  read("./lib/projectImports.ts"),
  read("./features/projectImports/config.ts"),
  read("./features/postgrad/config.ts"),
]);

test("public token route intercepts authoritative project imports before live Token Details", () => {
  assert.match(entry, /lookupProjectImport\(routeId, importChainId\)/);
  assert.match(entry, /if \(project\) return <>/);
  assert.match(entry, /<ImportedProjectDetails/);
  assert.match(entry, /<ProjectXClaimDialog/);
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

test("image-less authoritative import stays locked but still exposes project claim", () => {
  assert.match(page, /if\(!String\(item\.imageUrl\|\|""\)\.trim\(\)\)/);
  assert.match(page, /PROJECT REGISTRATION INCOMPLETE/);
  assert.match(page, /A project image is required before this registration becomes public\./);
  assert.match(page, /Project verification can still be completed\. Trading, Arena actions and reward claims remain unavailable from this incomplete registration\./);
  assert.match(page, /data-project-registration-incomplete="true"/);
  assert.match(page, /data-project-claim-action="true">CLAIM MEMECOIN/);
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

test("topbar verification pill derives only from authoritative project ownership state", () => {
  assert.match(page, /ownerVerified=item\.ownershipStatus==="ownership_verified"/);
  assert.match(page, /data-owner-status-pill="verified"/);
  assert.match(page, /> VERIFIED<\/span>/);
  assert.match(page, /data-owner-status-pill="unverified"/);
  assert.match(page, />UNVERIFIED<\/span>/);
  assert.match(page, /border-orange-400\/40 bg-orange-500\/10/);
  assert.match(page, /border-emerald-400\/40 bg-emerald-500\/10/);
  assert.match(page, /projectOwnerWallet/);
  assert.doesNotMatch(page, /arenaStatus|status.*passed|needs_review|verifiedAt/i);
});

test("verified project controller can manage profile and image but registrar identity is not edit authority", () => {
  assert.match(page, /ownerConnected/);
  assert.match(page, /canEdit=ownerVerified&&ownerConnected/);
  assert.match(page, /data-owner-edit-controls="true"/);
  assert.match(page, /data-owner-image-edit="true"/);
  assert.match(page, /data-owner-profile-editor="true"/);
  assert.doesNotMatch(page, /importedByWallet/);
});

test("unverified Solana project exposes one reusable Claim Memecoin dialog from topbar", () => {
  assert.match(page, /canClaim=solana&&item\.ownershipStatus==="ownership_pending"/);
  assert.match(page, /onClaimMemecoin/);
  assert.match(page, /data-project-claim-action="true">CLAIM MEMECOIN/);
  assert.match(entry, /onClaimMemecoin=\{\(\) => setClaimOpen\(true\)\}/);
  assert.match(entry, /<ProjectXClaimDialog item=\{project\} open=\{claimOpen\} onOpenChange=\{setClaimOpen\}/);
  assert.match(claimDialog, /<Dialog open=\{open\} onOpenChange=\{onOpenChange\}>/);
  assert.match(claimDialog, /CLAIM MEMECOIN/);
  assert.match(claimDialog, /Not the owner\? Close this window/);
});

test("post-import prompt uses the same Claim Memecoin dialog rather than a second flow", () => {
  assert.match(entry, /useState\(searchParams\.get\("claim"\) === "prompt"\)/);
  assert.match(claimDialog, /resolveProjectXIdentity\(item\)/);
  assert.match(claimDialog, /action: "project_import_claim"/);
  assert.match(claimDialog, /signSolanaMessage\(message, walletAddress\)/);
  assert.match(claimDialog, /startProjectXClaim\(item, auth\)/);
});

test("Warzone access remains visibly locked and verification is not competition approval", () => {
  assert.match(page, /WARZONE ACCESS LOCKED/);
  assert.match(page, /This project is registered with MemeWarzone\./);
  assert.match(page, /Battles, Tournaments and War Leagues are opening soon\./);
  assert.match(page, /Project verification is separate from financial and competition eligibility\./);
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
  assert.match(entry, /if \(project\) return <>/);
  assert.match(entry, /<ImportedProjectDetails/);
  assert.match(entry, /return <TokenDetailsLiveEntry \/>/);
});
