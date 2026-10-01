# Go-live runbook: all chains, one release

For the founder (every send runs from your terminal, every env change in Coolify) and the Safe signers
(every admin call on BNB and Robinhood is a Safe batch). Written 2026-10-01 from `release/all-chains`
at `f4a88c90`. Nothing in this document has been sent.

This runbook puts the two detailed runbooks in one order. They stay the reference for exact read-backs:

- Solana DBC: `docs/dbc/release/SOLANA_DBC_GO_LIVE.md`
- EVM generation 6/5: `docs/evm-launch/release/EVM_GEN6_GO_LIVE.md` (section numbers below written as "EVM 2.3" point there)

Facts marked "read 2026-10-01" were read today, read only, from chain (`cast call`) or from the
production and staging databases (`BEGIN READ ONLY`). Anything not checked is marked **to verify** and
collected in section 6.

## 0. What goes live

### 0.1 The release

| Part | What users get | Where it runs |
|---|---|---|
| Solana DBC | A new Solana launch type on Meteora's Dynamic Bonding Curve: tradable on Jupiter and Phantom from the first block, creator fee choice (keep, holders, split, buyback and burn), graduation into a locked Meteora DAMM v2 pool. The existing Solana launchpad is untouched. | Meteora's programs; our API, indexer workers, app. No Solana program upgrade is part of this release. |
| EVM generation 6/5, BNB (56) | New factory, campaign, router V4, creator vault V2: creator 5.6%, 60 s anti-sniper fee, creator first buy, creator buy escrow, graduation split 2.2 / 19.8 / 78, fee choice on every coin | New contracts, Safe-owned |
| EVM generation 6/5, Robinhood (4663) | The same, graduating into Uniswap V3 0.30%; stock-paired coins through the V2 stock adapter | New contracts, Safe-owned |
| Live fixes | Everything already on the live branch plus the fixes merged into the release (graduated Solana buys, payout bounds, locker gas, route configuration through the Safe, E18 airdrop cooldown and others) | API, indexer, app |

Branch: `release/all-chains`. The live branch `build/cross-chain-stabilization-rh-base` is an ancestor of it
(checked 2026-10-01: `git merge-base --is-ancestor` succeeds, 0 live commits missing), so going live is a
fast-forward, not a merge.

### 0.2 Decisions in force

| # | Decision | What it means for this runbook |
|---|---|---|
| E14 | The current factories stay open until the new generation replaces them | Old creation closes only in the opening session, never days before |
| E16 | No paid external audit; internal adversarial audit instead, damage bounded by the E15 caps and the Safe | Every Safe batch is decoded and re-encoded before signing (section 2.9) |
| E17 | Testnet runs by Claude with the testnet deployer; mainnet founder-only | Every mainnet send in this document is yours |
| E20 D1 | The creator-choice worker gets its own new operator key, not the payout operator `0xdcf07EB0…` | Create it in T-minus; batch B sets it |
| E20 D2 | On opening day create is paused on the old factories: BNB `0x632061cA…` and `0xc378221E…`, Robinhood `0x35E93D0b…`. Existing coins keep trading | Batch A pauses `0x632061cA…` / `0x35E93D0b…`; batch H on BNB adds `0xc378221E…` |
| E20 D3 | Batch A (the router switch) and the opening happen on the same day, back to back | One session per chain, BNB first |
| E21 | One combined release from `release/all-chains` | This document |

### 0.3 What is on chain today (read 2026-10-01)

| | BNB 56 | Robinhood 4663 |
|---|---|---|
| Safe (2 of 3) | `0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7` | same address |
| Deployer | `0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714`, 0.0294 BNB | same, 0.00406 ETH |
| Current factory | `0x632061cA786f7B585Bbd46A792FDA92B02f70671`, 0 campaigns, `createPaused` false | `0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA`, 0 campaigns, `createPaused` false |
| Older factory | `0xc378221E57898106079aE4B818a92978e4cd9559`, 1 campaign, `createPaused` false | none |
| Current router (V3) | `0xe635AA43fE5707561c8c3C655225da5C3e4C2239` | `0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb` |

Addresses collide across chains (same deployer, same nonces): `0x632061cA…` is the BNB factory and the
Robinhood protocol vault; `0xe635AA43…` is the BNB router and the Robinhood oracle. Always pair an address
with its chain.

Database (read 2026-10-01): production and staging both have **none** of this release's tables yet
(0 `dbc_*` tables, no `evm_holder_batches`, no `evm_graduation_keeper_jobs`, no `curve_trades.fee_raw`).

## 1. T-minus: preparation (days before, nothing visible to users)

Everything in this section is invisible to users: new keys, new token accounts, contracts nobody routes
to yet, a local rehearsal. Tick each box.

### 1.1 Keys

None of these is the deployer, and none may be a Safe owner. The EVM keeper and worker refuse the
deployer and the Safe at start.

