// Warzone overview + Major War League (2026-09-27): without a wallet the league read the BNB board, so
// Solana standings vanished on disconnect; and the league / featured feeds carry no art, so every card
// showed initials or a placeholder. Pins the three rules that fix it.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("the league feed follows the selected chain, not the wallet's alone", () => {
  const hook = read("hooks/useArenaLeagueFeed.ts");
  assert.match(hook, /const chainId = Number\(wallet\.feedChainId \|\| 0\) \|\| null;/);
  assert.doesNotMatch(hook, /const chainId = Number\(wallet\.chainId \|\| 0\) \|\| null;/);
});

test("both league surfaces carry the chain switch, so a visitor without a wallet can pick one", () => {
  assert.match(read("pages/Arena.tsx"), /<ChainFeedSwitch\b[^>]*\/>/);
  assert.match(read("pages/PostGradLeague.tsx"), /<ChainFeedSwitch \/>/);
});

test("cards without art resolve it through the token profile", () => {
  const mark = read("components/warzone/WarzoneTokenMark.tsx");
  assert.match(mark, /useArenaTokenProfile\(imageUrl \? null : chainId, imageUrl \? null : tokenAddress\)/);
  assert.match(read("components/warzone/WarzoneRankCard.tsx"), /chainId=\{chainId\} tokenAddress=\{tokenAddress\}/);
  const arena = read("pages/Arena.tsx");
  assert.match(arena, /<FeaturedArenaCoinCard/);
  assert.match(arena, /tokenAddress=\{entry\.tokenId\}/);
  const league = read("pages/PostGradLeague.tsx");
  assert.equal((league.match(/tokenAddress=\{(first|second|third)\.tokenId\}/g) || []).length, 3);
  assert.ok((league.match(/chainId=\{leagueChainId\}/g) || []).length >= 7);
  assert.match(read("components/arena/TournamentEventCard.tsx"), /chainId=\{card\.chain\?\.chainId\}/);
});
