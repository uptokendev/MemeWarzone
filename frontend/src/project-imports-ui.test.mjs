import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, config, importPage, importedProjectPage, tokenEntry, liveTokenEntry, client, coinsPage] = await Promise.all([
  read("./App.tsx"), read("./features/projectImports/config.ts"), read("./pages/ProjectImport.tsx"),
  read("./pages/ImportedProjectDetails.tsx"), read("./pages/TokenDetailsEntry.tsx"), read("./pages/TokenDetailsLiveEntry.tsx"),
  read("./lib/projectImports.ts"), read("./pages/command-center/CommandCenterCoins.tsx"),
]);
const api = await read("../api/projectImports.js");
const core = await read("../api/lib/projectImportCore.js");
const resolverAdapters = await read("../api/lib/projectImportResolverAdapters.js");

test("project imports remain independently gated from Arena", () => {
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORTS/); assert.doesNotMatch(config, /VITE_ENABLE_POSTGRAD_ARENA|postGradFlags/);
  assert.match(app, /projectImportsEnabled/); assert.match(client, /\/api\/project-imports/); assert.doesNotMatch(client, /\/api\/arena\/imports/);
});

test("import UX uses founder-approved wording and chain selection", () => {
  assert.match(importPage, /type ImportChain = "bnb" \| "solana"/); assert.match(importPage, />BNB<\/Button>/); assert.match(importPage, />Solana<\/Button>/);
  assert.match(importPage, /detectedChain/); assert.match(importPage, />IMPORT<\/Button>/); assert.match(importPage, /REGISTER &amp; VERIFY MEMECOIN/);
  assert.doesNotMatch(importPage, /RESOLVE PROJECT/); assert.doesNotMatch(importPage, /REGISTER &amp; VERIFY PROJECT/); assert.doesNotMatch(importPage, /Robinhood/i);
});

test("manual claim success becomes a non-actionable ownership review state", () => {
  assert.match(importPage, /OWNERSHIP REVIEW REQUESTED/); assert.match(importPage, /item\.ownershipStatus!=="ownership_manual_review"/);
  assert.match(importedProjectPage, /OWNERSHIP REVIEW REQUESTED/); assert.match(importedProjectPage, /item\.ownershipStatus!=="ownership_manual_review"/);
  assert.match(importedProjectPage, /REQUEST PROJECT CLAIM/);
});

test("registration still requires an image without granting ownership", () => {
  assert.match(importPage, /data-project-import-image-required="true"/); assert.match(importPage, /PNG, JPEG or WEBP/);
  assert.match(importPage, /This does not make you the verified project owner/); assert.match(importPage, /project_import_registration_image/);
  assert.match(core, /Only the registering wallet can attach the initial project image/);
  assert.doesNotMatch(core.match(/export async function bindRegistrationImage[\s\S]*$/)?.[0] || "", /ownership_status='ownership_verified'/);
});

test("imported route mounts owner-manageable project surface before live campaign runtime", () => {
  assert.match(tokenEntry, /lookupProjectImport\(routeId, importChainId\)/); assert.match(tokenEntry, /import ImportedProjectDetails from "\.\/ImportedProjectDetails"/);
  assert.match(tokenEntry, /if \(project\) return <ImportedProjectDetails item=\{project\} \/>/); assert.match(tokenEntry, /import TokenDetailsLiveEntry from "\.\/TokenDetailsLiveEntry"/);
  assert.match(liveTokenEntry, /import TokenDetails from "\.\/TokenDetails"/);
  assert.doesNotMatch(importedProjectPage, /from .*TokenDetails|from .*launchpad|from .*chart|from .*trading|from .*swap|from .*bonding|from .*graduation|from .*Topaz|from .*Meteora/i);
});

