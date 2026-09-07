import assert from "node:assert/strict";
import test from "node:test";
import {
  QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME,
  isQuarterlyChampionshipRuntime,
  presentQuarterlyChampionshipCard,
} from "./quarterlyChampionshipPresentation.mjs";

test("legacy quarter_finals runtime presents as Quarterly Championship", () => {
  assert.equal(isQuarterlyChampionshipRuntime({ origin: "quarter_finals" }), true);
  const card = presentQuarterlyChampionshipCard({
    title: "Major War League Quarter Finals",
    status: { key: "live", label: "LIVE" },
    bracketStage: "semifinals",
    progression: { nodes: [{ label: "QUARTER FINALS" }, { label: "SEMI FINALS" }] },
    bracketCta: "View bracket",
    liveRoundCta: "Watch live round",
    primaryCta: "View tournament",
  }, { origin: "quarter_finals" });
  assert.equal(card.title, QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME);
  assert.equal(card.title.includes("Quarter Finals"), false);
  assert.equal(card.bracketStage, null);
  assert.equal(card.progression, null);
  assert.equal(card.bracketCta, null);
  assert.equal(card.liveRoundCta, null);
  assert.equal(card.primaryCta, "View championship");
  assert.equal(card.quarterlyChampionship, true);
});

test("quarterly results retain canonical name without a final-bracket CTA", () => {
  const card = presentQuarterlyChampionshipCard({
    title: "MWL Quarter Finals",
    status: { key: "finished", label: "FINISHED" },
    bracketCta: "Final bracket",
  }, { eventType: "mwl_quarter_finals" });
  assert.equal(card.title, "Quarterly Championship");
  assert.equal(card.primaryCta, "View results");
  assert.equal(card.bracketCta, null);
});

test("ordinary tournaments keep their bracket presentation", () => {
  const original = {
    title: "Community Tournament",
    status: { key: "live", label: "LIVE" },
    bracketStage: "quarterfinals",
    progression: { nodes: [{ label: "QUARTER FINALS" }] },
    bracketCta: "View bracket",
  };
  assert.equal(isQuarterlyChampionshipRuntime({ origin: "custom" }), false);
  assert.equal(presentQuarterlyChampionshipCard(original, { origin: "custom" }), original);
});
