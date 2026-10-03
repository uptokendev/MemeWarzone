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
