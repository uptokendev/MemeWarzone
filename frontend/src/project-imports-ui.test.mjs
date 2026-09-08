import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [app, config, importPage, importedPage, tokenEntry, liveTokenEntry, navigation, leftSidebar, mobileSidebar, client, showcase, overlay] = await Promise.all([
  read("./App.tsx"),
  read("./features/projectImports/config.ts"),
  read("./pages/ProjectImport.tsx"),
  read("./pages/ImportedTokenDetailsPage.tsx"),
  read("./pages/TokenDetailsEntry.tsx"),
  read("./pages/TokenDetailsLiveEntry.tsx"),
  read("./constants/navigation.ts"),
  read("./components/LeftBattleSidebar.tsx"),
  read("./components/Sidebar.tsx"),
  read("./lib/projectImports.ts"),
  read("./pages/Showcase.tsx"),
  read("./components/home/ImportedProjectsOverlay.tsx"),
]);

test("import route is independently gated from Arena", () => {
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(config, /postGradFlags|VITE_ENABLE_POSTGRAD_ARENA/);
  assert.match(app, /projectImportsEnabled \? <Route path="\/import" element={<ProjectImport \/>} \/>/);
  assert.doesNotMatch(app.match(/projectImportsEnabled \? <Route path="\/import"[^\n]+/)?.[0] || "", /postGradFlags/);
});

test("BNB and Solana onboarding render without Robinhood", () => {
  assert.match(importPage, /type ImportChain = "bnb" \| "solana"/);
  assert.match(importPage, />BNB<\/Button>/);
  assert.match(importPage, />Solana<\/Button>/);
  assert.match(importPage, /CONNECT BNB WALLET/);
  assert.match(importPage, /CONNECT SOLANA WALLET/);
  assert.match(importPage, /RESOLVE PROJECT/);
  assert.match(importPage, /REGISTER &amp; VERIFY PROJECT/);
  assert.doesNotMatch(importPage, /Robinhood/i);
});

test("clear import entry is present on desktop and mobile navigation", () => {
  assert.match(navigation, /IMPORT YOUR MEMECOIN/);
  assert.match(leftSidebar, /IMPORT YOUR MEMECOIN/);
  assert.match(mobileSidebar, /"\/import"/);
});

