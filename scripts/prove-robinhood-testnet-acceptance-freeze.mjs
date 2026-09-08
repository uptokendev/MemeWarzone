#!/usr/bin/env node
import {
  assertRobinhoodTestnetMutationForbidden,
  loadRobinhoodTestnetFreeze,
  parseRobinhoodTestnetFreeze,
  proveFreezeMutationGuardsInSource,
  proveProductionRobinhoodDisabled,
  requireRobinhoodTestnetFreeze,
} from "./robinhoodTestnetFreeze.mjs";

export function proveRobinhoodTestnetAcceptanceFreeze() {
  const freeze = requireRobinhoodTestnetFreeze();
  const flags = proveProductionRobinhoodDisabled();
  const guards = proveFreezeMutationGuardsInSource();
  let rejected46630 = false;
  try {
    assertRobinhoodTestnetMutationForbidden(46630);
  } catch (error) {
    rejected46630 = String(error?.message || error).includes("forbids 46630");
    if (!rejected46630) throw error;
  }
  if (!rejected46630) throw new Error("46630 freeze mutation guard did not fire");
  let mutationAllowedOnLocal = true;
  try {
    assertRobinhoodTestnetMutationForbidden(31337);
  } catch {
    mutationAllowedOnLocal = false;
  }
  if (!mutationAllowedOnLocal) throw new Error("5C freeze must not block Hardhat 31337 rehearsal");
  let malformedRejected = false;
  try {
    parseRobinhoodTestnetFreeze({ schemaVersion: 1, kind: "wrong" });
  } catch {
    malformedRejected = true;
  }
  if (!malformedRejected) throw new Error("malformed freeze must fail closed");
  return {
    freeze,
    flags,
    guards,
    localRehearsalAllowed: true,
    malformedRejected: true,
  };
}

const result = proveRobinhoodTestnetAcceptanceFreeze();
console.log("Robinhood 5C freeze offline proof passed");
console.log(JSON.stringify({
  accepted5BSha: result.freeze.accepted5BSha,
  factory: result.freeze.factory,
  routeAuthority: result.freeze.routeAuthority,
  productionCreationEnabled: result.flags.productionCreationEnabled,
  guarded: result.guards.guarded,
}, null, 2));
