import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, config, importPage, importedPage, tokenEntry, liveTokenEntry, client, coinsPage, navigation, leftSidebar, mobileSidebar, claimDialog, api, core, resolverAdapters, reviewCore, imageApi, riskCore] = await Promise.all([
  read("./App.tsx"), read("./features/projectImports/config.ts"), read("./pages/ProjectImport.tsx"), read("./pages/ImportedTokenPage.tsx"),
  read("./pages/TokenDetailsEntry.tsx"), read("./pages/TokenDetailsLiveEntry.tsx"), read("./lib/projectImports.ts"), read("./pages/command-center/CommandCenterCoins.tsx"),
  read("./constants/navigation.ts"), read("./components/LeftBattleSidebar.tsx"), read("./components/Sidebar.tsx"), read("./components/imports/ProjectXClaimDialog.tsx"), read("../api/projectImports.js"),
  read("../api/lib/projectImportCore.js"), read("../api/lib/projectImportResolverAdapters.js"), read("../api/lib/projectOwnershipReview.js"),
  read("../api/projectImportImage.js"), read("../api/lib/projectImportRiskSecurity.js"),
]);

test("Project Import remains independently gated from Arena", () => {
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(config, /VITE_ENABLE_POSTGRAD_ARENA|postGradFlags/);
  assert.match(app, /projectImportsEnabled/);
  assert.match(client, /\/api\/project-imports/);
  assert.doesNotMatch(client, /\/api\/arena\/imports/);
});

test("BNB and Solana registration stay live while Robinhood uses its own gate", () => {
  assert.match(importPage, /type ImportChain = "bnb" \| "solana" \| "robinhood"/);
  assert.match(importPage, />BNB<\/Button>/);
  assert.match(importPage, />Solana<\/Button>/);
  assert.match(importPage, /projectImportRobinhoodEnabled/);
  assert.match(importPage, />Robinhood<\/Button>/);
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORT_ROBINHOOD/);
  assert.match(importPage, /3\. Contract Address/);
  assert.match(importPage, /placeholder="Contract Address"/);
  assert.match(importPage, /IMPORT MEMECOIN/);
  assert.doesNotMatch(importPage, /mint address/i);
});

test("registration is ownership-neutral and redirects pending projects into the separate claim flow", () => {
  assert.match(importPage, /Your wallet signs the import request only\. It does not need to own the token\./);
  assert.match(importPage, /createProjectImport/);
  assert.match(importPage, /ownershipStatus === "ownership_pending"/);
  assert.match(importPage, /params\.set\("claim", "prompt"\)/);
  assert.doesNotMatch(importPage, /claimProjectImport|requestProjectManualCheck|resolveProjectEvmAuthority/);
  assert.match(tokenEntry, /claimResult === "prompt" \|\| claimResult === "x_failed"/);
  assert.match(tokenEntry, /<ProjectXClaimDialog/);
});

test("wallet family auto-select remains safe while explicit chain choice is possible", () => {
  assert.match(importPage, /detectImportChain/);
  assert.match(importPage, /feedWallet\.solanaAccount/);
  assert.match(importPage, /feedWallet\.evmAccount/);
  assert.match(importPage, /setChainChosenByUser\(true\)/);
  assert.match(importPage, /disabled=\{!validAddress \|\| !connected \|\| working\}/);
});

test("EVM and Solana ownership verification lives only in the reusable claim dialog", () => {
  assert.match(claimDialog, /resolveProjectEvmAuthority\(item, connectedWallet\)/);
  assert.match(claimDialog, /claimProjectImport\(\{item,auth\}\)/);
  assert.match(claimDialog, /Solana project authority wallet/);
  assert.match(claimDialog, /VERIFY PROJECT AUTHORITY/);
  assert.match(claimDialog, /VERIFY WITH X/);
  assert.match(claimDialog, /REQUEST MANUAL REVIEW/);
  assert.match(claimDialog, /requestProjectManualCheck/);
});

test("automatic import remains gated by critical scam-risk screening", () => {
  assert.match(api, /scanProjectImportSecurity/);
  assert.match(api, /requireSecurityPass\(security\)/);
  assert.match(api, /security\?\.status === "blocked"/);
  assert.match(riskCore, /is_honeypot/);
  assert.match(riskCore, /cannot_sell_all/);
  assert.match(riskCore, /malicious_address/);
  assert.match(riskCore, /owner_change_balance/);
  assert.match(riskCore, /selfdestruct/);
  assert.match(riskCore, /can_take_back_ownership/);
  assert.match(riskCore, /freezable/);
  assert.match(riskCore, /non_transferable/);
  assert.match(riskCore, /balance_mutable_authority/);
  assert.match(riskCore, /transfer_hook/);
});

test("manual ownership review is retry-safe and cannot self-approve", () => {
  const manual = core.match(/export async function requestManualProjectClaim[\s\S]+?export async function patchProjectMetadata/)?.[0] || "";
  assert.match(manual, /ownership_status==="ownership_manual_review"/);
  assert.match(manual, /manual_claim_wallet/);
  assert.match(manual, /ownership_status='ownership_pending'/);
  assert.match(manual, /ownership_manual_review/);
  assert.doesNotMatch(manual, /SET[^;]*project_owner_wallet\s*=/i);
  assert.doesNotMatch(manual, /SET[^;]*ownership_status='ownership_verified'/i);
  assert.match(claimDialog, /This does not verify ownership automatically/);
});