test("verified project owner is the only profile/image edit authority", () => {
  assert.match(importedProjectPage, /item\.ownershipStatus==="ownership_verified"/); assert.match(importedProjectPage, /ownerConnected/);
  assert.match(importedProjectPage, /canEdit=ownerVerified&&ownerConnected/); assert.match(importedProjectPage, /data-owner-edit-controls="true"/);
  assert.match(importedProjectPage, /data-owner-image-edit="true"/); assert.match(importedProjectPage, /data-owner-profile-editor="true"/);
  assert.match(core, /project_owner_wallet=\$3 AND ownership_status='ownership_verified'/);
  assert.doesNotMatch(core.match(/export async function patchProjectMetadata[\s\S]+?export async function persistProjectImage/)?.[0] || "", /imported_by_wallet/);
});

test("public imported project remains financially inert and locked", () => {
  for (const marker of [/data-imported-badge="true"/, /OWNER VERIFIED/, /data-project-image="true"/, /data-project-name="true"/, /data-project-ticker="true"/, /data-project-description="true"/, /data-project-socials="true"/, /data-project-share="true"/, /WARZONE ACCESS LOCKED/]) assert.match(importedProjectPage, marker);
  assert.match(importedProjectPage, /No trading, claims, Arena actions or launch deployment are enabled from this page/);
  assert.doesNotMatch(importedProjectPage, />\s*BUY\s*</i); assert.doesNotMatch(importedProjectPage, />\s*SELL\s*</i); assert.doesNotMatch(importedProjectPage, /AUTO DEPLOY|Boost|UpVote|Quarterly/i);
});

test("Solana metadata is optional on-chain Metaplex data while ownership remains mintAuthority", () => {
  assert.match(resolverAdapters, /metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s/); assert.match(resolverAdapters, /findProgramAddressSync/); assert.match(resolverAdapters, /getAccountInfo/);
  assert.match(resolverAdapters, /name:metadata\.name/); assert.match(resolverAdapters, /symbol:metadata\.symbol/); assert.match(resolverAdapters, /currentAuthority:raw\.mintAuthority/);
  assert.match(resolverAdapters, /signedWalletMatchesAuthority:Boolean\(raw\.verified\)/); assert.doesNotMatch(resolverAdapters, /jupiter|birdeye|dexscreener/i);
});

test("manual claim persistence is retry-safe and cannot self-approve", () => {
  const manual = core.match(/export async function requestManualProjectClaim[\s\S]+?export async function patchProjectMetadata/)?.[0] || "";
  assert.match(manual, /ownership_status==="ownership_manual_review"/); assert.match(manual, /currentClaimant===signer/);
  assert.match(manual, /ownership_status='ownership_pending'/); assert.match(manual, /ownership_status='ownership_manual_review'/);
  assert.doesNotMatch(manual, /project_owner_wallet=/); assert.doesNotMatch(manual, /ownership_verified/);
});

test("operator review is admin-authenticated, version-CAS safe, audited, and Arena-independent", () => {
  assert.match(api, /requireDashboardAdmin/); assert.match(api, /ownership_status='ownership_manual_review'/); assert.match(api, /manual_claim_wallet IS NOT NULL/);
  assert.match(api, /xmin::text AS state_version/); assert.match(api, /expectedVersion/); assert.match(api, /FOR UPDATE/); assert.match(api, /PROJECT_OWNERSHIP_STATE_CONFLICT/);
  assert.match(api, /wm_admin_audit_log/); assert.match(api, /operatorReason/); assert.match(api, /project_owner_wallet=manual_claim_wallet/);
  assert.match(api, /ownership_status='ownership_verified'/); assert.match(api, /ownership_status='ownership_pending'/);
  const review = api.match(/async function reviewProjectOwnership[\s\S]+?async function handleOwnershipAdmin/)?.[0] || "";
  assert.doesNotMatch(review, /SET[^;]*(?:\bstatus\b|review_requested_at|review_reason|reviewer|reviewed_at)\s*=/i);
});

test("existing MemeWarzone token runtime remains fallback for non-imported rows", () => {
  assert.match(tokenEntry, /return <TokenDetailsLiveEntry \/>/); assert.match(coinsPage, /type: "imported"/); assert.match(client, /listUserProjectImports/);
});
