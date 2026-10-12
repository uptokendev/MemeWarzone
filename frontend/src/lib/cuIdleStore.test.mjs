import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("Solana coin page first-paints from store and looks up by mint, not a 500-row list", () => {
  const live = read("src/pages/TokenDetailsLiveEntry.tsx");
  const dbcCreate = read("src/lib/dbcCreate.ts");
  assert.doesNotMatch(live, /limit=500/);
  assert.match(live, /search=\$\{encodeURIComponent\(routeId\)\}/);
  assert.match(live, /fetchDbcToken\(routeId, \{ live: true \}\)/);
  assert.match(dbcCreate, /opts\?\.live \? "&live=1" : ""/);
  assert.match(live, /if \(isSolanaRoute && dbcCoin === undefined\)/);
});

test("frontpage unknown bonding progress is a dash, not 0%", () => {
  const card = read("src/components/home/CampaignCard.tsx");
  assert.match(card, /progressKnown/);
  assert.match(card, /progress == null\s*\n\s*\? "—"/);
});

test("BNB and Robinhood leftover display polls pause on idle via setVisibleInterval", () => {
  const files = [
    "src/hooks/useDexPairTrades.ts",
    "src/lib/useImportWalletBalances.ts",
    "src/pages/TokenDetailsEntry.tsx",
    "src/components/home/SafeFeaturedCampaigns.tsx",
    "src/hooks/useWarRoom.ts",
    "src/hooks/useEmbedChartMarket.ts",
    "src/hooks/useBnbUsdPrice.ts",
    "src/hooks/useEthUsdPrice.ts",
    "src/hooks/useRobinhoodBeatTheMarket.ts",
    "src/components/token/TokenSafetyStatusButton.tsx",
    "src/hooks/useTokenStatsRealtime.ts",
    "src/components/token/TokenComments.tsx",
    "src/components/home/AirdropStrip.tsx",
    "src/components/arena/useBattlePrizePool.ts",
    "src/components/arena/BuyInPopup.tsx",
    "src/components/arena/BattleVoteControls.tsx",
    "src/components/arena/TournamentVoteControls.tsx",
    "src/components/arena/TournamentBoostControls.tsx",
    "src/components/arena/TournamentFinalSalvoControls.tsx",
    "src/components/arena/IncomingChallengeListener.tsx",
    "src/hooks/useTournamentCommandState.ts",
    "src/hooks/useLeagueRealtimeBase.ts",
    "src/hooks/useProfileStream.ts",
    "src/hooks/usePrepareNotificationCenter.ts",
  ];
  for (const rel of files) {
    const src = read(rel);
    assert.match(src, /setVisibleInterval/, rel);
    assert.doesNotMatch(src, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 10_000\)/, rel);
  }
  const dex = read("src/hooks/useDexPairTrades.ts");
  assert.match(dex, /getReadProvider/);
  assert.match(dex, /setVisibleInterval\(load, pollIntervalMs\)/);
  const balances = read("src/lib/useImportWalletBalances.ts");
  assert.match(balances, /setVisibleInterval\(\(\) => void load\(\), 15_000\)/);
});

test("idle session parks the app wallet without provider.disconnect", () => {
  const idle = read("src/lib/idleSession.mjs");
  const evm = read("src/hooks/useWallet.ts");
  const sol = read("src/contexts/SolanaWalletContext.tsx");
  const solWallet = read("src/lib/solanaWallet.ts");
  assert.match(idle, /IDLE_PAUSE_MS = 2 \* 60 \* 1000/);
  assert.match(idle, /IDLE_DISCONNECT_MS = 15 \* 60 \* 1000/);
  assert.match(evm, /IDLE_PARK_EVENT/);
  assert.match(evm, /resetWalletState\(false\)/);
  assert.match(sol, /IDLE_PARK_EVENT/);
  assert.match(sol, /idleParked \? ""/);
  assert.match(sol, /const onPark = \(\) => \{\s*setIdleParked\(true\);\s*setSolanaAccount\(""\);\s*\}/);
  assert.match(solWallet, /export async function disconnectSolanaWallet/);
});
