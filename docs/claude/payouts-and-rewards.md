# Protocol fees, leagues, airdrop, recruiter and creator payouts

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

### Protocol fees, league vaults and the weekly airdrop (2026-09-25)

- **Solana protocol share (42.5% of the 2% fee = 0.85% of volume) only leaves `protocol_vault` via the
  permissionless `flush_operator_fill`, and nothing called it** (0.559 SOL sat there). The fee-escrow
  worker now flushes hourly (`SOLANA_PROTOCOL_FLUSH_*`). `route_state.native_usd_micros` is cap
  bookkeeping only; update with `scripts/solana/set-route-sol-price.mjs`. EVM `ProtocolRevenueVault`s
  forward on `receive()`, no crank.
- League page pot for the live Solana epoch = league vault balance (carry-overs included).
- **Two airdrop pipelines.** The website reads only the weekly runner (`frontend/scripts/weekly-airdrop`,
  tables `reward_batches`/`reward_ledger`), not the indexer's `airdrop_draws`. It had not run since
  2026-08-18 and `sum(bnb_amount_raw)` failed on production (text column). Rules are one USD set on
  every chain (`usdRules.mjs`, mirrored in the indexer's `airdropThresholds.ts`).
- **Runs on our Coolify, not GitHub** (founder): scheduled task on the API service, Mondays 00:15 UTC,
  one per `AIRDROP_CHAIN_ID`. Solana posts roots with the narrow **reward poster** role
  (treasury candidate `cb2e4546…`, not yet on mainnet; needs extend +53928 B), never the authority.
  EVM funds with the vault's `airdropOperator` key, bounded by Safe-pre-authorized deterministic batch
  ids (`scripts/make-airdrop-setup-calls.mjs`). Front-page strip behind `VITE_AIRDROP_STRIP_ENABLED`.

### League payouts are poker-style everywhere (2026-09-26)

Founder: "if 100 participants are in and only 1 gets paid we have got a problem." One rule for
pre-grad weekly/monthly, MWL monthly and the quarterly finals, all chains:
paid places = min(field, 255, max(3 weekly / 5 otherwise, floor(15% of field))), weights
1/rank^0.72, exact integer split, remainder to rank 1. Source: `realtime-indexer/src/rewards/pokerPayout.ts`
(settlement, `finalizeEpochWinners.ts`) mirrored in `frontend/shared/pokerPayout.mjs` (league page,
on-chain fallback); a parity test pins them. The page counts the whole field with
`COUNT(*) OVER ()`, not the loaded rows. `LEAGUE_PAGE_WRITE_WINNERS` page-writes are disabled: only the
job writes winners, one transaction per category (a partial write would strand every rank after the
failure). **Rank was capped at 5 in three more places**: the DB CHECKs on `league_epoch_winners/claims/
payouts` (migration `db/migrations/20260926_000001_league_ranks_poker_255.sql`, staging applied,
production = founder), the claim API and the Solana claim client. **Solana `claim_league` took ranks
1..=5 only** -- raised to 1..=255 in treasury candidate `1840a9e7…` (1436744 B, extend +130104, gate
19/19), which also lets the reward poster post recruiter/squad earnings batches (capped by
`max_lane_batch_lamports`, weekly, no expiry). Supersedes the unstaged `e996ba88…` and `b09d2b1a…`.
Safe by construction: the indexer posts roots only via `post_league_epoch_root`, which ships in the same
upgrade, so no poker root can reach a program that caps ranks at 5. Never post one with the authority key.

### Recruiter, recruiter league and creator payouts -- wired 2026-09-26 (they were not)

Nothing ever credited a recruiter: chains routed each linked trade's 12.5% (OG 15%) slice into the
recruiter vault and `recruiter_reward_ledger` held only test rows. Fixed end to end:
- **Per-trade source = `reward_events` on all chains.** Solana: the FeeSlices decoder skipped
  `creator_lamports` (added by the 2026-09-24 launchpad), shifting every slice one column; both layouts
  now decode by length, graduation (`FeeSlicesRouted`) is its own kind. EVM: the router scan read
  `factory.router()` (the DEX router) and only the V2 event; it now scans the treasury routers (V3
  `0xe635AA43` / RH `0xda0a9Ed9` + old V2 `0xe157a6FD`, `TREASURY_ROUTERS_<id>` override) with a cursor
  per router. Mainnet Solana: 110 events reconcile to the lamport with the recruiter vault (671407).
- **`cron:credit-recruiter-earnings`** (hourly): exact slices -> `recruiter_reward_ledger`, attributed
  like the signing decision (EVM `route_authorization_log`, Solana wallet link, graduation = creator's
  recruiter). Unattributable slices are recorded and retried, never dropped.
  `cron:backfill-solana-reward-events` once after deploy. Migration `20260926_000002` (Robinhood).
- **Claims:** Solana weekly batch via the reward poster (`post_recruiter_batch_root`, no expiry; the
  exporter refuses a batch the vault cannot fully pay). BNB/Robinhood pay at claim time from
  `RecruiterRewardsVault.payout` with `RECRUITER_PAYOUT_OPERATOR_PK`; the Safe must set operator, caps
  and unpause (BNB vault read 2026-09-26: operator 0, paused, caps 0). Testnet rows hidden on mainnet.

### BNB / Robinhood payouts switched on (P1 Safe batches, 2026-09-26)

Executed by the Safe: BNB `0xea53dd71…` (block 124206760), Robinhood `0xde938316…` (block 73377091).
One operator EOA `0xdcf07EB07e6D6722c246161e7530dc905F9eaA50` (key
`~/.config/memewarzone/mwz-evm-payout-operator.json`) holds three narrow roles on both chains:
recruiter vault operator (unpaused; caps 2/10 BNB, 0.5/3 ETH), weekly + monthly league `rootPoster`
(weekly claim caps 5/10 BNB, 1.5/3 ETH), and `airdropOperator` on the new `RewardDistributor`
(BNB `0xF170a2C9…`, RH `0x2ABd8970…`, owner Safe, batchOperator = community vault). Read back from
chain. Robinhood's vaults need Safe pre-authorization per epoch/month/batch: 12 weeks from 2026-09-21
(max 3 ETH each, publish from the following Monday), month 202609 (max 12 ETH, from 2026-10-01), and
airdrop batches (`batchAuthorization(bytes32)`, max 1.5 ETH) — all verified. BNB's first-generation
league vaults have no authorization step. **The operator starts with 0 gas on both chains** — fund it
(~0.01 BNB, ~0.003 ETH) before the first root post or payout.
- **Recruiter League is a prize league** (league fee, poker, last category so dust positions hold).
  Score basis is now identical in job and board: traded volume on every chain (the board had used the
  routed FEE as EVM volume, ~50x skew vs Solana), earnings = chain slices, USD frozen at settlement,
  paid place needs referred trading in the epoch, prize to a wallet valid on that chain.
- **Creator fees:** Solana works (claim simulated OK on mainnet). BNB/Robinhood accrued in
  `CreatorRewardsVault` with no app path -- now `/api/evm/creator-fees` + Claims panel. Pre-2026-09-20
  Solana coins lacked a creator fee vault; the escrow worker now backfills it hourly.
- **Still open:** squad earnings have no attribution rule (slices accrue in the squad vaults); LP-fee
  harvest after graduation is manual on all chains (no mainnet graduation yet); past epochs' recruiter
  prizes were never set aside (the league pot was split without them).


### Monthly league vaults capped at a few wei (found 2026-09-27)

Both `MonthlyLeagueTreasury` vaults (BNB `0xF62A09de…`, RH `0xE72A281b…`) hold `monthlyCapUsd = 30000`
raw; the unit is 18-decimal USD, so every month is capped at 39 / 12 wei and `sealMonth` reverts
`WinnerTotalAboveCap`. Immutable. No money was at stake (first launch 2026-09-27). Replacement:
`scripts/replace-monthly-league-treasury.ts` (deploy, then Safe batches M1 propose + authorizeMonth x12
+ dust, M2 accept after the router's 3600 s), rehearsed by `test/MonthlyLeagueTreasuryReplacement.spec.ts`
with a realistic price and prize. **Check values, not presence:** `node scripts/check-evm-payout-bounds.mjs`
prices every payout bound on both chains in dollars and fails outside $1..$1M -- run it after any
deploy or Safe batch that sets a cap. After M2: the new addresses go into `league.js`,
`evmLeagueClaimVerification.js` and `publish-evm-league-roots.mjs`.
**Done 2026-10-04** (`fix/evm-monthly-league-treasury`): one resolver, `frontend/api/lib/evmMonthlyLeagueTreasury.js`,
used by the publisher, `leagueRoot.js`, `monthlyLeagueTreasury.js`, `league.js` and claim verification. An env
pointing at a superseded vault (or anything but the record on mainnet) fails closed; a seal also requires router V4
and V3 `monthlyLeagueTreasury()` to equal the vault. Verified on chain that day: no month sealed on either old vault,
both hold 0 (BNB dust 36239495805697 wei moved in M1), new vaults hold all monthly money, 202609 + 202610
authorized (exceptional), **202608 not authorized** -> BNB August (12321428573942 wei, 5 leaves) needs a Safe
`authorizeMonth(202608, ..., exceptional=true)` on `0x42D254A7…` before the publisher can seal it. BNB
TreasuryRouterV2 `0xe157a6FD…` still points at the old vault (any V2-routed monthly slice lands there; Safe
`withdrawNative` moves it).


### Airdrop: 60-day claim window, unclaimed rolls back into the pot (founder, 2026-09-27)

`AIRDROP_CLAIM_WINDOW_DAYS=60`, `AIRDROP_WEEKLY_DISTRIBUTION_BPS=10000` + `AIRDROP_ALLOW_FULL_VAULT_DISTRIBUTION=true`
(pay everything weekly). Solana needs nothing more: posting never moves lamports, the pot is the vault
minus still-open batches, so an expired week's remainder is next week's pot. EVM moves each week into
`RewardDistributor`; after the deadline only the Safe can `recoverUnclaimed`, and the community vault
refuses plain transfers (`receive()` reverts, `depositAirdrop` is onlyRouter). So
`scripts/make-airdrop-recovery-batch.ts` writes ONE atomic Safe batch: recoverUnclaimed -> Safe,
vault.setRouter(Safe), depositAirdrop{value}, setRouter(router). Rehearsed in
`test/AirdropRecoveryBatch.spec.ts` (incl. the naive direct recovery failing, and replay reverting).
First weeks expire late November 2026; run the script monthly from then. `buildBatch` now takes an
optional `value` for payable calls only.



### Major War League payouts (built 2026-10-02)

Founder: poker split, recipient = coin creator / verified import owner, 60% month / 40% quarter,
no expiry, no manual work, every winner can collect. Pre-grad leagues untouched (own periods, vaults).

- **Ledger** `arena_league_share_ledger` (migration `20261002_000002`): each battle's league share,
  recorded by the crank BEFORE it moves it (Solana `claim_mwl` in resolve-due, EVM `claimLeague` in
  the API crank). Split = `PostGradLeagueTreasuryV2` (monthly = floor(gross*6000/10000)).
- **Winners** `arenaMwlPayouts.js` (API realtime worker, `ARENA_MWL_PAYOUTS=on`): finalized MWL month
  -> period `mwl_monthly`/category `mwl`; closed Quarterly Championship -> `quarterly`/`championship`.
  Pot = all unassigned ledger shares of that period and earlier (late shares roll forward). Coins
  without a valid owner wallet are skipped; Solana places < 0.005 SOL not paid alone; nobody payable
  -> `arena_mwl_payout_runs.status = rolled_over`. `expires_at` null.
- **Solana**: `cron:publish-league-epoch-root` (indexer scheduled task) posts `mwl_monthly` (3) and
  `quarterly` (2) roots for `mwl_vault`.
- **EVM**: two `TreasuryVaultV2` per chain (`scripts/deploy-mwl-payout-vaults.ts`, Safe batch MWL1:
  setReceivers, claim caps, 24 months + 8 quarters authorized, 2-year publish windows). Epoch codes
  3 / 4. API crank sweeps `claimMonthly`/`claimQuarterly` after each period ONLY when the receiver is
  the MWL vault. `publish-evm-league-roots.mjs` posts MWL roots only when the vault covers the list
  plus every earlier MWL prize still unclaimed (read from `epochTotal`/`epochClaimedTotal`).
  Env: `MWL_MONTHLY_VAULT_ADDRESS_<id>`, `MWL_QUARTERLY_VAULT_ADDRESS_<id>`.
- Rehearsed: staging (Sept pays ASK's owner 0.012 SOL, Q3 0.008 SOL; a signed claim returns a valid
  mwl_vault proof) and hardhat `test/MwlPayoutVaults.spec.ts` (full EVM money path + hot-key bounds).
- **LP fees**: `EVM_LP_HARVEST` (API, hourly, simulates locker.harvest) and `SOLANA_LP_HARVEST_AUTO`
  (indexer, 6h; refuses without `SOLANA_PROTOCOL_TREASURY_ADDRESS`, whose fallback is the devnet
  deployer HuKfoF).


### Finance fee-routing view (built 2026-10-03)

`GET /api/admin/finance/fee-routing?chainId=…[&environment=production&solanaCluster=mainnet-beta]&days=30`
(bearer + `finance.view` only; `frontend/api/lib/financeFeeRouting*.js`). Per chain: every fee flow with
its split and code citation, every destination's live balance (RPC), DB inflows over the period, and live
wiring checks (router getters, `route_state`, `arena_config`, `arena_money_config_v2`) against the
registry. Failed reads are `unknown`, never zero. Facts found while building it, read from chain:
- **LP protocol share on EVM is stranded by design.** Lockers route the 20% via `routeLpToken`
  (`safeTransferFrom` of WBNB/WETH into `ProtocolRevenueVault`); the vault forwards native only on
  `receive()` and has no ERC20 withdraw. No graduation has harvested on mainnet yet (balances 0).
- **No gen-6 router events are recorded.** `reward_events` has no rows for 56/4663 while the V4
  vaults hold fees: the indexer scans V4 only if `TREASURY_ROUTERS_EXTRA_<id>` is set
  (`realtime-indexer/src/indexer.ts:1182-1188`). Recruiter credit reads the same table.
- EVM war-pool protocol share goes straight to the Safe (`protocolReceiver`), not the protocol vault.
- Solana deployer 9YN7 holds `route_state` / `arena_config` / `rewards_config` authority (no fee path pays it).

### Command Center Reward Ops / recruiter payouts auth (2026-10-03, fix/finance-p0)

Verified on the live API (`3a591353`) before the change: `/api/admin/rewards/*` and
`/api/security/recruiter-payouts` answer 401 without auth (enforce flags are on), and every
`/api/internal/rewards/*` route answers 503 `INTERNAL_AUTH_NOT_CONFIGURED` because neither
`RANK_EVENTS_TOKEN` nor `INTERNAL_API_TOKEN` is set there. No worker, script or cron in this repo
calls these routes; the indexer has its own `/api/security/rewards/*` (rewardOpsRoutes.ts).
- `/api/admin/rewards/*` now needs a dashboard bearer with `finance.view` (GET) / `finance.manage`
  (writes), or the ops key; `/api/security/recruiter-payouts` needs `recruiter_payouts.manage` or the
  ops key. Both fail closed in `railwayProxy.js` and again in the route
  (`api/lib/dashboardPermissionOrOps.js`), whatever `API_AUTH_ENFORCE_*` says.
- Dashboard doors to the internal handlers: `/api/admin/rewards/{publications,draws,routing,claim-vault,epoch-status}`.
  `/api/internal/rewards/*` is unchanged (internal token). The draw-run route is not exposed.
- `reward_ledger.amount` is per-chain atomic units. Production holds Solana rows only: chain 101
  (mainnet, lamports) and legacy chain 102 (small test rows, left in place). Routing and overview
  amounts are now per chain + token; the old cross-chain sums are `null`.
- Finance rewards read chain-101 rows only for the API's own cluster (`SOLANA_CLUSTER`, default
  mainnet-beta): picking devnet on the live API returns no rows plus a `notice`.
- Finance inventory items carry a live native `balance` (fee-routing readers); failed read = unknown.

### Finance: mainnets only, All chains, USD (2026-10-04, feat/finance-mainnet-allchains-usd)

- Founder: finance shows mainnets only (Solana 101 mainnet-beta, BNB 56, Robinhood 4663). `financeScope()` in
  `frontend/api/admin/finance.js` refuses 97, 46630 and Solana devnet with 400; `chainId=all` (also the default
  with no chainId) returns `finance-all-chains-v1`: one section per chain (a failing chain is reported, not
  hidden) plus merged `totals`. LP harvest keeps its old parser (`harvestNetwork`) and is untouched.
- USD lives in `frontend/api/lib/financePrices.js`. Spot: the existing readers (`*UsdPrice.js`: env override,
  then Binance spot, 60 s cache). History: Binance hourly klines (same public API, no key); there is no
  native/USD history in the DB (`token_candles.reference_price_usd` is empty on production, `market_stats`
  holds only the latest). Revenue and fee inflows are queried per hour and valued at that hour's close;
  hours without history use spot and say `priceBasis: current|mixed`. Balances use spot. USDC/USDT = $1
  (quote catalog rule). No price -> `amountUsd: null`, counted in `missingPriceCount`, never 0.
- Totals never add SOL + BNB + ETH: native sums are per chain and asset only; the USD total is cross-chain.
- Hidden test coins (`meta.publicHidden`) are left out of revenue and fee inflows via
  `notPublicHiddenCampaignSql` (`api/lib/publicHiddenSql.js`). `arena_league_share_ledger` and
  `dbc_fee_accruals` have no campaign column and are shown in full. Fee-routing holdings leave out watch-only
  wallets; inflow totals leave out the DBC collector (its claim is re-split into the vault slices).
- Production read-only run 2026-10-04 12:33 UTC: revenue $65.33 (0.540657363 SOL, K88 only, event-time
  prices; 66 test-coin fee events left out); fee destinations hold $287.27 (SOL $273.08, BNB $11.43,
  ETH $2.76; watch-only deployer wallets left out); routed in (all time) $168.56, all Solana.

### Finance: "Ours" vs "Held now", LP harvest mainnets only (2026-10-04, feat/finance-ours-lpharvest-mainnet)

- Every fee-routing destination carries `ownership: ours | owed | watch`, `ownershipReason` (with the code
  line) and `ownershipMixed`. Table: `frontend/api/lib/financeFeeRoutingOwnership.js`; an id missing from it
  is counted as owed and flagged `ownershipUnclassified`, and the ownership test fails.
- Ours: Solana protocol_vault PDA, operator 2AMf (cap fill + import-swap fee), Squads fk5Y, UP vote treasury,
  LP-fee protocol treasury, DBC referral account (swept 100% to protocol_vault), import-swap fee owner; EVM
  ProtocolRevenueVault (its wrapped LP share is ours but unmovable: no ERC20 withdraw), operator EOA, Safe.
- Mixed, counted as owed: DBC fee collector (re-split mostly to reward vaults), EVM ArenaWarPoolTreasuryV2
  (pendingProtocol sits beside players' prizes until claimProtocol), LP lockers (creator pending + protocol
  pending). Charity treasury is owed (earmarked), even though only the Safe can move it.
- `totals.ours` (fee-routing and overview; overview also gets `totals.feeHoldings`) uses `buildTotals`, so
  price rules match Held now. Production read-only 2026-10-04: Held now $287.35, Ours $151.42 (SOL
  1.132841864 = $137.48, BNB 0.014206 = $11.21, ETH 0.001009 = $2.72). Solana vote/LP/DBC receivers are not
  set in the local env, so they read not_configured there (4 unknown in Ours).
- `/api/admin/finance/lp-harvest` refuses BNB 97, Solana devnet and anything not BNB 56 / Solana mainnet-beta
  with 400 (`lpHarvestMainnetOnly`), before `financeLpHarvest` runs. Robinhood 4663 has no harvest path in
  this route (it was never in `harvestNetwork`). `/api/dashboard/lp-fees` (testnet-open read mode) unchanged.

### Finance payouts overview (2026-10-04, feat/finance-payouts)

`GET /api/admin/finance/payouts?chainId=all|56|4663|101(+environment=production&solanaCluster=mainnet-beta)&days=30`
(bearer + `finance.view`, GET only, 60 s cache; `frontend/api/lib/financePayouts.js`). Per mainnet and payout type
(weekly, monthly, MWL, recruiter, creator fees, airdrop, squad, war pool/arena, operator fill): paid (period + all time,
last tx link), owed now (claimable = root on chain, waiting = no root yet), the paying vault's live balance (fee-routing
balances) and covered / short. Test-coin prizes are left out of paid/owed and shown apart, but the vault check counts
them (the vault pays them). Facts read on production 2026-10-04:
- `league_epoch_claims.signature` is the winner's wallet message signature (base64), not a transaction; the claim
  transaction is `league_epoch_payouts.tx_hash` (older claims have no payout row, so no link).
