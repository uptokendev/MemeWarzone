import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [entry, page, claimDialog, liveEntry, client, xClient, importsConfig, postgradConfig, tradePanel] = await Promise.all([
  read("./pages/TokenDetailsEntry.tsx"),
  read("./pages/ImportedTokenPage.tsx"),
  read("./components/imports/ProjectXClaimDialog.tsx"),
  read("./pages/TokenDetailsLiveEntry.tsx"),
  read("./lib/projectImports.ts"),
  read("./lib/projectImportXClaim.ts"),
  read("./features/projectImports/config.ts"),
  read("./features/postgrad/config.ts"),
  read("./components/arena/ImportedTradePanel.tsx"),
]);

test("public token route intercepts authoritative project imports before live Token Details", () => {
  assert.match(entry, /lookupProjectImport\(routeId, importChainId\)/);
  assert.match(entry, /if \(project\) return <>/);
  assert.match(entry, /<ImportedTokenPage/);
  assert.match(entry, /<ProjectXClaimDialog/);
  assert.match(entry, /return <TokenDetailsLiveEntry \/>/);
  assert.match(entry, /onResolvedImage=\{\(imageUrl\) => setProject/);
  assert.match(client, /\/api\/project-imports/);
  assert.doesNotMatch(entry, /from .*campaign|from .*LaunchFactory|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
});

test("pending ownership refreshes from the authoritative API without a hard reload", () => {
  assert.match(entry, /project\.ownershipStatus !== "ownership_pending" && project\.ownershipStatus !== "ownership_manual_review"/);
  assert.match(entry, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 10_000\)/);
  assert.match(entry, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(entry, /document\.addEventListener\("visibilitychange", onVisibility\)/);
});

test("BNB, Solana and feature-gated Robinhood imported identities select the dedicated project page", () => {
  assert.match(entry, /requested === BNB_CHAIN_ID \|\| requested === SOLANA_CHAIN_ID \|\| \(requested === 4663 && projectImportRobinhoodEnabled\)/);
  assert.match(page, /item\.chainId === 4663 \? "Robinhood" : "BNB"/);
  assert.match(page, /identityLabel = solana \? "Mint" : "Contract"/);
  assert.match(page, /data-project-chain="true"/);
  assert.match(page, /data-project-address="true"/);
});

test("image-less authoritative import stays public and still exposes project claim", () => {
  assert.match(page, /Add a project image from the owner tools/);
  assert.match(page, /data-project-claim-action="true">CLAIM MEMECOIN/);
});

test("completed imported page renders project identity, profile and share fields", () => {
  assert.match(page, /data-project-image="true"/);
  assert.match(page, /data-project-name="true"/);
  assert.match(page, /data-project-ticker="true"/);
  assert.match(page, /data-project-description="true"/);
  assert.match(page, /data-project-socials="true"/);
  assert.match(page, /data-project-share="true"/);
  assert.match(page, /data-imported-badge="true"/);
});

test("topbar verification pill derives only from authoritative project ownership state", () => {
  assert.match(page, /ownerVerified = item.ownershipStatus === "ownership_verified"/);
  assert.match(page, /data-owner-status-pill="verified"/);
  assert.match(page, /> VERIFIED<\/span>/);
  assert.match(page, /data-owner-status-pill="unverified"/);
  assert.match(page, />UNVERIFIED<\/span>/);
  assert.match(page, /border-orange-400\/40 bg-orange-500\/10/);
  assert.match(page, /border-emerald-400\/40 bg-emerald-500\/10/);
  assert.match(page, /admissionPill\(item\.arenaStatus\)/);
});

test("verified project controller can manage profile and image but registrar identity is not edit authority", () => {
  assert.match(page, /ownerConnected/);
  assert.match(page, /canEdit = ownerVerified && ownerConnected/);
  assert.match(page, /data-owner-edit-controls="true"/);
  assert.match(page, /data-owner-image-edit="true"/);
  assert.match(page, /data-owner-profile-editor="true"/);
  assert.doesNotMatch(page, /importedByWallet/);
});

test("all supported unverified imports expose one reusable Claim Memecoin dialog", () => {
  assert.match(page, /canClaim = item.ownershipStatus === "ownership_pending" \|\| item.ownershipStatus === "ownership_manual_review"/);
  assert.match(page, /data-project-claim-action="true">CLAIM MEMECOIN/);
  assert.match(entry, /onClaimMemecoin=\{\(\) => setClaimOpen\(true\)\}/);
  assert.match(entry, /<ProjectXClaimDialog item=\{project\} open=\{claimOpen\} onOpenChange=\{setClaimOpen\}/);
  assert.match(claimDialog, /BNB_CHAIN_ID/);
  assert.match(claimDialog, /ROBINHOOD_CHAIN_ID = 4663/);
  assert.match(claimDialog, /item\.chainId === SOLANA_CHAIN_ID/);
});

test("EVM Claim Memecoin checks current owner first and offers X fallback", () => {
  assert.match(xClient, /\/api\/project-imports\/image\/x\/authority/);
  assert.match(claimDialog, /resolveProjectEvmAuthority\(item, connectedWallet\)/);
  assert.match(claimDialog, /\{evmChainLabel\} project owner wallet/);
  assert.match(claimDialog, /CONNECT \{evmChainLabel\.toUpperCase\(\)\} OWNER WALLET/);
  assert.match(claimDialog, /VERIFY \{evmChainLabel\.toUpperCase\(\)\} OWNER WALLET/);
  assert.match(claimDialog, /claimProjectImport\(\{item,auth\}\)/);
  assert.match(claimDialog, /VERIFY WITH X/);
  assert.match(claimDialog, /does not expose an active owner\(\)\/getOwner\(\) wallet/);
});

test("Solana Claim Memecoin offers current project-authority proof before manual review", () => {
  assert.match(claimDialog, /Solana project authority wallet/);
  assert.match(claimDialog, /VERIFY PROJECT AUTHORITY/);
  assert.match(claimDialog, /verifyPumpCreatorWallet/);
  assert.match(claimDialog, /project_import_claim/);
  assert.match(claimDialog, /Recorded project authority:/);
});

test("manual review is the final ownership fallback and requires a contact X account", () => {
  assert.match(claimDialog, /Last resort — manual review/);
  assert.match(claimDialog, /REQUEST MANUAL REVIEW/);
  assert.match(claimDialog, /SUBMIT MANUAL REVIEW/);
  assert.match(claimDialog, /Contact X account/);
  assert.match(claimDialog, /project_import_manual_claim/);
  assert.match(claimDialog, /requestProjectManualCheck/);
  assert.match(claimDialog, /Contact X: \$\{contactX\}/);
  assert.match(claimDialog, /This does not verify ownership automatically/);
});

test("failed X OAuth reopens Claim Memecoin and explains account mismatch", () => {
  assert.match(entry, /claimResult === "prompt" \|\| claimResult === "x_failed"/);
  assert.match(claimDialog, /PROJECT_IMPORT_X_ACCOUNT_MISMATCH/);
  assert.match(claimDialog, /does not match the project account attached to this token/);
  assert.match(claimDialog, /THAT WAS NOT THE CORRECT X ACCOUNT/);
  assert.match(claimDialog, /text-red-300/);
  assert.match(claimDialog, /data-project-x-mismatch-alert="true"/);
  assert.match(entry, /onManualReviewRequested=\{\(next\) => \{ setProject\(next\); setClaimOpen\(false\); \}\}/);
});

test("post-import prompt uses the same Claim Memecoin dialog rather than a second flow", () => {
  assert.match(entry, /claimResult === "prompt"/);
  assert.match(claimDialog, /resolveProjectXIdentity\(item\)/);
  assert.match(claimDialog, /action, walletAddress/);
  assert.match(claimDialog, /signSolanaMessage\(message,walletAddress\)/);
  assert.match(claimDialog, /startProjectXClaim\(item,auth\)/);
});

test("imported official page mounts trading, claim banner and arena strip", () => {
  assert.match(page, /ImportedTradePanel/);
  assert.match(page, /UnifiedMarketChart/);
  assert.match(page, /data-import-claim-banner="true"/);
  assert.match(page, /Is this your project\? Claim it/);
  assert.match(page, /data-import-arena-strip="true"/);
  assert.match(page, /Project verification is separate from financial and competition eligibility/);
  assert.match(page, /REQUEST MANUAL CHECK/);
  assert.match(page, />Chart</);
  assert.match(page, />Trades</);
  assert.match(page, />Comments</);
  assert.match(page, /TokenComments/);
  assert.match(page, /ArenaUpvoteDialog/);
  assert.match(page, /Challenge this coin/);
  assert.match(page, /Trades appear here once this pool is indexed/);
  assert.match(page, /Imported token — no bonding curve/);
});

test("imports remain independent from post-grad Arena flags", () => {
  assert.match(importsConfig, /VITE_ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(importsConfig, /VITE_ENABLE_POSTGRAD_ARENA|postGradFlags/);
  assert.doesNotMatch(entry, /postGradFlags|isPostGradRouteEnabled|VITE_ENABLE_POSTGRAD_ARENA/);
  assert.match(postgradConfig, /VITE_ENABLE_POSTGRAD_ARENA/);
});

test("ordinary token fallback preserves original live Token Details boundary", () => {
  assert.match(liveEntry, /import TokenDetails from "\.\/TokenDetails"/);
  assert.doesNotMatch(liveEntry, /lookupArenaImport/);
  assert.doesNotMatch(liveEntry, /ImportedTokenDetails/);
  assert.match(entry, /if \(!projectImportsEnabled\) return <TokenDetailsLiveEntry \/>/);
  assert.match(entry, /if \(project\) return <>/);
  assert.match(entry, /<ImportedTokenPage/);
  assert.match(entry, /return <TokenDetailsLiveEntry \/>/);
});

test("Robinhood imported trades resolve a V3 pool or hide the panel with a clear note", () => {
  assert.match(tradePanel, /resolveImportedRobinhoodV3Route/);
  assert.match(tradePanel, /Trading on Robinhood imports arrives next/);
  assert.match(tradePanel, /data-robinhood-import-trade-pending="true"/);
});


test("claim image backfill updates the rendered imported project immediately", () => {
  assert.match(xClient, /imageUrl\?: string \| null/);
  assert.match(claimDialog, /if\(resolved\.imageUrl\) onResolvedImage\?\.\(resolved\.imageUrl\)/);
  assert.match(entry, /onResolvedImage=\{\(imageUrl\) => setProject/);
});