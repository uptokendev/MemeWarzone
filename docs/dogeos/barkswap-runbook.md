# DogeOS Barkswap runbook (Chikyū testnet, chain 6281971)

Deploy, wiring and canary for gen-8 on Barkswap custom pools (plan
`docs/templar/plans/2026-10-15-dogeos-barkswap-launch.md` t29-t31, spec
`docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md` section 5). Testnet and the TEST stack only.

**Every step that sends a transaction, touches Coolify or runs SQL needs the founder's explicit go first, each
time.** Nothing here is for live, production Supabase or mainnet. Keys are named by role only; their values live in
the gitignored `config/dogeos.local` and are pasted by hand. Never print, commit or paste them anywhere else.

## 1. Keys and roles (spec "Roles and keys (B9)")

| Role | Name in `config/dogeos.local` | Holds | Sends |
|---|---|---|---|
| Deployer (owner/admin of every DogeOS contract) | `DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY` (the only key `--network dogeosTestnet` loads, no fallback: `hardhat.config.ts`, `scripts/lib/dogeosNetwork.ts`) | owner of launcher, vaults, choice vault; airdrop operator (see "Open before mainnet" in `docs/claude/dogeos.md`) | deploy, wiring, activation |
| Oracle updater | `DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY` | DOGE/USD testnet oracle updater | the indexer's oracle push (`DOGEOS_ORACLE_PUSH_ENABLED`) |
| Keeper | `DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY` | **no contract role** | the permissionless keeper lanes |
| Route authority = create signer | `DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY` | the launcher's `createSigner` | nothing on chain; the TEST API signs creates with it |
| DogeOS operator | `DOGEOS_TESTNET_OPERATOR_PRIVATE_KEY` | splitter operator (`route`, and `claimRouter` through F4), choice-vault operator (`buyback`, holder batches) | route worker, choice-vault buyback |

- **The Bark keeper key and the graduation keeper key are the same key.** The env generator fills
  `DOGEOS_BARK_KEEPER_PRIVATE_KEY_6281971` with the placeholder for `DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY`
  (`scripts/dogeos-env-blocks.mjs`, indexer block). There is no separate Bark keeper key.
- **The operator key does not exist yet.** The founder generates it before the deploy and stores it in
  `config/dogeos.local` as `DOGEOS_TESTNET_OPERATOR_PRIVATE_KEY`; its public address is the deploy input
  `DOGEOS_OPERATOR_ADDRESS`. The deploy refuses an operator equal to the deployer, oracle updater, keeper, route
  authority or signer (`validateOperator`, `scripts/lib/dogeosTestnetDeployGuards.mjs`).
- The pinned public addresses of the deployer, oracle updater, keeper and route authority are
  `DOGEOS_TESTNET_ROLES` / `DOGEOS_TESTNET_ROUTE_AUTHORITY` in `scripts/lib/dogeosTestnetDeployGuards.mjs`.
- Indexer guards: the keeper key is refused when it is a deployer / updater / route authority
  (`FORBIDDEN_KEEPER_ADDRESSES`), `DOGEOS_OPERATOR_ADDRESS` (`forbiddenKeeperAddresses(env, 6281971)`) or an
  `EVM_KEEPER_FORBIDDEN_ADDRESSES` entry (`realtime-indexer/src/evm/evmGraduationKeeper.ts`). The operator key
  (`EVM_GEN8_OPERATOR_KEY_6281971`) is refused unless it is `DOGEOS_OPERATOR_ADDRESS`'s key and passes
  `assertOperatorKeyAllowed` (`realtime-indexer/src/evm/dogeosBarkKeepers.ts` `barkOperatorWallet`).

## 2. Deploy (plan t29, spec section 5 "Deployment 1")

