# Go-live log, 2026-10-01

One place for every change made on go-live day: on chain, Safe, services, database and code.
Append to it; never rewrite an entry. Branch: `release/all-chains`. Live branch:
`build/cross-chain-stabilization-rh-base` (fast-forwarded to the release branch each push).

## 1. On chain (mainnet)

### BNB (56)
| What | Address / tx | Read back |
|---|---|---|
| TreasuryRouterV4 | `0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa` (block 125085243) | admin Safe, creator 560 bps |
| CreatorRewardsVaultV2 | `0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66` (block 125085249) | router V4, factory 0x1948411B |
| Holder RewardDistributor | `0xD106198Ca83c26f4B43c9DF7368F134f0Cd46cc1` | owner Safe |
| BnbBasicLaunchFactory (gen 6/5) | `0x1948411B84424f6f67fDf83ce4A9b8ED49c8bF4F` (block 125129400) | owner Safe, live, open |
| PermanentLpLocker | `0xEEEfa12B14ea922B21bAf05Ad4aa79B2643c8eA6` | authorized + primary on V4 |
| LaunchCampaign impl | `0x1abD944215B9a2632E0A33BBa9e259548D9bbDFB` | |
| BnbQuoteLaunchCampaign impl | `0xbC46EC1687Da43FEe36498d88d60cC4605bb9960` | |
| BnbNativeGraduationAdapter | `0x1f71f2833a305eFa8902705e6131342261D32A63` | admin deployer (immutable, by design) |
| BnbQuoteGraduationAdapter | `0x15404d5e37cda82C421e25B5429417EC22C5329d` | admin Safe, factory bound |
| LaunchTokenDeployer | `0xA590A8c3051dBd5E83B250191eBaCD07C10eCFeF` | |
| Old factories | `0x632061cA…`, `0xc378221E…` | createPaused true |

### Robinhood (4663)
| What | Address / tx | Read back |
|---|---|---|
| TreasuryRouterV4 | `0x49Ae38B19664d90b410AE860B9604e1Bc5f7Ab5d` (block 77307987) | admin Safe, creator 560 bps |
| CreatorRewardsVaultV2 | `0xEDCC2667365F116b9971Cc02f198470BE23a5651` (block 77308016) | router V4, factory 0xc673B116 |
| Holder RewardDistributor | `0x0Bf17e4bF2Ef1f4737d1e8cF95170D814e36A023` | owner Safe |
| LaunchFactory (gen 6/5) | `0xc673B116b4eA8E8923Aad1fa60F0452966F2437F` (block 77504664) | owner Safe, live, open |
| PermanentV3PositionLocker | `0x615b1AbE348edA2e5a44eCe32fb50fbC45d2AF07` | authorized + primary on V4 |
| LaunchCampaign impl | `0x948463E91d63a7A51cEeC0342735D1B738044aea` | |
| RobinhoodStockLaunchCampaign impl | `0x1e463947d28f2c878312139b87aD482a614F1cDC` | set on factory (R5) |
| RobinhoodV3NativeGraduationAdapterV2 | `0x52A47A33930B8a90a2000b1bA3CB96e879569670` | admin Safe |
| RobinhoodStockGraduationAdapterV2 | `0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4` | admin Safe |
| RobinhoodV3NativeSwapAdapter | `0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296` | |
| CreatorRegistry / RiskRegistry (new) | `0xAE3D6d8cde4daD5D835D7B487298F09Ec5b41589` / `0x174E4d5AF15dF8e600E2025acbd33B52485cEcA4` | owner Safe |
| LaunchTokenDeployer | `0x1030aD424D7D7bDa569035F6BAf40642AEBF3AC8` | |
| Old factory | `0x35E93D0b…` | createPaused true |

Several addresses repeat across chains (same deployer, same nonces): always pair an address with its chain.

### Safe `0x1edcEdf5…` batches (each re-encoded OK and executed as the Safe on a fork first)
| Batch | BNB tx | Robinhood tx |
|---|---|---|
| A: router V4 vaults, community vault -> V4, distributor, caps, old factory paused | `0xee43b688…` (nonce 14) | `0x025b62a8…` (nonce 9) |
| B: locker authorized, vault factory pin, launch recorder, adapters, operator `0x2065…` | `0x590ea096…` (nonce 15) | `0xb3912ce9…` (nonce 10) |
| R5: stock campaign implementation | n/a | `0x471ba0a7…` (nonce 11) |
| H: enableLive + create open; old factories paused | `0x6771494a…` (nonce 16) | `0xa9293de3…` (nonce 12) |

EVM test coins (founder wallet `0x1A36…`): BNB MWZBNB campaign `0x49ac80f9…` / token `0x5d5bea01…`;
Robinhood MWZRH campaign `0x404d723d…` / token `0x3765d716…`. Create + first buy + sell work on both; fee 2%.

