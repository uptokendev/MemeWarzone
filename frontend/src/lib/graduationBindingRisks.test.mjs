import test from "node:test";
import assert from "node:assert/strict";

import {
  STRUCTURAL_BINDING_RISKS,
  bindingNeedsConfirmation,
  bindingRiskHeadline,
  bindingRisksForAsset,
} from "./graduationBindingRisks.mjs";

const xStock = {
  symbol: "NVDAx",
  bindingRisks: [
    { code: "PERMANENT_DELEGATE", armed: true, severity: "high", title: "The issuer can move this token out of the pool", detail: "…" },
    { code: "TRANSFER_HOOK", armed: false, severity: "info", title: "Transfers can run the issuer's own code", detail: "…" },
    { code: "PAUSABLE", armed: true, severity: "high", title: "The issuer can halt all transfers", detail: "…" },
  ],
};

test("binding to the chain's own coin asks for nothing", () => {
  assert.deepEqual(bindingRisksForAsset({ symbol: "SOL" }, { isNative: true }), []);
  assert.equal(bindingNeedsConfirmation({ symbol: "SOL" }, { isNative: true }), false);
});

test("a quote with no scanned risks still warns about what is always true", () => {
  // A creator choosing a quote the catalog has not rescanned must not see an
  // empty dialog: the lock and the price coupling hold regardless.
  const risks = bindingRisksForAsset({ symbol: "USDC" });
  assert.equal(risks.length, STRUCTURAL_BINDING_RISKS.length);
  assert.ok(risks.some((risk) => risk.code === "LIQUIDITY_LOCKED_FOREVER"));
  assert.ok(risks.some((risk) => risk.code === "CHECKED_ONCE"));
  assert.equal(bindingNeedsConfirmation({ symbol: "USDC" }), true);
});

test("issuer powers come first, and the most serious leads", () => {
  const risks = bindingRisksForAsset(xStock);
  assert.equal(risks[0].severity, "high");
  const codes = risks.map((risk) => risk.code);
  assert.ok(codes.indexOf("PERMANENT_DELEGATE") < codes.indexOf("PRICE_FOLLOWS_QUOTE"));
  // Structural risks are appended, never lost.
  for (const structural of STRUCTURAL_BINDING_RISKS) assert.ok(codes.includes(structural.code));
});

test("an unarmed power is shown as information, not as a warning", () => {
  // A transfer hook with no hook program set is not the same risk as one that
  // is armed; flattening them would make every Token-2022 asset look equal.
  const hook = bindingRisksForAsset(xStock).find((risk) => risk.code === "TRANSFER_HOOK");
  assert.equal(hook.armed, false);
  assert.equal(hook.severity, "info");
  const delegate = bindingRisksForAsset(xStock).find((risk) => risk.code === "PERMANENT_DELEGATE");
  assert.equal(delegate.severity, "high");
});

test("the headline counts only the powers that are actually armed", () => {
  assert.equal(bindingRiskHeadline(xStock, bindingRisksForAsset(xStock)),
    "NVDAx gives its issuer 2 powers over your locked liquidity.");
  const clean = { symbol: "USDC" };
  assert.equal(bindingRiskHeadline(clean, bindingRisksForAsset(clean)),
    "Your launch will be paired with USDC instead of the chain's own coin.");
});

test("malformed catalog entries are dropped rather than rendered blank", () => {
  const messy = { symbol: "X", bindingRisks: [null, {}, { code: "OK", title: "Fine", severity: "high" }, "nope"] };
  const risks = bindingRisksForAsset(messy);
  assert.ok(risks.every((risk) => risk.code && risk.title));
  assert.ok(risks.some((risk) => risk.code === "OK"));
});
