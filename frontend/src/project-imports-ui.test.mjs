import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  app,
  config,
  importPage,
  importedPage,
  tokenEntry,
  liveTokenEntry,
  navigation,
  leftSidebar,
  mobileSidebar,
  client,
  showcase,
  overlay,
  coinsPage,
  coinRow,
  profilePage,
  commandShell,
  api,
  core,
  resolverAdapters,
] = await Promise.all([
  read("./App.tsx"),
  read("./features/projectImports/config.ts"),
  read("./pages/ProjectImport.tsx"),
  read("./pages/ImportedProjectDetails.tsx"),
  read("./pages/TokenDetailsEntry.tsx"),
  read("./pages/TokenDetailsLiveEntry.tsx"),
  read("./constants/navigation.ts"),
  read("./components/LeftBattleSidebar.tsx"),
  read("./components/Sidebar.tsx"),
  read("./lib/projectImports.ts"),
  read("./pages/Showcase.tsx"),
  read("./components/home/ImportedProjectsOverlay.tsx"),
  read("./pages/command-center/CommandCenterCoins.tsx"),
  read("./components/postgrad/CommandCenterCoinRow.tsx"),
  read("./pages/ProfilePage.tsx"),
  read("./components/command-center/CommandCenterShell.tsx"),
  read("../api/projectImports.js"),
  read("../api/lib/projectImportCore.js"),
  read("../api/lib/projectImportResolverAdapters.js"),
]);

test("import route remains independently gated from Arena", () => {
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(config, /postGradFlags|VITE_ENABLE_POSTGRAD_ARENA/);
  assert.match(app, /projectImportsEnabled \? <Route path="\/import" element={<ProjectImport \/>} \/>/);
});

test("BNB and Solana onboarding uses founder-approved wording and no Robinhood dependency", () => {
  assert.match(importPage, /type ImportChain = "bnb" \| "solana"/);
  assert.match(importPage, />BNB<\/Button>/);
  assert.match(importPage, />Solana<\/Button>/);
  assert.match(importPage, /CONNECT BNB WALLET/);
  assert.match(importPage, /CONNECT SOLANA WALLET/);
  assert.match(importPage, />IMPORT<\/Button>/);
  assert.match(importPage, /REGISTER &amp; VERIFY MEMECOIN/);
  assert.doesNotMatch(importPage, /RESOLVE PROJECT|REGISTER &amp; VERIFY PROJECT/);
  assert.doesNotMatch(importPage, /Robinhood/i);
});

test("wallet family auto-select is safe and explicit chain choice remains available", () => {
  assert.match(importPage, /detectImportChain/);
  assert.match(importPage, /feedWallet\.solanaAccount/);
  assert.match(importPage, /feedWallet\.evmAccount/);
  assert.match(importPage, /setChainChosenByUser\(true\)/);
  assert.match(importPage, /disabled=\{!validAddress\|\|!connected\|\|working\}/);
});

test("clear import entry remains on desktop and mobile navigation", () => {
  assert.match(navigation, /Import your memecoin/);
  assert.match(leftSidebar, /Import your memecoin/);
  assert.match(mobileSidebar, /"\/import"/);
});

test("public token route resolves imported DB state before mounting live campaign runtime", () => {
  assert.match(importPage, /`\/token\/\$\{encodeURIComponent\(item\.tokenAddress\)\}\?chainId=\$\{item\.chainId\}`/);
  assert.match(tokenEntry, /lookupProjectImport\(routeId, importChainId\)/);
  assert.match(tokenEntry, /import ImportedProjectDetails from "\.\/ImportedProjectDetails"/);
  assert.match(tokenEntry, /import TokenDetailsLiveEntry from "\.\/TokenDetailsLiveEntry"/);
  assert.ok(tokenEntry.indexOf("lookupProjectImport(routeId, importChainId)") < tokenEntry.indexOf("if (project) return <ImportedProjectDetails item={project} />"));
  assert.match(tokenEntry, /if \(!projectImportsEnabled\) return <TokenDetailsLiveEntry \/>/);
  assert.match(tokenEntry, /return <TokenDetailsLiveEntry \/>/);
  assert.doesNotMatch(tokenEntry, /from .*graduation|from .*bonding|from .*Topaz|from .*Meteora|claim_intent/i);
  assert.match(liveTokenEntry, /import TokenDetails from "\.\/TokenDetails"/);
});