Ownership to the Safe (deployer txs): BNB factory `0xb4f6a72a…`; Robinhood factory `0x7a0228a9…`,
CreatorRegistry `0x3e9f10c4…`, RiskRegistry `0xcdd78f3a…`.

### Solana
- Meteora DBC launch type live behind canary mode. Test coins: MWZDNB (pool `4xPQpj…`), DNB (pool `GkFyug…`),
  plus MWZTC on the old launchpad (pool `79cJNJ…`, launched from a stale tab).
- Anti-sniper start fee 50% -> 90% for configs created after `c03e4e7d` (proven on DNB: a bot at t+54 s paid 10.80%).
- All fees on MWZDNB reconciled to the lamport: 80% to our collector `3NWt…`, 20% Meteora.

### Explorer verification
- Fees stack: BscScan 3/3, Sourcify 3/3.
- Gen-6 contracts: BscScan 7/7 Pass; Sourcify 10/10 match on Robinhood.
- Every gen-6 contract's creation input equals our artifact bytecode + constructor args (checked from chain).

## 2. Key incident: DBC referral owner key exposed

`VITE_DBC_REFERRAL_TOKEN_ACCOUNTS` on the app held the referral owner's private key instead of the address
map, so it shipped in the public JS bundle. Exposure: owner `C1UCui…` (0.039 SOL) and 7 empty referral accounts.
Rotated: new owner `4T7q9fkgnUe1nsB8xXgwwJ4q1oXE6Pv854uPJzNDDz3n`, 7 new referral accounts (map in Coolify).
Bundle re-checked: no 64-byte key arrays. **Open:** move the remaining 0.039 SOL off `C1UCui…`.

## 3. Services and env (Coolify)

- RPCs moved to Chainstack (BNB, Robinhood). Indexer log prints the BNB RPC URL including its key: mask later.
- Release env set (runbook 2.2): DBC secrets, referral map, workers `_SEND=false`, `CREATE_CANARY_WALLETS`.
- Gen-6 addresses (B14): `FACTORY_ADDRESS_*`, `VITE_FACTORY_ADDRESS_*`, `EVM_GEN5_FACTORIES_*`,
  `EVM_GEN5_LP_LOCKERS_*` (`0xEEEf…@125129400`, `0x615b…@77504664`), supported-factory lists appended,
  `EVM_GRADUATION_KEEPER_ENABLED_*` and `EVM_CREATOR_CHOICE_ENABLED_*` true, both `_SEND` false; app VITE router,
  locker, implementation and Robinhood registries.
- App nginx: security headers (frame-ancestors none; `/embed/chart/` allows crypticpump.com).

## 4. Database (production, all run by the founder)

- 18-migration bundle (`docs/release/all-chains-migrations.sql`), vote battle 48 h, `social_posts` (+ RLS).
- MWZDNB candles rebuilt from chain (`node dist/jobs/rebuildDbcCandles.js … --apply`, 30 candles).
- Solana test coins hidden (`meta.publicHidden = true`): MWZTC, MWZDNB, DNB. K88 stays visible.

## 5. Code fixes shipped today (release branch, live after each push)

| Commit | Fix |
|---|---|
| `10807fe1` | battle card art collapsed to a sliver on mobile |
| `618de2dd` | big live countdown with seconds between the two coins |
| `4050b1e4` | indexer build ships the Meteora DBC IDL (container died at boot) |
| `aad7715d` | Upvotes tile read a 404 and stale 24 h windows |
| `230e9e13` | Solana coins missing from the live ticker |
| `4db31c49`, `bd17657d` | Phantom blocked DBC create / locked buy: wallet now signs before other keys |
| `ca0f32f9` | a version 1 Solana transaction stalled the DBC indexer; later trades never indexed |
| `c03e4e7d` | DBC anti-sniper 90% start |
| `93e99720`, `c79b4344`, `320badd6` | DBC market cap, Deployed, Flywheel, chart supply (wrong column name hid every DBC price) |
| `f260e065` | creator profile lists the creator's DBC coins |
| `904e504c` | new DBC coins announced live to the front page |
| `153c792f`, `1986d774`, `aac9f213` | live chart without reload on every chain; DBC candles at pool spot; old Solana indexer no longer deletes DBC candles; render loop fixed |
| `1694840d` | Solana card bonding % fell to 0% when the first RPC refused (K88) |
| `958590b3` | Safety pill removed from the token page |
| `59b09972` | EVM create/buy/sell refuse when the wallet is on another chain (value would be lost) |
| `ee695e76`, `4625bd72` | gen-6 market cap fully diluted on page, cards, ticker; chart opens at start price |

## 6. Decisions taken today

- Boosts: unlimited per wallet, state the rule clearly on the site (more boosts = bigger prize pool).
- DBC anti-sniper 90% start on Solana; EVM keeps 50% until its next contract.
- DBC test coins hidden, not deleted.
- Market cap for the new generations (EVM gen 6/5, Meteora DBC) = price x total supply (fully diluted, like
  pump.fun). Old coins (K88, BNB/Robinhood gen <= 5) keep price x sold. Battle scoring (percentages) unchanged.
