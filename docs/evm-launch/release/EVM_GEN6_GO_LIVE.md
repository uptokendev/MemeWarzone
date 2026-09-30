# EVM generation 6 go-live runbook (BNB 56, Robinhood 4663)

For the founder (every send runs from your terminal) and the Safe signers (every admin call is a Safe
batch). Branch to release: `build/evm-launch-staging` (`4c4f00c5` when this was written; the live branch
`build/cross-chain-stabilization-rh-base` is an ancestor, so it fast-forwards). Design and decisions:
`docs/evm-launch/EVM_LAUNCH_GENERATION_PLAN.md` (E1-E19); contract detail: the "As built" sections of
`docs/evm-launch/spec/*.md`.

Nothing in this document has been sent. Chain facts marked "read 2026-10-01" were read with `cast call`
against `bsc-dataseed.bnbchain.org` and `rpc.mainnet.chain.robinhood.com`. Anything that could not be
checked is marked **to verify** and collected in section 10. The whole of section 2 (plus batch H and one
coin) was rehearsed on 2026-10-01 on anvil forks of both chains with the real Safe and the real deployer
impersonated (section 0.7): accepted on both.

Order, per chain, BNB first and Robinhood second:

1. Database (once, both chains).
2. Fees stack (deployer) -> Safe batch A -> generation (deployer) -> Safe batch B -> ownership to the Safe
   (deployer) -> Robinhood only: stock campaign implementation (deployer) + Safe batch R5.
3. Explorer verification.
4. Services: API, indexer (keeper and creator-choice worker in dry run), app.
5. Safe batch H opens the new factory; canary on the live site with your wallet, small.
6. Keeper and worker sending switched on.

From batch A until batch H, EVM creation on that chain is closed on the site (batch A pauses the old
factory first). Plan each chain as one session.

## 0. Before you start

### 0.1 What is on chain today (read 2026-10-01)

