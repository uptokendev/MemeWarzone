import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [app, config, importPage, importedPage, tokenEntry, liveTokenEntry, navigation, leftSidebar, mobileSidebar, client, showcase, overlay] = await Promise.all([
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
  assert.match(tokenEntry, /lookupProjectImport/);
  assert.match(tokenEntry, /ImportedProjectDetails/);
  assert.match(tokenEntry, /projectImportsEnabled/);
  assert.match(tokenEntry, /TokenDetailsLiveEntry/);
  assert.match(tokenEntry, /if \(project\) return <ImportedProjectDetails item={project} \/>/);
  assert.doesNotMatch(tokenEntry, /from .*graduation|from .*bonding|from .*Topaz|from .*Meteora|claim_intent/i);
  assert.match(liveTokenEntry, /TokenDetails/);
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
  assert.match(importedPage, /item\.ownershipStatus==="ownership_verified"/);
  assert.match(importedPage, /item\.projectOwnerWallet/);
  assert.doesNotMatch(importedPage, /verifiedAt/);
  assert.doesNotMatch(importedPage, /status===.*passed|status===.*needs_review/);
});

test("manual claim is available to a signed connected claimant, not only first importer", () => {
  assert.match(importedPage, /if\(!connectedWallet\|\|ownerVerified/);
  assert.match(importedPage, /REQUEST PROJECT CLAIM/);
  assert.doesNotMatch(importedPage, /ownerWallet/);
  assert.doesNotMatch(importedPage, /imported_by_wallet|importedByWallet/);
  assert.match(importedPage, /Manual review does not grant edit rights or Arena access/);
});

test("imported project page exposes only release-safe project controls", () => {
  assert.match(importedPage, /data-imported-badge="true"/);
  assert.match(importedPage, /data-owner-verified-badge="true"/);
  assert.match(importedPage, /data-owner-edit-controls="true"/);
  assert.match(importedPage, /data-owner-image-edit="true"/);
  assert.match(importedPage, /data-manual-claim-state="true"/);
  assert.match(importedPage, /data-project-share="true"/);
  assert.match(importedPage, /WARZONE ACCESS LOCKED/);
  assert.match(importedPage, /This project is registered with MemeWarzone\./);
  assert.match(importedPage, /Battles, Tournaments and War Leagues are opening soon\./);
  assert.match(importedPage, /No trading, claims, Arena actions or launch deployment are enabled from this page\./);

  assert.doesNotMatch(importedPage, />\s*TRADE\s*</i);
  assert.doesNotMatch(importedPage, /UpVote/i);
  assert.doesNotMatch(importedPage, /AUTO DEPLOY/i);
  assert.doesNotMatch(importedPage, /Boost/i);
  assert.doesNotMatch(importedPage, /Quarterly/i);
  assert.doesNotMatch(importedPage, /Follow this project/i);
});

test("owner edits are gated by verified ownership and authoritative owner wallet", () => {
  assert.match(importedPage, /canEdit=ownerVerified&&ownerConnected/);
  assert.match(importedPage, /editing&&canEdit/);
  assert.match(importedPage, /if\(!canEdit\|\|saving\)return/);
  assert.match(importedPage, /if\(!canEdit\|\|uploading\)return/);
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

test("import form cannot complete without a PNG, JPEG or WEBP image", () => {
  assert.match(importPage, /data-project-import-image-required="true"/);
  assert.match(importPage, /Add a project image \(PNG, JPEG or WEBP\) before registering/);
  assert.match(importPage, /disabled=\{!connected\|\|!validAddress\|\|working\|\|!evidence\|\|!imageFile\}/);
  assert.match(importPage, /project_import_registration_image/);
  assert.match(importPage, /This does not make you the verified project owner/);
  assert.match(client, /listRecentProjectImports/);
  assert.match(client, /uploadProjectRegistrationImage/);
});
