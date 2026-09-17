import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, config, importPage, importedPage, tokenEntry, liveTokenEntry, client, coinsPage, navigation, leftSidebar, mobileSidebar, api, core, resolverAdapters, reviewCore, imageApi, riskCore] = await Promise.all([
  read("./App.tsx"), read("./features/projectImports/config.ts"), read("./pages/ProjectImport.tsx"), read("./pages/ImportedProjectDetails.tsx"),
  read("./pages/TokenDetailsEntry.tsx"), read("./pages/TokenDetailsLiveEntry.tsx"), read("./lib/projectImports.ts"), read("./pages/command-center/CommandCenterCoins.tsx"),
  read("./constants/navigation.ts"), read("./components/LeftBattleSidebar.tsx"), read("./components/Sidebar.tsx"), read("../api/projectImports.js"),
  read("../api/lib/projectImportCore.js"), read("../api/lib/projectImportResolverAdapters.js"), read("../api/lib/projectOwnershipReview.js"),
  read("../api/projectImportImage.js"), read("../api/lib/projectImportRiskSecurity.js"),
]);

test("project imports remain independently gated from Arena", () => {
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORTS/); assert.doesNotMatch(config, /VITE_ENABLE_POSTGRAD_ARENA|postGradFlags/);
  assert.match(app, /projectImportsEnabled/); assert.match(client, /\/api\/project-imports/); assert.doesNotMatch(client, /\/api\/arena\/imports/);
});

test("BNB and Solana stay live while Robinhood import is built behind its own disabled-by-default switch", () => {
  assert.match(importPage, /type ImportChain = "bnb" \| "solana" \| "robinhood"/); assert.match(importPage, />BNB<\/Button>/); assert.match(importPage, />Solana<\/Button>/);
  assert.match(importPage, /projectImportRobinhoodEnabled\?<Button/); assert.match(importPage, />Robinhood<\/Button>/);
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORT_ROBINHOOD/); assert.match(config, /projectImportRobinhoodEnabled = readBoolean\(import\.meta\.env\.VITE_ENABLE_PROJECT_IMPORT_ROBINHOOD, false\)/);
  assert.match(importPage, /3\. Contract Address/); assert.match(importPage, /placeholder="Contract Address"/); assert.match(importPage, /}IMPORT<\/Button>/); assert.match(importPage, /REGISTER MEMECOIN/);
  assert.doesNotMatch(importPage, /mint address/i);
});

test("wallet family auto-select remains safe while explicit chain choice is possible", () => {
  assert.match(importPage, /detectImportChain/); assert.match(importPage, /feedWallet\.solanaAccount/); assert.match(importPage, /feedWallet\.evmAccount/);
  assert.match(importPage, /setChainChosenByUser\(true\)/); assert.match(importPage, /disabled=\{!validAddress\|\|!connected\|\|working\}/);
});

test("wrong wallet is fully blocked and shows the masked controlling wallet", () => {
  assert.match(importPage, /NOT TOKEN OWNER/); assert.match(importPage, /This token is controlled by wallet/); assert.match(importPage, /Connect that wallet to continue/);
  assert.match(importPage, /slice\(0, 4\)/); assert.match(importPage, /slice\(-4\)/); assert.match(importPage, /Import blocked/);
  assert.match(importPage, /canRequestManual=.*?!wrongAuthorityWallet/);
  assert.match(importPage, /reviewablePumpMismatch/); assert.match(importPage, /pumpFunToken/); assert.match(importPage, /Easy project proof/); assert.match(importPage, /MWZ-/);
  assert.match(importPage, /REQUEST MANUAL CHECK/);
  assert.match(api, /isPumpFunImportToken\(resolved\)/);
  assert.match(api, /Connect that wallet to continue/);
});

test("automatic import is gated by scam-risk screening", () => {
  assert.match(api, /scanProjectImportSecurity/); assert.match(api, /requireSecurityPass\(security\)/);
  assert.match(api, /security\?\.status === "blocked"/);
  assert.match(riskCore, /is_honeypot/); assert.match(riskCore, /cannot_sell_all/); assert.match(riskCore, /malicious_address/);
  assert.match(riskCore, /owner_change_balance/); assert.match(riskCore, /selfdestruct/); assert.match(riskCore, /can_take_back_ownership/);
  assert.match(riskCore, /freezable/); assert.match(riskCore, /non_transferable/); assert.match(riskCore, /balance_mutable_authority/); assert.match(riskCore, /transfer_hook/);
  assert.match(riskCore, /status === "pass" \|\| security\?\.status === "review"/);
  assert.match(importPage, /autoCleared&&evidence\?\.signedWalletMatchesAuthority/);
  assert.doesNotMatch(importPage, /securityPass&&autoCleared/);
});

