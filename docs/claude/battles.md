# Battles: matchmaking, challenge popups, e2e, Solana resolver

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

### Battle matchmaking and league points (founder policy, 2026-09-25)

Battle points are relative (% market-cap change, % holder change, turnover), so a
size gap does not skew the score. Matching only guards the cost of pumping a tiny
coin. `calculateMatchQuality` (`frontend/api/lib/arenaMatchQuality.js`) decides
ranked; `battleLeagueEligibility` (`arenaBattleCompetition.js`) decides league points.

- **Vote battles are always ranked**, full points, no matching.
- **Metrics battles are ranked** when both coins are under $150k
  (`ARENA_MATCH_MICRO_FLOOR_USD`), or within 4x market cap above that
  (`ARENA_MATCH_V2_HARD_MCAP_RATIO`, was 8).
- Floors: liquidity >= $2,500 and holders >= 25 on both sides
  (`ARENA_MATCH_MIN_LIQUIDITY_USD`, `ARENA_MATCH_MIN_HOLDERS`). The old holder and
  liquidity *ratio* gates are gone.
- **The match score no longer gates ranked**; it only sorts recommendations.
  `ARENA_MATCH_SCORE_GATES_RANKED=true` restores the 70 gate.
- **Open War** (an unranked metrics challenge) earns league points at 0.5x
  (`ARENA_OPEN_WAR_POINTS_MULTIPLIER`): win 1.5, loss 0.5. Stakes and payouts are
  unaffected; only league points scale.
- Metrics battles need market data. Imported tokens have no `market_stats` rows
  yet, so the server refuses a metrics challenge involving one
  (`METRICS_MARKET_DATA_UNAVAILABLE`); vote battles work for them.

### Challenge popups: two delivery paths (2026-09-25)

A challenge, counter, accept or decline reaches the other owner two ways, and either alone shows
the popup. **Realtime:** the API publishes to `arena:creator:{chain}:{wallet}` (Ably; best-effort,
lost if the owner is away). **Inbox:** `GET /api/arena/battles/inbox?chainId&wallet`
(`frontend/api/lib/arenaChallengeInbox.js`) re-derives the same popups from `arena_battles`, and
`IncomingChallengeListener` reads it on load, on tab return, on reconnect and every 20 s. An
unanswered challenge returns on every page load; accepted/declined show once per browser.

- A decline stores `decline_message = ""` when no message is given: **non-null means declined**,
  null + expired means timed out. Do not "clean up" empty strings.
- A challenge expires at `ends_at`, which each counter restarts (was `created_at + 24h`).
- Every named GET route under `/arena/battles/` must be in `ARENA_BATTLE_NAMED_ROUTES`
  (`arenaBattleChainIdentity.js`), or the runtime 404s it as an unknown battle id. `opponents` was
  missing until 2026-09-25; a test now pins the list against the router.
- Staging lacks `db/migrations/20260924_000001_arena_battle_decline_message.sql` (production has it).

### Battle flow e2e (2026-09-25) -- run before any battle change ships

`E2E_DATABASE_URL=<staging> PG_SSL_ALLOW_SELF_SIGNED=1 node frontend/scripts/e2e-arena-battle-flow.mjs`
drives the real handlers on staging with generated, really-signing wallets: ownership, refusals,
challenge -> inbox -> counter -> inbox -> accept -> votes / market move -> realtime tick -> clock out
-> settlement -> winner -> league points (vote 3/1, ranked 3/1, Open War 1.5/0.5), decline with and
without message, timeout. 31 checks; refuses the production URL; retires its coins (import history
is append-only). First run found four live blockers: `data_lag_seconds` (integer) got fractional
seconds at accept and at V3 settlement (every metrics settlement failed), a legacy active season
without a month blocked league writes, and notification markers were written without their
required `outbox_id` (no marker-keyed notification was ever sent; 0 rows on production).
Import market data: DexScreener (solana/bsc/robinhood) + GeckoTerminal fallback and EVM holders
(free tier ~30/min; per-pass budget; `COINGECKO_API_KEY` for the paid API). Imports need a fresh
scan (7 days): `scripts/backfill-import-admission.mjs --rescan-stale` must run hourly on Coolify.


### Solana battle resolver never resolved anything (fixed 2026-09-27, `e61d7d40`)

