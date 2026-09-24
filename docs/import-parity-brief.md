# Imported tokens: full token page, battle-ready, in the challenge picker — build brief (for Grok)

Owner: founder. Date: 2026-09-24. Branch: `build/robinhood-full-expansion`. Follows
`docs/import-unification-brief.md` (merged as `8269f868`). This is the last piece before the doors
open, so scope is exactly the three points below.

## The founder's bar

1. An imported token's page must be the **same page a launched memecoin gets**, minus the
   bonding-curve parts that cannot apply. Today `ImportedTokenPage` has header, chart, trade panel,
   claim, profile, arena strip. A launched token also has: Chart / Trades / Comments tabs,
   `TokenComments`, UP votes (`ArenaUpvoteDialog`), `TokenWarRoom`, favourite star, report flag,
   creator avatar, share, campaign activity.
2. Imported tokens must be **inside the battle system** the day we open: eligible for battles, visible
   on the Battle Wall's open-for-battle queue, and their owners can open / accept / challenge from
   Command Center.
3. The **Challenge a coin** popup must show a list of the **most recent imports** as opponents.

## What exists (facts, reuse)

- Battle system already treats imports as coins: `arenaBattles.js` `coinByIdentity` → `importedCoin`
  (reads `arena_token_imports`), creator status lists imports by `owner_wallet`, find-match filters
  rivals with `evaluateImportedCompetitionEligibility` (`frontend/api/lib/arenaImportEligibility.js`).
  Eligibility = `status === "passed"` and the scan not stale (`IMPORT_SCAN_STALE`) and no
  non-overridable finding. Nothing in the battle engine needs changing for imports; what is missing is
  data (all 16 production imports are still `scanning`) and freshness.
- Launched-page building blocks and their props: `TokenComments({ chainId, campaignAddress,
  tokenAddress?, mode })` — pass the token address as `campaignAddress` for imports;
  `ArenaUpvoteDialog` already accepts `{ tokenAddress, campaignAddress? }`; `TokenWarRoom({ chainId,
  campaignAddress, creatorAddress })`; favourite / flag / avatar / share are small components on
  `TokenDetails.tsx`.
- Trades, holders and candles come from the indexer, and **the indexer does not index imported
  tokens' pools** (no reference to `arena_token_imports` in `realtime-indexer/src`). That is a
  separate piece of work; do not fake it.
- The challenge popup's step 1 takes candidates from `fetchArenaBattleMatches(tokenId, chainId, 5)`
  and renders them through `presentMatchCandidates` (`findMatchPresentation.mjs`, shape: `tokenId`,
  `symbol`, `name`, `imageUrl`, …). `GET /api/arena/imports` lists **one wallet's** imports only;
  there is no public "recent imports" route.

## What to build

### A. Page parity (`frontend/src/pages/ImportedTokenPage.tsx`)

Reshape it to the launched page's layout so it reads the same: hero header (image, name, ticker,
chain, owner avatar via `UserProfile`, favourite star, share, report flag, ownership + arena pills),
then the **Chart / Trades / Comments** tabs exactly as `TokenDetails.tsx` builds them:
- Chart: as now (profile market state; candles only from the indexer when present).
- Trades: the indexer's trades when the pool is indexed; otherwise the DEX stats from the profile
  (price, market cap, liquidity, 24 h volume) plus an explorer / DEX link and the line "Trades appear
  here once this pool is indexed". Never synthesise trades.
- Comments: `TokenComments` with `campaignAddress = tokenAddress`, `mode="comments"`.
Right column, same order as launched: the trade panel (unchanged), UP votes through
`ArenaUpvoteDialog({ tokenAddress })`, `TokenWarRoom` when a market route resolves for the token
(hide it when it does not), the claim banner when ownership is pending, the owner profile editor, the
arena strip, and a **"Challenge this coin"** button that opens `ChallengeCoinModal` with the target
prefilled. Bonding-curve blocks (`CampaignMetrics`, `AthBar`, `GraduationExplosion`,
`MarketResolution`, CrypticPump) stay out; a small "Imported token — no bonding curve" note replaces them.

### B. Battle-ready by default

- `scripts/backfill-import-admission.mjs` gets `--rescan-stale`: rescan every import whose scan is
  older than the freshness window `arenaImportEligibility.js` enforces (read the constant; do not
  invent a second one). Idempotent, prints per row. The founder adds it as a Coolify scheduled task on
  the API (hourly) so `IMPORT_SCAN_STALE` never silently pulls an import out of battles.
- Command Center → Coins → My Coins lists owned imports with the same Open / Challenge actions as
  launched coins (creator status already returns them; make sure the UI does not filter them out).
- Battle Wall open-for-battle queue shows imported coins with an "IMPORTED" tag, same card.

### C. Recent imports in the challenge picker

- New public route `GET /api/arena/imports/recent?chainId=<id>&limit=<n≤24>` in
  `frontend/api/arenaImports.js`: `status = 'passed'` imports on that chain, newest first, only rows
  `evaluateImportedCompetitionEligibility` marks eligible, public fields only (`id`, `chainId`,
  `tokenAddress`, `name`, `symbol`, `imageUrl`, `createdAt`). No wallet needed.
- `ChallengeCoinModal` step 1: under the match candidates, a **"Recent imports"** row of selectable
  cards from that route (same chain as the challenger's coin); selecting one sets the target exactly
  like a match candidate. Empty state: "No imported coins on this chain yet".

## Rules

- Contracts, swap execution (Topaz / Meteora / V3), wallet-action message lines and the battle engine
  unchanged. No new money logic.
- Additive DB only; nothing here should need a migration.
- Tests: pure helpers get `node --test` files; update the source-contract pins in
  `imported-token-details-page.test.mjs`, `project-imports-ui.test.mjs`,
  `creatorChallengePresentation.test.mjs`. `eslint` clean, no new type errors in touched files,
  `vite build` passes.

## Acceptance (founder, on the live app)

1. Open any of the 16 imported tokens: hero, Chart / Trades / Comments tabs, trade panel, UP vote,
   War Room when a route exists, "Challenge this coin". It looks like a launched token's page.
2. After the backfill, an imported token with `passed` shows "eligible" and appears in the Battle
   Wall queue; its owner sees it under My Coins with Open / Challenge.
3. Battle Wall → Challenge a coin → step 1 lists recent imports; picking one and confirming creates
   the challenge; the import's owner gets the popup.
4. The hourly rescan keeps imports eligible; one is never dropped for a stale scan.
