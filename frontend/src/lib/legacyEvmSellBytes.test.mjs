/**
 * Gen-6 and gen-7 sells stay the bytes they had before the gen-8 one-time allowance.
 * The app bonding sell is sellExactTokens / sellExactTokensAuthorized in launchpadClient.ts and
 * WarRoomTradePanel.tsx. Graduated import sells are sellV2 and the Robinhood Universal Router
 * commands. The non-gen-8 widget is Solana (bonding.ts, importSwapWidget.js). gen8SellSetup is
 * only the gen-8 sell.
 *   node --test src/lib/legacyEvmSellBytes.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Interface, concat, keccak256 } from "ethers";

import { buildFeeRouterCall } from "./importSwapFeeRouter.mjs";
import { encodeImportSell } from "./robinhoodImportSwap.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const SELL = "function sellExactTokens(uint256 amountIn,uint256 minPayout) returns (uint256 payout)";
const AUTHORIZED = "function sellExactTokensAuthorized(uint256 amountIn,uint256 minPayout,uint8 routeProfile,uint64 routeDeadline,bytes routeSignature) returns (uint256 payout)";
const AMOUNT = 10n ** 18n;
const MIN_OUT = 123456789n;
const DEADLINE = 1700000000;
const SIGNATURE = "0x" + "ab".repeat(65);

const LEGACY_SELL =
  "0x3794f6be0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000075bcd15";
const AUTHORIZED_SELL =
  "0xac2d72040000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000075bcd150000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006553f10000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000041ababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab00000000000000000000000000000000000000000000000000000000000000";
const FEE_ROUTER_SELL =
  "0x0ed0842b000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000075bcd150000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000006553f100";

const UNTOUCHED = [
  "frontend/src/lib/launchpadClient.ts",
  "frontend/src/components/postgrad/WarRoomTradePanel.tsx",
  "frontend/src/lib/robinhoodImportSwap.mjs",
  "frontend/src/lib/importSwapFeeRouter.mjs",
  "frontend/src/widget/bonding.ts",
  "frontend/src/widget/mwzSwapWidget.ts",
  "frontend/api/importSwapWidget.js",
];

test("gen-6 and gen-7 app sells encode the pinned calldata, and both surfaces share the ABI", () => {
  for (const rel of ["frontend/src/lib/launchpadClient.ts", "frontend/src/components/postgrad/WarRoomTradePanel.tsx"]) {
    const source = read(rel);
    assert.equal(source.includes(SELL), true, rel);
    assert.equal(source.includes(AUTHORIZED), true, rel);
    assert.equal(source.includes("gen8SellSetup"), false, rel);
  }
  const iface = new Interface([SELL, AUTHORIZED]);
  assert.equal(iface.encodeFunctionData("sellExactTokens", [AMOUNT, MIN_OUT]), LEGACY_SELL);
  assert.equal(
    iface.encodeFunctionData("sellExactTokensAuthorized", [AMOUNT, MIN_OUT, 1, DEADLINE, SIGNATURE]),
    AUTHORIZED_SELL,
  );
});

test("graduated import sells stay the exact-approval and permit commands", () => {
  const call = buildFeeRouterCall({
    side: "sell",
    routerAddress: "0x2222222222222222222222222222222222222222",
    token: "0x1111111111111111111111111111111111111111",
    stable: false,
    amountIn: AMOUNT,
    minOut: MIN_OUT,
    deadline: BigInt(DEADLINE),
  }, "0x3333333333333333333333333333333333333333");
  assert.equal(call.data, FEE_ROUTER_SELL);
  assert.equal(call.value, 0n);
  assert.match(read("frontend/src/lib/importSwapFeeRouter.mjs"), /approves exactly the amount to the router \(no standing allowance\)/);

  const permit = {
    permitSingle: {
      details: {
        token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
        amount: 5n,
        expiration: 9n,
        nonce: 0n,
      },
      spender: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
      sigDeadline: 9n,
    },
    signature: "0x" + "11".repeat(65),
  };
  const imported = encodeImportSell({
    token: permit.permitSingle.details.token,
    fee: 500,
    amountIn: 5n,
    minGrossEthOut: 10_000n,
    permit,
  });
  assert.equal(imported.commands, "0x0a000c0604");
  assert.equal(keccak256(concat([imported.commands, ...imported.inputs])), "0x04a15a726d0e68a3816cfeba43291b146262951adc357ff56a59ace8ff169d1c");
});

function filesNamed(dir, rel, needle) {
  const skip = new Set(["node_modules", "dist", "coverage", ".next"]);
  const text = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue;
    const abs = path.join(dir, name);
    const next = `${rel}/${name}`;
    if (fs.statSync(abs).isDirectory()) found.push(...filesNamed(abs, next, needle));
    else if (text.has(path.extname(name)) && fs.readFileSync(abs, "utf8").includes(needle)) found.push(next);
  }
  return found;
}

test("the one-time allowance is only the gen-8 sell, and the older sell files are unchanged", () => {
  const hits = filesNamed(path.join(root, "frontend"), "frontend", "gen8SellSetup").sort();
  assert.deepEqual(hits, [
    "frontend/api/gen8Swap.js",
    // The swap widget's Robinhood import sell (2026-10-22): the same one-time allowance, built by the API, so the
    // swap carries no user-signed permit and its build fingerprint holds. The app's import sell keeps its permit.
    "frontend/api/importSwap.js",
    "frontend/shared/evmGen8Swap.mjs",
    "frontend/shared/evmGen8Swap.test.mjs",
    "frontend/src/lib/evmGen8Client.mjs",
    "frontend/src/lib/legacyEvmSellBytes.test.mjs",
  ]);
  assert.equal(read("frontend/src/widget/bonding.ts").includes("gen8SellSetup"), false);
  assert.equal(read("frontend/src/widget/mwzSwapWidget.ts").includes("gen8SellSetup"), false);
  assert.equal(read("frontend/api/importSwapWidget.js").includes("gen8SellSetup"), false);
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...UNTOUCHED], { cwd: root, stdio: "pipe" });
});