| Chain | Key / secret | What it does | Fund with | Create with |
|---|---|---|---|---|
| Solana | DBC collector | Partner fee claimer on every DBC pool; routes fees into the vaults; pays creator pots; runs graduations | ~0.5 SOL | `solana-keygen new -o ~/.config/memewarzone/dbc-collector.json` |
| Solana | DBC config payer | Creates the DBC configs (one per target, price step and quote, ~0.006 SOL each) | ~0.3 SOL | `solana-keygen new -o ~/.config/memewarzone/dbc-config-payer.json` |
| Solana | DBC referral owner | Owns the referral token accounts (20% of Meteora's cut on our site's trades). Never claims | ~0.05 SOL | `solana-keygen new -o ~/.config/memewarzone/dbc-referral-owner.json` |
| Solana | DBC buyback seed | 32 random bytes, not a wallet. Picks the secret buyback and snapshot moments | none | `openssl rand -hex 32` |
| EVM | Graduation keeper | Sends `graduate`, pool repair, native fallback, LP `harvest` (permissionless calls only) | 0.02 BNB, 0.005 ETH | `cast wallet new --json > ~/.config/memewarzone/mwz-evm-graduation-keeper.json && chmod 600 ~/.config/memewarzone/mwz-evm-graduation-keeper.json` |
| EVM | Creator-choice operator (new, D1) | The creator vault's `operator()`: holder batches, buybacks, quote conversions | 0.02 BNB, 0.005 ETH | `cast wallet new --json > ~/.config/memewarzone/mwz-evm-creator-choice-operator.json && chmod 600 ~/.config/memewarzone/mwz-evm-creator-choice-operator.json` |
| EVM | API internal secret | Authenticates the worker's buyback call to the API | none | `openssl rand -hex 32` |
| EVM | EVM buyback seed | Same role as the Solana seed, for EVM coins | none | `openssl rand -hex 32` |

One EVM address serves both chains for the keeper and for the operator. Keep the four secrets in your
password manager; they go into Coolify on the day (section 2.2), never into git or a chat.

- [ ] Eight keys and secrets created, files chmod 600
- [ ] Solana keys funded; check with `solana balance <pubkey> --url <mainnet rpc>`
- [ ] EVM keeper and operator funded on both chains; check with `cast balance <address> --ether --rpc-url <rpc>`

### 1.2 Solana referral token accounts

One per quote, owned by the referral owner. SOL uses our script (a dedicated WSOL account, not the ATA a
claim would close); USDC, USDT and the xStocks are plain accounts. Exact commands: DBC runbook section 1.

```
SOLANA_RPC_URL=<mainnet rpc> DBC_REFERRAL_OWNER_KEYPAIR="$(cat ~/.config/memewarzone/dbc-referral-owner.json)" \
  node scripts/dbc/create-referral-account.mjs          # dry run, then add --send
```

Write the result as one JSON map, quote mint to referral account:
`{"So11111111111111111111111111111111111111112":"<wsol ref>","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v":"<usdc ref>", …}`.
It goes into two env vars on the day (app and indexer).

- [ ] Six referral accounts exist (`spl-token accounts --owner <referral owner>`), JSON map written down

### 1.3 Deployer funding

| Chain | Needed for the whole EVM deploy (fork measurement) | Balance read 2026-10-01 | Action |
|---|---|---|---|
| BNB | 0.00162 BNB (20 transactions) | 0.0294 BNB | enough |
| Robinhood | 0.00082 ETH (25 transactions) | 0.00406 ETH | top up to 0.01 ETH if the gas price is above 0.05 gwei on the day |

Canary money comes from your own wallet: about 0.05 BNB, 0.02 ETH and 0.1 SOL.

- [ ] Both deployer balances re-read the day before

### 1.4 Fork rehearsal (re-run the day before)

It runs the whole EVM deploy, batch H and one coin to graduation and harvest on a local copy of each
mainnet, with the real Safe and the real deployer impersonated. No key is used. Accepted on both chains
on 2026-10-01 (EVM 0.7).

```
npx hardhat compile
BSC_MAINNET_RPC=<paid BSC RPC> npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network bscForkRehearsal
ROBINHOOD_MAINNET_RPC_URL=<paid RH RPC> npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network robinhoodForkRehearsal
```

Pass means the script exits 0 and `deployments/fork-rehearsal/<network>/rehearsal-report.json` says accepted.

- [ ] BNB fork rehearsal accepted
- [ ] Robinhood fork rehearsal accepted

### 1.5 Keep the old deployment records

The generation scripts write to the paths that hold today's generation. On the release branch, one commit
(EVM 0.8):

```
git mv deployments/bnb/mainnet.quote-generation.json deployments/bnb/mainnet.quote-generation.gen4.json
git mv deployments/robinhood/mainnet.quote-generation.json deployments/robinhood/mainnet.quote-generation.gen4.json
git mv deployments/robinhood/mainnet.stock-campaign-implementation.json deployments/robinhood/mainnet.stock-campaign-implementation.gen4.json
git mv deployments/robinhood/mainnet.R5-stock-campaign-implementation.safe-batch.json deployments/robinhood/mainnet.R5-stock-campaign-implementation.gen4.safe-batch.json
```

Required on Robinhood: the stock implementation script refuses while its old record exists.

- [ ] Records moved and committed on `release/all-chains`

### 1.6 EVM fees stack, per chain (deployer; invisible)

What can be deployed ahead: `TreasuryRouterV4`, `CreatorRewardsVaultV2` and the holder `RewardDistributor`.
Nothing routes to them until batch A, so users see nothing. The script also writes batch A for the day.

**The factory itself cannot be deployed ahead.** The generation script refuses a router whose vaults are
unset (`assertRouterCanServeStrictRouting`, `assertCreatorVaultServesGeneration`), and those vaults are set
by batch A, which also pauses the old factory and switches the community vault. So the factory, batch B,
the ownership handover and R5 move into the opening session (section 2.7). This is the order the fork
rehearsed. An alternative that deploys the factory ahead is in section 6, item 1; it has not been rehearsed.

BNB (EVM 2.1):

```
export BSC_MAINNET_RPC=<paid BSC RPC>
export DEPLOYER_PK=<deployer key>
cast chain-id --rpc-url "$BSC_MAINNET_RPC"            # must print 56
env | grep -E '^BNB_FORK_RPC='                        # must print nothing
CONFIRM_EVMGEN_FEES_DEPLOY=I_UNDERSTAND_MAINNET \
EVMGEN_BUYBACK_MAX_PER_TX=0.65 EVMGEN_BUYBACK_MAX_PER_CAMPAIGN_WEEK=6.5 \
EVMGEN_BUYBACK_MIN_INTERVAL_SECONDS=21600 EVMGEN_BUYBACK_MAX_IMPACT_BPS=50 \
EVMGEN_HOLDER_MAX_PER_WEEK=32 EVMGEN_HOLDER_BATCH_AUTH_MAX=32 \
  npx hardhat run scripts/deploy-evm-treasury-router-v4.ts --network bscMainnet
```