| | BNB 56 | Robinhood 4663 |
|---|---|---|
| Safe (owner/admin of everything) | `0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7`, 2 of 3 | same address, 2 of 3 |
| Safe owners | `0x1A367016…`, `0x913d2Bd9…`, `0xEE0B64C4…` | same |
| Deployer | `0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714`, 0.0294 BNB | same, 0.00406 ETH |
| Current factory (in the live app) | `0x632061cA786f7B585Bbd46A792FDA92B02f70671`: 0 campaigns, `live` true, `createPaused` false | `0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA`: 0 campaigns, `live` true, `createPaused` false |
| Older factory still open | `0xc378221E57898106079aE4B818a92978e4cd9559`: 1 campaign, `createPaused` false, router V2 `0xe157a6FD…`, not referenced by the live app bundle | none |
| Current router (V3) | `0xe635AA43fE5707561c8c3C655225da5C3e4C2239` | `0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb` |
| Weekly league vault | `0xC9286EE3390A4dC642340bd703396E6B7b2521d5` | `0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e` |
| Monthly league treasury | `0x42D254A7451808Bb01df879d71BcAfDC5D605A38` | `0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A` |
| Recruiter vault | `0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78` | `0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7` |
| Community vault (serves one router) | `0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e`, router = V3 | `0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a`, router = V3 |
| Protocol revenue vault | `0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c` | `0x632061cA786f7B585Bbd46A792FDA92B02f70671` |
| Payout operator EOA | `0xdcf07EB07e6D6722c246161e7530dc905F9eaA50`, 0.0100 BNB | same, 0.0040 ETH |
| Route authority (API key) | `0xb989A99823eA96552c3E3198A40CdBF682EDf1aA` | same |
| Arena war pool (live, open) | `0xe69a6a41…`, resolver `0x2b72A9E6C4Ea3525d83B8C5E8F2044BDbC1f1Dec`, boost signer `0xFCA7DF580eae01bfA7D3abc96c5075317742D421` | `0xD3E00E47…`, same resolver and signer |
| DEX | Topaz pool factory `0x65E6cD0e…`, volatile fee 30 bps, implementation `0xdC942D8e…` (matches the script's pin) | Uniswap V3 factory `0x1f7d7550…`, fee 3000 -> spacing 60 |
| Price feed | Chainlink BNB/USD `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` (oracle `0x9D204406…`) | Chainlink ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, oracle `0xe635AA43…` with `maxPriceAge` 90000; feed was 3414 s old |
| Gas price | 0.05 gwei | 0.0223 gwei |

Addresses collide across chains (same deployer, same nonces): `0xB6ccAc81…` is the BNB community vault
and the Robinhood weekly vault; `0xe635AA43…` is the BNB router and the Robinhood oracle;
`0x632061cA…` is the BNB factory and the Robinhood protocol vault. Always pair an address with its chain.

Every pin in `scripts/deploy-evm-treasury-router-v4.ts` (`PINS`) matched the V3 routers' getters on
2026-10-01; the script re-reads them and refuses on any difference.

### 0.2 Terminal, RPC, chain-id guard

Every deploy script refuses without its `CONFIRM_*` phrase, and the fees script also refuses a
non-interactive shell or CI. Before every send, in the same shell:

```
cast chain-id --rpc-url "$BSC_MAINNET_RPC"            # must print 56
cast chain-id --rpc-url "$ROBINHOOD_MAINNET_RPC_URL"  # must print 4663
env | grep -E '^BNB_FORK_RPC='                        # must print nothing
```

`hardhat.config.ts` resolves `bscMainnet` to `BNB_FORK_RPC` first, then `BSC_MAINNET_RPC`, then a public
endpoint. Use a paid RPC for both chains. Public BSC nodes load-balance and can answer a read one block
behind a confirmed transaction: the scripts retry read-backs (`readBack`), and so should you before
calling a step failed (re-read after 5-10 s, or on a second RPC).

Keys (never commit, never paste into a chat):

| Chain | Env the hardhat config reads |
|---|---|
| BNB | `DEPLOYER_PK` (or `PRIVATE_KEY_DEPLOY`) |
| Robinhood | `ROBINHOOD_MAINNET_DEPLOYER_PRIVATE_KEY` (falls back to `PRIVATE_KEY_DEPLOY`, `DEPLOYER_PK`) |

Compile once before starting: `npx hardhat compile` (the Safe batch builder reads the artifacts).

### 0.3 Deployer balance

Measured on the mainnet forks (0.7), 2026-10-01, every deployer transaction of section 2 (fees stack,
generation, ownership handover; Robinhood also the stock campaign implementation), priced at the live gas
price read from the upstream RPC the same minute:

| | Deployer transactions | Gas | Gas price | Cost | Deployer now | Action |
|---|---|---|---|---|---|---|
| BNB | 20 | 32.37M | 0.05 gwei | 0.00162 BNB | 0.0294 BNB | enough (18x); keep at least 0.01 BNB after |
| Robinhood | 25 | 37.22M L2 + 70.6k L1-data gas units | 0.0220 gwei | 0.00082 ETH (L1 data part 0.0000015 ETH: the Nitro L1 base fee estimate was 0.00087 gwei) | 0.00406 ETH | enough (5x at today's price); top up to 0.01 ETH if the L2 price is above 0.05 gwei on the day |

The Safe's own batches (A, B, R5, Q, H) cost the executing signer about 0.9M gas on BNB (under 0.0001 BNB)
and 3.15M gas on Robinhood (0.00007 ETH; batch Q with nine routes is most of it). The fork numbers are in
`deployments/fork-rehearsal/<network>/rehearsal-report.json` (`funding`, per-transaction L1 detail on
Robinhood). Re-run the rehearsal on the day: the script reads the gas price live.

Canary money (section 6) comes from your own wallet, not the deployer: about 0.05 BNB and 0.02 ETH.

### 0.4 Safe signers

Two of the three owners must be reachable for the whole session of each chain: batches A, B, (R5,) H
follow each other within hours, and batch H is what opens creation again. Signers check every batch with
the decoder in section 3.1 before signing.

### 0.5 Keys and secrets to create

None of these is the deployer. The keeper and the worker refuse the deployer, the Safe and a few known
testnet deployers at start (`FORBIDDEN_KEEPER_ADDRESSES` in `realtime-indexer/src/evm/evmGraduationKeeper.ts`,
`assertOperatorKeyAllowed` in `evmCreatorChoiceConfig.ts`).

| Key / secret | What it does | Where it lives | Fund with |
|---|---|---|---|
| Graduation keeper | Sends `graduate`, chunked pool repair, native fallback (E12), flush, V3 observation slots, LP `harvest` (permissionless calls only; no role on chain) | `~/.config/memewarzone/mwz-evm-graduation-keeper.json` (chmod 600); indexer env `EVM_GRADUATION_KEEPER_PRIVATE_KEY` | 0.02 BNB, 0.005 ETH |
| Creator-choice operator | The vault's `operator()`: proposes and executes holder batches, buybacks, quote conversions, `syncLpFees` | decision D1 below; indexer env `EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY` | 0.02 BNB, 0.005 ETH |
| API internal secret | Authenticates the worker's buyback-authorization call to the API | `openssl rand -hex 32`; API and indexer env `EVM_CREATOR_CHOICE_API_SECRET` (same value) | none |
| Buyback seed secret | Master secret for the weekly secret moments (buybacks, holder snapshot); hash published before the week, secret after | `openssl rand -hex 32`; indexer env `EVM_BUYBACK_SEED_SECRET` only | none |

```
cast wallet new --json > ~/.config/memewarzone/mwz-evm-graduation-keeper.json && chmod 600 ~/.config/memewarzone/mwz-evm-graduation-keeper.json
cast wallet new --json > ~/.config/memewarzone/mwz-evm-creator-choice-operator.json && chmod 600 ~/.config/memewarzone/mwz-evm-creator-choice-operator.json   # only if D1 = dedicated key
openssl rand -hex 32   # EVM_CREATOR_CHOICE_API_SECRET
openssl rand -hex 32   # EVM_BUYBACK_SEED_SECRET
```

### 0.6 Decisions needed before the first send

| # | Question | Recommendation |
|---|---|---|
| D1 | Batch A sets the vault operator to the existing payout operator `0xdcf07EB0…` (pinned in `PINS.payoutOperator`). The API already sends recruiter payouts and league roots from that key; the worker would send from it too, from another service, so nonces would collide. | A dedicated creator-choice operator key. Batch A still sets `0xdcf07EB0…`; pass `EVMGEN_VAULT_OPERATOR=<new key>` when building batch B (2.4 / 2.9) and B ends with `CreatorRewardsVaultV2.setOperator(<new key>, false)` (one slot, replaced). Rehearsed on both forks. |
| D2 | BNB factory `0xc378221E…` (generation 3/2, router V2 `0xe157a6FD…`, 1 campaign `0xA2baB122…`, create open) is not in batch A. On the fork its coin bought and sold normally before **and after** batch A: it routes through V2, whose community vault is `0x5becb76c…` (router = V2), not the `0xB6ccAc81…` that batch A re-points. So batch A does not affect it; closing it is a separate choice. | Add `setCreatePaused(true)` for it to batch H on BNB, if you agree it is retired. Its existing coin keeps trading either way. |
| D4 | Robinhood stock coins. The campaign implementation must be bound before the first campaign (R5, section 2.9) or stock bindings are dead for this generation. | Do R5 before H regardless. Stock routes are batch Q (`configure-robinhood-stock-routes.ts`, section 3); open stock bindings once Q is executed. |
| E14 | Batch A closes the old factories at the start of each chain's session (the community vault serves one router), while E14 said the old factories stay open until the new generation replaces them. | See 10.13: creation on that chain is closed from batch A to batch H. Both old factories that batch A pauses hold 0 campaigns. |

D3 (a new war pool and league the generation scripts deployed but nothing used) is closed: the scripts no
longer deploy them (2026-10-01). The live war pools and leagues stay; the API's arena env is unchanged.

### 0.7 Rehearse on a mainnet fork (done 2026-10-01; re-run before the real deploy)

`scripts/rehearse-evm-gen6-mainnet-fork.ts` runs section 2 end to end on a local anvil fork, through the
production scripts (in-process, same code path), with the **real Safe** and the **real deployer**
impersonated. No private key is involved: the fork networks in `hardhat.config.ts` (`bscForkRehearsal`,
`robinhoodForkRehearsal`) use `accounts: "remote"`, and the deploy scripts accept them as aliases of
`bscMainnet` / `robinhoodMainnet` only after `anvil_nodeInfo` proves a local fork. Records and batches land in
`deployments/fork-rehearsal/<network>/` (gitignored, wiped at each start), never over the mainnet records.

```
npx hardhat compile
BSC_MAINNET_RPC=<paid BSC RPC> \
  npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network bscForkRehearsal         # ~2 min
ROBINHOOD_MAINNET_RPC_URL=<paid RH RPC> \
  npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network robinhoodForkRehearsal   # ~5 min
```

(Without the env it forks the public endpoints, which also worked.) The script starts anvil itself on port
8645 / 8646 (`REHEARSAL_KEEP_ANVIL=1` leaves it running) and refuses if something already listens there.
It exits non-zero on the first failed check; the report is `deployments/fork-rehearsal/<network>/rehearsal-report.json`.

What it runs, in the order of section 2:

1. BNB only: the live generation-3 coin on `0xc378221E…` bought and sold (its factory's route authority
   replaced on the fork by a throwaway key, a fork-only Safe call) **before** batch A;
2. fees stack (deployer), batch A executed as the Safe, then the same old coin bought and sold again;
3. generation script (deployer);
4. `EVMGEN_BATCHES_ONLY=1` with a D1 operator, batch B executed as the Safe;
5. ownership to the Safe (deployer);
6. Robinhood: stock campaign implementation (deployer), batch R5 as the Safe;
7. route script: plan, simulate every call as the Safe, write batch Q, execute it as the Safe;
8. the read-backs of 2.1-2.9 and `check-evm-payout-bounds.mjs` against the fork;
9. fork only: the Safe sets a throwaway route authority on the new factory so the rehearsal can sign like
   the API (`frontend/api/dev-fix/routeAuthorizationSigner.js`); batch H as the Safe;
10. one coin: create with a 1% creator first buy (BNB fee choice keep, Robinhood holders), a signed buy after
    the 60 s window and a signed sell, buys to the $15,000 target (Pending), `graduate()` from a third wallet,
    a DEX buy and sell on the locked pool, `harvest()`.

Result 2026-10-01 (fork blocks BNB 124,989,815 and Robinhood 76,880,885): **accepted on both chains.**

| | BNB | Robinhood |
|---|---|---|
| Old coin before / after batch A | buy + sell OK / buy + sell OK (V2 community vault `0x5becb76c…` untouched) | n/a (old factory 0 campaigns) |
| Batch A / B / R5 / Q / H as the Safe | 10 / 6 / - / 0 (no BNB route clears the floor) / 2 calls, all executed | 10 / 6 / 1 / 18 (9 adapter routes + 9 vault routes) / 2 |
| Read-backs 2.1-2.9, payout bounds | all pass (vault caps 0.65 / 6.5 / 21600 / 50 / 32 BNB) | all pass (0.19 / 1.9 / 21600 / 50 / 9.3 ETH) |
| Coin: create, trade, graduate | $15,000 target = 19.53 BNB; 2.2 / 19.8 / 78 exact; start price = curve price | $15,000 = 5.59 ETH; same |
| Harvest | WBNB 80/20 exact; MEME side carried (the new pool has no 30 min TWAP yet: fail closed, as designed) | WETH 80/20 exact; MEME side sold |
| Deployer gas | 32.37M in 20 txs | 37.22M in 25 txs (+ 70.6k L1-data gas units) |

BNB ran five times: four accepted; one stopped in step 10 at the post-graduation Topaz round trip with a
reasonless router revert (public upstream RPC; not reproducible, deploy path unaffected). The script now
simulates each DEX call first and prints the revert reason; re-run on a failure there.

The manual anvil + `cast` route that used to be here is no longer needed.

### 0.8 Keep the old records

The generation scripts and the stock-implementation script write to fixed paths that today hold the
2026-09-23/24 generation. Move those first, in one commit:

```
git mv deployments/bnb/mainnet.quote-generation.json deployments/bnb/mainnet.quote-generation.gen4.json
git mv deployments/robinhood/mainnet.quote-generation.json deployments/robinhood/mainnet.quote-generation.gen4.json
git mv deployments/robinhood/mainnet.stock-campaign-implementation.json deployments/robinhood/mainnet.stock-campaign-implementation.gen4.json
git mv deployments/robinhood/mainnet.R5-stock-campaign-implementation.safe-batch.json deployments/robinhood/mainnet.R5-stock-campaign-implementation.gen4.safe-batch.json
```

`scripts/deploy-robinhood-stock-campaign-implementation.ts` refuses while its record exists and reads the
factory from `mainnet.quote-generation.json`, so this is required on Robinhood, not cosmetic.

## 1. Database migrations

Seven files, in this order. Run each in the Supabase SQL editor, staging (`vrnsbguutnwgtekcexls`) first,
then production (`ellkfgoxnzykxqybajtn`). Each is one transaction and uses `if not exists` / `drop
constraint if exists`, so a second paste is harmless.

| # | File | What it adds |
|---|---|---|
| 1 | `db/migrations/20260930_000001_evm_gen5_indexing.sql` | `campaigns.factory_generation/campaign_generation`; `curve_trades` fee, gross, creator-buy kind, `league_excluded` (default false); `evm_campaign_events`; `evm_campaign_gen5_state` |
| 2 | `db/migrations/20260930_000002_evm_graduation_keeper.sql` | `evm_graduation_keeper_jobs` (every send recorded before broadcast) |
| 3 | `db/migrations/20260930_000003_dex_trade_quote_leg_preserved.sql` | `set_dex_trade_quote_identity` keeps an explicit quote leg on MEME/QUOTE trades |
| 4 | `db/migrations/20260930_100001_campaign_draft_evm_launch_options.sql` | `campaign_draft_evm_launch_options` (first buy and fee choice on a draft) |
| 5 | `db/migrations/20260930_200001_evm_graduation_keeper_observations.sql` | keeper action `observations` |
| 6 | `db/migrations/20260930_300001_evm_creator_choice_operator.sql` | `evm_creator_choice_weeks`, jobs, snapshots, `evm_holder_batches` |
| 7 | `db/migrations/20260930_300002_evm_graduation_keeper_harvest.sql` | keeper action `harvest` |

Number 3 changes a trigger function that every chain's DEX trades pass through; old rows are not
rewritten. Whether staging already has all seven is **to verify** (read-only check:
`select to_regclass('public.evm_holder_batches'), to_regclass('public.campaign_draft_evm_launch_options');`).

Before production, one read-only check that the columns 000001 alters exist:
`select column_name from information_schema.columns where table_name='curve_trades' and column_name in ('fee_raw','league_excluded');`
(empty before, two rows after).

## 2. Deploy, per chain

All commands run from the repo root on the release branch, in your terminal.

### 2.1 BNB: fees stack (deployer)

```
export BSC_MAINNET_RPC=<paid BSC RPC>
export DEPLOYER_PK=<deployer key>
cast chain-id --rpc-url "$BSC_MAINNET_RPC"   # 56
CONFIRM_EVMGEN_FEES_DEPLOY=I_UNDERSTAND_MAINNET \
EVMGEN_BUYBACK_MAX_PER_TX=0.65 \
EVMGEN_BUYBACK_MAX_PER_CAMPAIGN_WEEK=6.5 \
EVMGEN_BUYBACK_MIN_INTERVAL_SECONDS=21600 \
EVMGEN_BUYBACK_MAX_IMPACT_BPS=50 \
EVMGEN_HOLDER_MAX_PER_WEEK=32 \
EVMGEN_HOLDER_BATCH_AUTH_MAX=32 \
  npx hardhat run scripts/deploy-evm-treasury-router-v4.ts --network bscMainnet
```

The cap values are E15 in BNB (priced at BNB $767; `parseEther` units). The script refuses mainnet
without the four money caps; set the interval explicitly (its default is 3600, E15 says 6 h).

It deploys `TreasuryRouterV4(admin = Safe, weekly, monthly, 3600)`, `CreatorRewardsVaultV2(admin = Safe,
router, WBNB, dexKind 1, Topaz pool factory, 86400)` and a holder `RewardDistributor(owner = Safe)`, and
prints:

```
[fees-v4] TreasuryRouterV4 0x…
[fees-v4] CreatorRewardsVaultV2 0x…
[fees-v4] holder RewardDistributor 0x…
[fees-v4] wrote deployments/bnb/mainnet.evmgen-fees.A.safe-batch.json (10 call(s))
[fees-v4] wrote deployments/bnb/mainnet.evmgen-fees.json
[fees-v4] batch B comes after the generation: EVMGEN_BATCHES_ONLY=1 …
```

Files: `deployments/bnb/mainnet.evmgen-fees.json` (addresses, caps, deploy blocks) and
`deployments/bnb/mainnet.evmgen-fees.A.safe-batch.json`. A second full run refuses while that record
exists (no resume, it would deploy a second stack). `EVMGEN_BATCHES_ONLY=1` with the same command rebuilds
the batches from the records without deploying anything (2.4).

Verify on chain (`R`, `V`, `D` = the three printed addresses):

```
RPC=$BSC_MAINNET_RPC
cast call $R 'admin()(address)' --rpc-url $RPC                  # the Safe
cast call $R 'CREATOR_TRADE_BPS()(uint16)' --rpc-url $RPC       # 560
cast call $R 'upgradeDelay()(uint256)' --rpc-url $RPC           # 3600
cast call $R 'weeklyLeagueVault()(address)' --rpc-url $RPC      # 0xC9286EE3…
cast call $R 'monthlyLeagueTreasury()(address)' --rpc-url $RPC  # 0x42D254A7…
cast call $R 'creatorRewardsVault()(address)' --rpc-url $RPC    # 0x0 until batch A
cast call $V 'admin()(address)' --rpc-url $RPC                  # the Safe
cast call $V 'router()(address)' --rpc-url $RPC                 # R
cast call $V 'dexKind()(uint8)' --rpc-url $RPC                  # 1
cast call $V 'wrappedNative()(address)' --rpc-url $RPC          # 0xbb4CdB9C… (WBNB)
cast call $V 'holderBatchDelay()(uint256)' --rpc-url $RPC       # 86400
cast call $D 'owner()(address)' --rpc-url $RPC                  # the Safe
```

### 2.2 BNB: Safe batch A (wiring)

File `deployments/bnb/mainnet.evmgen-fees.A.safe-batch.json`, 10 calls (`batchACalls`):

1. old factory `0x632061cA….setCreatePaused(true)`: the old generation stops creating first.
2. `V4.setRecruiterRewardsVault(0x40ac5cD7…)`
3. `V4.setCommunityRewardsVault(0xB6ccAc81…)`
4. `V4.setProtocolRevenueVault(0xc2d4E6f8…)`
5. `V4.setCreatorRewardsVault(V)`: set once for life (audit F1).
6. `CommunityRewardsVault 0xB6ccAc81….setRouter(V4)`: from here the V3 router's airdrop and squad routes
   revert. Harmless now: both current factories hold 0 campaigns (read 2026-10-01).
7. `holder RewardDistributor.setBatchOperator(V)`
8. `V.setHolderDistributorOnce(D)`
9. `V.setOperator(0xdcf07EB0…, false)`
10. `V.setCaps(0.65 BNB, 6.5 BNB, 21600, 50, 32 BNB)` in wei.

No holder batch is pre-authorized (audit F5): each week's batch is its own Safe batch (section 9).

After execution:

```
cast call 0x632061cA786f7B585Bbd46A792FDA92B02f70671 'createPaused()(bool)' --rpc-url $RPC   # true
for f in recruiterRewardsVault communityRewardsVault protocolRevenueVault creatorRewardsVault; do cast call $R "$f()(address)" --rpc-url $RPC; done
cast call 0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e 'router()(address)' --rpc-url $RPC      # R
cast call $D 'batchOperator()(address)' --rpc-url $RPC                                        # V
cast call $V 'holderDistributor()(address)' --rpc-url $RPC                                    # D
cast call $V 'operator()(address)' --rpc-url $RPC
cast call $V 'limits()(bool,uint256,uint256,uint256,uint256,uint256)' --rpc-url $RPC          # false, 0.65e18, 6.5e18, 21600, 50, 32e18
```

From this point EVM creation on BNB is closed until batch H.

### 2.3 BNB: generation (deployer)

Needs batch A executed: the script refuses a router whose vaults are unset or whose creator vault is not
a `CreatorRewardsVaultV2` paying this router (`assertRouterCanServeStrictRouting`,
`assertCreatorVaultServesGeneration`).

```
CONFIRM_BNB_QUOTE_GENERATION=I_UNDERSTAND_MAINNET \
BNB_TREASURY_ROUTER=<R> \
BNB_NATIVE_USD_FEED=0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE \
  npx hardhat run scripts/deploy-bnb-quote-generation.ts --network bscMainnet
```

Defaults from the script's `bscMainnet` profile (all re-checked on chain before any deployment): owner
Safe, Topaz adapter `0x5c3135Df…` (factory side, answers `poolFactory()`), Topaz router `0x1E98c822…`
(quote adapter side), oracle `0x9D204406…`, CreatorRegistry `0x8194FB37…` and RiskRegistry
`0x92b1494C…` (both Safe-owned, reused), route authority `0xb989A998…`. No war pool or league is deployed
(D3 closed): the live ones stay in use.

What it does, in order: read-only guards (Topaz routers agree, 30 bps, pinned implementation; router
serves strict routing) -> `LaunchCampaign` and `BnbQuoteLaunchCampaign` implementations -> locker then
factory (`scripts/lib/deployFactoryWithLocker.ts`: the locker's admin is the factory's predicted CREATE
address, explicit nonces) -> `BnbNativeGraduationAdapter` (bound to the factory by the deployer) and
`BnbQuoteGraduationAdapter` (admin Safe) -> `setConfig`,
`setProtocolFee(200)`, `setRegistries`, `setRouteAuthority` -> `LaunchTokenDeployer`,
`setNativeGraduationAdapter`, `setLaunchTokenDeployer` (`scripts/lib/evmGenerationCreateWiring.ts`) ->
`setCreatePaused(true)`.

It writes `deployments/bnb/mainnet.quote-generation.json` and prints `PENDING` owner actions. Expect
exactly these four, all covered by batch B (do not sign them a second time from the printout):

- `creatorRegistry.setLaunchRecorder(factory, true)` (the registry is the Safe's)
- `CreatorRewardsVaultV2.setFactoryOnce(factory)` (vault admin is the Safe)
- `TreasuryRouterV4.setAuthorizedLpLocker(locker, true)` (first locker on V4: direct, no timelock)
- `BnbQuoteGraduationAdapter.setCampaignFactoryOnce(factory)` (adapter admin is the Safe)

Verify (`F` = factory, `L` = locker, `N` = native adapter, `Q` = quote adapter):

```
cast call $F 'FACTORY_GENERATION()(uint32)' --rpc-url $RPC      # 6
cast call $F 'CAMPAIGN_GENERATION()(uint32)' --rpc-url $RPC     # 5
cast call $F 'feeRecipient()(address)' --rpc-url $RPC           # R
cast call $F 'leagueReceiver()(address)' --rpc-url $RPC         # R
cast call $F 'permanentLpLocker()(address)' --rpc-url $RPC      # L
cast call $L 'admin()(address)' --rpc-url $RPC                  # F
cast call $L 'treasuryRouter()(address)' --rpc-url $RPC         # R
cast call $F 'nativeGraduationAdapter()(address)' --rpc-url $RPC   # N
cast call $F 'launchTokenDeployer()(address)' --rpc-url $RPC    # the printed LaunchTokenDeployer
cast call $F 'bnbQuoteGraduationAdapter()(address)' --rpc-url $RPC # Q
cast call $N 'campaignFactory()(address)' --rpc-url $RPC        # F
cast call $Q 'admin()(address)' --rpc-url $RPC                  # the Safe
cast call $F 'routeAuthority()(address)' --rpc-url $RPC         # 0xb989A998…
cast call $F 'createPaused()(bool)' --rpc-url $RPC              # true
cast call $F 'live()(bool)' --rpc-url $RPC                      # false
cast call $F 'campaignsCount()(uint256)' --rpc-url $RPC         # 0
cast call $F 'owner()(address)' --rpc-url $RPC                  # the deployer, until 2.5
```

### 2.4 BNB: Safe batch B (bind the generation)

Built from the two records and the chain, nothing deployed:

```
EVMGEN_BATCHES_ONLY=1 \
EVMGEN_VAULT_OPERATOR=<dedicated operator, D1; omit to keep 0xdcf07EB0…> \
  npx hardhat run scripts/deploy-evm-treasury-router-v4.ts --network bscMainnet
```

It re-checks the router/vault pair (admin Safe, vault pays this router), rewrites batch A (same calls, for
re-review) and writes `deployments/bnb/mainnet.evmgen.B.safe-batch.json` with the calls still missing on
chain, in this order: `TreasuryRouterV4.setAuthorizedLpLocker(L, true)`, `setPrimaryLpLocker(L)`,
`CreatorRewardsVaultV2.setFactoryOnce(F)`, `CreatorRegistry 0x8194FB37….setLaunchRecorder(F, true)`,
`BnbQuoteGraduationAdapter.setCampaignFactoryOnce(F)`, and `CreatorRewardsVaultV2.setOperator(<D1>, false)`
when `EVMGEN_VAULT_OPERATOR` is set. It refuses unless every `pendingOwnerActions` entry of the generation
record is in the batch byte for byte (or already done on chain). No `setQuoteRoute` in B: quote routes are
batch Q (section 3); no BNB quote token has a Topaz WBNB pool above the floor (2026-09-24 scan).

After execution: `cast call $R 'authorizedLpLocker(address)(bool)' $L` true, `permanentLpLocker()` = L,
`cast call $V 'factory()(address)'` = F, `cast call 0x8194FB37… 'launchRecorder(address)(bool)' $F` true,
`cast call $Q 'campaignFactory()(address)'` = F, `cast call $V 'operator()(address)'` = the D1 key.

### 2.5 BNB: ownership to the Safe (deployer)

```
CONFIRM_OWNERSHIP_TRANSFER=I_UNDERSTAND_MAINNET \
NEW_OWNER=0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7 \
OWNABLE_CONTRACTS=<F> \
  npx hardhat run scripts/transfer-evm-ownership-to-safe.ts --network bscMainnet
```

It checks every owner before sending anything and reads each back after. What stays with the deployer,
by design: `BnbNativeGraduationAdapter.admin` (immutable; its only admin call, `setCampaignFactoryOnce`,
is already spent). The locker's admin is the factory. `LaunchTokenDeployer` has no owner.

Verify: `cast call $F 'owner()(address)'` = the Safe.

### 2.6 Robinhood: fees stack (deployer)

```
export ROBINHOOD_MAINNET_RPC_URL=<paid Robinhood RPC>
export ROBINHOOD_MAINNET_DEPLOYER_PRIVATE_KEY=<deployer key>
cast chain-id --rpc-url "$ROBINHOOD_MAINNET_RPC_URL"   # 4663
CONFIRM_EVMGEN_FEES_DEPLOY=I_UNDERSTAND_MAINNET \
EVMGEN_BUYBACK_MAX_PER_TX=0.19 \
EVMGEN_BUYBACK_MAX_PER_CAMPAIGN_WEEK=1.9 \
EVMGEN_BUYBACK_MIN_INTERVAL_SECONDS=21600 \
EVMGEN_BUYBACK_MAX_IMPACT_BPS=50 \
EVMGEN_HOLDER_MAX_PER_WEEK=9.3 \
EVMGEN_HOLDER_BATCH_AUTH_MAX=9.3 \
  npx hardhat run scripts/deploy-evm-treasury-router-v4.ts --network robinhoodMainnet
```

E15 in ETH (priced at ETH $2,695). Same output shape, written to `deployments/robinhood/mainnet.evmgen-fees*.json`.
Verify as in 2.1 with `dexKind` 2, `wrappedNative` `0x0Bd7D308…`, weekly `0xB6ccAc81…`, monthly `0x576c1d6B…`.

### 2.7 Robinhood: Safe batch A

Same 10 calls on Robinhood addresses: old factory `0x35E93D0b….setCreatePaused(true)`, recruiter
`0xBd7EB35d…`, community `0xdE9Ec7c6…`, protocol `0x632061cA…` (the protocol vault on this chain), the
community vault `0xdE9Ec7c6….setRouter(V4)`, caps `0.19 / 1.9 / 21600 / 50 / 9.3` ETH. Verify as in 2.2
with those addresses.

### 2.8 Robinhood: generation (deployer)

```
CONFIRM_ROBINHOOD_GENERATION=I_UNDERSTAND_MAINNET \
RH_TREASURY_ROUTER=<R> \
RH_WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 \
RH_V3_FACTORY=0x1f7d7550B1b028f7571E69A784071F0205FD2EfA \
RH_POSITION_MANAGER=0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3 \
RH_SWAP_ROUTER=0xCaf681a66D020601342297493863E78C959E5cb2 \
RH_NATIVE_USD_FEED=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9 \
RH_GRADUATION_ORACLE=0xe635AA43fE5707561c8c3C655225da5C3e4C2239 \
RH_ROUTE_AUTHORITY=0xb989A99823eA96552c3E3198A40CdBF682EDf1aA \
RH_OWNER=0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7 \
  npx hardhat run scripts/deploy-robinhood-quote-generation.ts --network robinhoodMainnet
```

`RH_ADAPTER_ADMIN` defaults to the Safe on 4663 and the deployer is refused; `RH_MAX_ORACLE_AGE_SECONDS`
defaults to 90000 and the run refuses a value the live feed already exceeds. The script refuses the testnet
route authority and an owner equal to the deployer.

What it deploys: `RobinhoodV3NativeGraduationAdapterV2` (admin Safe; also the factory's router),
`LaunchCampaign` implementation, `PermanentV3PositionLocker` then `LaunchFactory`,
`RobinhoodStockGraduationAdapterV2` (admin Safe, max oracle age 90000), `RobinhoodV3NativeSwapAdapter`,
and a **fresh** `CreatorRegistry` + `RiskRegistry` (deployer-owned; the
factory is registered as launch recorder in the script). Creator cooldowns therefore start fresh on
Robinhood. Then `setStockGraduationAdapter`, `setConfig` (target $30,000), `setProtocolFee(200)`,
`setRouteAuthority`, `setRegistries`, the create path, `setCreatePaused(true)`. It appends both adapters
to `config/verification/mainnet-contracts.json` itself.

Record: `deployments/robinhood/mainnet.quote-generation.json`. Expected pending owner actions (covered by
batch B): `setAuthorizedLpLocker` on V4, `setFactoryOnce` on the vault, and `adapterBindActions`:
`setCampaignFactoryOnce(F)` on the native adapter and on the stock adapter.

Verify as in 2.3, plus:

```
RPC=$ROBINHOOD_MAINNET_RPC_URL
cast call $F 'liquidityKind()(uint8)' --rpc-url $RPC            # 2 (V3)
cast call $F 'stockGraduationAdapter()(address)' --rpc-url $RPC # the stock adapter
cast call $F 'stockCampaignImplementation()(address)' --rpc-url $RPC  # 0x0 until R5
cast call <stock adapter> 'maxOracleAgeSeconds()(uint256)' --rpc-url $RPC   # 90000
cast call <native adapter> 'feeTier()(uint24)' --rpc-url $RPC   # 3000
cast call <creator registry> 'launchRecorder(address)(bool)' $F --rpc-url $RPC  # true
```

### 2.9 Robinhood: Safe batch B, ownership, R5

Batch B as in 2.4, `--network robinhoodMainnet` (`EVMGEN_VAULT_OPERATOR` per D1). On Robinhood it holds
`setAuthorizedLpLocker`, `setPrimaryLpLocker`, `setFactoryOnce`, `setCampaignFactoryOnce(F)` on the native
adapter and on the stock adapter (+ `setOperator`), written to `deployments/robinhood/mainnet.evmgen.B.safe-batch.json`.
Verify: both adapters `campaignFactory()` = F and `campaignFactoryLocked()` true; locker authorized and
primary on V4; vault `factory()` = F.

Ownership (deployer): `OWNABLE_CONTRACTS=<F>,<CreatorRegistry>,<RiskRegistry>` with the
same command as 2.5 and `--network robinhoodMainnet`.

R5, the stock campaign implementation (deployer, then Safe). Requires the factory owned by the Safe and
the stock adapter bound, so it comes after both:

```
npx hardhat run scripts/deploy-robinhood-stock-campaign-implementation.ts --network robinhoodMainnet
```

It deploys `RobinhoodStockLaunchCampaign` and writes
`deployments/robinhood/mainnet.R5-stock-campaign-implementation.safe-batch.json`
(`LaunchFactory.setStockCampaignImplementation(impl)`). The setter is `whenMutable`: it must execute
before batch H, because the first campaign of any kind locks it forever. Verify
`stockCampaignImplementation()` = impl after execution.

## 3. The Safe batches, in order

| Order | Batch | Chain | Written by | Contents | Opens anything? |
|---|---|---|---|---|---|
| 1 | A | 56 | `deploy-evm-treasury-router-v4.ts` | old factory create paused, V4 vaults, community vault -> V4, holder distributor, operator, E15 caps | closes old creation |
| 2 | B | 56 | `deploy-evm-treasury-router-v4.ts` with `EVMGEN_BATCHES_ONLY=1` (2.4) | locker on V4, vault factory pin, launch recorder, quote adapter factory (+ D1 operator) | no |
| 3 | H | 56 | `make-safe-batch.ts` (section 7) | `enableLive`, `setCreatePaused(false)` on the new factory (+ D2) | yes |
| 4 | A | 4663 | `deploy-evm-treasury-router-v4.ts` | as 1 | closes old creation |
| 5 | B | 4663 | `deploy-evm-treasury-router-v4.ts` with `EVMGEN_BATCHES_ONLY=1` (2.9) | locker on V4, vault factory pin, both adapter binds (+ D1) | no |
| 6 | R5 | 4663 | `deploy-robinhood-stock-campaign-implementation.ts` | `setStockCampaignImplementation` | no |
| 7 | H | 4663 | `make-safe-batch.ts` | as 3 | yes |
| before or after H | Q | 4663 (56 when a route exists) | `configure-robinhood-stock-routes.ts` / `configure-bnb-quote-routes.ts` | per route: adapter `configureStockRoute` / `configureQuoteRoute` + vault `setQuoteRoute`; every call simulated as the Safe first | stock / quote bindings |
| weekly | W | both | `evm-holder-batch-verify.mjs` | `approveHolderBatch` + `authorizeBatch` | pays holders |

The ownership handover between B and H is sent by the deployer, not the Safe. Existing E15 caps are
changed later with a one-call `setCaps` batch (section 9.4).

Batch Q (stock / quote routes). Run from the release branch after batch B:

```
npx hardhat run scripts/configure-robinhood-stock-routes.ts --network robinhoodMainnet   # -> deployments/robinhood/mainnet.stock-routes.Q.safe-batch.json
npx hardhat run scripts/configure-bnb-quote-routes.ts --network bscMainnet               # BNB: "no bindable route" until Topaz liquidity changes
```

Each re-derives every fact from chain (feed age, canonical pool, depth on the side the adapter measures: the
STOCK side on Robinhood, WBNB x2 on BNB), checks the policy against the adapter's rules, simulates every call
with `eth_call` from the Safe and only then writes the batch; the deployer sends nothing (`ROUTES_SEND=1` is
refused when the admin is the Safe). The Robinhood file (`config/robinhood/mainnet-stock-routes.json`, rescanned
2026-10-01) routes SPY, NVDA, META, COIN, SPCX, TSLA, QQQ, AAPL and USDG at slippage 100 bps, reserved fields 0,
fee tiers 100/500/3000; MSTR, MU, GLD, SGOV, CRCL (only a 1% pool clears the $50k floor) and GME ($6.5k of
stock in its 0.05% pool) are listed under `excluded`. A configured route's feed, pool and tier are fixed for
the life of the adapter (`RouteFixed`), so check each row before signing.

### 3.1 Before signing any batch

1. Re-encode every call from its decoded fields and compare with the bytes the Safe will sign:

```
jq -c '.transactions[]' <batch>.safe-batch.json | while read -r tx; do
  sig=$(jq -r '.contractMethod.name + "(" + ([.contractMethod.inputs[].type]|join(",")) + ")"' <<<"$tx")
  args=$(jq -r '. as $t | [$t.contractMethod.inputs[].name | $t.contractInputsValues[.]] | join(" ")' <<<"$tx")
  to=$(jq -r .to <<<"$tx"); data=$(jq -r .data <<<"$tx")
  [ "$(cast calldata "$sig" $args)" = "$data" ] && r=OK || r=MISMATCH
  echo "$r $to $sig $args"
done
```

   Every line must say `OK`. Batch Q carries a tuple argument (the route struct), which this loop cannot
   rebuild; for it run `npx ts-node -e 'require("./scripts/make-safe-batch").verifyBatchFile("<batch>", <chainId>)'`
   (re-encodes every call from its decoded values, tuples included) and read each tuple in the Builder.
   Then compare each `to` and each address argument with the deployment record
   of **that chain** (the collisions in 0.1 are real) and with the tables in this document.
2. `jq -r .chainId <batch>` is the chain you are signing on.
3. In the Safe Transaction Builder the imported batch shows the same method names and values; the Safe
   executes it as one MultiSend, all or nothing.
4. After execution, run the read-backs listed with each step. A read that disagrees right after execution
   is re-read after a few seconds before it is called a failure.

## 4. Explorer verification

The manifest is `config/verification/mainnet-contracts.json`. The Robinhood generation script adds its two
adapters; every other new contract is added by hand with its constructor arguments:

| Contract | Constructor arguments |
|---|---|
| TreasuryRouterV4 | Safe, weekly, monthly, `3600` |
| CreatorRewardsVaultV2 | Safe, router, wrapped native, `1` (BNB) or `2` (RH), DEX factory, `86400` |
| RewardDistributor (holders) | Safe |
| LaunchCampaign, BnbQuoteLaunchCampaign, LaunchTokenDeployer, RobinhoodStockLaunchCampaign, CreatorRegistry, RiskRegistry | none |
| PermanentLpLocker / PermanentV3PositionLocker | factory |
| BnbBasicLaunchFactory | Topaz adapter `0x5c3135Df…`, router, LaunchCampaign impl, oracle, BnbQuoteLaunchCampaign impl, locker |
| LaunchFactory (RH) | native adapter, router, LaunchCampaign impl, oracle, locker |
| BnbNativeGraduationAdapter | Topaz pool factory, WBNB, locker |
| BnbQuoteGraduationAdapter | Safe, Topaz router `0x1E98c822…`, locker, BNB/USD feed, `3600` |
| RobinhoodV3NativeSwapAdapter | SwapRouter02, WETH |

```
ONLY=<names> npx hardhat run scripts/verify-mainnet-contracts.ts --network bscMainnet   # BscScan (Etherscan v2 API key)
ONLY=<names> node scripts/sourcify-verify.mjs 4663                                     # Robinhood via Sourcify
```

Commit the manifest. Verification changes nothing on chain; it can run any time after deployment, but do
it before opening so users can read the code.

## 5. Services

Redeploy order after the env is set: indexer, then API, then app. Branch: fast-forward the live branch to
the release branch first (`git merge-base --is-ancestor origin/build/cross-chain-stabilization-rh-base
origin/build/evm-launch-staging` must succeed; it did on 2026-10-01).

### 5.1 API (`api.memewar.zone`)

| Name | Value |
|---|---|
| `VITE_FACTORY_ADDRESS_56` and `FACTORY_ADDRESS_56` | new BNB factory (the create signer `frontend/api/dev-fix/route-auth.js` reads the `VITE_` name first, so both must be the new one) |
| `VITE_FACTORY_ADDRESS_4663` and `FACTORY_ADDRESS_4663` | new Robinhood factory |
| `EVM_CREATOR_VAULT_V2_56`, `EVM_CREATOR_VAULT_V2_4663` | the vaults |
| `EVM_CREATOR_CHOICE_API_SECRET` | the secret from 0.5 |
| `EVM_CAMPAIGN_STATE_CACHE_MS`, `EVM_FIRST_BUY_MAX_COST_SLACK_BPS` | optional (defaults 10000 ms and the built-in slack) |
| route authority key | unchanged (`0xb989A998…`); the 6/5 pair is already in `ALLOWED_GENERATION_PAIRS` |
| `ARENA_WAR_POOL_TREASURY_V2_ADDRESS_*` | unchanged (the live war pools stay; D3 closed) |

### 5.2 Indexer (keeper and worker run inside it)

| Name | Value |
|---|---|
| `FACTORY_ADDRESS_56`, `FACTORY_ADDRESS_4663` | new factories |
| `SUPPORTED_FACTORY_ADDRESSES_<id>` / `SUPPORTED_FACTORY_START_BLOCKS_<id>` | the existing list plus the new factory and its deploy block |
| `TREASURY_ROUTERS_EXTRA_56`, `TREASURY_ROUTERS_EXTRA_4663` | `<V4>@<deploy block>` (appended to the known V3/V2 routers; recruiter credit source) |
| `EVM_CREATOR_VAULT_V2_<id>` | `<vault>@<deploy block>` |
| `EVM_GEN5_LP_LOCKERS_<id>` | `<locker>@<deploy block>` (keeper harvest reads this) |
| `EVM_GEN5_FACTORIES_<id>` | new factory (optional; forces generation 5 without an RPC call) |
| `EVM_GRADUATION_KEEPER_ENABLED_56` / `_4663` | `true` (Robinhood only when its chain is done) |
| `EVM_GRADUATION_KEEPER_SEND` | `false` first. One flag for every enabled chain |
| `EVM_GRADUATION_KEEPER_PRIVATE_KEY` | keeper key |
| `EVM_KEEPER_HARVEST_INTERVAL_SEC` / `_MIN_GAS` / `_MAX_PER_PASS` | defaults 21600 / 2,000,000 / 10. Never lower the gas floor: a harvest sent with the bare estimate reverts (`InsufficientSaleGas`, audit F9; seen on 46630) |
| `EVM_KEEPER_V3_OBSERVATION_SLOTS_4663` | default 180 |
| `EVM_CREATOR_CHOICE_ENABLED_56` / `_4663` | `true` (same rule) |
| `EVM_CREATOR_CHOICE_SEND` | `false` first. One flag for every enabled chain |
| `EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY` | operator key (D1); nothing is sent while it is not the vault's `operator()` |
| `EVM_BUYBACK_SEED_SECRET` | from 0.5 |
| `EVM_CREATOR_CHOICE_API_URL` / `EVM_CREATOR_CHOICE_API_SECRET` | `https://api.memewar.zone` / same secret as the API |
| `EVM_HOLDER_CLAIM_WINDOW_DAYS` | `60` |
| `EVM_HOLDER_BATCH_MAX_WEI_<id>` | optional, below the Safe's per-batch max (32 BNB / 9.3 ETH) |
| `BSC_RPC_HTTP_56`, `ROBINHOOD_RPC_HTTP_4663` | existing |

Because `_SEND` is one flag for all enabled chains, enable Robinhood (`_ENABLED_4663`) only when it has
reached the same point BNB has.

Log lines to expect after redeploy: `[evm-grad] enabled { chainId: 56, send: false, keeper: 0x… }` and the
creator-choice worker's enabled line with `send: false`; `[evm-grad] keeper key refused` means the key is
on the forbidden list.

### 5.3 App (`app.memewar.zone`)

| Name | Value |
|---|---|
| `VITE_FACTORY_ADDRESS_56`, `VITE_FACTORY_ADDRESS_4663` | new factories |
| `VITE_SUPPORTED_FACTORY_ADDRESSES_<id>` | old list plus the new factory, so old coin pages keep resolving |
| `VITE_TREASURY_ROUTER_ADDRESS_<id>` | V4 |
| `VITE_PERMANENT_LP_LOCKER_ADDRESS_<id>` | new locker |
| `VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_<id>` | new `LaunchCampaign` implementation |
| `VITE_CREATOR_REGISTRY_ADDRESS_4663`, `VITE_RISK_REGISTRY_ADDRESS_4663` | the new Robinhood registries (BNB keeps its registries) |

The generation 6 screens (first buy, fee choice, anti-sniper line, escrow, graduation state) switch on the
factory's own generation; there is no feature flag. Which other `VITE_*` addresses the create and coin
pages read for generation 6 is **to verify** against `frontend/src/lib/bnbContracts.ts` and
`deploymentConfig.ts` on the release build (`scripts/verify-live-app-bundle.mjs`).

## 6. Canary (your wallet, small amounts, per chain)

Run after batch H (section 7) and the service redeploys; until you are satisfied, nobody else knows the
generation is open, and any failure is followed by `setCreatePaused(true)` from the Safe.

1. Create one coin on the site, $15,000 target, with a small first buy (for example 1% of supply).
   BNB: fee choice keep. Robinhood: fee choice holders (exercises the worker's dry run). One wallet signature.
2. Wait 60 s (the anti-sniper window), then buy about 0.01 BNB / 0.003 ETH and sell half from the token page.
3. Check each trade on the explorer, by transfer logs, not events alone:
   - fee exactly 2% after the window (during it `200 + 4800 x left/60` bps);
   - router V4 split: league 37.5% (weekly/monthly), creator vault 5.6%, community 15% (unlinked), protocol 41.9%;
   - the first buy paid the flat 2% and the tokens sit unlocked in your wallet;
   - a later buy by the creator wallet goes to the escrow, not the wallet.
4. `GET https://api.memewar.zone/api/evm/campaign-state?chainId=<56|4663>&campaign=<campaign>&wallet=<your wallet>` shows generation 5, the fee
   choice and the escrow; the coin page shows the launch fee line and creator panel.
5. Indexer: the campaign row has `factory_generation = 6`, the trades have `fee_bps` and `league_excluded`
   true on the creator's buys; the keeper logs the coin as idle (not due); the worker (Robinhood coin)
   logs its week commitment and snapshot decisions with nothing signed.
6. BNB coin: claim the creator fees from the Claims panel; the amount equals the sum of `TradeFeeAccrued`.

Graduation cannot be canaried cheaply: the smallest target is $15,000. The first graduation is watched
live instead (section 8). Switch sending on when the canary looks right:

7. `EVM_GRADUATION_KEEPER_SEND=true`, redeploy the indexer, and confirm the keeper still logs idle
   decisions with `send: true`. Anyone can call `graduate()` anyway; the keeper only makes it prompt.
8. `EVM_CREATOR_CHOICE_SEND=true` once the first week commitment is published
   (`GET /api/evm/creator-choice?chainId=`).

## 7. Opening

Per chain, after R5 (Robinhood) and the ownership handover:

1. Safe batch H (calls file then `make-safe-batch.ts`):

```json
[
  { "contract": "LaunchFactory", "to": "<F>", "fn": "enableLive", "args": [] },
  { "contract": "LaunchFactory", "to": "<F>", "fn": "setCreatePaused", "args": [false] }
]
```

   On BNB use contract name `BnbBasicLaunchFactory`; add `0xc378221E….setCreatePaused(true)` if D2 is
   agreed. `enableLive` has no inverse: after it, create is
   the only gate.
2. Read back: `live()` true, `createPaused()` false; the old factory `createPaused()` true (batch A).
3. Services already point at the new factory (section 5); run the canary (section 6).
4. The old factories stay paused. They cannot be reopened safely once a generation 6 coin exists (section 8).

## 8. Stop switches and rollback

| Failure | Stop | Who | Effect |
|---|---|---|---|
| A deploy script fails midway | nothing to stop: everything it deployed is create-paused and unwired | you | read the record and the chain; do not re-run the fees script (no resume, it deploys a new stack); re-running the generation script deploys a fresh set, the half set is inert |
| After batch A, the generation cannot be finished today | reopen the old generation: `CommunityRewardsVault.setRouter(<old V3>)` then old factory `setCreatePaused(false)` | Safe | valid only while no generation 6 coin exists |
| New creates must stop | `setCreatePaused(true)` on the new factory | Safe | existing coins keep trading |
| One coin misbehaves | `setCampaignPauses(campaign, paused, buys, sells, graduation)` on the factory | Safe | that coin only |
| All generation 6 trading must stop | `TreasuryRouterV4.setForwardingPaused(true)` | Safe | strict routing reverts every buy and sell of every coin on V4; graduated pools still trade on the DEX |
| Keeper misbehaves | `EVM_GRADUATION_KEEPER_SEND=false` or `_ENABLED_<id>=false`, redeploy indexer | you | graduation stays permissionless; every send is recorded before broadcast, so a restart resumes rather than repeats |
| Creator-choice worker misbehaves | `EVM_CREATOR_CHOICE_SEND=false`; on chain `CreatorRewardsVaultV2.setOperator(<op>, true)` pauses every operator path | you / Safe | holder money waits in the vault |
| A bad holder batch was proposed | `vetoHolderBatch(batchId)` | Safe | amounts return to the coins' holder balances and free the weekly cap (F7) |
| Operator key leaked | `setOperator(<new>, false)` | Safe | a stolen key can only time buybacks within the caps; it cannot pay itself (F5) |
| Route authority key leaked | `setRouteAuthority(<new>)` on the factory, new key on the API | Safe / you | signed creates and trades need the new key |
| API down | none needed | | pre-graduation trading on the site stops (trades are server-signed); graduated pools trade on the DEX |

Two things cannot be rolled back and are the reason for the fork rehearsal: the router's creator vault
and the vault's router are set once (F1), and the community vault serves one router, so after the first
generation 6 coin the old generation cannot be reopened without breaking every unlinked trade of the new
coins.

## 9. Weekly and monthly operations

### 9.1 Holder batch (weekly, both chains)

Monday from 00:05 UTC the worker proposes last week's holder batch and publishes its leaf file. A signer then:

```
node scripts/evm-holder-batch-verify.mjs --chain 56 \
  --file "https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=<Monday of the week>" \
  --auth-max 32000000000000000000 --out holders-56-<week>.safe-batch.json
node scripts/evm-holder-batch-verify.mjs --chain 4663 \
  --file "https://api.memewar.zone/api/evm/holder-batch?chainId=4663&weekId=<week>" \
  --auth-max 9300000000000000000 --out holders-4663-<week>.safe-batch.json
```

It recomputes the root and total from the leaves, checks the vault's `HolderBatchProposed` and the proposing
calldata, each coin's choice, the vetoed/executed state and the cap, and only then writes batch W
(`approveHolderBatch` + `authorizeBatch(id, total, now, now + 6 days)`). Any mismatch refuses. Check the
batch with 3.1, sign, execute. After the vault's 24 h veto window the worker executes it and the Claim
Center rows open. Nothing pays without this weekly Safe step.

### 9.2 Unclaimed holder payouts (E19, monthly from the first expired batch)

Built (`scripts/make-holder-recovery-batch.ts`, rehearsed by `test/HolderRecoveryBatch.spec.ts`). After a
holder batch's 60-day claim deadline, one Safe transaction per batch, all or nothing:
`RewardDistributor.recoverUnclaimed(batchId, Safe)` then `CreatorRewardsVaultV2.creditUnclaimedHolders{value}(campaigns, amounts)`,
which puts each coin's unclaimed part back into that coin's holder balance (from the leaf file's per-campaign
`parts`). The script refuses before the deadline, when already recovered, when the leaf file is not the batch
on chain, or when the attribution does not sum exactly to the unclaimed amount.

```
HOLDER_RECOVERY_FILE="https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=<Monday of the week>" \
  npx hardhat run scripts/make-holder-recovery-batch.ts --network bscMainnet
HOLDER_RECOVERY_FILE="https://api.memewar.zone/api/evm/holder-batch?chainId=4663&weekId=<week>" \
  npx hardhat run scripts/make-holder-recovery-batch.ts --network robinhoodMainnet
```

Read-only; it writes the Safe batch under `deployments/<chain>/` when there is something to recover. Check it
with 3.1, sign, execute. Run it monthly for every batch whose deadline has passed; the first deadline falls
about 60 days after the first executed holder batch (early December 2026 at the earliest).

### 9.3 Airdrop recovery (existing, unchanged)

`npx hardhat run scripts/make-airdrop-recovery-batch.ts --network bscMainnet` (and `robinhoodMainnet`),
monthly from late November 2026. It reads the community vault's router from chain, so after batch A it
restores V4, not V3. It covers the airdrop distributor, not the holder distributor.

### 9.4 Cap reviews

Monthly, or when BNB or ETH moves by more than 25% from $767 / $2,695:

1. `node scripts/check-evm-payout-bounds.mjs` (read-only; defaults to the current monthly vaults
   `0x42D254A7…` / `0x576c1d6B…`). With `deployments/<chain>/mainnet.evmgen-fees.json` on disk it also prices
   each `CreatorRewardsVaultV2.limits()` (buyback per tx, per coin per week, holder batches per week),
   range-checks the interval (60 s..30 d) and the impact cap (1..50 bps), and prices every open holder
   authorization on the distributor (none may exceed the weekly holder cap). Exit 1 means a bound is outside
   $1..$1,000,000 or a rule is broken.
2. To change: one-call batch `CreatorRewardsVaultV2.setCaps(maxBuyPerTx, maxBuybackPerCampaignWeek,
   minBuyInterval, maxImpactBps, maxHolderBatchPerWeek)` in wei; `maxImpactBps` above 50 is refused.
   The per-batch Safe maximum (`--auth-max`) is off chain; keep it equal to `maxHolderBatchPerWeek`.

### 9.5 Keeper and operator gas

Top the keeper and the operator up when either drops under 0.005 BNB / 0.001 ETH. On Robinhood,
`block.number` inside the EVM is the parent-chain block, so a locker sells MEME at most once per parent
block; a second harvest in the same parent block only carries it (seen on 46630, not a fault).

## 10. Open items and "to verify"

Open decisions (founder):

1. **D1 operator key** (0.6): a dedicated creator-choice operator avoids nonce collisions with the API's
   payout sends; batch B carries it when `EVMGEN_VAULT_OPERATOR` is set.
2. **D2 BNB factory `0xc378221E…`** (generation 3/2, 1 campaign, create open): batch A does not affect its
   coin (fork, 0.7); pausing its create is optional, in batch H.
3. **E14 vs batch A timing**: the founder decision keeps the old factories open until the new generation
   replaces them; batch A closes them at the start of each chain's session because the community vault
   serves one router. Both factories batch A pauses hold 0 campaigns, so nothing existing is affected, but
   creation on that chain is closed from batch A to batch H.

Still to verify or watch:

4. **BNB harvest MEME sale (E9)** was not observed on BSC testnet (its Topaz has no `quote()`) nor on the BNB
   fork rehearsal (the fresh pool had no 30 min TWAP at the harvest: fail closed, MEME carried, WBNB 80/20
   exact). Proven on the BSC fork specs; on the Robinhood fork the MEME side was sold. Watch the first
   mainnet BNB harvest: MEME sold, then exactly 80/20 in WBNB.
5. **Migrations on staging**: whether all seven are applied (section 1).
6. **App `VITE_*` completeness** for generation 6 pages (5.3).
7. **Stock- or quote-bound coin end to end**: the fork configured all nine Robinhood routes as the Safe
   (batch Q), but the coin it graduated was native. No stock-bound coin has graduated on a generation 6
   deployment yet; the adapter specs and `test/evmgen-rh-graduation.fork.spec.ts` cover it.

Closed 2026-10-01: the fork rehearsal (0.7); the Robinhood L1 data fee (0.3, negligible at today's L1
price); batch B script (`EVMGEN_BATCHES_ONLY=1`, 2.4); D3 (no unused war pool and league); stock and quote
routes as Safe batches with a policy the V2 adapter accepts (batch Q, section 3); E19 recovery (9.2);
`check-evm-payout-bounds.mjs` (current monthly vaults, vault V2 limits, holder authorizations, 9.4).
