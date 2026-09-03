import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NOT_PREVIEWED_EXPLANATION,
  NOT_PREVIEWED_LABEL,
  OPEN_WAR_EXPLANATION,
  OPEN_WAR_LABEL,
  presentManualOpponentPreview,
  presentMatchCandidate,
  presentMatchCandidates,
} from "./findMatchPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function candidate(overrides = {}) {
  return {
    matchQuality: 94,
    classification: "perfect",
    ranked: true,
    components: { marketCap: 99, holders: 88, liquidity: 77, volume: 66, maturity: 55 },
    token: {
      tokenId: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      campaignAddress: "0x2222222222222222222222222222222222222222",
      tokenName: "Dog War",
      symbol: "DOGWAR",
      marketCapUsd: 428_000,
      holderCount: 2840,
      liquidityUsd: 91_000,
      volumeUsd: 126_000,
      origin: overrides.origin,
    },
    ...overrides,
  };
}

const FORMULA_MARKERS = [
  "calculateMatchQuality",
  "logRatioScore",
  "weightedScore",
  "marketCapWeight",
  "holderWeight",
  "liquidityWeight",
  "volumeWeight",
  "maturityWeight",
  "competitiveMinimum",
  "hardMcapRatio",
  "ARENA_MATCH_V2",
  "recommendMatchCandidates",
];

test("backend recommendation renders Match Quality and classification from the payload", () => {
  const presented = presentMatchCandidate(candidate());
  assert.equal(presented.matchQuality, 94);
  assert.equal(presented.matchQualityLabel, "94%");
  assert.equal(presented.classification, "perfect");
  assert.equal(presented.classificationLabel, "Perfect match");
  assert.equal(presented.tokenName, "Dog War");
  assert.equal(presented.symbol, "DOGWAR");
  assert.equal(presented.marketCapLabel, "$428.0K");
  assert.equal(presented.holdersLabel, "2,840");
  assert.equal(presented.liquidityLabel, "$91.0K");
  assert.equal(presented.volumeLabel, "$126.0K");
  assert.equal("components" in presented, false);
});

test("server-ranked recommendation displays as ranked competitive when the backend says so", () => {
  const presented = presentMatchCandidate(
    candidate({ matchQuality: 76.4, classification: "competitive", ranked: true }),
  );
  assert.equal(presented.ranked, true);
  assert.equal(presented.previewKind, "ranked");
  assert.equal(presented.rankedLabel, "Ranked");
  assert.equal(presented.classificationLabel, "Competitive");
  assert.equal(presented.matchQualityLabel, "76.4%");
  assert.equal(presented.challengeAnyway, false);
  assert.equal(presented.continueWithChallenge, false);
});

test("server-declared Open War displays as unranked without inventing a score", () => {
  const presented = presentMatchCandidate(
    candidate({ matchQuality: 43, classification: "open_war", ranked: false }),
  );
  assert.equal(presented.ranked, false);
  assert.equal(presented.previewKind, "open_war");
  assert.equal(presented.classificationLabel, OPEN_WAR_LABEL);
  assert.equal(presented.rankedLabel, OPEN_WAR_LABEL);
  assert.equal(presented.challengeAnyway, true);
  assert.equal(presented.continueWithChallenge, false);
  assert.equal(presented.matchQuality, 43);
  const preview = presentManualOpponentPreview("0x1111111111111111111111111111111111111111", [presented]);
  assert.equal(preview.previewKind, "open_war");
  assert.equal(preview.challengeAnyway, true);
  assert.equal(preview.explanation, OPEN_WAR_EXPLANATION);
});

test("arbitrary manual target missing from recommendations is not previewed, not Open War", () => {
  const preview = presentManualOpponentPreview("0x3333333333333333333333333333333333333333", [
    presentMatchCandidate(candidate()),
  ]);
  assert.equal(preview.previewKind, "not_previewed");
  assert.equal(preview.ranked, null);
  assert.equal(preview.classification, "not_previewed");
  assert.equal(preview.classificationLabel, NOT_PREVIEWED_LABEL);
  assert.equal(preview.challengeAnyway, false);
  assert.equal(preview.continueWithChallenge, true);
  assert.equal(preview.matchQuality, null);
  assert.equal(preview.matchQualityLabel, null);
  assert.equal(preview.explanation, NOT_PREVIEWED_EXPLANATION);
  assert.equal(preview.source, "manual");
  assert.notEqual(preview.classificationLabel, OPEN_WAR_LABEL);
});

test("manual target that is in the ranked recommendation list shows the server-provided quality", () => {
  const ranked = presentMatchCandidates({ candidates: [candidate()] });
  const preview = presentManualOpponentPreview("0x1111111111111111111111111111111111111111", ranked);
  assert.equal(preview.source, "recommendation");
  assert.equal(preview.previewKind, "ranked");
  assert.equal(preview.matchQuality, 94);
  assert.equal(preview.classificationLabel, "Perfect match");
  assert.equal(preview.ranked, true);
  assert.equal(preview.challengeAnyway, false);
});

test("Match Quality is copied from the backend and not recomputed from market stats", () => {
  const rich = presentMatchCandidate(candidate({ matchQuality: 10, classification: "competitive", ranked: true }));
  const poor = presentMatchCandidate(
    candidate({
      matchQuality: 10,
      classification: "competitive",
      ranked: true,
      token: {
        tokenAddress: "0x4444444444444444444444444444444444444444",
        tokenName: "Tiny",
        symbol: "TINY",
        marketCapUsd: 1,
        holderCount: 1,
        liquidityUsd: 1,
        volumeUsd: 1,
      },
    }),
  );
  assert.equal(rich.matchQuality, 10);
  assert.equal(poor.matchQuality, 10);
  const mislabeled = presentMatchCandidate(candidate({ matchQuality: 40, classification: "perfect", ranked: true }));
  assert.equal(mislabeled.classificationLabel, "Perfect match");
  assert.equal(mislabeled.matchQuality, 40);
});

