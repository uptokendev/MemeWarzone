# LIVE product layer — main-portability report

Date: 2026-08-22
Working branch: `hotfix/bnb-locker-30bps-release`
Do not merge this branch to `main`. Port LIVE commits after certification.

## SHAs (recorded after LIVE-1..5)

| Ref | SHA |
|---|---|
| Working branch HEAD (before leftover indexer follow-up) | `34980df2e44d5dd78e7b93488d32640e5383d747` |
| `origin/main` | `b0dd578b02a90d29c2de4ea969748d644785335c` |
| Merge-base | `d4e4e70805643bc36f965a37e5caa08310e71768` |

Branch is ~41 commits ahead of main (locker/certification line) and 1 commit behind.

## LIVE commits to cherry-pick (vertical)

Cherry-pick these onto current main after rebasing each one. Do **not** cherry-pick the rest of the locker/FeeEscrow/factory branch.

1. `196104e5` LIVE-3 Token Details live chart overlay and indexer-stuck fallback
2. `9268a800` LIVE-1 publish Solana league create+stats+activity on Ably
3. `858ad6ac` LIVE-4 War Trade Room live row metrics, sort, and expand freeze
4. `34980df2` LIVE-5 homepage league patches update mcap/new/trending without stale REST overwrite
5. Follow-up on this branch: Meteora league patches + Solana identity case fallback + liveMarketMerge tests (commit after this report)

Suggested order onto main: LIVE-1 (indexer) → LIVE-5 store/helper + homepage → LIVE-4 WTR → LIVE-3 Token Details. LIVE-5 introduces `frontend/src/lib/liveMarketMerge.ts` which LIVE-4 WTR lookup also uses after the follow-up.

## Files changed in both branches (merge-base vs HEAD and vs main)

These are **not** LIVE files; they pre-existed on the locker line:

- `frontend/server/railwayProxy.js`
- `frontend/src/contexts/SolanaWalletContext.tsx`
- `frontend/src/lib/solanaTradeV1.ts`

LIVE files are not in this overlap set at report time. Expected LIVE cherry-pick conflicts: **minor** if main has moved CampaignGrid/TokenDetails/WarRoom since merge-base.

## Expected conflicts

| Area | Risk |
|---|---|
| `CampaignGrid.tsx` / `SafeFeaturedCampaigns.tsx` | Minor if main still prefers REST mcap over Ably |
| `useWarRoomCampaignFeed.ts` | Minor — main has no league overlay |
| `TokenDetails.tsx` 15s vs 5s Solana curve poll | Minor |
| `solanaIndexer.ts` | Minor/major if main lacks dual-lane tip |
| Frozen program / economics files | Do not port; already frozen |

## DB migrations

None. League publish reuses existing `curve_trades` / `token_stats` / `campaigns`.

## Environment additions

None required. Existing `ABLY_API_KEY`, `VITE_REALTIME_API_BASE`, `VITE_ABLY_AUTH_BASE`.

## New APIs

None. `/api/token/:campaign/summary` now resolves Solana addresses with a case-insensitive fallback after exact match.

## New Ably channels/events

None. Same channels:

- `token:{chainId}:{campaign}` — `trade`, `stats_patch`, `candle_upsert`
- `league:{chainId}` — `campaign_created`, `campaign_patch`

Solana indexer now publishes the league channel (BNB already did).

## New worker/indexer behavior

- Solana tip ingest fire-and-forget `campaign_created`
- `leagueFeed.queueStats` / `queueActivity` / bonding `queueRaisedDelta`
- Meteora swap indexer queues stats+activity (not bonding raised)
- Dual-lane tip (`solana:v4:tip`) still does not wait on backfill; league publish is not awaited on create

## Manual deployment steps

1. Push `hotfix/bnb-locker-30bps-release` (Coolify already tracks this branch for test.memewar.zone).
2. Confirm indexer + frontend redeploy. Do not change `app.memewar.zone` DNS.
3. Two-browser QA on test.memewar.zone: wallet A trades, wallet B sees tape+metrics+row movement on Token Details, homepage, War Trade Room.
4. After that QA, cherry-pick LIVE commits onto main in a separate PR.

## Known risks

- League pages and Prepare counters are not live (LIVE-6/7 deferred).
- Featured ranking remains votes; mcap label is live but order is still votes.
- Empty `/summary` still happens until the campaign is indexed; Token Details keeps last-good/on-chain curve so the page does not blank.
- If Coolify frontend FQDN list includes both `test.memewar.zone` and `app.memewar.zone`, pushing this branch updates both hostnames. Confirm Coolify routing before treating app as production-isolated.
