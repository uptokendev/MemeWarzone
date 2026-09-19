import assert from "node:assert/strict";
import test from "node:test";
import { classifyProjectImportSecurity, scanProjectImportSecurity, securityAllowsAutomaticImport } from "./projectImportRiskSecurity.js";

test("BNB honeypot and impossible-sell signals block automatic import", () => {
  const result = classifyProjectImportSecurity({ chainId: 56, raw: { is_honeypot: "1", cannot_sell_all: "1", is_open_source: "1", holders: [], dex: [{}] } });
  assert.equal(result.status, "blocked");
  assert.equal(securityAllowsAutomaticImport(result), false);
  assert.ok(result.criticalRisks.some((risk) => risk.code === "honeypot"));
  assert.ok(result.criticalRisks.some((risk) => risk.code === "cannot_sell_all"));
});

test("BNB risky admin controls require manual review", () => {
  const result = classifyProjectImportSecurity({ chainId: 56, raw: { is_open_source: "1", transfer_pausable: "1", is_mintable: "1", holders: [], dex: [{}] } });
  assert.equal(result.status, "review");
  assert.equal(securityAllowsAutomaticImport(result), true);
  assert.ok(result.reviewRisks.some((risk) => risk.code === "transfer_pausable"));
  assert.ok(result.reviewRisks.some((risk) => risk.code === "mintable"));
});

test("Solana non-transferable or mutable-balance tokens block automatic import", () => {
  const result = classifyProjectImportSecurity({ chainId: 101, raw: { non_transferable: "1", balance_mutable_authority: { status: "1" }, dex: [{}], holders: [] } });
  assert.equal(result.status, "blocked");
  assert.ok(result.criticalRisks.some((risk) => risk.code === "non_transferable"));
  assert.ok(result.criticalRisks.some((risk) => risk.code === "balance_mutable"));
});

test("Solana freeze, mint, transfer hook and mutable metadata signals require review", () => {
  const result = classifyProjectImportSecurity({ chainId: 101, raw: {
    freezable: { status: "1" }, mintable: { status: "1" }, metadata_mutable: { status: "1", metadata_upgrade_authority: [] },
    transfer_hook: [{ address: "hook", malicious_address: 0 }], dex: [{}], holders: [],
  } });
  assert.equal(result.status, "review");
  for (const code of ["freezable", "mintable", "metadata_mutable", "transfer_hook"]) assert.ok(result.reviewRisks.some((risk) => risk.code === code));
});

test("clean token data can pass automatic security gate", () => {
  const result = classifyProjectImportSecurity({ chainId: 56, raw: { is_open_source: "1", is_honeypot: "0", cannot_sell_all: "0", sell_tax: "0", buy_tax: "0", holders: [], dex: [{}] } });
  assert.equal(result.status, "pass");
  assert.equal(securityAllowsAutomaticImport(result), true);
});

test("scanner outage fails closed to manual review", async () => {
  const result = await scanProjectImportSecurity({
    chainId: 56,
    tokenAddress: "0x0000000000000000000000000000000000000001",
    fetchImpl: async () => { throw new Error("network unavailable"); },
  });
  assert.equal(result.status, "review");
  assert.equal(securityAllowsAutomaticImport(result), true);
  assert.ok(result.reviewRisks.some((risk) => risk.code === "scanner_unavailable"));
});
test("PumpSwap virtual quote remains a recorded review risk but does not block automatic import", () => {
  const result = classifyProjectImportSecurity({
    chainId: 101,
    raw: { default_account_state: "1", non_transferable: "0", freezable: { status: "0" }, mintable: { status: "0" }, balance_mutable_authority: { status: "0" }, holders: [], dex: [{}] },
    market: { verified: true, phase: "postgrad", liquidityAvailable: true, virtualQuoteReserves: "17584506971" },
  });
  assert.equal(result.status, "review");
  assert.ok(result.reviewRisks.some((risk) => risk.code === "virtual_quote_pricing"));
  assert.equal(securityAllowsAutomaticImport(result), true);
});
