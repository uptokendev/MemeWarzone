import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, config, importPage, importedPage, tokenEntry, liveTokenEntry, client, coinsPage, navigation, leftSidebar, mobileSidebar, api, core, resolverAdapters, reviewCore] = await Promise.all([
  read("./App.tsx"), read("./features/projectImports/config.ts"), read("./pages/ProjectImport.tsx"), read("./pages/ImportedProjectDetails.tsx"),
  read("./pages/TokenDetailsEntry.tsx"), read("./pages/TokenDetailsLiveEntry.tsx"), read("./lib/projectImports.ts"), read("./pages/command-center/CommandCenterCoins.tsx"),
  read("./constants/navigation.ts"), read("./components/LeftBattleSidebar.tsx"), read("./components/Sidebar.tsx"), read("../api/projectImports.js"),
  read("../api/lib/projectImportCore.js"), read("../api/lib/projectImportResolverAdapters.js"), read("../api/lib/projectOwnershipReview.js"),
]);

test("project imports remain independently gated from Arena", () => {
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORTS/); assert.doesNotMatch(config, /VITE_ENABLE_POSTGRAD_ARENA|postGradFlags/);
  assert.match(app, /projectImportsEnabled/); assert.match(client, /\/api\/project-imports/); assert.doesNotMatch(client, /\/api\/arena\/imports/);
});

test("BNB and Solana onboarding use approved wording and no Robinhood dependency", () => {
  assert.match(importPage, /type ImportChain = "bnb" \| "solana"/); assert.match(importPage, />BNB<\/Button>/); assert.match(importPage, />Solana<\/Button>/);
  assert.match(importPage, /detectedChain/); assert.match(importPage, /}IMPORT<\/Button>/); assert.match(importPage, /REGISTER &amp; VERIFY MEMECOIN/);
  assert.doesNotMatch(importPage, /RESOLVE PROJECT|REGISTER &amp; VERIFY PROJECT/); assert.doesNotMatch(importPage, /Robinhood/i);
});

test("wallet family auto-select remains safe while explicit chain choice is possible", () => {
  assert.match(importPage, /detectImportChain/); assert.match(importPage, /feedWallet\.solanaAccount/); assert.match(importPage, /feedWallet\.evmAccount/);
  assert.match(importPage, /setChainChosenByUser\(true\)/); assert.match(importPage, /disabled=\{!validAddress\|\|!connected\|\|working\}/);
});

test("clear import navigation remains available", () => {
  assert.match(navigation, /Import your memecoin/i); assert.match(leftSidebar, /Import your memecoin/i); assert.match(mobileSidebar, /"\/import"/);
});

test("registration image is required and never grants ownership", () => {
  assert.match(importPage, /data-project-import-image-required="true"/); assert.match(importPage, /PNG, JPEG or WEBP/);
  assert.match(importPage, /This does not make you the verified project owner/); assert.match(importPage, /project_import_registration_image/);
  assert.match(core, /Only the registering wallet can attach the initial project image/);
  assert.doesNotMatch(core.match(/export async function bindRegistrationImage[\s\S]*$/)?.[0] || "", /ownership_status='ownership_verified'/);
});

test("manual review becomes visible and the request button is removed after success", () => {
  assert.match(importPage, /OWNERSHIP REVIEW REQUESTED/); assert.match(importPage, /item\.ownershipStatus!=="ownership_manual_review"/); assert.match(importPage, /REQUEST PROJECT CLAIM/);
  assert.match(importedPage, /OWNERSHIP REVIEW REQUESTED/); assert.match(importedPage, /item\.ownershipStatus!=="ownership_manual_review"/); assert.match(importedPage, /REQUEST PROJECT CLAIM/);
});

test("manual claim persistence is retry-safe and cannot self-approve", () => {
  const manual = core.match(/export async function requestManualProjectClaim[\s\S]+?export async function patchProjectMetadata/)?.[0] || "";
  assert.match(manual, /ownership_status==="ownership_manual_review"/); assert.match(manual, /normalizeAddress\(existing\.manual_claim_wallet\|\|"",identity\.chainId\)[\s\S]*?===signer[\s\S]*?===normalizedNote[\s\S]*?return existing/);
  assert.match(manual, /ownership_status='ownership_pending'/); assert.match(manual, /ownership_manual_review/);
  assert.doesNotMatch(manual, /SET[^;]*project_owner_wallet\s*=/i); assert.doesNotMatch(manual, /SET[^;]*ownership_status='ownership_verified'/i);
});

