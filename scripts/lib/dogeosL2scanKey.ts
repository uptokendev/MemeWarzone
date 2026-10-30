// The L2Scan API key for DogeOS Chikyu explorer verification (chain 6281971), and nothing else.
//
// L2Scan's Etherscan-style API answers 401 "Invalid API Key" without a real key (since 2026-10). The key lives in
// the gitignored config/dogeos.local next to the DogeOS private keys, so this reads that file with dotenv.parse and
// returns only DOGEOS_TESTNET_L2SCAN_API_KEY: it never sets process.env, so no private key reaches a verify run.
// An env value wins over the file. The "l2scan" placeholder only keeps hardhat-verify from refusing before the request.
import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";

export const DOGEOS_L2SCAN_KEY_NAME = "DOGEOS_TESTNET_L2SCAN_API_KEY";
export const DOGEOS_L2SCAN_KEY_PLACEHOLDER = "l2scan";

type Env = Record<string, string | undefined>;

export function dogeosL2scanApiKey(env: Env = process.env, file = path.resolve(__dirname, "../../config/dogeos.local")): string {
  const fromEnv = String(env[DOGEOS_L2SCAN_KEY_NAME] || "").trim();
  if (fromEnv) return fromEnv;
  let fromFile = "";
  try {
    fromFile = String(dotenv.parse(fs.readFileSync(file))[DOGEOS_L2SCAN_KEY_NAME] || "").trim();
  } catch {
    fromFile = "";
  }
  return fromFile || DOGEOS_L2SCAN_KEY_PLACEHOLDER;
}