`arena-operator-worker.mjs` validated `arena_config` without an environment/cluster, so every mainnet
resolve returned `config-unreadable` -- the API probe's 2026-09-22 bug, in the worker. The worker now
**requires `SOLANA_CLUSTER=mainnet-beta`** (on the resolve-due service too). First battle
`arena-mugwhj11-9b1973` (ASK won; resolve deadline 2026-09-28 12:29 UTC, after which only
`settle_expired_pool` refunds are possible). Stale test: `arena-operator-resolve.test.mjs` imports the
removed `buildArenaCancelInstructions`.



### Resolver crash loop + MWL never rolls over (found 2026-10-02)

- **resolve-due crash loop:** `ERR_REQUIRE_ESM` on start. `rpc-websockets` 9.3.9 (under
  `@solana/web3.js`) `require()`s its nested ESM-only `uuid` 14; that needs Node >= 22.12 (or 20.19).
  `FROM node:22-slim` built from a cached 22.11 base. Both worker Dockerfiles now pin `node:22.20-slim`.
- **MWL has no automatic rollover.** Only the admin POST `/api/arena/league/finalize` (alias
  `cycle-season-state`) runs `finalizeMwlForChampionship`, which sets `active=false`; nothing schedules
  it. `ensureActiveSeason` returns any active monthly row without checking its month, so points
  scored after month end land in the old month. Production 2026-10-02: `mwl-2026-m09-c{56,101,4663}`
  all still `live/active`, `arena_mwl_finalizations` empty, and one chain-101 battle settled
  2026-10-02 11:35 UTC (3+1 points) went into `mwl-2026-m09-c101`.
- **EVM league share needs a crank.** `ArenaWarPoolTreasuryV2.claimLeague(poolId, monthlyEpoch,
  quarterlyEpoch)` is permissionless and nothing in the app sends it; the pot only grows when someone
  does. Epochs are `keccak("YYYY-MM")` / `keccak("YYYY-Qn")` (`leagueEpochs` in
  `scripts/t2-battle-resolve-claim-evm-real.mjs`). The caller picks the epoch: a wrong one cannot
  steal (`PostGradLeagueTreasuryV2.claimMonthly/claimQuarterly` pay fixed receivers, permissionless)
  but it puts the money under the wrong month. A crank must derive the epoch from the battle's
  settlement month, not from "now". Money then sits in the league treasury until `claimMonthly(epoch)`.

**Fixed (2026-10-02, code; deploy + SQL pending):**
- `api/lib/arenaMwlRollover.js` `rolloverEndedMwlSeasons`, run every minute by the realtime worker:
  finalizes every active month that has ended (`finalizeMwlForChampionship`), writes the treasury
  identity row when `MONTHLY_LEAGUE_TREASURY_ADDRESS_<id>`/`MWL_TREASURY_ADDRESS_<id>` is set (none
  is set anywhere today; the month closes regardless), then opens the current month.
  `ensureActiveSeason` now throws `MWL_ROLLOVER_PENDING` for an ended month, so settlement rolls
  back and retries instead of scoring into it. `recordMwlFinalization` moved there from `arenaLeague.js`.
- Misplaced points: `database/prod_fix_mwl_2026_10_02_B1_before_deploy.sql` (before the deploy,
  so September freezes as ASK 3 / Derpy Dave 1) and `..._B2_after_rollover.sql` (after
  `mwl-2026-m10-c101` exists). Rehearsed on staging with the real rollover code inside a rolled-back
  transaction (savepoint-mapped client): guard, B1, early-B2 refusal, rollover, snapshot, B2, Q4 mirror.
- `api/lib/arenaEvmLeagueCrank.js`: `claimLeague` for every Resolved V2 pool with an unclaimed
  league share on 56/4663 (and testnets if configured), epoch from settlement month. Off unless
  `ARENA_EVM_LEAGUE_CRANK=dry|send`; key `ARENA_LEAGUE_CRANK_PK` else `RECRUITER_PAYOUT_OPERATOR_PK`.
  Money then waits in `PostGradLeagueTreasuryV2` until `claimMonthly(epoch)` -- not cranked yet.
- The Q3 championship epochs are still `open` on all chains; nothing closes a quarter automatically either.

### Q3 close + MWL payout decisions (2026-10-02)