Order: gates first, fork rehearsal, then Chikyū. Scripts: `scripts/deploy-dogeos-testnet.ts`,
`scripts/verify-dogeos-testnet.ts`, `scripts/activate-dogeos-testnet.ts`, library `scripts/lib/dogeosBarkStack.ts`,
guards `scripts/lib/dogeosTestnetDeployGuards.mjs`.

0. **Gates 0-3 passed** (plan t7, t25-t28): audit PASS, full suites, branch review, fork rehearsal with the DOGE
   budget (`scripts/rehearse-dogeos-bark-fork.ts` and report `reports/dogeos/bark-fork-rehearsal.json`, both still to be written in t27).
   Fund the deployer, keeper and operator from that budget.
1. **Build both artifact sets** (the stack refuses stale artifacts):
   `npx hardhat compile && npx hardhat --config hardhat.dogeos-bark-fork.config.ts compile`
2. **Fork rehearsal of the deploy itself** (no broadcast possible; fork block `DOGEOS_FORK_BLOCK`, default 8,578,734):
   - `npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/DogeosBarkStack.fork.spec.ts`
     (deploy + activate in one fork, every role and address read back).
   - Optionally the real script on the fork: `npx hardhat --config hardhat.dogeos-bark-fork.config.ts run
     scripts/deploy-dogeos-testnet.ts` with `DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO` and fork-local
     `DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS` / `DOGEOS_OPERATOR_ADDRESS` (fork mode `chikyu-fork`: outputs go to a temp
     dir or `DOGEOS_TESTNET_MANIFEST`, never into the repo).
3. **Chikyū deploy (founder go).** Inputs (public values only): `DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO`,
   `DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS` = the pinned route authority, `DOGEOS_OPERATOR_ADDRESS` = the operator's
   public address. Then `npm run deploy:dogeos-testnet`.
   - Refused unless the signer is the DogeOS deployer and none of `deployments/dogeos/testnet.bark.json`,
     `config/verification/dogeos-testnet-contracts.json`, `deployments/dogeos/testnet.bark.partial.json` exists.
   - The initial DOGE/USD answer and the choice-vault caps (gen-8 testnet caps re-priced to DOGE) come from Binance
     DOGEUSDT / ETHUSDT at run time.
   - The launcher lands `createPaused`.
   - **A stopped run leaves `deployments/dogeos/testnet.bark.partial.json`** with every transaction sent so far. Every
     later run refuses until the founder has checked what was deployed and removed that file by hand. There is no
     resume.
4. **Read-back and explorer verification** (L2Scan, `https://dogeos-testnet.l2scan.co`; sends no transaction;
   `DOGEOS_TESTNET_L2SCAN_API_KEY` optional):
   - `npm run verify:dogeos-testnet`: reused contracts (root 0.8.24 build, `hardhat.dogeos-verify.config.ts`).
   - `npm run verify:dogeos-bark-testnet`: the seven Bark contracts and the launcher's two libraries (0.8.26 build,
     `hardhat.dogeos-bark-verify.config.ts`).
   Both first cross-check the verification JSON against the manifest and read every address and role back
   (`readBackDogeosBarkStack`). "Already verified" counts as done; any other failure exits non-zero.
5. **Activate (founder go):** `DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO`
   `DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS=<route authority>` `npx hardhat run scripts/activate-dogeos-testnet.ts
   --network dogeosTestnet`. One call, `setCreatePaused(false)`. It refuses unless the signer owns the launcher and
   `GraduationOracle.nativeUsdPrice()` is fresh (max age 3600 s) and inside the launcher's band ($0.01-$10). If more
   than an hour passed since the deploy, the oracle push (section 3, founder go) must have updated the price first.

## 3. TEST wiring (plan t30, spec section 5 "Deployment 2")