Robinhood (EVM 2.6): the same with `ROBINHOOD_MAINNET_RPC_URL`, `ROBINHOOD_MAINNET_DEPLOYER_PRIVATE_KEY`,
`cast chain-id` printing 4663, `--network robinhoodMainnet` and the ETH caps `0.19 / 1.9 / 21600 / 50 / 9.3 / 9.3`.

How to check: run the read-backs in EVM 2.1 (router admin is the Safe, `CREATOR_TRADE_BPS` 560, vault
`router()` is the new router, distributor owner is the Safe). Commit
`deployments/<chain>/mainnet.evmgen-fees.json` and the batch A file. Never run the fees script twice on a
chain: it has no resume and would deploy a second stack.

- [ ] BNB fees stack deployed, read back, record committed
- [ ] Robinhood fees stack deployed, read back, record committed

### 1.7 Explorer verification of the fees stack

```
ONLY=TreasuryRouterV4,CreatorRewardsVaultV2,RewardDistributor npx hardhat run scripts/verify-mainnet-contracts.ts --network bscMainnet
ONLY=TreasuryRouterV4,CreatorRewardsVaultV2,RewardDistributor node scripts/sourcify-verify.mjs 4663
```

Add each contract with its constructor arguments to `config/verification/mainnet-contracts.json` first
(table in EVM 4). How to check: BscScan and the Robinhood explorer show the source as verified.

- [ ] Fees stack verified on both explorers

### 1.8 Signers and the day

- [ ] Two of the three Safe owners booked for the whole opening session (BNB then Robinhood, several hours)
- [x] `docs/release/all-chains-migrations.sql` applied on staging and production (2026-10-01, see 2.1)
- [ ] Coolify: know which resources auto-deploy on a push to the live branch (section 6, item 2)

## 2. Go-live day, in order

Each step can stop without harm until 2.7. Tick the box only after the check under it passes.

### 2.1 Production database

**Done 2026-10-01.** The founder ran the bundle on staging and production; read back the same day on both:
20 new `dbc_*`/`evm_*` tables, keeper action check with `harvest`, vote battles 1/6/12/24/48 h,
`campaign_drafts.dbc_quote_mint` present. Skip this step on the day.

Run `docs/release/all-chains-migrations.sql` once in the Supabase SQL editor on production
(`ellkfgoxnzykxqybajtn`). It holds, in order:

| Files | What they add |
|---|---|
| `20260929_000001` .. `000011` (DBC, same content as `docs/dbc/release/dbc-solana-migrations.sql`) | DBC configs, launch type, drafts, creator locks, trade venue, fee accruals, graduation, creator choice, quote binding, payout quote |
| `20260930_000001` .. `20260930_300002` (seven files, `db/migrations/`) | EVM generation indexing, keeper jobs, DEX quote leg, draft launch options, keeper observations and harvest, creator-choice tables |

`20261001_000001_arena_vote_battle_48h` is already applied on production and is not in the bundle.
Every file is `if not exists` style, so a second paste is harmless.

How to check (read only, run in the same editor):

```
select (select count(*) from information_schema.tables where table_schema='public' and table_name like 'dbc\_%') as dbc_tables,
       to_regclass('public.evm_holder_batches') as holder_batches,
       to_regclass('public.evm_graduation_keeper_jobs') as keeper_jobs,
       (select count(*) from information_schema.columns where table_name='curve_trades' and column_name in ('fee_raw','league_excluded')) as curve_cols;
```

Before: `0, null, null, 0` (read 2026-10-01). After: 11 or more DBC tables, both regclasses filled, `2`.

- [ ] Bundle applied on production, check passes

### 2.2 Service env, everything off or dry run

Set these in Coolify before the fast-forward, so each service comes up with the new code already closed.
The EVM factory, locker and registry addresses do not exist yet; they are set in the opening session (2.7).
Names only below; values come from section 1 and the deployment records.

API (`api.memewar.zone`):

| Name | Value now | Later |
|---|---|---|
| `DBC_LAUNCH_ENABLED` | `false` | `true` at opening (2.8) |
| `CREATE_CANARY_WALLETS` | unset | your wallets in 2.5, removed at opening (2.8) |
| `DBC_FEE_COLLECTOR` | collector public key | |
| `DBC_CONFIG_PAYER_SECRET` | config payer keypair JSON | |
| `RUNTIME_ENVIRONMENT` | `production` (Solana drafts refuse without it) | |
| `SOLANA_CLUSTER` | `mainnet-beta` (already set) | |
| `JUPITER_API_KEY` | optional | |
| `EVM_CREATOR_VAULT_V2_56`, `EVM_CREATOR_VAULT_V2_4663` | the vaults from 1.6 | |
| `EVM_CREATOR_CHOICE_API_SECRET` | the API internal secret | |
| `FACTORY_ADDRESS_<id>`, `VITE_FACTORY_ADDRESS_<id>`, `FACTORY_START_BLOCK_<id>`, `SUPPORTED_FACTORY_*_<id>` | unchanged (old factory) | new factory in 2.7 |

Indexer (`indexer.memewar.zone`; the DBC workers, the EVM keeper and the creator-choice worker run inside it):

