import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, "../config/robinhood-staging.env.example");
const source = fs.readFileSync(envPath, "utf8");

function assertEnvLine(line) {
  assert.match(source, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
}

test("Robinhood 46630 staging env pins GREEN deployment identities", () => {
  assertEnvLine("FACTORY_ADDRESS_46630=0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943");
  assertEnvLine("TREASURY_VAULT_ADDRESS_46630=0x290fD8eCA353637Be4a0cbC335095e5E6F5F16e2");
  assertEnvLine("PROTOCOL_REVENUE_VAULT_ADDRESS_46630=0xcDA6e2ca98c4BD6e831Ec04d4ED390535A6Da65C");
  assertEnvLine("ARENA_WAR_POOL_TREASURY_V2_ADDRESS_46630=0x1eDd34933E5395c82F14CE2A220b81adF35C52B7");
  assertEnvLine("WRAPPED_NATIVE_ADDRESS_46630=0x52A47A33930B8a90a2000b1bA3CB96e879569670");
  assertEnvLine("VITE_ROBINHOOD_V3_FACTORY_ADDRESS_46630=0x948463E91d63a7A51cEeC0342735D1B738044aea");
  assertEnvLine("REWARD_CLAIMS_ENABLED=false");
});

test("Robinhood production 4663 has no Arena V2 war-pool staging pin", () => {
  assert.doesNotMatch(source, /^ARENA_WAR_POOL_TREASURY_V2_ADDRESS_4663=/m);
});