- **EVM monthly league: vault mismatch.** V4 routers send to `0x42D254A7…` (BNB) / `0x576c1d6B…` (RH); claims and roots
  use `MONTHLY_LEAGUE_TREASURY_ADDRESS_<id>` or the old `0xF62A09de…` / `0xE72A281b…` (balance 0). BNB August monthly
  winners (0.0000123 BNB, no root) are therefore short against the old vault.
- Solana recruiter: 1065542 lamports claimable in `recruiter_reward_ledger` (33 of 35 rows are test coins); the prepared
  weekly batch (671407 lamports, not posted) is in a `recruiter_reward_claims` row whose payout wallet is the devnet key HuKfoF.
- Creator claims are not recorded anywhere; Solana "owed" is read live from each public coin's escrow + creator vault
  (same math as `solanaCreatorFeeMath.js`), EVM owed = CreatorRewardsVault V1 + V2 balances.
- `ProtocolRevenueVault.operatorFillCapUsd/operatorFilledUsd` are 18-decimal USD (cap 10000e18); Solana `route_state` is USD micros.

### Finance fee coverage audit (2026-10-04, feat/finance-fee-coverage)

Every fee route checked against what `revenueLanes()` counts. Lanes added in
`frontend/api/lib/financeRevenueLanes.js` (protocol share only; prize and MWL money never):
arena boosts 10% (`arena_contest_actions.protocol_native_raw`, finished battles only: a cancelled
pool refunds), battle entries 5% (`arena_league_share_ledger.gross_raw / 4`: the program takes 20%
MWL and 5% protocol of the same base), sponsorships marketing 20% + protocol 10%
(`sponsorship_payments`, confirmed), Home placements (USD package price of placements an admin marked
paid; no payment reference exists), DBC referral (`dbc_fee_accruals.referral_fee`), EVM graduation
(`reward_events.route_kind = 'finalize'`; Solana graduation is stored as `trade` and was already in).
Lane values stay inside the dashboard enum (`other_approved` / `sponsorship` / `bonding_curve_fee`);
each aggregate carries a `source` label.