test("clear Import navigation is available on desktop and mobile without replacing Warzone navigation", () => {
  assert.match(navigation, /Import your memecoin/i);
  assert.match(leftSidebar, /Import your memecoin/i);
  assert.match(leftSidebar, /Warzone/);
  assert.match(mobileSidebar, /"\/import"/);
  assert.match(mobileSidebar, /ArenaMobileNav/);
});

test("imported project route mounts owner-manageable surface and refreshes manual approval before live token runtime", () => {
  assert.match(tokenEntry, /lookupProjectImport\(routeId, importChainId\)/);
  assert.match(tokenEntry, /import ImportedTokenPage from "\.\/ImportedTokenPage"/);
  assert.match(tokenEntry, /if \(project\) return <>/);
  assert.match(tokenEntry, /<ImportedTokenPage/);
  assert.match(tokenEntry, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 10_000\)/);
  assert.match(liveTokenEntry, /import TokenDetails from "\.\/TokenDetails"/);
});

test("verified project owner is the only profile and replacement-image edit authority", () => {
  assert.match(importedPage, /item.ownershipStatus === "ownership_verified"/);
  assert.match(importedPage, /ownerConnected/);
  assert.match(importedPage, /canEdit = ownerVerified && ownerConnected/);
  assert.match(importedPage, /data-owner-edit-controls="true"/);
  assert.match(importedPage, /data-owner-image-edit="true"/);
  assert.match(importedPage, /data-owner-profile-editor="true"/);
  assert.match(core, /project_owner_wallet=\$3 AND ownership_status='ownership_verified'/);
  assert.doesNotMatch(core.match(/export async function patchProjectMetadata[\s\S]+?export async function persistProjectImage/)?.[0] || "", /imported_by_wallet/);
});

test("public imported project uses the official token layout with trading and arena status", () => {
  for (const marker of [/data-imported-badge="true"/, /data-owner-status-pill="verified"/, /data-project-image="true"/, /data-project-name="true"/, /data-project-ticker="true"/, /data-project-description="true"/, /data-project-socials="true"/, /data-project-share="true"/, /ImportedTradePanel/, /data-import-arena-strip="true"/]) assert.match(importedPage, marker);
  assert.match(importedPage, /Project verification is separate from financial and competition eligibility/);
  assert.match(coinsPage, /ProjectImportPanel/);
  assert.doesNotMatch(coinsPage, /title="Imported coins"/);
});

test("Solana display metadata stays separate from authenticated project-wallet evidence", () => {
  assert.match(resolverAdapters, /metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s/);
  assert.match(resolverAdapters, /findProgramAddressSync/);
  assert.match(resolverAdapters, /getTokenMetadata/);
  assert.match(resolverAdapters, /TOKEN_2022_PROGRAM_ID/);
  assert.match(resolverAdapters, /resolveSolanaProjectAuthority/);
  assert.match(resolverAdapters, /signedWalletMatchesAuthority:\s*Boolean\(authority\.currentAuthority/);
  assert.doesNotMatch(resolverAdapters, /jupiter|birdeye|dexscreener|updateAuthority/i);
});

test("operator ownership review is admin-authenticated, CAS-safe, audited, image-gated and Arena-independent", () => {
  assert.match(api, /requireDashboardAdmin/);
  assert.match(api, /\/admin\/ownership-claims/);
  assert.match(api, /reviewProjectOwnership\(pool/);
  assert.match(reviewCore, /ownership_status = \$1/);
  assert.match(reviewCore, /manual_claim_wallet IS NOT NULL/);
  assert.match(reviewCore, /xmin::text AS state_version/);
  assert.match(reviewCore, /expectedVersion/);
  assert.match(reviewCore, /FOR UPDATE/);
  assert.match(reviewCore, /PROJECT_OWNERSHIP_STATE_CONFLICT/);
  assert.match(reviewCore, /PROJECT_OWNERSHIP_IMAGE_REQUIRED/);
  assert.match(reviewCore, /wm_admin_audit_log/);
  assert.doesNotMatch(reviewCore, /SET[^;]*(?:\bstatus\b|review_requested_at|review_reason|reviewer|reviewed_at)\s*=/i);
});

test("Project image API remains isolated behind Project ownership rather than Arena authority", () => {
  assert.match(imageApi, /requireProjectImportWalletAuth/);
  assert.match(imageApi, /bindRegistrationImage|persistProjectImage/);
  assert.doesNotMatch(imageApi, /\/api\/arena\/imports/);
});

test("existing MemeWarzone token runtime remains the fallback for non-imported rows", () => {
  assert.match(coinsPage, /type: "imported"/);
  assert.match(client, /listUserProjectImports/);
  assert.match(tokenEntry, /return <TokenDetailsLiveEntry \/>/);
});

test("Pump ownership challenge rails remain available as a server-verified fallback without granting Arena rights", () => {
  assert.match(client, /startPumpOwnershipChallenge/);
  assert.match(client, /checkPumpOwnershipChallenge/);
  assert.match(api, /pump-challenge/);
  assert.match(api, /PROJECT_IMPORT_ACTIONS\.pumpChallengeStart/);
  assert.match(api, /PROJECT_IMPORT_ACTIONS\.pumpChallengeCheck/);
  assert.doesNotMatch(client, /\/api\/arena\/imports/);
});