test("manual-review cases can attach an image but remain hidden until approval", () => {
  assert.match(importPage, /REQUEST MANUAL CHECK/); assert.match(importPage, /Add the project image before requesting manual review/);
  assert.match(importPage, /uploadPendingImage/); assert.match(importPage, /ATTACH IMAGE TO REVIEW/); assert.match(importPage, /MANUAL CHECK NEEDED/); assert.match(importPage, /project stays hidden until we approve it/);
  assert.match(core, /ownership_status='ownership_verified'/); assert.match(core, /ownership_status='ownership_manual_review'/); assert.match(core, /manual_claim_wallet=\$3/);
  assert.match(core, /AND ownership_status='ownership_verified'/);
  assert.match(reviewCore, /Manual ownership approval requires a project image/); assert.match(reviewCore, /PROJECT_OWNERSHIP_IMAGE_REQUIRED/);
  assert.doesNotMatch(imageApi, /if\(registration\)assertVerifiedProjectOwner/);
});

test("manual claim persistence is retry-safe and cannot self-approve", () => {
  const manual = core.match(/export async function requestManualProjectClaim[\s\S]+?export async function patchProjectMetadata/)?.[0] || "";
  assert.match(manual, /ownership_status==="ownership_manual_review"/); assert.match(manual, /normalizeAddress\(existing\.manual_claim_wallet\|\|"",identity\.chainId\)[\s\S]*?===signer[\s\S]*?===normalizedNote[\s\S]*?return existing/);
  assert.match(manual, /ownership_status='ownership_pending'/); assert.match(manual, /ownership_manual_review/);
  assert.doesNotMatch(manual, /SET[^;]*project_owner_wallet\s*=/i); assert.doesNotMatch(manual, /SET[^;]*ownership_status='ownership_verified'/i);
});

test("clear import navigation remains available", () => {
  assert.match(navigation, /Import your memecoin/i); assert.match(leftSidebar, /Import your memecoin/i); assert.match(mobileSidebar, /"\/import"/);
});

test("imported project route mounts owner-manageable surface and refreshes manual approval before live token runtime", () => {
  assert.match(tokenEntry, /lookupProjectImport\(routeId, importChainId\)/); assert.match(tokenEntry, /import ImportedProjectDetails from "\.\/ImportedProjectDetails"/);
  assert.match(tokenEntry, /if \(project\) return <ImportedProjectDetails key=/); assert.match(tokenEntry, /item=\{project\} \/>/); assert.match(tokenEntry, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 10_000\)/); assert.match(liveTokenEntry, /import TokenDetails from "\.\/TokenDetails"/);
});

test("verified project owner is the only profile and replacement-image edit authority", () => {
  assert.match(importedPage, /item\.ownershipStatus==="ownership_verified"/); assert.match(importedPage, /ownerConnected/); assert.match(importedPage, /canEdit=ownerVerified&&ownerConnected/);
  assert.match(importedPage, /data-owner-edit-controls="true"/); assert.match(importedPage, /data-owner-image-edit="true"/); assert.match(importedPage, /data-owner-profile-editor="true"/);
  assert.match(core, /project_owner_wallet=\$3 AND ownership_status='ownership_verified'/);
  assert.doesNotMatch(core.match(/export async function patchProjectMetadata[\s\S]+?export async function persistProjectImage/)?.[0] || "", /imported_by_wallet/);
});