Production on 2026-10-04: earnings went from $68.71 to $785.47 all time (+$15.71 boosts, +$3.04
entries, +$698 Home placements on BNB). Still not countable, needs indexing:
- Import swap fee 0.5% (Solana WSOL to the operator, BNB to the protocol vault): the API never
  records a swap. Record signature + fee at build/confirm, or index transfers into the fee accounts.
- BNB / Robinhood `RouteExecuted`: production has 11 curve trades on 56/4663 and 0 `reward_events`,
  and no `rewards-router:` cursor in `indexer_state`, so the live indexer does not run the
  2026-09-26 router scan (f47cb48c). All 4 EVM mainnet coins are hidden test coins today.
- `arena_war_pool_deposits` misses stakes (battle arena-mugwhj11 has one 0.05 SOL stake recorded,
  the ledger proves two); the entries lane reads the MWL ledger instead.
- Accounting (Close, tax reserve, distributions, revenue CSV) reads the same lanes:
  `financeAccountingSources.js` `monthlyRevenue` / `revenueEventRows` call
  `sharedRevenueLanes` / `revenueLaneEvents`. Each lane is one spec (`LANE_SPECS`) that builds both
  the hourly and the per-event SQL. Production Sep / Oct 2026: Summary = Close = CSV ($67.72 /
  $717.75, CSV within $0.00001 of per-row rounding).