test("frontend uses independent project ownership fields and project import API namespace", () => {
  assert.match(client, /ownershipStatus/);
  assert.match(client, /projectOwnerWallet/);
  assert.match(client, /ownershipVerifiedAt/);
  assert.match(client, /manualClaimRequestedAt/);
  assert.match(client, /arenaStatus/);
  assert.match(client, /\/api\/project-imports/);
  assert.doesNotMatch(client, /\/api\/arena\/imports/);
});

test("OWNER VERIFIED and edit authority derive only from verified project ownership", () => {
  assert.match(importedPage, /item\.ownershipStatus==="ownership_verified"/);
  assert.match(importedPage, /ownerConnected=sameWallet\(connectedWallet,item\.projectOwnerWallet,solana\)/);
  assert.match(importedPage, /canEdit=ownerVerified&&ownerConnected/);
  assert.match(importedPage, /data-owner-verified-badge="true"/);
  assert.match(importedPage, /data-owner-edit-controls="true"/);
  assert.match(importedPage, /data-owner-image-edit="true"/);
  assert.doesNotMatch(importedPage, /importedByWallet/);
  assert.doesNotMatch(importedPage, /arenaStatus|status.*passed|needs_review/i);
});

test("completed imported page exposes required project profile and share surface", () => {
  assert.match(importedPage, /data-project-image="true"/);
  assert.match(importedPage, /data-project-name="true"/);
  assert.match(importedPage, /data-project-ticker="true"/);
  assert.match(importedPage, /data-project-chain="true"/);
  assert.match(importedPage, /data-project-address="true"/);
  assert.match(importedPage, /data-imported-badge="true"/);
  assert.match(importedPage, /data-project-description="true"/);
  assert.match(importedPage, /data-project-socials="true"/);
  assert.match(importedPage, /Website/);
  assert.match(importedPage, />X<\/a>/);
  assert.match(importedPage, /Telegram/);
  assert.match(importedPage, /data-project-share="true"/);
});

test("image-less authoritative import stays incomplete and never falls through to live TokenDetails", () => {
  assert.match(importedPage, /PROJECT REGISTRATION INCOMPLETE/);
  assert.match(importedPage, /A project image is required before this registration becomes public\./);
  assert.match(importedPage, /No trading, Arena actions or claims are available from this incomplete registration\./);
  assert.match(importedPage, /data-project-registration-incomplete="true"/);
  assert.doesNotMatch(tokenEntry, /imageUrl/);
});

test("manual review becomes a terminal visible pending state until operator decision", () => {
  assert.match(importPage, /OWNERSHIP REVIEW REQUESTED/);
  assert.match(importPage, /data-ownership-review-requested="true"/);
  assert.match(importedPage, /OWNERSHIP REVIEW REQUESTED/);
  assert.match(importedPage, /item\.ownershipStatus!=="ownership_manual_review"/);
  assert.match(importedPage, /REQUEST PROJECT CLAIM/);
});

