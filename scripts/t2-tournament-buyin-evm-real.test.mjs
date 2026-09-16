import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER_PATH = fileURLToPath(new URL("./t2-tournament-buyin-evm-real.mjs", import.meta.url));
const source = fs.readFileSync(RUNNER_PATH, "utf8");

const RH46630 = Object.freeze({
  chainId: 46630,
  treasury: "0x1eDd34933E5395c82F14CE2A220b81adF35C52B7",
  runtimeHash: "0x79979c3684c328e866c2b5b03d276cda7072a4c39d7f5b55c42672f9cb82958d",
  native: "ETH",
});

function authoritySource(text) {
  const start = text.indexOf("const AUTHORITY = Object.freeze({");
  assert.notEqual(start, -1, "runner must define AUTHORITY");
  const end = text.indexOf("\n});", start);
  assert.notEqual(end, -1, "runner AUTHORITY block must terminate with });");
  return text.slice(start, end + 4);
}

const authority = authoritySource(source);

test("AUTHORITY pins RH46630 ArenaWarPoolTreasuryV2 identity and native ETH", () => {
  const expectedEntry = `${RH46630.chainId}: { treasury: "${RH46630.treasury}", runtimeHash: "${RH46630.runtimeHash}", native: "${RH46630.native}" }`;
  assert.ok(
    authority.includes(expectedEntry),
    "RH46630 AUTHORITY entry must pin the attested treasury, runtime hash, and native ETH",
  );
});

test("AUTHORITY excludes Robinhood production chain 4663", () => {
  assert.doesNotMatch(
    authority,
    /(?:^|[\s,{])4663\s*:/m,
    "production chain 4663 must not be present in Tournament T2 EVM AUTHORITY",
  );
});