| Name | Value now | Later |
|---|---|---|
| `DBC_FEE_COLLECTOR_SECRET`, `DBC_REFERRAL_OWNER_SECRET` | keypair JSON | |
| `DBC_REFERRAL_TOKEN_ACCOUNTS` | the JSON map from 1.2 | |
| `DBC_BUYBACK_SEED_SECRET` | the Solana seed | |
| `DBC_FEE_ROUTING_ENABLED` / `DBC_FEE_ROUTING_SEND` | `true` / `false` | `_SEND=true` in 2.10 |
| `DBC_GRADUATION_ENABLED` / `DBC_GRADUATION_SEND` | `true` / `false` | same |
| `DBC_CREATOR_CHOICE_ENABLED` / `DBC_CREATOR_CHOICE_SEND` | `true` / `false` | same |
| `EVM_GRADUATION_KEEPER_ENABLED_56` / `_4663` | `false` | `true` per chain in 2.7 |
| `EVM_GRADUATION_KEEPER_SEND` | `false` | `true` in 2.10 (one flag for every enabled chain) |
| `EVM_GRADUATION_KEEPER_PRIVATE_KEY` | keeper key | |
| `EVM_CREATOR_CHOICE_ENABLED_56` / `_4663` | `false` | `true` per chain in 2.7 |
| `EVM_CREATOR_CHOICE_SEND` | `false` | `true` in 2.10 (one flag for every enabled chain) |
| `EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY` | operator key (D1) | |
| `EVM_BUYBACK_SEED_SECRET` | the EVM seed | |
| `EVM_CREATOR_CHOICE_API_URL` / `EVM_CREATOR_CHOICE_API_SECRET` | `https://api.memewar.zone` / the API internal secret | |
| `EVM_HOLDER_CLAIM_WINDOW_DAYS` | `60` | |
| `EVM_CREATOR_VAULT_V2_<id>`, `TREASURY_ROUTERS_EXTRA_<id>` | `<address>@<deploy block>` from 1.6 | |
| `EVM_GEN5_LP_LOCKERS_<id>`, factory names as on the API | unchanged | new values in 2.7 |
| `JUPITER_API_KEY` | optional | |

Leave `EVM_KEEPER_HARVEST_MIN_GAS` at its default (2,000,000). A lower value makes harvests revert.

App (`app.memewar.zone`; `VITE_*` are baked in at build time, so every change needs an app redeploy):

| Name | Value now | Later |
|---|---|---|
| `VITE_DBC_LAUNCH_ENABLED` | `false` | `true` at opening (2.8) |
| `VITE_DRAFT_PUSH_LIVE_ENABLED` | `true` (draft and scheduled launches) | |
| `VITE_RUNTIME_ENVIRONMENT` | `production` | |
| `VITE_DBC_REFERRAL_TOKEN_ACCOUNTS` | the JSON map from 1.2 | |
| `VITE_FACTORY_ADDRESS_<id>`, `VITE_SUPPORTED_FACTORY_*_<id>`, `VITE_TREASURY_ROUTER_ADDRESS_<id>`, `VITE_PERMANENT_LP_LOCKER_ADDRESS_<id>`, `VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_<id>`, `VITE_CREATOR_REGISTRY_ADDRESS_4663`, `VITE_RISK_REGISTRY_ADDRESS_4663` | unchanged | new values in 2.7 |

Checked against the Coolify env files on 2026-10-01 (names only): none of the `DBC_*`, `EVM_*` or
`VITE_DBC_*` names exist on the services yet; `VITE_DRAFT_PUSH_LIVE_ENABLED` and `VITE_RUNTIME_ENVIRONMENT`
are also missing on the app.

- [ ] API env set
- [ ] Indexer env set, including `ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_4663` (SwapRouter02
  `0xCaf681a66D020601342297493863E78C959E5cb2`). Without it the indexer records router 0x0 for graduated
  Robinhood pools; the app now ignores a 0x0 router, but set it so every reader gets the right one
  (found by the release browser test, 2026-10-01).
- [ ] App env set

### 2.3 Fast-forward the live branch

```
git fetch origin
git merge-base --is-ancestor origin/build/cross-chain-stabilization-rh-base origin/release/all-chains && echo FAST-FORWARD-OK
git push origin origin/release/all-chains:build/cross-chain-stabilization-rh-base
```

The push has no `--force`: if the live branch moved since the check, git refuses and nothing changes.
Re-run the check and ask why it moved before going on.

Coolify redeploys from the live branch. Order: **indexer, then API, then app**. If all three redeploy at
once on the push, that is acceptable because every flag is off; otherwise redeploy them by hand in that
order (section 6, item 2).

- [ ] Live branch fast-forwarded
- [ ] Indexer, API, app redeployed

### 2.4 Smoke checks

| Service | Check | Expect |
|---|---|---|
| API | `curl -s https://api.memewar.zone/health` | `sourceCommit` = the release head |
| API | `curl -s https://api.memewar.zone/api/dbc/launch-config` | `disabled: true`, `featureFlag: "DBC_LAUNCH_ENABLED"` |
| Indexer | `curl -s https://indexer.memewar.zone/health` | `sourceCommit` = the release head |
| Indexer log | DBC | `[dbcIndexer] enabled`, `[dbc-fee] enabled { send: false … }`, `[dbc-grad] enabled`, `[dbc-5b] enabled { send: false … }` |
| Indexer log | EVM | `[evm-choice] disabled (set EVM_CREATOR_CHOICE_ENABLED_<chainId>=true)`; no `[evm-grad] enabled` yet |
| App | open `https://app.memewar.zone`, a BNB, a Robinhood and a Solana coin page, the Create page | pages load; Solana create shows no DBC option; EVM create still uses the old factories |
| Existing coins | a small buy on an existing Solana launchpad coin | works as before |

- [ ] All smoke checks pass

### 2.5 Solana DBC canary