**Env blocks.** `node scripts/dogeos-env-blocks.mjs deployments/dogeos/testnet.bark.json` prints three blocks from
the manifest: TEST frontend ("Frontend Dev", build-time `VITE_*`, rebuild after), TEST API ("Backend API Dev"), TEST
indexer ("realtime-indexer Dev"). Order: indexer, API, frontend. The script reads only the manifest, refuses
`*.local` and `.env*` inputs, and every key value it prints is a `<paste NAME from config/dogeos.local>` placeholder.
Each Coolify change needs its own go. Names it sets (values come from the manifest):

- Frontend: `VITE_PUBLIC_RPC_6281971`, `VITE_EVM_GEN8_{LAUNCHER,PLUGIN,LENS,ESCROW,CHOICE_VAULT,RESERVE_LOCK}_6281971`,
  the reused-vault and graduation-oracle `VITE_*_6281971` names; `VITE_ALLOWED_CHAIN_IDS` is an append (`,6281971`),
  never a full value.
- API: `DOGEOS_RPC_HTTP_6281971`, `EVM_GEN8_{LAUNCHER,PLUGIN,SPLITTER}_6281971` (`0xaddr@startBlock`),
  `EVM_GEN8_{LENS,CHOICE_VAULT,RESERVE_LOCK,ESCROW}_6281971`, `REWARD_DISTRIBUTOR_ADDRESS_6281971`, and
  `ROUTE_AUTHORITY_PRIVATE_KEY` = the route-authority key (it replaces the TEST API's global route key). Check after:
  `GET /api/routing/status?chainId=6281971` → `signerConfigured true`, `matchesOnchain true`.
- Indexer: the same gen-8 names, `DOGEOS_OPERATOR_ADDRESS`, every keeper flag `false`, `DOGEOS_BARK_SEND_6281971=false`,
  the two key placeholders, the DOGE/USD oracle address, `DOGEOS_ORACLE_PUSH_ENABLED=false` and the updater key
  placeholder. The gen-8 loops (and with them the keepers) start only when `EVM_GEN8_LAUNCHER_6281971` and
  `EVM_GEN8_PLUGIN_6281971` are both set (`realtime-indexer/src/evm/evmGen8Worker.ts`).
- Money ingestion on DogeOS reads to 20 blocks below `latest` (`GEN8_MONEY_DEPTH`, founder 2026-10-15;
  `EVM_GEN8_MONEY_DEPTH_6281971` is clamped to at least 17, Chikyū's max reorg); display rows follow `latest`
  (`realtime-indexer/src/evm/evmGen8Config.ts`). Fee accruals, route rows and the holder census therefore lag the
  coin page by about 20 blocks.

**Staging migration.** The founder runs `database/staging_apply_dogeos_barkswap.sh`. It applies
`db/migrations/20261010_000020_dogeos_chain_launch_path.sql` then `db/migrations/20261015_000010_dogeos_barkswap.sql`
as one transaction, only against staging `vrnsbguutnwgtekcexls` (refuses production `ellkfgoxnzykxqybajtn`), with
`STAGING_DATABASE_URL` from the environment or `frontend/.env.local`:

- `bash database/staging_apply_dogeos_barkswap.sh dryrun`: runs everything, then ROLLBACK (the default mode).
- `bash database/staging_apply_dogeos_barkswap.sh apply`: COMMIT.

20261015 creates `evm_gen8_bark_sell_fees` and `evm_gen8_bark_credits`, adds one index on `evm_gen8_fee_accruals` and
adds the side-pool venue `'algebra'` to `evm_gen8_side_pools_venue_chk`. Additive and idempotent.

**Keepers** (`realtime-indexer/src/evm/dogeosBarkKeepers.ts`, run inside the TEST indexer, 6281971 only). Every lane
is off by default. With its flag on, a lane simulates and logs (dry run, nothing signed) until
`DOGEOS_BARK_SEND_6281971=true`. A dry run simulates from the key's address, so a lane without its key logs
`skip: no <role> key`; the route lane dry-runs without a signer. Each flag and the send switch need a go.

| Lane | Key | Flag | What it calls |
|---|---|---|---|
| collect | keeper | `DOGEOS_BARK_COLLECT_ENABLED_6281971` | `launcher.collect(coin)` when uncollected DOGE fees reach `DOGEOS_BARK_COLLECT_MIN_WEI` (0.1 DOGE) or coin fees can convert; `launcher.convert(coin)` once its 10 min interval allows; `choiceVault.pull(coin)` when a choice coin's creator balance reaches `DOGEOS_BARK_PULL_MIN_WEI` (0.1 DOGE) |
| gradFee | keeper | `DOGEOS_BARK_GRAD_FEE_ENABLED_6281971` | `launcher.takeGraduationFee(pool)` for a graduated coin whose fee the plugin's inline call did not take |
| reserve | keeper | `DOGEOS_BARK_RESERVE_ENABLED_6281971` | `MwzBarkReserveLock.release(coin)` once 1 h has passed since graduation |
| adminWatch | keeper | `DOGEOS_BARK_ADMIN_WATCH_ENABLED_6281971` | reads `plugin()`, `globalState()`, `tickSpacing()` of each pool; alerts on any change; `launcher.restore(coin)` for plugin / lastFee / plugin config (community fee and tick spacing: alert only) |
| sidePools | none (read only) | `DOGEOS_BARK_SIDE_POOLS_ENABLED_6281971` | `runBarkSidePoolWatcherOnce` (`evmGen8SidePools.ts`): Barkswap `Pool` / `CustomPool` and MuchFi factory, alerts |
| route | operator | `DOGEOS_BARK_ROUTE_ENABLED_6281971` | `runGen8RoutePass` on the Barkswap venue: `launcher.claimRouter` then `splitter.route` (and `payParkedRouter`), every `DOGEOS_BARK_ROUTE_INTERVAL_MS` (1 h) |
| buyback | operator | `EVM_CREATOR_CHOICE_ENABLED_6281971` | `MwzBarkCreatorChoiceVault.buyback(coin, amount)` at the coin's secret moments; needs `EVM_BUYBACK_SEED_SECRET`; sized to the vault caps, never below `EVM_BUYBACK_MIN_WEI_6281971` |

- **`DOGEOS_BARK_SIDE_POOLS_ENABLED_6281971` stays off until 20261015 is applied on staging**: the watch writes venue
  `'algebra'`, which the old `evm_gen8_side_pools_venue_chk` refuses.
- A lane also turns itself off (logged at start) when what it needs is missing: `EVM_GEN8_LENS_6281971` (collect,
  gradFee, reserve), `EVM_GEN8_RESERVE_LOCK_6281971`, `EVM_GEN8_SPLITTER_6281971` (route),
  `EVM_GEN8_CHOICE_VAULT_6281971` or `EVM_BUYBACK_SEED_SECRET` (buyback), or a key its guard refuses.
- The keeper key may send only `collect`, `convert`, `restore`, `takeGraduationFee`, `release`, `pull`; the operator
  key only `claimRouter`, `payParkedRouter`, `route`, `buyback`, `executeHolderBatch`, `proposeHolderBatch`
  (`BARK_KEEPER_CALLS` / `BARK_OPERATOR_CALLS`). One transaction per key at a time.
- Intervals (floor 60 s): `DOGEOS_BARK_KEEPER_POLL_MS` 300000, `DOGEOS_BARK_ADMIN_WATCH_MS` 180000,
  `DOGEOS_BARK_BUYBACK_POLL_MS` 60000, `DOGEOS_BARK_ROUTE_INTERVAL_MS` 3600000.
- Suggested switch-on order: adminWatch and sidePools (read-mostly), then collect / gradFee / reserve dry run, then
  send, then route and buyback with the operator key.

## 4. Canary (plan t31, spec section 5 "Deployment 3")

One coin graduated by 5+ buyer wallets the founder funds, through the TEST app. Record each tx hash in
`reports/dogeos/bark-canary.json`. After each step:

1. **Create** (TEST app create page; the API signs with the route authority). Check: `Launched` and the plugin's
   `PoolRegistered`; gas ≤ 7M; the pool's `plugin()` is ours, `globalState()` lastFee 0, plugin config 135, community
   fee 30, `tickSpacing()` 10; `MwzBarkReserveLock.reserves(coin)` holds 20M coins; the indexer writes the
   `evm_gen8_pools` row (`hook_address` = plugin, `pool_manager_address` = pool) and the coin page shows the coin.
2. **Buy** (5+ wallets, in the launch window). Check: `BarkSwap` events; `curve_trades` rows with
   `execution_source 'gen8_v4'`, trader = `tx.from`; buy fee rows in `evm_gen8_fee_accruals` about 20 blocks later;
   the lens `progress(coin)` advances.
3. **Sell.** Check: a `evm_gen8_bark_sell_fees` row per sell; the price never ends below the start price (F2).
   Then buy through graduation: `Graduated`, `GraduationFeeTaken` (inline, or by the gradFee lane), `curve_trades`
   up to and including the crossing swap and `dex_trades` after it.
4. **Collect / convert** (collect lane or by hand; both permissionless). Check: `FeesCollected`, then
   `CoinFeesConverted`; the lens `owed(coin)` books move; the conversion swap writes no trade and no accrual row; the
   attribution replay restates the sell-fee rows' converted amounts and writes one `evm_gen8_bark_credits` row per
   DOGE amount a launcher log credited to the router bucket.
5. **Route run** (route lane, operator key). Check: `RouterClaimed` and the splitter's `Routed`; the run's
   `expectedPaid` is `launcher.routerPaid(splitter)` and its `evm_gen8_route_runs` row set is the matching credits;
   the vault balances grow.
6. **Claims.** Creator: `launcher.claimCreator` → `CreatorClaimed` (for a choice-vault coin: `pull` then
   `claimCreatorFees`). Reserve: 1 h after graduation, `release` → `ReserveReleased`. Escrow: a buy → `EscrowBuy`
   (its `claim` pays only once the vesting schedule has vested a tranche). A buyback-choice coin → `Buyback`. Then the
   coin page shows the graduated coin trading on Barkswap.

## 5. Measured reference and known gaps

- Launch gas: worst measured **6,293,026** (buyback choice + creator first buy, t8 fork), gate 7M
  (`test/dogeos/barkswap/BarkLaunch.fork.spec.ts` asserts ≤ 7M; the app's gas floor note,
  `frontend/src/lib/evmGen8Client.mjs`).
- Other steps (t9 fork run, printed, not asserted): collect 180-409k, convert 180-240k, route 114-338k,
  claimRouter 55-109k.
- Rounding: collected minus plugin-booked fees, per swap per book, is at most 1 wei against us and up to 45 wei in
  our favour in the fork setup ($0.10 DOGE, $150 target, block 8,578,734); it scales with liquidity and price
  (`MEASURED_TOLERANCE_WEI`, `MEASURED_AGAINST_US_WEI` in `test/dogeos/barkswap/fixtures/barkBooks.ts`). The excess
  goes to router post, never to a creator book.

Known gaps (accepted):

- **Escrow refund branch** (`MwzBarkCreatorEscrow.buy`, refund of an unfilled part): unreachable on a real pool (it
  would need about 3e42 wei to drain range B). Only a mock-pool unit test could reach it; none is written.
- **Buyback moments are seeded at lane start.** The used-moment set is in memory; on (re)start each coin's set is
  seeded with the moment already due, so a restart skips that moment rather than firing it twice
  (`runBarkBuybackPass`).
- **Reserve-lock events are stored with `contract_kind` `gen8_choice_vault`** in `evm_campaign_events`
  (`realtime-indexer/src/evm/evmGen8Bark.ts` `applyBarkEvent`): a label only, no reader depends on it.