test("Warzone remains explicitly locked and imported page mounts no financial controls", () => {
  assert.match(importedPage, /WARZONE ACCESS LOCKED/);
  assert.match(importedPage, /Battles, Tournaments and War Leagues are opening soon\./);
  assert.match(importedPage, /No trading, claims, Arena actions or launch deployment are enabled from this page\./);
  assert.doesNotMatch(importedPage, /from .*TokenDetails|from .*launchpad|from .*chart|from .*trading|from .*swap|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
  assert.doesNotMatch(importedPage, /\bBUY\b|\bSELL\b|AUTO DEPLOY|UpVote|Boost|BATTLE READY|ARENA APPROVED|VERIFIED SAFE|LAUNCHED BY MEMEWARZONE|APPROVED FOR TRADING|GRADUATION MARKET APPROVED/i);
  assert.doesNotMatch(importedPage, /\/api\/arena|\/api\/campaign|candles|lightweight-charts|TradingView|swapRouter|bondingCurve|graduationMarket/i);
});

test("recent public imports exclude incomplete registrations without coupling to ownership or Arena", () => {
  const listFn = core.match(/export async function listRecentProjectImports[\s\S]+?return r\.rows\|\|\[\];/)?.[0] || "";
  assert.match(listFn, /image_url IS NOT NULL/);
  assert.match(listFn, /btrim\(image_url\) <> ''/);
  assert.doesNotMatch(listFn, /ownership_verified/);
  assert.doesNotMatch(listFn, /passed/);
});

test("registration requires durable PNG JPEG or WEBP image without granting ownership", () => {
  assert.match(importPage, /data-project-import-image-required="true"/);
  assert.match(importPage, /Add a project image \(PNG, JPEG or WEBP\) before registering/);
  assert.match(importPage, /disabled=\{!connected\|\|!validAddress\|\|working\|\|!evidence\|\|!imageFile\}/);
  assert.match(importPage, /project_import_registration_image/);
  assert.match(importPage, /This does not make you the verified project owner/);
  assert.match(client, /uploadProjectRegistrationImage/);
});

test("Command Center and global Import entry retain the emergency onboarding route", () => {
  assert.match(coinsPage, /data-command-center-import-card="true"/);
  assert.match(coinsPage, /IMPORT EXISTING MEMECOIN/);
  assert.match(coinsPage, /<ProjectImportPanel embedded/);
  assert.match(coinsPage, /searchParams.get\("import"\) === "1"/);
  assert.match(importPage, /Navigate to=\{commandCenterImportPath\(feedWallet\.address\)\}/);
  assert.match(client, /return "\/profile\?import=1"/);
  assert.match(profilePage, /searchParams.get\("import"\) === "1"/);
  assert.match(commandShell, /location\.search/);
});

test("imported projects remain visible in My Coins with wallet-relative ownership states", () => {
  assert.match(coinsPage, /listUserProjectImports\(walletAddress, importChainId\)/);
  assert.match(coinsPage, /type: "imported"/);
  assert.match(coinsPage, /label: "OWNER VERIFIED"/);
  assert.match(coinsPage, /label: "OWNERSHIP PENDING"/);
  assert.match(coinRow, /type: 'draft' \| 'coin' \| 'imported'/);
  assert.match(coinRow, /label="IMPORTED"/);
  assert.match(coinRow, /data-imported-project-row="true"/);
});

test("homepage imported-project overlay stays non-financial", () => {
  assert.match(showcase, /ImportedProjectsOverlay/);
  assert.match(overlay, /WARZONE REGISTERED/);
  assert.match(overlay, /BATTLE ACCESS LOCKED/);
  assert.match(overlay, /listRecentProjectImports/);
  assert.doesNotMatch(overlay, /arenaStatus|Battle Ready|TRADE|Boost|UpVote|claims|status===.*passed/i);
  assert.doesNotMatch(overlay, /from .*Topaz|from .*Meteora|from .*graduation/i);
});

test("manual project claim creation is idempotent and cannot overwrite another pending claimant", () => {
  const manual = core.match(/export async function requestManualProjectClaim[\s\S]+?export async function patchProjectMetadata/)?.[0] || "";
  assert.match(manual, /ownership_status==="ownership_manual_review"/);
  assert.match(manual, /if\(claimant===signer\)return existing/);
  assert.match(manual, /A different project ownership claim is already under review/);
  assert.match(manual, /ownership_status='ownership_pending'/);
  assert.match(manual, /OWNERSHIP_CONFLICT/);
});

test("admin ownership queue and decisions never reuse Arena admission state", () => {
  assert.match(api, /\/admin\/ownership-claims/);
  assert.match(api, /ownership_status='ownership_manual_review'/);
  assert.match(api, /project_owner_wallet=manual_claim_wallet/);
  assert.match(api, /ownership_status='ownership_verified'/);
  assert.match(api, /ownership_status='ownership_pending'/);
  assert.match(api, /wm_admin_audit_log/);
  assert.match(api, /expectedVersion/);
  assert.doesNotMatch(api, /SET status=|status='passed'|status='rejected'/);
});

test("Solana display metadata is optional and ownership remains mintAuthority-only", () => {
  assert.match(resolverAdapters, /TOKEN_METADATA_PROGRAM_ID/);
  assert.match(resolverAdapters, /resolveSolanaDisplayMetadata/);
  assert.match(resolverAdapters, /return\{name:null,symbol:null\}/);
  assert.match(resolverAdapters, /resolveProjectOwnershipSolana/);
  assert.match(resolverAdapters, /automaticOwnershipAvailable:Boolean\(raw\.automaticVerificationAvailable\)/);
  assert.match(resolverAdapters, /currentAuthority:raw\.mintAuthority/);
  assert.doesNotMatch(resolverAdapters, /updateAuthority|creator.*authority/i);
});
