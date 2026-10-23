// Writes public/llms.txt and public/llms-full.txt from shared/llmsTxt.mjs. Run after changing About, comparison or
// Help Center content: `node scripts/generate-llms.mjs`. shared/llmsTxt.test.mjs fails when they are stale.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildLlmsFullTxt, buildLlmsTxt } from "../shared/llmsTxt.mjs";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
writeFileSync(path.join(pub, "llms.txt"), buildLlmsTxt());
writeFileSync(path.join(pub, "llms-full.txt"), buildLlmsFullTxt());
console.log("wrote public/llms.txt and public/llms-full.txt");