### Protocol forwarder flush keeper (built 2026-10-04, PR #507, not deployed)

`realtime-indexer/src/protocolForwarderKeeper.ts` calls the permissionless `flush()` on ProtocolRevenueForwarder
(BNB 56 / Robinhood 4663) so the LP protocol 20% (WBNB/WETH) reaches ProtocolRevenueVault (operator fill, overflow to
the Safe). Started from `main.ts`, own timer per chain, status in `/health` → `protocolForwarderKeeper`.

| Env | Default | |
|---|---|---|
| `PROTOCOL_FORWARDER_KEEPER` | `off` | `off` / `dry` (static call + log only) / `send` |
| `PROTOCOL_FORWARDER_ADDRESS_56`, `_4663` | unset | unset = chain skipped |
| `PROTOCOL_FORWARDER_KEEPER_PK` | unset | dedicated gas-only key, `send` only. No fallback to any other key; missing key, the deployer `0x77F96A7d…` or an `EVM_KEEPER_FORBIDDEN_ADDRESSES` entry refuses start |
| `PROTOCOL_FORWARDER_KEEPER_INTERVAL_MS` | 3600000 | min 60000 |
| `PROTOCOL_FORWARDER_MIN_FLUSH_USD` | 1 | priced with the vault's own `nativeUsdPrice()` |
| `PROTOCOL_FORWARDER_MIN_FLUSH_WEI_<id>` | 56: 0.002 BNB, 4663: 0.0005 ETH | only when the vault price is 0 |
| `PROTOCOL_FORWARDER_MAX_GAS_COST_BPS` | 500 | gas cost must be <= 5% of the value flushed |
| `PROTOCOL_FORWARDER_TICK_TIMEOUT_MS` | 60000 | bounded tick |

Fail closed per chain: forwarder `nativeSink()` must be the known vault, `admin()` the Safe, `wrappedNative()` the known
WBNB/WETH, else the chain is refused until restart. One flush in flight per chain (receipt polled next tick).
Turn on only after PF2 (router points at the forwarder): first `dry`, then `send` with a funded keeper key.
Tests: `npm run test:protocol-forwarder-keeper` (12).