- Q3 2026 closes without placement bonuses: transfer status `waived`
  (`db/migrations/20261002_000001_championship_mwl_transfer_waived.sql`), then
  `database/prod_close_q3_2026_without_bonus.sql`; the realtime worker closes the quarter.
- MWL treasuries (defaults in `arenaMwlChainIdentity.mjs`): Solana `mwl_vault`
  `PCDQmFBrYTV2kfdGtiGWJ2Au9TfaR5ZzBkXdtymV1Bd`; BNB `PostGradLeagueTreasuryV2` `0xD9E38140…`; Robinhood
  `0x5D5CC19B…`. Both EVM league treasuries' `monthlyReceiver`/`quarterlyReceiver` are the Safe and
  held 0 on 2026-10-02. `MONTHLY_LEAGUE_TREASURY_ADDRESS_*` is the PRE-GRAD vault, never the MWL.
- Nothing pays MWL winners yet. Decided: poker split, recipient = coin creator / import owner, 60%
  month / 40% quarter, new fixed-cap `MonthlyLeagueTreasury` per EVM chain for the MWL.

### Who moves the money (2026-10-02)

- **Solana battles:** resolve-due worker (Coolify "arena-resolve-due", `Dockerfile.resolve-due`) resolves
  each finished pool and, with `ARENA_OPERATOR_CLAIMS=send`, claims its MWL share (-> `mwl_vault`) and
  protocol share (-> `protocol_vault`). First sweep 2026-10-02: 0.1 SOL MWL, 0.1555 SOL protocol.
- **Solana protocol_vault -> wallets:** the indexer's fee-escrow worker calls `flush_operator_fill`
  hourly (>= 0.05 SOL): operator `2AMfRaxS…` up to $10k, rest to multisig `fk5YYWb…`. Key is
  `SOLANA_FEE_ESCROW_PAYER_SECRET` (inline JSON; `_KEYPAIR` is a file path and stays unset). Payer
  `Crmw8dwU…`. `route_state` SOL price is cap bookkeeping only (`set-route-sol-price.mjs`).
- **EVM trading fees:** `TreasuryRouterV3` -> `ProtocolRevenueVault`, which forwards on receive. No crank.
- **EVM battles:** the API realtime worker's war pool crank (`arenaEvmLeagueCrank.js`,
  `ARENA_EVM_LEAGUE_CRANK=dry|send`): resolves a finished Live pool with the server-signed result
  (`claimIntentFor` in `arenaWarPools.js`, the Claim button's own path), then `claimProtocol` and
  `claimLeague`. The winner still collects with the Claim button.
- **Graduation keeper** = Coolify "Graduation Operator" (`Dockerfile.graduation-keeper`).
- resolve-due crash loop root cause: Coolify built it with Nixpacks (Node 22.11). Fixed twice:
  Dockerfile build pack, and root `overrides` pinning rpc-websockets' uuid to 11.1.0 (CJS).

### War pool deposits and claims come from the chain (2026-10-06, branch `feat/arena-deposits-from-chain`)

- Before: `arena_war_pool_deposits` got a row only when the staker's browser posted a stake receipt
  (second signature). Owner B's 0.05 SOL in `arena-mugwhj11-9b1973` (tx `3khothUk...`) had no row;
  `arena_war_pool_claims` was empty. Boosts had **no** gap: all 157 mainnet boost txs were in
  `arena_contest_actions` with the same amounts (checked 2026-10-06).
- Now: `scripts/solana/arena-war-pool-index.mjs` (lib `frontend/api/lib/arenaWarPoolChainIndex.js`)
  reads every pool's transactions and writes `source = 'chain'` rows: stake / support / buy_in /
  boost deposits from the program's events, winner / place / protocol / MWL claims and refunds from
  the vault's balance change (receipt account when one tx moves the vault twice). EVM: the
  `ArenaWarPoolTreasuryV2` events. Unique by `(chain_id, tx_hash, ix_index)`; a receipt row of the
  same tx and purpose is replaced, and the receipt route skips its insert once a row exists.
- Migration `db/migrations/20261006_000010_arena_war_pool_chain_index.sql`. Deploy the API first
  (its receipt insert has no conflict target), then the migration, then the scheduled task.
- Mainnet backfill (dry run 2026-10-06, 3 battles, 169 txs): 3 receipt rows replaced, 164 rows
  added (owner B's stake, 157 boosts, 2 winner, 2 protocol, 2 MWL claims).