- Safety pill removed from the token page (`958590b3`).

## 6b. Opening (2026-10-01 evening)

- DBC fee routing live (`DBC_FEE_ROUTING_SEND=true`): first run 19:07 UTC claimed MWZDNB 0.715 SOL and DNB's partner fee,
  routed 0.6715 SOL: monthly league 0.2369, weekly league 0.1015, airdrop 0.1353, protocol 0.1977 (D4 split, checked);
  MWZDNB's 7% creator pool (~0.05 SOL) stays with the collector for its buyback.
- `DBC_GRADUATION_SEND=true`, `EVM_GRADUATION_KEEPER_SEND=true` (founder). Creator-choice `_SEND` flags stay false this week.
- All worker keys funded (collector 0.5 SOL, config payer 0.29 SOL, keeper 0.0199 BNB / 0.0051 ETH, operators funded).
- Test coins hidden on all chains (MWZTC, MWZDNB, DNB, MWZBNB, MWZRH).
- **Public opening: `CREATE_CANARY_WALLETS` removed, `/api/launch-status` = `{"canary":false}`.** Live and API at `16d6d405`.

## 6c. Robinhood stock routes (batch Q)

- Safe tx `0x3b71783d359647ff0175c2b35b669d41898f713887fe97b31978433895fa03a0`, block 77631362, status 1
  (ExecutionSuccess). 9 `configureStockRoute` on stock adapter V2 `0xfF64Bd69…` + 9 `setQuoteRoute` on
  CreatorRewardsVaultV2 `0xEDCC2667…`.
- Read back from chain: SPY, NVDA, META, COIN, SPCX, TSLA, QQQ, AAPL, USDG enabled, oracle and pool equal
  to the registry env, vault route pool equal. MSTR, MU, GLD, SGOV, GME, CRCL have no route (below the
  liquidity floor when Q was built) and cannot be offered.
- Factory `0xc673B116…` -> adapter `0xfF64Bd69…` (locked to the factory), stock impl `0x1e463947…`,
  same locker `0x615b1AbE…` on factory and adapter.
- App side: the registry rows still carried "route disabled" from the 19:00 UTC health check. Needs a
  rescan in the API container, then a 10-minute `--routed-only` scheduled task (certification is valid
  900 s). `ROBINHOOD_STOCK_TOKEN_REGISTRY_4663` is read only by the indexer, not by the API.
- First rescan: all 8 registry stocks `review`, "launch-size price impact exceeds policy (19 > 0 bps)".
  Cause: adapter V2 requires `maxPriceImpactBps`/`maxOracleDeviationBps` = 0 (reserved), the API
  certification still read them as limits. Fix: for V2 routes the certification compares the
  launch-size QuoterV2 output with the adapter's own `oracleMinimumStockOut` (what `graduate` enforces,
  100 bps slippage cap). Checked against mainnet at 11.2 ETH: SPY, NVDA, META, COIN, SPCX, QQQ, AAPL,
  USDG pass; TSLA fails (pool 187 bps under the oracle, a graduation would revert), correctly.
- USDG has a route but no row in `robinhood_stock_token_registry` (the sync pulls Robinhood's stock
  list only), so the app does not offer it yet. Open.

## 7. Open items

- [x] EVM gen-6 token page: fully diluted market cap, chart from start price (`ee695e76`, `4625bd72`), founder-checked on both chains.
- [x] War Trade Room gen-6: fully diluted rows/ATH/chart, liquidity = curve reserve, Robinhood bonding coin no longer on the BNB panel (`5a590f68`, `22a652ad`).
- [ ] War Trade Room: trading a Robinhood bonding coin inside the row (today a link to its token page; needs a new panel).
- [ ] Holder count on cards/War Room = distinct buyers (BNB test coin shows 1, chain 0).
- [ ] Create page: BNB/Robinhood switch in MetaMask can make the page use the other chain's factory (must-fix).
- [ ] `VITE_SUPPORTED_FACTORY_ADDRESSES_56/_4663` on the app hold only the new factories; append the old ones.

- [x] EVM canary coins on BNB and Robinhood (B16) and public opening (B18).
- [ ] Creator-choice workers to sending (`DBC_CREATOR_CHOICE_SEND`, `EVM_CREATOR_CHOICE_SEND`) after the first week commitment.
- [ ] Move 0.039 SOL off the leaked referral owner `C1UCui…`; rotate the Helius key pasted in chat.
- [ ] League pot: check whether DBC trades are counted in the chain-101 pot before Monday's settlement.
- [ ] Site copy: state the boost rule; mask RPC keys in indexer logs; front-page cards for Solana/DBC get live market cap.
- [ ] Higher DBC starting market cap (curve starts at ~$92): decision for after go-live.
- [ ] Solana indexer health counter reports DEGRADED although trades ingest.
