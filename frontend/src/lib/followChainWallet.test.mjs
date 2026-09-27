// Follow bugs found by the founder on 2026-09-28: a connected Phantom user on a Solana token page was sent
// to the connect modal (the page followed with the EVM account only), and followed imported coins never
// showed in "Following" (only launched campaigns were resolved to cards).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("token page follows with the wallet of the coin's chain", () => {
  const page = read("pages/TokenDetails.tsx");
  assert.match(page, /const followWallet = isSolanaPage \? \(isSolanaConnected \? String\(solanaAccount \|\| ""\) : ""\) : String\(wallet\.account \|\| ""\);/);
  assert.match(page, /if \(!followWallet\) \{\s*toast\(\{ title: "Connect wallet"/);
  assert.match(page, /await followCampaign\(followWallet, campaignAddr/);
  assert.match(page, /await unfollowCampaign\(followWallet, campaignAddr/);
  assert.match(page, /isFollowingCampaign\(followWallet, campaignAddr/);
});

test("followed imported coins get a card in Following", () => {
  const hook = read("hooks/profile/useProfileFollows.ts");
  assert.match(hook, /fetchArenaTokenProfile\(a, resolvedChainId\)/);
  assert.match(hook, /r\.value\.origin === "import"/);
  assert.match(hook, /setFollowedCards\(\[\.\.\.draftCards, \.\.\.liveCards, \.\.\.importCards\]\)/);
});
