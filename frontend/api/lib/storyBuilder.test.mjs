import assert from "node:assert/strict";
import test from "node:test";
import { buildStory, cleanText, creatorChapters, offsetLabel } from "./storyBuilder.mjs";

const NOW = new Date("2026-09-27T22:00:00Z");
const SHARE = "https://api.memewar.zone";

// K88's real facts (production, 2026-09-27).
const K88_DESCRIPTION = "From the deepest trenches of the blockchain, a colossal titan has awakened. **$K88** didn't just step into the arena—he shattered the tyranny of the Ronin Master, rewriting the food chain on Solana for good. Forged from pure cryptonite and infused with the unstoppable, blinding power of the infinite green candle, this apex predator cannot be contained.\n\n**GODZILLA COULDN'T STOP $K88. SUPERMAN IS POWERLESS. THE $CLAN REIGNS SUPREME.**\n\n**$K88** is the first Ever coin and first Solana coin launched on MemeWarzone,We aim to be the first ever coin to fully bond on MemeWarzone!";
const k88 = {
  chainId: 101, token: "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77", origin: "launched", name: "KAIJU88", ticker: "K88", chainLabel: "Solana",
  logoUrl: "https://ellkfgoxnzykxqybajtn.supabase.co/storage/v1/object/public/MEMEBATTLES/logos/101/k88.webp", logoAnimated: true,
  accent: "#a3ff3c", accent2: "#1f6b3a", tokenPath: "/token/4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77", shareBase: SHARE,
  creator: { description: K88_DESCRIPTION, note: "Kaiju88 gonna flip Godzilla not even superman can stop us!!", socials: { x: "https://x.com/kaijuclancoin", telegram: "https://t.me/clanupwithkaiju", website: "https://kaijuclancoin.com/" } },
  promotion: { createdAt: "2026-09-24T14:04:50Z", views: 122, follows: 4, firstFollowAt: "2026-09-24T14:31:41Z" },
  launch: { at: "2026-09-25T13:57:27Z", firstOnMwz: true, firstOnChain: true },
  trades: { count: 85, wallets: 41, first: { at: "2026-09-25T13:58:53Z", amount: 0.8, unit: "SOL", wallet: "8WWq…RcK", txUrl: "https://solscan.io/tx/4Cj7" }, biggest: { at: "2026-09-25T13:59:45Z", amount: 7.9, unit: "SOL", wallet: "tYDR…DWP", txUrl: "https://solscan.io/tx/big" } },
  holders: 35, progress: { percent: 21.49, targetUsd: 15000 }, battles: [], standing: [],
};

// Derpy Dave's real facts: an import whose creator wrote nothing.
const history = Array.from({ length: 30 }, (_, i) => {
  const time = new Date(Date.UTC(2026, 3, 20 + i)).toISOString();
  const v = i < 11 ? 30000 - i * 300 : i <= 24 ? 26800 + (i - 11) * 8500 : 140300 - (i - 24) * 13000;
  return { time, high: i === 24 ? 140300 : v * 1.001, low: i === 11 ? 26800 : v * 0.999, close: v };
});
const derpy = {
  chainId: 101, token: "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS", origin: "imported", name: "Derpy Dave", ticker: "DERPYDAVE", chainLabel: "Solana",
  logoUrl: "https://ellkfgoxnzykxqybajtn.supabase.co/storage/v1/object/public/MEMEBATTLES/project-imports/101/derpy.jpg", logoAnimated: false,
  accent: "#fcf144", accent2: "#c955f7", tokenPath: "/token/2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS?chainId=101", shareBase: SHARE,
  creator: { description: null, note: null, socials: {} },
  born: { at: "2026-03-20T12:48:01Z" }, joined: { at: "2026-09-08T18:40:23Z", ownerVerified: true, cleared: true },
  market: { holders: 160, marketCapUsd: 61496, liquidityUsd: 21389 }, history,
  battles: [{ id: "arena-mugwhj11-9b1973", at: "2026-09-25T14:03:29Z", mode: "vote", won: false, me: { ticker: "DERPYDAVE", points: 11 }, rival: { ticker: "ASK", points: 15, imageUrl: "https://cdn.dexscreener.com/cms/images/AcVGdQwC13InxMHb" } }],
  standing: [{ position: "#2", label: "Major War League 2026-09", detail: "1 pts · 0W / 1L" }, { position: "#1", label: "Featured memecoins", detail: "1 UP votes in 24h" }],
};

