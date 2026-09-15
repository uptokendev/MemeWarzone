import fs from "node:fs";

const file = "scripts/test-bnb97-native-pending-graduation.ts";
const source = fs.readFileSync(file, "utf8");
const needle = `  const blockedBuy = await expectCustomError(campaign, "GraduationPending", () =>\n    campaign.connect(buyer).buyExactBnbAuthorized(1n, pendingAuth.routeProfileId, pendingAuth.deadline, pendingAuth.signature, { value: ethers.parseEther("0.001") }),\n  );`;
const replacement = `  const blockedBuyValue = ethers.parseEther("0.001");\n  const blockedBuyAuth = await buildTradeAuthorization(\n    signerMod,\n    campaign,\n    buyer,\n    routeAuthority,\n    TRADE_AUTH_BUY_EXACT_NATIVE,\n    blockedBuyValue,\n    1n,\n  );\n  const blockedBuy = await expectCustomError(campaign, "GraduationPending", () =>\n    campaign.connect(buyer).buyExactBnbAuthorized(\n      1n,\n      blockedBuyAuth.routeProfileId,\n      blockedBuyAuth.deadline,\n      blockedBuyAuth.signature,\n      { value: blockedBuyValue },\n    ),\n  );`;

const occurrences = source.split(needle).length - 1;
if (occurrences !== 1) {
  throw new Error(`expected exactly one stale blocked-buy authorization fixture, found ${occurrences}`);
}

const patched = source.replace(needle, replacement);
fs.writeFileSync(file, patched);
console.log("bnb97_pending_harness_fresh_blocked_buy_auth=ok");