test("public token route resolves imported DB state before mounting live campaign runtime", () => {
  assert.match(importPage, /`\/token\/\$\{encodeURIComponent\(item\.tokenAddress\)\}\?chainId=\$\{item\.chainId\}`/);
  assert.doesNotMatch(importPage, /`\/imported\//);
  assert.match(tokenEntry, /lookupProjectImport\(routeId, importChainId\)/);
  assert.match(tokenEntry, /import ImportedTokenDetailsPage from "\.\/ImportedTokenDetailsPage"/);
  assert.match(tokenEntry, /import TokenDetailsLiveEntry from "\.\/TokenDetailsLiveEntry"/);
  assert.match(tokenEntry, /projectImportsEnabled/);
  assert.ok(tokenEntry.indexOf("lookupProjectImport(routeId, importChainId)") < tokenEntry.indexOf("if (project) return <ImportedTokenDetailsPage item={project} />"));
  assert.ok(tokenEntry.indexOf("if (project) return <ImportedTokenDetailsPage item={project} />") < tokenEntry.lastIndexOf("return <TokenDetailsLiveEntry />"));
  assert.match(tokenEntry, /if \(!projectImportsEnabled\) return <TokenDetailsLiveEntry \/>/);
  assert.match(tokenEntry, /if \(project\) return <ImportedTokenDetailsPage item={project} \/>/);
  assert.match(tokenEntry, /return <TokenDetailsLiveEntry \/>/);
  assert.doesNotMatch(tokenEntry, /ImportedProjectDetails/);
  assert.doesNotMatch(tokenEntry, /from .*graduation|from .*bonding|from .*Topaz|from .*Meteora|claim_intent/i);
  assert.match(liveTokenEntry, /import TokenDetails from "\.\/TokenDetails"/);
});

test("frontend uses independent project ownership fields and new API namespace", () => {
  assert.match(client, /ownershipStatus/);
  assert.match(client, /projectOwnerWallet/);
  assert.match(client, /ownershipVerifiedAt/);
  assert.match(client, /manualClaimRequestedAt/);
  assert.match(client, /arenaStatus/);
  assert.match(client, /\/api\/project-imports/);
  assert.doesNotMatch(client, /\/api\/arena\/imports/);
});

test("OWNER VERIFIED comes only from project ownership authority", () => {
  assert.match(importedPage, /item\.ownershipStatus === "ownership_verified"/);
  assert.match(importedPage, /const ownerVerified = item\.ownershipStatus === "ownership_verified"/);
  assert.match(importedPage, /data-owner-verified-badge="true"/);
  assert.match(importedPage, /OWNER VERIFIED/);
  assert.ok(importedPage.indexOf("if (!imageUrl)") < importedPage.indexOf('data-owner-verified-badge="true"'));
  assert.doesNotMatch(importedPage, /verifiedAt/);
  assert.doesNotMatch(importedPage, /status===.*passed|status===.*needs_review/);
  assert.doesNotMatch(importedPage, /arenaStatus/);
});

test("completed imported token page certifies the current temporary public profile", () => {
  assert.match(importedPage, /export default function ImportedTokenDetailsPage/);
  assert.match(importedPage, /const chainLabel = isSolana \? "Solana" : "BNB"/);
  assert.match(importedPage, /const identityLabel = isSolana \? "Mint" : "Contract"/);
  assert.match(importedPage, /src={imageUrl}/);
  assert.match(importedPage, /data-project-image="true"/);
  assert.match(importedPage, /data-project-name="true"/);
  assert.match(importedPage, /data-project-ticker="true"/);
  assert.match(importedPage, /data-project-chain="true"/);
  assert.match(importedPage, /data-project-address="true"/);
  assert.match(importedPage, /data-imported-badge="true"/);
  assert.match(importedPage, />[\s\n]*IMPORTED[\s\n]*<\//);
  assert.match(importedPage, /data-project-description="true"/);
  assert.match(importedPage, /data-project-socials="true"/);
  assert.match(importedPage, />Website<\/a>/);
  assert.match(importedPage, />X<\/a>/);
  assert.match(importedPage, />Telegram<\/a>/);
  assert.match(importedPage, /data-project-share="true"/);
  assert.match(importedPage, /SHARE/);
  assert.match(importedPage, /WARZONE ACCESS LOCKED/);
  assert.match(importedPage, /This project is registered with MemeWarzone\./);
  assert.match(importedPage, /The full Warzone is opening soon\./);
  assert.match(importedPage, /Share this project while the Warzone prepares for deployment\./);
  assert.ok(importedPage.indexOf("if (!imageUrl)") < importedPage.indexOf('data-imported-badge="true"'));
  assert.ok(importedPage.indexOf("if (!imageUrl)") < importedPage.indexOf('data-project-image="true"'));
});

test("temporary imported token page does not expose old public-page ownership or campaign controls", () => {
  assert.doesNotMatch(importedPage, /REQUEST PROJECT CLAIM/);
  assert.doesNotMatch(importedPage, /data-owner-edit-controls/);
  assert.doesNotMatch(importedPage, /data-owner-image-edit/);
  assert.doesNotMatch(importedPage, /data-manual-claim-state/);
  assert.doesNotMatch(importedPage, /claimProject|requestProjectClaim|manualClaimRequestedAt/);
  assert.doesNotMatch(importedPage, /canEdit=ownerVerified&&ownerConnected/);
  assert.doesNotMatch(importedPage, /\bBUY\b|\bSELL\b/);
  assert.doesNotMatch(importedPage, />\s*TRADE\s*</i);
  assert.doesNotMatch(importedPage, /UpVote/i);
  assert.doesNotMatch(importedPage, /AUTO DEPLOY/i);
  assert.doesNotMatch(importedPage, /Boost/i);
  assert.doesNotMatch(importedPage, /Follow this project/i);
  assert.doesNotMatch(importedPage, /Quarterly/i);
  assert.doesNotMatch(importedPage, /from .*TokenDetails|from .*launchpad|from .*chart|from .*trading|from .*swap|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
  assert.doesNotMatch(importedPage, /\/api\/arena|\/api\/campaign|candles|lightweight-charts|TradingView|swapRouter|bondingCurve|graduationMarket/i);
  assert.doesNotMatch(importedPage, /Arena admission|BATTLE READY|ARENA APPROVED|VERIFIED SAFE|LAUNCHED BY MEMEWARZONE|APPROVED FOR TRADING|GRADUATION MARKET APPROVED/i);
});

test("image-less authoritative import stays on the temporary page and does not fall through to live TokenDetails", () => {
  assert.match(importedPage, /const imageUrl = String\(item\.imageUrl \|\| ""\)\.trim\(\)/);
  const start = importedPage.indexOf("if (!imageUrl)");
  const end = importedPage.indexOf("const ownerVerified");
  assert.ok(start >= 0 && end > start, "incomplete image gate must precede completed profile rendering");
  const incomplete = importedPage.slice(start, end);
  assert.match(incomplete, /PROJECT REGISTRATION INCOMPLETE/);
  assert.match(incomplete, /A project image is required before this registration becomes public\./);
  assert.match(incomplete, /No trading, Arena actions or claims are available from this incomplete registration\./);
  assert.doesNotMatch(incomplete, /IMPORTED/);
  assert.doesNotMatch(incomplete, /OWNER VERIFIED/);
  assert.doesNotMatch(incomplete, /data-imported-badge|data-owner-verified-badge|data-project-profile|data-project-description|data-project-socials|data-project-share/);
  assert.doesNotMatch(tokenEntry, /imageUrl/);
  assert.match(tokenEntry, /if \(project\) return <ImportedTokenDetailsPage item={project} \/>/);
  assert.doesNotMatch(importedPage, /TokenDetailsLiveEntry/);
  assert.doesNotMatch(importedPage, /from "\.\/TokenDetails"|from '\.\/TokenDetails'/);
});

test("homepage overlay lists imported projects without Arena or financial actions", () => {
  assert.match(showcase, /ImportedProjectsOverlay/);
  assert.match(overlay, /WARZONE REGISTERED/);
  assert.match(overlay, /BATTLE ACCESS LOCKED/);
  assert.match(overlay, /listRecentProjectImports/);
  assert.match(overlay, /`\/token\/\$\{encodeURIComponent\(item\.tokenAddress\)\}\?chainId=\$\{item\.chainId\}`/);
  assert.match(overlay, /item\.imageUrl/);
  assert.match(overlay, /\$\{item\.symbol\}/);
  assert.doesNotMatch(overlay, /arenaStatus|Battle Ready|TRADE|Boost|UpVote|claims|status===.*passed/i);
  assert.doesNotMatch(overlay, /from .*Topaz|from .*Meteora|from .*graduation/i);
});

test("public recent-import query excludes incomplete imageless registrations", async () => {
  const core = await read("../api/lib/projectImportCore.js");
  const listFn = core.match(/export async function listRecentProjectImports[\s\S]+?return r\.rows\|\|\[\];/)?.[0] || "";
  assert.match(listFn, /image_url IS NOT NULL/);
  assert.match(listFn, /btrim\(image_url\) <> ''/);
  assert.doesNotMatch(listFn, /ownership_verified/);
  assert.doesNotMatch(listFn, /passed/);
});

test("import form cannot complete without a PNG, JPEG or WEBP image", () => {
  assert.match(importPage, /data-project-import-image-required="true"/);
  assert.match(importPage, /Add a project image \(PNG, JPEG or WEBP\) before registering/);
  assert.match(importPage, /disabled=\{!connected\|\|!validAddress\|\|working\|\|!evidence\|\|!imageFile\}/);
  assert.match(importPage, /project_import_registration_image/);
  assert.match(importPage, /This does not make you the verified project owner/);
  assert.match(client, /listRecentProjectImports/);
  assert.match(client, /uploadProjectRegistrationImage/);
});
