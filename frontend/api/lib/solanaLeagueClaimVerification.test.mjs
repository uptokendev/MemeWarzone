import test from "node:test";
import assert from "node:assert/strict";
import { buildExpectedSolanaLeagueClaim } from "./solanaLeagueClaimVerification.js";
import { leagueVaultForPeriod } from "../solanaLeagueMerkle.js";

const PID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID = PID;
const base = { chainId: 101, solanaCluster: "mainnet-beta", environment: "production", epochStart: "2026-08-01T00:00:00Z", category: "top_earner", rank: 1, recipient: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H", amountRaw: "84960" };

test("each period is verified against the vault the program pays it from", () => {
  // Mainnet 2026-09-28: monthly Aug top_earner #1 paid 84960 lamports from monthly_league_vault 68FNN...
  assert.equal(buildExpectedSolanaLeagueClaim({ ...base, period: "monthly" }).vaultAddress, "68FNNeXDMAU8XaJsNYL4VFY2YnprnE36LCncCm8uRyJg");
  assert.equal(buildExpectedSolanaLeagueClaim({ ...base, period: "weekly" }).vaultAddress, leagueVaultForPeriod("weekly", PID));
  assert.notEqual(leagueVaultForPeriod("weekly", PID), leagueVaultForPeriod("monthly", PID));
});