The API holds creation to the launch team while `CREATE_CANARY_WALLETS` is set (comma-separated creator
wallets; EVM any case, Solana exact). Every create path (DBC, Solana launchpad, EVM direct, scheduled arm,
BNB quote, Robinhood stock) answers 403 `CREATE_CANARY_ONLY` to any other wallet; drafts still save.

- API: set `CREATE_CANARY_WALLETS=<your Solana wallet>,<your EVM 6 wallet>` and redeploy before step 1;
  `GET /api/launch-status` returns `{"canary":true}`.
- App: nothing to set; the Create page shows a "Launches open soon" banner while the API reports canary.
- Indexer and workers: nothing to set.

1. API `DBC_LAUNCH_ENABLED=true`, app `VITE_DBC_LAUNCH_ENABLED=true`; redeploy API, then app.
2. Launch one coin on the site: SOL pairing, $15K, fee choice keep. One wallet signature.
3. After 60 s, buy 0.02 SOL and sell half from the token page.
4. In Jupiter or Phantom's swap, search the coin by address: it routes on the curve.
5. Indexer log: the trades are indexed, the fee accrual appears, `[dbc-fee]` logs a dry-run route.

If anything is wrong: set both flags back to `false` and redeploy (section 4). Otherwise leave them on;
DBC stays limited to the canary wallets until `CREATE_CANARY_WALLETS` is removed at the public opening (2.8).

- [ ] DBC canary coin launched, traded, routed on Jupiter, indexed

### 2.6 Opening session: overview (D3)

One session per chain, BNB first, Robinhood second. Two Safe signers present throughout. On each chain,
EVM creation on the site is closed from batch A until batch H (the old factory is paused by A, the new one
opens with H). That window is the length of the session; on the fork it was minutes of script time, on
mainnet it is mostly waiting for signatures.

| Step | Who | What it does | Opens anything? |
|---|---|---|---|
| Batch A | Safe | Old factory create paused (D2); router V4 vaults set; community vault switched to V4 (the router switch); holder distributor; operator; E15 caps | closes old creation |
| Generation | deployer | New factory, campaign implementations, locker, graduation adapters; everything create-paused | no |
| Batch B | Safe | Locker on router V4, vault pinned to the factory, launch recorder, adapter binds, D1 operator | no |
| Ownership | deployer | Factory (Robinhood also both registries) to the Safe | no |
| R5 (Robinhood only) | deployer, then Safe | Stock campaign implementation bound; must land before any coin exists | no |
| Batch Q (Robinhood, optional before H) | Safe | Nine stock routes | stock bindings only |
| Explorer verification | you | Source of every new contract | no |
| Env + redeploy | you | Services point at the new factory | no |
| Batch H | Safe | `enableLive` and `setCreatePaused(false)` on the new factory; BNB also pauses `0xc378221E…` (D2) | yes |
| EVM canary | you | One coin | |

### 2.7 Opening session, per chain

Run everything for BNB, then everything for Robinhood.

**A. Batch A (Safe).** File `deployments/<chain>/mainnet.evmgen-fees.A.safe-batch.json`, 10 calls, listed
in EVM 2.2. Check it with section 2.9, sign, execute. How to check after: old factory `createPaused()` is
true, community vault `router()` is the new router, vault `limits()` shows the E15 caps (EVM 2.2 read-backs).

- [ ] BNB batch A executed and read back
- [ ] Robinhood batch A executed and read back

**B. Generation (deployer).** BNB: EVM 2.3 (`deploy-bnb-quote-generation.ts` with
`BNB_TREASURY_ROUTER=<router V4>`). Robinhood: EVM 2.8 (`deploy-robinhood-quote-generation.ts`, every
`RH_*` value listed there). How to check: `FACTORY_GENERATION` 6, `CAMPAIGN_GENERATION` 5, `createPaused`
true, `live` false, `campaignsCount` 0, fee recipient and league receiver both the new router.

- [ ] BNB generation deployed and read back
- [ ] Robinhood generation deployed and read back

**C. Batch B (Safe).** Build it without deploying anything, with the D1 operator:

```
EVMGEN_BATCHES_ONLY=1 EVMGEN_VAULT_OPERATOR=<creator-choice operator address> \
  npx hardhat run scripts/deploy-evm-treasury-router-v4.ts --network bscMainnet        # robinhoodMainnet for 4663
```

Check with 2.9, sign, execute. How to check after: locker authorized and primary on the router, vault
`factory()` is the new factory, vault `operator()` is the D1 key (EVM 2.4, 2.9).

- [ ] BNB batch B executed and read back
- [ ] Robinhood batch B executed and read back

**D. Ownership to the Safe (deployer).** EVM 2.5; on Robinhood `OWNABLE_CONTRACTS=<factory>,<CreatorRegistry>,<RiskRegistry>`.
How to check: `owner()` is the Safe on each.

- [ ] BNB ownership handed over
- [ ] Robinhood ownership handed over

**E. Robinhood only: R5 and batch Q.** `npx hardhat run scripts/deploy-robinhood-stock-campaign-implementation.ts --network robinhoodMainnet`,
then the Safe executes `deployments/robinhood/mainnet.R5-stock-campaign-implementation.safe-batch.json`.
R5 must execute before batch H: the first coin locks the setter forever. How to check:
`stockCampaignImplementation()` on the new factory is the new implementation. Batch Q (stock routes,
EVM section 3) can follow now or after the opening; stock pairings are offered once it is executed.

- [ ] R5 executed and read back
- [ ] Batch Q executed (or consciously deferred)

**F. Explorer verification** of every new contract (EVM 4). How to check: the explorers show verified source.

- [ ] Generation contracts verified on both chains