test("K88: 10 chapters, creator first, then the chronicle, valid against the contract", () => {
  const { story, problems } = buildStory(k88, { now: NOW });
  assert.deepEqual(problems, []);
  assert.deepEqual(story.chapters.map((c) => c.id), ["cover", "creator-1", "creator-2", "creator-warcry", "promotion", "launch", "first-trades", "clan", "road", "call"]);
  const warcry = story.chapters.find((c) => c.kind === "warcry");
  assert.deepEqual(warcry.lines, ["GODZILLA COULDN'T STOP $K88.", "SUPERMAN IS POWERLESS.", "THE $CLAN REIGNS SUPREME."]);
  const launch = story.chapters.find((c) => c.id === "launch");
  assert.equal(launch.time, "13:57:27 UTC");
  assert.deepEqual(launch.seal, ["FIRST", "COIN", "EVER"]);
  const trades = story.chapters.find((c) => c.kind === "trades");
  assert.equal(trades.items[0].offsetLabel, "86 SECONDS IN");
  assert.equal(trades.items[1].offsetLabel, "52 SECONDS LATER");
  assert.equal(story.chapters.find((c) => c.kind === "clan").exited, 6);
  assert.equal(story.chapters.find((c) => c.id === "promotion").lede, "The first follower showed up 27 minutes after the page went live.");
  assert.match(story.share.text, /^KAIJU88 was the first coin ever launched on MemeWarzone\. 41 wallets in, 21.49% to graduation\./);
  assert.equal(story.share.url, `${SHARE}/s/101/${k88.token}`);
});

test("Derpy Dave: 8 chapters from data alone, including the real battle score", () => {
  const { story, problems } = buildStory(derpy, { now: NOW });
  assert.deepEqual(problems, []);
  assert.deepEqual(story.chapters.map((c) => c.kind), ["cover", "moment", "chart", "counts", "moment", "battle", "standing", "call"]);
  assert.equal(story.chapters[0].voice, "chronicle");
  assert.equal(story.chapters[1].sub, "First pool on Solana. A Friday afternoon.");
  const chart = story.chapters.find((c) => c.kind === "chart");
  assert.equal(chart.title, "5.2× in 13 days.");
  const battle = story.chapters.find((c) => c.kind === "battle");
  assert.equal(battle.title, "Lost to $ASK.");
  assert.equal(battle.sub, "Vote battle, 11 to 15 votes.");
  assert.ok(!story.chapters.some((c) => c.id === "creator-1"), "no invented creator text");
  assert.ok(!story.chapters.at(-1).ctas.some((c) => /^(X|TELEGRAM|WEBSITE)$/.test(c.label)), "no socials the owner never saved");
});

test("a coin with nothing but a name still gets a cover and a call, and never more than its cap", () => {
  const bare = { ...derpy, born: null, joined: null, market: {}, history: [], battles: [], standing: [] };
  const { story, problems } = buildStory(bare, { now: NOW });
  assert.deepEqual(problems, []);
  assert.deepEqual(story.chapters.map((c) => c.kind), ["cover", "call"]);
  const busy = { ...derpy, creator: { description: K88_DESCRIPTION }, battles: [...derpy.battles, { ...derpy.battles[0], id: "b2", won: true }] };
  assert.ok(buildStory(busy, { now: NOW }).story.chapters.length <= 8);
});

test("copy rules: no markup, no em dashes, markdown bold becomes emphasis", () => {
  assert.equal(cleanText("a — b <script>x</script> **bold**"), "a, b scriptx/script *bold*");
  for (const facts of [k88, derpy]) assert.ok(!JSON.stringify(buildStory(facts, { now: NOW }).story).includes("—"));
  const chapters = creatorChapters(K88_DESCRIPTION);
  assert.equal(chapters[0].heading, "From the deepest trenches of the blockchain, a colossal titan has awakened.");
  assert.match(chapters[0].body, /^\*\$K88\* didn't just step into the arena, he shattered/);
});

test("imported owners add one short story chapter and a full story in our boxes; chronicle stays standard", () => {
  const withProfile = { ...derpy, storyProfile: { shortStory: "Dave showed up with a hat and **no plan**. <b>Still here.</b>", sections: { next: "Weekly memes and a rematch with ASK.", origin: "Made in March by three friends.", bogus: "ignored" }, updatedAt: "2026-09-28T10:00:00Z" } };
  const { story, problems } = buildStory(withProfile, { now: NOW });
  assert.deepEqual(problems, []);
  const short = story.chapters.find((c) => c.id === "creator-short");
  assert.equal(short.body, "Dave showed up with a hat and *no plan*. bStill here./b");
  assert.equal(story.chapters.length, 8, "still capped at 8: a chronicle chapter gives way");
  assert.deepEqual(story.fullStory.sections.map((s) => [s.key, s.heading]), [["origin", "Where it started"], ["next", "What's next"]]);
  assert.equal(buildStory(derpy, { now: NOW }).story.fullStory, null);
});

test("time offsets read like people talk", () => {
  assert.equal(offsetLabel("2026-09-25T13:57:27Z", "2026-09-25T14:01:27Z"), "4 MINUTES IN");
  assert.equal(offsetLabel("2026-09-25T13:57:27Z", "2026-09-27T09:00:00Z"), "ON 27 SEP");
  assert.equal(offsetLabel("2026-09-25T13:57:27Z", "2026-09-26T09:00:00Z"), "19 HOURS IN");
});
