import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { resolveBnb56TopazAuthority } from "./lib/bnbMainnetTopazAuthority";

async function main() {
  if (network.name !== "bscMainnet") throw new Error(`read-only Topaz authority probe requires bscMainnet, got ${network.name}`);
  const evidence = await resolveBnb56TopazAuthority();
  const output = {
    evidenceType: "bnb56-live-topaz-authority",
    capturedAt: new Date().toISOString(),
    network: network.name,
    ...evidence,
  };
  console.log(JSON.stringify(output, null, 2));

  const out = String(process.env.BNB56_TOPAZ_EVIDENCE_OUT || "").trim();
  if (out) {
    const resolved = path.resolve(out);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(output, null, 2)}\n`);
    console.error(`[bnb56-topaz] wrote read-only evidence to ${resolved}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
