import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [app, config, importPage, importedPage, tokenEntry, navigation, leftSidebar, mobileSidebar] = await Promise.all([
  read("./App.tsx"),
  read("./features/projectImports/config.ts"),
  read("./pages/ProjectImport.tsx"),
  read("./pages/ImportedProjectDetails.tsx"),
  read("./pages/TokenDetailsEntry.tsx"),
  read("./constants/navigation.ts"),
  read("./components/LeftBattleSidebar.tsx"),
  read("./components/Sidebar.tsx"),
]);

test("import route is independently gated from Arena", () => {
  assert.match(config, /VITE_ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(config, /postGradFlags|VITE_ENABLE_POSTGRAD_ARENA/);
  assert.match(app, /projectImportsEnabled \? <Route path="\/import" element={<ProjectImport \/>} \/>/);
  assert.doesNotMatch(app.match(/projectImportsEnabled \? <Route path="\/import"[^\n]+/)?.[0] || "", /postGradFlags/);
});

test("BNB and Solana onboarding render without Robinhood", () => {
  assert.match(importPage, /data-import-chain="bnb"/);
  assert.match(importPage, /data-import-chain="solana"/);
  assert.match(importPage, /CONNECT BNB WALLET/);
  assert.match(importPage, /CONNECT SOLANA WALLET/);
  assert.match(importPage, /RESOLVE PROJECT/);
  assert.match(importPage, /REGISTER & VERIFY PROJECT/);
  assert.doesNotMatch(importPage, /Robinhood/i);
});

test("clear import entry is present on desktop and mobile navigation", () => {
  assert.match(navigation, /IMPORT YOUR MEMECOIN/);
  assert.match(leftSidebar, /IMPORT YOUR MEMECOIN/);
  assert.match(mobileSidebar, /"\/import"/);
});

test("public token route reload can resolve an imported project", () => {
  assert.match(tokenEntry, /lookupProjectImport/);
  assert.match(tokenEntry, /ImportedProjectDetails/);
  assert.match(tokenEntry, /projectImportsEnabled/);
  assert.doesNotMatch(tokenEntry, /ROBINHOOD|Robinhood/);
});

test("imported project page exposes only launch-safe project controls", () => {
  assert.match(importedPage, /data-imported-badge="true"/);
  assert.match(importedPage, /data-owner-verified-badge="true"/);
  assert.match(importedPage, /data-owner-edit-controls="true"/);
  assert.match(importedPage, /data-owner-image-edit="true"/);
  assert.match(importedPage, /data-manual-claim-state="true"/);
  assert.match(importedPage, /REQUEST PROJECT CLAIM/);
  assert.match(importedPage, /data-project-share="true"/);
  assert.match(importedPage, /WARZONE ACCESS LOCKED/);
  assert.match(importedPage, /This project is registered with MemeWarzone\./);
  assert.match(importedPage, /Battles, Tournaments and War Leagues are opening soon\./);
  assert.match(importedPage, /Follow this project to be notified when the Warzone opens\./);

  assert.doesNotMatch(importedPage, />\s*TRADE\s*</i);
  assert.doesNotMatch(importedPage, /UpVote/i);
  assert.doesNotMatch(importedPage, /AUTO DEPLOY/i);
  assert.doesNotMatch(importedPage, /CrypticPump/i);
  assert.doesNotMatch(importedPage, /competition review/i);
  assert.doesNotMatch(importedPage, /Arena audit/i);
  assert.doesNotMatch(importedPage, /Boost/i);
  assert.doesNotMatch(importedPage, /Quarterly/i);
});

test("owner edits are gated by verified ownership and wallet identity", () => {
  assert.match(importedPage, /const canEdit = ownerVerified && ownerConnected/);
  assert.match(importedPage, /editing && canEdit/);
  assert.match(importedPage, /if \(!canEdit \|\| saving\) return/);
  assert.match(importedPage, /if \(!canEdit \|\| uploading\) return/);
});
