import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function read(relativePath) {
  return fs.readFileSync(path.join(here, relativePath), "utf8");
}

test("Battle Boost stays isolated from legacy paid UpVote routes and components", () => {
  const client = read("./battleBoostClient.ts");
  const panel = read("../../components/arena/BattleBoostPanel.tsx");

  for (const source of [client, panel]) {
    assert.doesNotMatch(source, /\/api\/(?:upvotes|votes)(?:\/|\b)/i);
    assert.doesNotMatch(source, /UpvoteDialog|UPVoteTreasury|buyUpvote|purchaseUpvote/i);
  }
  assert.match(client, /\/api\/arena\/boosts\/quote/);
});

test("winner claim remains generation-gated on the Battle Wall", () => {
  const more = read("../../components/arena/BattleWallMore.tsx");
  const funding = read("../../components/arena/BattleFunding.tsx");

  assert.match(more, /explicitClaimGeneration/);
  assert.match(more, /claimBlockedReason/);
  assert.match(more, /Historical economics will not be inferred/);
  assert.match(funding, /data-battle-claim-generation-pending/);
  assert.match(funding, /claimBlockedReason/);
});

test("WarPool adapter cannot restore a default historical 85 percent split", () => {
  const hook = read("../../hooks/useArenaWarPoolFeed.ts");
  const routing = read("./warPoolGenerationRouting.mjs");

  assert.match(hook, /presentWarPoolRouting/);
  assert.match(hook, /if \(!routingBreakdown\) return null/);
  assert.doesNotMatch(hook, /totalPotUsd \* 0\.85/);
  assert.match(routing, /war_pool_v1/);
  assert.match(routing, /war_pool_v2/);
  assert.match(routing, /if \(!generation\) return null/);
});

test("Final Salvo presentation remains Free Vote only", () => {
  const panel = read("../../components/arena/FinalSalvoPanel.tsx");
  const presentation = read("./finalSalvoPresentation.mjs");

  assert.match(panel, /Boost disabled during Final Salvo/);
  assert.doesNotMatch(panel, /BattleBoostPanel|boostBattle|\/api\/arena\/boosts/);
  assert.doesNotMatch(presentation, /boostPoints|boostUnits|paidBoost/i);
});

test("event sponsorship is not wired to the homepage advertising application", () => {
  const flow = read("../../components/arena/EventSponsorshipFlow.tsx");
  const contracts = read("./eventSponsorshipContracts.ts");

  assert.doesNotMatch(flow, /sponsorship-applications|featured-top-left|homepage-sponsored-rail/);
  assert.doesNotMatch(contracts, /featured-top-left|homepage-sponsored-rail/);
});