**G. Env and redeploy.** API, indexer and app get the new addresses (EVM 5.1 to 5.3):
`FACTORY_ADDRESS_<id>` and `VITE_FACTORY_ADDRESS_<id>` (both on the API, the create signer reads the `VITE_`
name first), `FACTORY_START_BLOCK_<id>` = the factory's deploy block, `SUPPORTED_FACTORY_ADDRESSES_<id>` /
`_START_BLOCKS_<id>` = the old list plus the new factory, `EVM_GEN5_LP_LOCKERS_<id>`, and on the app the router,
locker, campaign implementation and (Robinhood) registry addresses. On the indexer set
`EVM_GRADUATION_KEEPER_ENABLED_<id>=true` and `EVM_CREATOR_CHOICE_ENABLED_<id>=true` for this chain, with both
`_SEND` flags still `false`. Robinhood only when its chain has reached this point, because `_SEND` is shared.
Redeploy indexer, API, app. How to check:
indexer log `[evm-grad] enabled { chainId: 56, send: false, … }` and `[evm-choice] enabled { chainId: 56, send: false, … }`;
`node scripts/verify-live-app-bundle.mjs https://app.memewar.zone` finds the new addresses (section 6, item 7).

- [ ] BNB env set, services redeployed, logs correct
- [ ] Robinhood env set, services redeployed, logs correct

**H. Batch H (Safe): opens the new factory.** Build from a calls file with `scripts/make-safe-batch.ts`:

```json
[
  { "contract": "BnbBasicLaunchFactory", "to": "<new BNB factory>", "fn": "enableLive", "args": [] },
  { "contract": "BnbBasicLaunchFactory", "to": "<new BNB factory>", "fn": "setCreatePaused", "args": [false] },
  { "contract": "LaunchFactory", "to": "0xc378221E57898106079aE4B818a92978e4cd9559", "fn": "setCreatePaused", "args": [true] }
]
```

Robinhood: contract name `LaunchFactory`, the new Robinhood factory, and no third call. `enableLive` has
no inverse; afterwards `setCreatePaused` is the only gate. How to check: new factory `live()` true and
`createPaused()` false; all old factories `createPaused()` true (BNB `0x632061cA…` and `0xc378221E…`,
Robinhood `0x35E93D0b…`).

- [ ] BNB batch H executed; new open, both old paused
- [ ] Robinhood batch H executed; new open, old paused

**I. EVM canary, right after H.** The factory has no creator allowlist, but it only creates with the API's
signature, and the API signs only for `CREATE_CANARY_WALLETS` (set in 2.5, still set). A failure is
followed by `setCreatePaused(true)`. From your wallet (EVM 6):

1. Create one coin, $15,000 target, 1% first buy. BNB: fee choice keep. Robinhood: fee choice holders.
2. After 60 s buy about 0.01 BNB / 0.003 ETH, sell half.
3. On the explorer, by transfer logs: fee 2% after the window; router split league 37.5%, creator vault
   5.6%, community 15% (unlinked), protocol 41.9%; first-buy tokens unlocked in your wallet.
4. `GET https://api.memewar.zone/api/evm/campaign-state?chainId=<id>&campaign=<campaign>&wallet=<you>` shows
   generation 5, the fee choice and the escrow.
5. Indexer: campaign row `factory_generation = 6`; the keeper logs the coin as idle; the Robinhood worker logs
   its week commitment with nothing signed.
6. BNB: claim the creator fees from the Claims panel; the amount equals the sum of `TradeFeeAccrued`.

- [ ] BNB canary passes
- [ ] Robinhood canary passes

### 2.8 Public opening

When both EVM canaries and the DBC canary pass, open creation to everyone:

- API: remove `CREATE_CANARY_WALLETS` (or set it empty) and redeploy; `GET /api/launch-status` returns `{"canary":false}`.
- App, indexer, workers: nothing to change; the Create page banner disappears on its own.

Everything is then open: DBC flags on since 2.5, both new factories live since H, old factories paused. Announce.

- [ ] Announced

### 2.9 Before signing any Safe batch

Every signer, every batch (EVM 3.1):

1. Re-encode every call from its decoded fields and compare with the bytes to be signed. Every line must
   say `OK`:

```
jq -c '.transactions[]' <batch>.safe-batch.json | while read -r tx; do
  sig=$(jq -r '.contractMethod.name + "(" + ([.contractMethod.inputs[].type]|join(",")) + ")"' <<<"$tx")
  args=$(jq -r '. as $t | [$t.contractMethod.inputs[].name | $t.contractInputsValues[.]] | join(" ")' <<<"$tx")
  to=$(jq -r .to <<<"$tx"); data=$(jq -r .data <<<"$tx")
  [ "$(cast calldata "$sig" $args)" = "$data" ] && r=OK || r=MISMATCH
  echo "$r $to $sig $args"
done
```

   Batch Q has tuple arguments: use `npx ts-node -e 'require("./scripts/make-safe-batch").verifyBatchFile("<batch>", <chainId>)'`.
2. `jq -r .chainId <batch>` is the chain you are signing on.
3. Every `to` and address argument matches the deployment record of that chain.
4. After execution run the read-backs; re-read after a few seconds before calling a read a failure (BSC
   RPCs lag a block).

### 2.10 Switch the workers to sending, one at a time

Change one flag, redeploy the indexer, watch, then the next. Every send is recorded before it leaves, so a
restart resumes instead of repeating.