test("imported and native recommendation payloads use the same presenter", () => {
  const native = presentMatchCandidate(candidate({ origin: "native" }));
  const imported = presentMatchCandidate(candidate({ origin: "import" }));
  assert.equal(native.classificationLabel, imported.classificationLabel);
  assert.equal(native.matchQualityLabel, imported.matchQualityLabel);
  assert.equal(native.rankedLabel, imported.rankedLabel);
});

test("Find Match wiring only prefills the existing challenge and leaves stake/duration to the creator", () => {
  const battles = readSrc("../../pages/command-center/CommandCenterBattles.tsx");
  const panel = readSrc("../../components/command-center/FindMatchPanel.tsx");
  const preview = readSrc("../../components/command-center/MatchQualityPreview.tsx");
  const client = readSrc("../../features/postgrad/apiClient.ts");
  const mount = battles.split("<FindMatchPanel")[1]?.split("/>")[0] || "";

  assert.match(panel, /onSelectTarget\(candidate\.tokenId\)/);
  assert.doesNotMatch(panel, /challengePostGradBattle/);
  assert.doesNotMatch(panel, /handleChallenge/);
  assert.doesNotMatch(panel, /setStake/);
  assert.doesNotMatch(panel, /setDurationHours/);
  assert.doesNotMatch(panel, /stakeNative/);

  assert.match(mount, /setChallengeTarget\(tokenId\)/);
  assert.doesNotMatch(mount, /challengePostGradBattle/);
  assert.doesNotMatch(mount, /handleChallenge\(/);
  assert.doesNotMatch(mount, /setStake/);
  assert.doesNotMatch(mount, /setDurationHours/);

  assert.match(battles, /const \[stake, setStake\]/);
  assert.match(battles, /const \[durationHours, setDurationHours\]/);
  assert.match(battles, /disabled=\{!canAct \|\| !challengeTarget\.trim\(\)\}/);
  assert.match(battles, /onClick=\{\(\) => void handleChallenge\(\)\}/);
  assert.match(
    battles,
    /await challengePostGradBattle\(\{ tokenId, targetTokenId, chainId: Number\(chainId\), stakeNative: stakeAmount, durationHours, auth \}\)/,
  );

  assert.match(preview, /Challenge anyway/);
  assert.match(preview, /Continue with challenge/);
  assert.match(preview, /OPEN_WAR_LABEL/);
  assert.match(preview, /NOT_PREVIEWED_LABEL/);
  assert.match(preview, /data-match-quality="open-war"/);
  assert.match(preview, /data-match-quality="not-previewed"/);
  assert.match(battles, /onContinueWithChallenge/);
  assert.doesNotMatch(preview, /challengePostGradBattle/);
  assert.match(client, /\/api\/arena\/battles\/matches/);
  assert.equal(OPEN_WAR_LABEL, "OPEN WAR — UNRANKED");
  assert.equal(NOT_PREVIEWED_LABEL, "MATCH QUALITY NOT PREVIEWED");
  const openWarBlock = preview.split('data-match-quality="open-war"')[1]?.split('data-match-quality="ranked"')[0] || "";
  const unknownBlock = preview.split('data-match-quality="not-previewed"')[1]?.split('data-match-quality="open-war"')[0] || "";
  assert.match(openWarBlock, /Challenge anyway/);
  assert.doesNotMatch(openWarBlock, /Continue with challenge/);
  assert.match(unknownBlock, /Continue with challenge/);
  assert.doesNotMatch(unknownBlock, /Challenge anyway/);
});

test("accept/counter/decline behavior stays on the existing handlers", () => {
  const battles = readSrc("../../pages/command-center/CommandCenterBattles.tsx");
  const carousel = readSrc("../../components/arena/CreatorChallengeCarousel.tsx");
  assert.match(battles, /await acceptPostGradBattle\(battleId, auth\)/);
  assert.match(battles, /await declinePostGradBattle\(battleId, auth\)/);
  assert.match(battles, /await counterPostGradBattle\(battleId, amount, auth, hours\)/);
  assert.match(battles, /CreatorChallengeCarousel/);
  assert.match(carousel, />\s*ACCEPT\s*</);
  assert.match(carousel, />\s*DECLINE\s*</);
  assert.match(carousel, />\s*COUNTER\s*</);
});

test("imported and native eligible tokens share the same Find Match panel", () => {
  const battles = readSrc("../../pages/command-center/CommandCenterBattles.tsx");
  const mount = battles.split("<FindMatchPanel")[1]?.split("/>")[0] || "";
  assert.match(battles, /item\.origin === "import" \? "imported" : "graduated"/);
  assert.match(mount, /tokenId=\{tokenKey\(selected\)\}/);
  assert.doesNotMatch(mount, /origin/);
});

test("no Match Quality formula exists in the Find Match frontend slice", () => {
  const files = [
    readSrc("./findMatchPresentation.mjs"),
    readSrc("../../components/command-center/FindMatchPanel.tsx"),
    readSrc("../../components/command-center/MatchQualityPreview.tsx"),
    readSrc("../../pages/command-center/CommandCenterBattles.tsx"),
    readSrc("../../features/postgrad/apiClient.ts"),
  ];
  for (const source of files) {
    for (const marker of FORMULA_MARKERS) {
      assert.doesNotMatch(source, new RegExp(marker));
    }
  }
});
