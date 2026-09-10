import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const read=p=>readFile(new URL(p,import.meta.url),"utf8");
test("Robinhood import is independently frontend-gated and has no launch dependency",async()=>{const [cfg,page,entry,adapter]=await Promise.all([read("./features/projectImports/config.ts"),read("./pages/ProjectImport.tsx"),read("./pages/TokenDetailsEntry.tsx"),read("../api/lib/projectImportResolverAdapters.js")]);assert.match(cfg,/VITE_ENABLE_PROJECT_IMPORT_ROBINHOOD/);assert.match(page,/projectImportRobinhoodEnabled/);assert.match(page,/>Robinhood<\/Button>/);assert.match(entry,/requested === 4663 && projectImportRobinhoodEnabled/);assert.match(adapter,/ROBINHOOD_CHAIN_ID = 4663/);assert.doesNotMatch(adapter,/LaunchFactory|graduation|locker|swap router|claims|Arena/i);});