| Order | Flag (indexer) | What starts | What to watch |
|---|---|---|---|
| 1 | `DBC_FEE_ROUTING_SEND=true` | Collector claims DBC partner fees and routes them into the vaults | One claim and route land; vault deltas match the split; collector balance |
| 2 | `DBC_GRADUATION_SEND=true` | Collector runs DBC graduations (Meteora's keepers only migrate at 10 SOL / 750 USDC and above, so we run it) | No graduation is due yet; log shows `send: true` and idle |
| 3 | `DBC_CREATOR_CHOICE_SEND=true` | Buybacks and weekly split and holder transfers for DBC coins | Week secrets published; no unexpected sends |
| 4 | `EVM_GRADUATION_KEEPER_SEND=true` | Keeper sends `graduate`, repairs, harvests on both chains | `[evm-grad] enabled { send: true }`, idle decisions for the canary coins |
| 5 | `EVM_CREATOR_CHOICE_SEND=true` | Operator sends buybacks and proposes holder batches | Only after the first week commitment is published: `GET https://api.memewar.zone/api/evm/creator-choice?chainId=<id>` |

Graduation on both EVM chains is permissionless: anyone can call `graduate()`. The keeper only makes it prompt.

- [ ] 1 to 5 switched on, each watched before the next

## 3. The first 24 hours

| What | When | How to check | Normal |
|---|---|---|---|
| First DBC graduation | when a coin hits its target | indexer `[dbc-grad]` steps: locker, migrate, mark, withdraw, compensate, route, done; the DAMM v2 pool trades | creator payout claimable; Meteora keeps 0.2% of migrated liquidity, compensated to the creator from our share |
| First EVM graduation per chain | when a coin hits $15K / $30K / $50K | keeper log `graduate` sent; on the explorer 2.2% to the router, 19.8% as `pendingCreatorGraduation`, 78% into the locked pool | the crossing buy lands even if graduation fails; graduation then retries |
| First harvest per chain | keeper every 6 h | 80/20 creator/protocol in native | **BNB: the first harvest on a new pool carries the MEME side** until the pool has 30 min of trade history (Topaz records an observation on a swap after each 1800 s). Not a fault; a later harvest sells it. Watch the first BNB harvest that sells: MEME sold, then exactly 80/20 in WBNB |
| Stock-paired coin (Robinhood) | first one | graduation into the stock pool | never graduated on generation 6 before (section 6) |
| USDC-paired DBC coin | first one | fees swapped to SOL through Jupiter, log shows the swap | never run on mainnet (section 6) |
| Key balances | twice a day | collector, config payer, EVM keeper, EVM operator | top up below 0.1 SOL / 0.005 BNB / 0.001 ETH |
| Payout bounds | after every batch that sets a cap | `node scripts/check-evm-payout-bounds.mjs` | exit 0 |
| Old coins | once | the one coin on `0xc378221E…` and existing Solana launchpad coins trade | unchanged (rehearsed on the BNB fork) |
| First holder week | Monday 2026-10-05 | DBC: 00:05 UTC the worker moves the week's holder deposit, 00:15 the airdrop runner adds the holder leaves. EVM: from 00:05 UTC the worker proposes the holder batch; then the weekly Safe step (section 5.1) | Claim Center rows appear after the Safe step and, on EVM, the vault's 24 h veto window |

## 4. Stop switches and rollback

Env flags are changed by you in Coolify and take effect after a redeploy of that service (a few minutes;
section 6, item 3). `VITE_*` flags need an app rebuild. Safe calls need two of three signers; the time is
however long it takes to reach them.

### 4.1 Solana DBC

| Failure | Stop | Who | Effect |
|---|---|---|---|
| New DBC launches must stop | API `DBC_LAUNCH_ENABLED=false`, app `VITE_DBC_LAUNCH_ENABLED=false` | you | API refuses new DBC launches at once after its redeploy; app hides the option after its rebuild. Existing coins keep trading on Meteora; nothing on chain depends on our servers |
| Our DBC transactions misbehave | `DBC_FEE_ROUTING_SEND`, `DBC_GRADUATION_SEND`, `DBC_CREATOR_CHOICE_SEND` to `false` (any one, or all) | you | fees accrue in the pools and wait; graduations wait; buybacks and holder payouts wait. Nothing is lost |
| Collector key leaked | stop the three `_SEND` flags; new collector key; the key is the partner fee claimer named in every config | you | **to verify**: how pools already created move to a new claimer |

### 4.2 EVM (per chain)

| Failure | Stop | Who | Effect |
|---|---|---|---|
| Opening cannot be finished after batch A | `CommunityRewardsVault.setRouter(<old V3 router>)`, then old factory `setCreatePaused(false)` | Safe | back to today; valid only while no generation 6 coin exists |
| New creates must stop | `setCreatePaused(true)` on the new factory | Safe | existing coins keep trading |
| One coin misbehaves | `setCampaignPauses(campaign, paused, buys, sells, graduation)` on the factory | Safe | that coin only |
| All generation 6 trading must stop | `TreasuryRouterV4.setForwardingPaused(true)` | Safe | every curve buy and sell on the new factory reverts; graduated pools still trade on the DEX |
| Keeper misbehaves | `EVM_GRADUATION_KEEPER_SEND=false`, or `EVM_GRADUATION_KEEPER_ENABLED_<id>=false` for one chain | you | graduation stays permissionless |
| Creator-choice worker misbehaves | `EVM_CREATOR_CHOICE_SEND=false`; on chain `CreatorRewardsVaultV2.setOperator(<operator>, true)` pauses every operator path | you / Safe | holder money waits in the vault |
| A bad holder batch was proposed | `vetoHolderBatch(batchId)` within the 24 h window | Safe | amounts return to the coins' holder balances |
| Operator key leaked | `setOperator(<new>, false)` | Safe | a stolen key can only time buybacks within the caps; it cannot pay itself |
| Route authority key leaked | `setRouteAuthority(<new>)` on the factory, new key on the API | Safe / you | signed creates and trades need the new key |
| API down | nothing to flip | | curve trading on the site stops (trades are server-signed); graduated pools trade on the DEX |

Two things cannot be rolled back: the router's creator vault and the vault's router are set once, and the
community vault serves one router, so once a generation 6 coin exists the old generation cannot be reopened.

### 4.3 App or API regression from the live fixes

Push the previous live head back only as a new commit (revert), never with `--force`: the live branch
auto-deploys and other work is based on it. Record the live head before 2.3 (`git rev-parse
origin/build/cross-chain-stabilization-rh-base`) so you know what "previous" is. Reverting the code does not
undo contracts or database migrations; the migrations only add tables and columns, so the old code runs on
the new schema. **To verify** for the one trigger change in `20260930_000003`, which the old code also passes through.

## 5. After go-live: weekly and monthly

### 5.1 Weekly holder batch, EVM (Mondays, both chains)

From Monday 00:05 UTC the worker proposes last week's holder batch and publishes its leaf file. A signer runs:

```
node scripts/evm-holder-batch-verify.mjs --chain 56 \
  --file "https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=<Monday of the week>" \
  --auth-max 32000000000000000000 --out holders-56-<week>.safe-batch.json
node scripts/evm-holder-batch-verify.mjs --chain 4663 \
  --file "https://api.memewar.zone/api/evm/holder-batch?chainId=4663&weekId=<week>" \
  --auth-max 9300000000000000000 --out holders-4663-<week>.safe-batch.json
```

It recomputes the root and total from the leaves, checks what the vault holds on chain and the cap, and
only then writes the batch (`approveHolderBatch` + `authorizeBatch`). Any mismatch refuses. Check with 2.9,
sign, execute. After the 24 h veto window the worker executes it and the claims open. Nothing is paid
without this weekly Safe step. Solana DBC holder payouts need no Safe step: they ride the weekly airdrop runner.

### 5.2 Unclaimed holder payouts (E19, monthly)

After a holder batch's 60-day deadline, one Safe transaction per batch returns the unclaimed part to each
coin's holder balance:

```
HOLDER_RECOVERY_FILE="https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=<week>" \
  npx hardhat run scripts/make-holder-recovery-batch.ts --network bscMainnet
HOLDER_RECOVERY_FILE="https://api.memewar.zone/api/evm/holder-batch?chainId=4663&weekId=<week>" \
  npx hardhat run scripts/make-holder-recovery-batch.ts --network robinhoodMainnet
```

Read only; it writes a Safe batch when there is something to recover and refuses before the deadline or when
the numbers do not add up exactly. First deadline: about 60 days after the first executed holder batch, so
early December 2026 at the earliest.

### 5.3 Airdrop recovery (monthly, unchanged)

`npx hardhat run scripts/make-airdrop-recovery-batch.ts --network bscMainnet` (and `robinhoodMainnet`),
monthly from late November 2026. After batch A it restores to router V4 on its own (it reads the
community vault's router from chain).

### 5.4 Cap reviews (monthly, or when BNB or ETH moves more than 25% from $767 / $2,695)

1. `node scripts/check-evm-payout-bounds.mjs` (read only). Exit 1 means a bound is outside $1..$1,000,000
   or a rule is broken.
2. To change: a one-call Safe batch `CreatorRewardsVaultV2.setCaps(maxBuyPerTx, maxBuybackPerCampaignWeek,
   minBuyInterval, maxImpactBps, maxHolderBatchPerWeek)` in wei. Impact above 50 bps is refused on chain.
   Keep `--auth-max` in 5.1 equal to `maxHolderBatchPerWeek`.

### 5.5 Balances

Weekly: EVM keeper and operator (top up below 0.005 BNB / 0.001 ETH), DBC collector and config payer (the
config payer pays ~0.006 SOL for each new target and SOL price step).

## 6. To verify

1. **Factory ahead of the day.** As built, batch A must execute before the generation script runs, so the
   factory is deployed in the opening session, not in T-minus. An alternative that shortens the closed
   window: a hand-built "A1" batch with only the router V4 and vault calls (2-5, 7-10) days before, the
   generation, B, ownership and R5 also days before (all closed), and on the day an "A2" with only the old
   factory pause and the community vault switch, then H. The script checks suggest it works, but the batch
   B builder and the fork rehearsal assume one batch A. Use it only after a fork rehearsal with the split.
2. **Coolify auto-deploy.** Which resources redeploy on a push to the live branch (API, indexer, app, the
   Solana graduation keeper and resolve-due worker built from the repo root), and whether the indexer-API-app
   order can be held.
3. **Redeploy time** per service, which sets how fast an env stop switch takes effect.
4. **The migration bundle.** Done: applied on staging and production on 2026-10-01 (2.1). Previously: check
   it holds the 11 DBC and 7 EVM files in order and not `20261001_000001`. None of them is on staging either
   (read 2026-10-01), so staging cannot serve as a dry run unless it is applied there first.
5. **Stock-paired coin end to end** on generation 6: routes configured on the fork, but no stock-bound coin has
   graduated on a generation 6 deployment.
6. **USDC-paired DBC coin** fee swap to SOL through Jupiter: never run on mainnet.
7. **App addresses.** Which other `VITE_*` addresses the generation 6 pages read (`frontend/src/lib/bnbContracts.ts`,
   `deploymentConfig.ts`), and whether `scripts/verify-live-app-bundle.mjs` knows the new addresses.
8. **Airdrop runner on chain 101.** The Monday Coolify task that adds DBC holder leaves exists and runs for Solana.
9. **Robinhood deployer gas** on the day (top up if above 0.05 gwei).
10. **DBC collector rotation** for pools already created (4.1).
11. ~~**DBC canary without opening to everyone.**~~ Solved in the API: `CREATE_CANARY_WALLETS` (2.5, removed in 2.8).
    Still to verify on the day: a non-listed wallet gets `CREATE_CANARY_ONLY` on each chain before the canary.
12. **Rollback on the trigger change** in `20260930_000003` with the old code (4.3).