test("imported project route mounts owner-manageable surface before live token runtime", () => {
  assert.match(tokenEntry, /lookupProjectImport\(routeId, importChainId\)/); assert.match(tokenEntry, /import ImportedProjectDetails from "\.\/ImportedProjectDetails"/);
  assert.match(tokenEntry, /if \(project\) return <ImportedProjectDetails item=\{project\} \/>/); assert.match(tokenEntry, /return <TokenDetailsLiveEntry \/>/);
  assert.match(liveTokenEntry, /import TokenDetails from "\.\/TokenDetails"/);
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

test("Solana display metadata is optional on-chain metadata while ownership remains mintAuthority", () => {
  assert.match(resolverAdapters, /metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s/); assert.match(resolverAdapters, /findProgramAddressSync/); assert.match(resolverAdapters, /getAccountInfo/);
  assert.match(resolverAdapters, /getTokenMetadata/); assert.match(resolverAdapters, /TOKEN_2022_PROGRAM_ID/);
  assert.match(resolverAdapters, /name:\s*metadata\.name/); assert.match(resolverAdapters, /symbol:\s*metadata\.symbol/); assert.match(resolverAdapters, /currentAuthority:\s*raw\.mintAuthority/);
  assert.match(resolverAdapters, /signedWalletMatchesAuthority:\s*Boolean\(raw\.verified\)/); assert.doesNotMatch(resolverAdapters, /jupiter|birdeye|dexscreener|updateAuthority/i);
  assert.match(api, /enrichExistingProjectIdentity/); assert.match(api, /name IS NULL OR btrim\(name\) = ''/); assert.match(api, /symbol IS NULL OR btrim\(symbol\) = ''/);
});

test("ownership verification commits before best-effort display metadata refresh", () => {
  const refresh = api.match(/async function refreshVerifiedProjectIdentityBestEffort[\s\S]+?async function handleOwnershipAdmin/)?.[0] || "";
  assert.match(refresh, /try[\s\S]*resolveForSigner[\s\S]*enrichExistingProjectIdentity[\s\S]*catch/);
  assert.match(api, /const updated = await reviewProjectOwnership\(pool,[\s\S]*?\);[\s\S]*?if \(action === "verify_owner"\) await refreshVerifiedProjectIdentityBestEffort\(updated\);[\s\S]*?return json/);
});

test("operator ownership review is admin-authenticated, CAS-safe, audited, and Arena-independent", () => {
  assert.match(api, /requireDashboardAdmin/); assert.match(api, /\/admin\/ownership-claims/); assert.match(api, /reviewProjectOwnership\(pool/);
  assert.match(reviewCore, /ownership_status = \$1/); assert.match(reviewCore, /manual_claim_wallet IS NOT NULL/);
  assert.match(reviewCore, /xmin::text AS state_version/); assert.match(reviewCore, /expectedVersion/); assert.match(reviewCore, /FOR UPDATE/); assert.match(reviewCore, /PROJECT_OWNERSHIP_STATE_CONFLICT/);
  assert.match(reviewCore, /wm_admin_audit_log/); assert.match(reviewCore, /operatorReason/); assert.match(reviewCore, /operatorAuthUserId/); assert.match(reviewCore, /FROM public.wm_users WHERE id=\$1::uuid/); assert.match(reviewCore, /project_owner_wallet\s*=\s*manual_claim_wallet/);
  assert.match(reviewCore, /ownership_status\s*=\s*\$2/); assert.match(reviewCore, /VERIFIED/); assert.match(reviewCore, /PENDING/);
  assert.doesNotMatch(reviewCore, /SET[^;]*(?:\bstatus\b|review_requested_at|review_reason|reviewer|reviewed_at)\s*=/i);
});

test("existing MemeWarzone token runtime remains the fallback for non-imported rows", () => {
  assert.match(coinsPage, /type: "imported"/); assert.match(client, /listUserProjectImports/); assert.match(tokenEntry, /return <TokenDetailsLiveEntry \/>/);
});