test("public imported project remains financially inert and visibly locked", () => {
  for (const marker of [/data-imported-badge="true"/, /OWNER VERIFIED/, /data-project-image="true"/, /data-project-name="true"/, /data-project-ticker="true"/, /data-project-description="true"/, /data-project-socials="true"/, /data-project-share="true"/, /WARZONE ACCESS LOCKED/]) assert.match(importedPage, marker);
  assert.match(importedPage, /No trading, claims, Arena actions or launch deployment are enabled from this page/);
  assert.doesNotMatch(importedPage, />\s*BUY\s*</i); assert.doesNotMatch(importedPage, />\s*SELL\s*</i); assert.doesNotMatch(importedPage, /AUTO DEPLOY|Boost|UpVote|Quarterly/i);
  assert.doesNotMatch(importedPage, /from .*TokenDetails|from .*launchpad|from .*chart|from .*trading|from .*swap|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
});

test("Solana display metadata stays optional and separate from authenticated project-wallet evidence", () => {
  assert.match(resolverAdapters, /metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s/); assert.match(resolverAdapters, /findProgramAddressSync/); assert.match(resolverAdapters, /getAccountInfo/);
  assert.match(resolverAdapters, /getTokenMetadata/); assert.match(resolverAdapters, /TOKEN_2022_PROGRAM_ID/);
  assert.match(resolverAdapters, /name:\s*metadata\.name/); assert.match(resolverAdapters, /symbol:\s*metadata\.symbol/); assert.match(resolverAdapters, /resolveSolanaProjectAuthority/);
  assert.match(resolverAdapters, /signedWalletMatchesAuthority:\s*Boolean\(authority\.currentAuthority/); assert.doesNotMatch(resolverAdapters, /jupiter|birdeye|dexscreener|updateAuthority/i);
  assert.match(api, /enrichExistingProjectIdentity/); assert.match(api, /name IS NULL OR btrim\(name\) = ''/); assert.match(api, /symbol IS NULL OR btrim\(symbol\) = ''/);
});

test("ownership verification commits before best-effort display metadata refresh", () => {
  const refresh = api.match(/async function refreshVerifiedProjectIdentityBestEffort[\s\S]+?async function handleOwnershipAdmin/)?.[0] || "";
  assert.match(refresh, /try[\s\S]*resolveForSigner[\s\S]*enrichExistingProjectIdentity[\s\S]*catch/);
  assert.match(api, /const updated = await reviewProjectOwnership\(pool,[\s\S]*?\);[\s\S]*?if \(action === "verify_owner"\) await refreshVerifiedProjectIdentityBestEffort\(updated\);[\s\S]*?return json/);
});

test("operator ownership review is admin-authenticated, CAS-safe, audited, image-gated, and Arena-independent", () => {
  assert.match(api, /requireDashboardAdmin/); assert.match(api, /\/admin\/ownership-claims/); assert.match(api, /reviewProjectOwnership\(pool/);
  assert.match(reviewCore, /ownership_status = \$1/); assert.match(reviewCore, /manual_claim_wallet IS NOT NULL/);
  assert.match(reviewCore, /xmin::text AS state_version/); assert.match(reviewCore, /expectedVersion/); assert.match(reviewCore, /FOR UPDATE/); assert.match(reviewCore, /PROJECT_OWNERSHIP_STATE_CONFLICT/);
  assert.match(reviewCore, /PROJECT_OWNERSHIP_IMAGE_REQUIRED/); assert.match(reviewCore, /wm_admin_audit_log/); assert.match(reviewCore, /operatorReason/); assert.match(reviewCore, /operatorAuthUserId/);
  assert.match(reviewCore, /project_owner_wallet=manual_claim_wallet/); assert.match(reviewCore, /ownership_status=\$2/); assert.match(reviewCore, /VERIFIED/); assert.match(reviewCore, /PENDING/);
  assert.doesNotMatch(reviewCore, /SET[^;]*(?:\bstatus\b|review_requested_at|review_reason|reviewer|reviewed_at)\s*=/i);
});

test("existing MemeWarzone token runtime remains the fallback for non-imported rows", () => {
  assert.match(coinsPage, /type: "imported"/); assert.match(client, /listUserProjectImports/); assert.match(tokenEntry, /return <TokenDetailsLiveEntry \/>/);
});


test("Pump.fun mismatch offers a 15-minute creator-wallet transfer proof without weakening other mismatches",()=>{
  assert.match(importPage,/VERIFY YOUR PUMP\.FUN WALLET/);
  assert.match(importPage,/START VERIFICATION/);
  assert.match(importPage,/I SENT IT - CHECK NOW/);
  assert.match(importPage,/MemeWarzone never receives the SOL/);
  assert.match(importPage,/project_import_pump_challenge_start/);
  assert.match(importPage,/project_import_pump_challenge_check/);
});
