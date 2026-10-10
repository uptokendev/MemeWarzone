# DogeOS sub-project 1: Foundation + Launch (Chikyū testnet)

Date: 2026-10-10 · Branch: `feat/dogeos-testnet` · Tracker: none

## Context

DogeOS is a Scroll-based zkEVM L2 for Dogecoin. Its only network is the Chikyū testnet, chain `6281971`.
No mainnet chain ID or date has been announced. This spec is the first of four DogeOS sub-projects:

| # | Sub-project | Depends on |
|---|---|---|
| 1 | **Foundation + Launch** (this spec): chain identity, gen-7 contracts, create/buy/sell/graduate on testnet | — |
| 2 | ~~Official DEX adapter~~: folded into sub-project 1 (MuchFi graduation, 2026-10-10) | — |
| 3 | Arena on 6281971: battles, leagues, vote treasury, war pools | 1 |
| 4 | DogeOS SDK / MyDoge wallet (needs a partner `clientId`) | — (parallel) |

Prior work on `origin/grok/dogeos-chikyu` (commit `d1563735f`) and its build-plan were written by a
third party. They are **not** a source of truth. Every chain fact below was re-verified on 2026-10-10
with read-only RPC calls, explorer API calls and docs.dogeos.com.

## Verified chain facts (2026-10-10)

| Fact | Value | Evidence |
|---|---|---|
| Chain ID | `6281971` (`0x5fdaf3`) | `eth_chainId` on both HTTP RPCs |
| HTTP RPC | `https://rpc.testnet.dogeos.com`; alt `https://dogeos-testnet-public.unifra.io/` | answered, reth/v2.0.0 |
| WS RPC | `wss://ws.rpc.testnet.dogeos.com` | `eth_chainId` over WS |
| Native | DOGE, 18 decimals | SDK config docs; WDOGE balance = totalSupply |
| Block time / gas limit | 3.0 s / 10M | 5000-block sample; Blockscout stats |
| Fees | EIP-1559 (flat base fee ~0.0157 gwei, tip 100 wei) **plus** an L1 "data & finality" fee charged by size | `eth_feeHistory`; `L1GasPriceOracle` `0x5300…0002` `getL1Fee` |
| `eth_getLogs` | at most 10,000 blocks **and** at most 10,000 results per call | RPC error texts |
| Reorgs / finality | max reorg depth 17 blocks; `safe` lags ~1059 blocks, `finalized` ~1217 (about 1 h) | docs; tag queries |
| EVM | solc 0.8.24 bytecode (our build targets paris; cancun also probed) runs: PUSH0, TSTORE/TLOAD, MCOPY, BASEFEE, CHAINID all work. Disabled: SELFDESTRUCT, BLOBHASH, BLOBBASEFEE. PREVRANDAO = 0. COINBASE = fee vault. Precompiles RIPEMD-160, blake2f and point-eval revert; modexp only for inputs ≤ 32 bytes | `eth_call` probes; docs |
| Docs recommendation | prague, solc ≥ 0.8.30 (advice; not enforced) | developer quickstart |
| Wrapped native | WDOGE `0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE`: WETH9-style `deposit`/`withdraw`/`receive` + permit, verified source `src/dogeos/WrappedDoge.sol` | explorer source, selectors in bytecode |
| Faucet mock tokens | LBTC, WETH, USD1, USDC, USDT: owner-mintable, **all 18 decimals** (including USDC/USDT) | `eth_call` |
| Multicall3 | present at `0xcA11bde05977b3631167028862bE2a173976CA11` | `eth_getCode` |
| DEX | **No official DEX.** BarkSwap is promoted but publishes no addresses. Only unofficial UniV3/V4 deployments with ~0 txs exist | web + Blockscout search |
| Explorer / verify | L2Scan `https://dogeos-testnet.l2scan.co`, Etherscan-style `/api`; also `https://blockscout.testnet.dogeos.com` | `getabi` calls |
| Faucet | `https://faucet.testnet.dogeos.com`, 42.069 DOGE per 24 h, accepts a pasted address | funding tx `0x2eb60ae1…f919` |

Our contracts use none of the disabled opcodes or precompiles (grep of `contracts/`, excluding mocks
and comments).

## Goal

DogeOS Chikyū works end to end on the **TEST stack**: create → buy → sell → graduate → trade after
graduation, in native DOGE. It behaves like BNB and Robinhood: the same flows, rules, thresholds,
pages and terminology. Only the chain-specific parts differ (native asset, RPC, explorer, DEX).

## Scope

**In scope**
- The gen-7 contract set on 6281971 with unchanged bytecode, graduating into **MuchFi** (1% tier),
  plus the new contracts: a DOGE/USD testnet oracle and three MuchFi variants (graduation adapter,
  position locker, creator vault).
- 6281971 in every hand-kept chain list across app, API, indexer and staging DB, plus a guard test.
- Chain identity: native DOGE, RPC, explorer, add/switch chain for injected wallets (MetaMask, Rabby).
- Indexing, including graduated MuchFi trades, and a DOGE/USD price for display.
- Exposure on TEST only (test frontend, TEST API, TEST indexer, staging Supabase), plus the local
  hybrid dev setup pointed at the same.

**Out of scope**
- Sub-projects 3–4 above.
- Quote coins against the faucet mock tokens. Native DOGE is the only quote.
- Showing the L1 data & finality fee in our UI. Wallets show what they show.
- Any change to live (`build/cross-chain-stabilization-rh-base`), mainnet, Solana, or BNB/Robinhood
  contracts, config or behaviour.
- A shared chain-registry refactor. The chain lists stay hand-kept; the postponed refactor owns
  centralizing them.
- Reorg rollback or reconciliation in the indexer (see Indexer).

**Hard constraints**
- Factory, campaign and every other reused contract: bytecode identical to the audited gen-7 build
  (the only new bytecode is the oracle and the three MuchFi variants, each with an audit diff): solc 0.8.24, the existing `hardhat.config.ts`
  compiler settings, no DogeOS compiler profile.
- CREATE/BUY/SELL transaction flow and shape unchanged. The pins in the existing tests stay green and
  are never re-pinned.
- No transaction on Chikyū without an explicit founder go per gate (Verification gates 4 and 5).
- Staging SQL only. Production SQL is handed to the founder, never run.
- Do not change unrelated logic.

## Design

### 1. Contracts and on-chain

**Deployed unchanged (gen-7 bytecode): a complete fresh set**

The 46630 gen-7 deploy is **not** a template to copy. It reuses gen-6 infrastructure: WETH, the V3 set,
the USD feed, the graduation oracle, both registries, the swap adapter, the gen-6 factory, and the
weekly/monthly/recruiter/protocol vaults (`deployments/robinhood/testnet.gen7.json` `reused`,
`reusedVaults`). Its vault logic exists to supersede a gen-6 factory. DogeOS has none of that, so
everything is deployed fresh:
- **Launch:** `LaunchFactoryGen7`, the `LaunchCampaignGen7` implementation, and `LaunchTokenDeployer`.
  The factory reverts `NativeGraduationAdapterUnavailable` without the token deployer
  (`LaunchFactoryGen7.sol:505`). The `$150` test graduation target (`TEST_GRADUATION_USD_THRESHOLD = 150 ether`, line 190) is already allowed for 6281971
  (`isGraduationTargetAllowedForChain`, `LaunchFactoryGen7.sol:367-371`), so the factory needs no
  change.
- **Fees:** `TreasuryRouterV4` and its full vault set: weekly, monthly, recruiter, protocol and
  community rewards, the holder distributor, the airdrop distributor and a **fresh** main vault with
  an explicit testnet cap set in the deploy config. The 46630 helper derives the cap from a gen-6
  main pot, which DogeOS doesn't have.
  `RewardDistributor`, and the creator vault as its **MuchFi variant** (below).
- **Registries and price:** `CreatorRegistry`, `RiskRegistry`, the generic `GraduationOracle`.
- **Graduation and trading:** the graduation adapter as its **MuchFi variant** (below), and
  `RobinhoodV3NativeSwapAdapterV2` unchanged (no chain checks), pointed at MuchFi's SmartRouter.
- **Lockers:** the position locker as its **MuchFi variant** (below).
- **Not deployed:** `RobinhoodStockLaunchCampaignGen7` and every stock/quote adapter
  (`RobinhoodStockGraduationAdapterV2`, etc.). The factory's stock slots stay empty.

The plan derives the exact constructor and wiring order from the from-scratch shapes:
`scripts/local-gen7-stack.ts`, `test/fixtures/evmgen7Core.ts` and
`scripts/deploy-robinhood-gen7-generation.ts`. It must not inherit any reuse or supersede step.
The fork rehearsal (gate 3) proves the set is complete.

**Route authority:** the API holds one global `ROUTE_AUTHORITY_PRIVATE_KEY` and refuses create
authorization with `ROUTE_AUTHORITY_MISMATCH` unless it matches `factory.routeAuthority()`
(`frontend/api/dev-fix/route-auth.js:95`, global only).

Verified 2026-10-10: the TEST API has **no** route-authority key configured.
`/api/routing/status` reports `route_signer_missing` for 97 and 46630, whose factories expect
`0x2501cdC1…Bde0`. Founder decision: **a new DogeOS route-authority key**
(`DOGEOS_TESTNET_ROUTE_AUTHORITY_PRIVATE_KEY` in `config/dogeos.local`), address
`0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF`.
- The DogeOS factory's `routeAuthority` is set to its address at deploy.
- At gate 5 the founder sets it as the TEST API's global `ROUTE_AUTHORITY_PRIVATE_KEY`. Creates on 97
  and 46630 on TEST stay blocked, as they are today (a known item, out of scope).
- Before enabling live, `/api/routing/status?chainId=6281971` must report `signerConfigured: true`
  and `matchesOnchain: true`.
- The key never signs a transaction; it only signs authorizations. It is added to the keeper's and
  oracle push's forbidden-key lists.

Why graduation ships in this sub-project: a gen-7 campaign fixes its `graduationAdapter` and
`graduationOracle` at create time (`LaunchCampaignGen7.sol:322-339`). Coins created before a working
adapter exists would be bound to whatever adapter was set at that moment.

**Graduation venue: MuchFi CLMM** (founder decision 2026-10-10, replaces the own staging V3)

MuchFi is the DEX DogeOS coins graduate into. Facts verified read-only on Chikyū (2026-10-10) and from
MuchFi's docs (https://docsv2.muchfi.xyz/docs/home/contracts/clmm) and the founder's chat with MuchFi:
- A **PancakeSwap V3 fork**. Factory `0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B`, PoolDeployer
  `0x6c04e808d5FfFb597cb6a5b539f2a1dDF3529348`, NonfungiblePositionManager
  `0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5`, SmartRouter (SwapRouter02 shape, no deadline)
  `0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB`, SwapRouter (with deadline)
  `0xd34FE9553CE3012F81c8a7D86F3063AcADb8201c`, QuoterV2 `0x5DE1Ea595653419f295511DEb781b98387a77cc2`.
  All use the official WDOGE `0xF6BD…78aE`.
- Graduated coins use the **1% tier: fee 10000, tick spacing 200** (agreed with MuchFi; 3000 is not
  enabled). Pool creation is permissionless on every enabled tier.
- The LP position is an ERC-721 NFT, locked permanently in our locker as on Robinhood.
- MuchFi takes **32% of LP fees** at the pool (`feeProtocol` 3200 per side). Our locker receives the
  rest and splits it through the existing router/locker revenue mechanism, unchanged from Robinhood.
- **Trust caveats:** no MuchFi source is verified on any explorer, and one EOA
  (`0xDa4dD661…0056`) owns the factory and can change the protocol fee per pool. Accepted for testnet;
  a mainnet precondition is re-checking both.

**MuchFi variant contracts.** Three of our contracts swap directly on a pool and receive the pool's
callback, and MuchFi pools call `muchfiV3SwapCallback` instead of `uniswapV3SwapCallback`. MuchFi
`slot0()` also returns `feeProtocol` as `uint32` (value 209718400), which our `uint8` decode
rejects. So each of these gets a DogeOS-only **MuchFi variant**, a minimal diff from the audited
original:
1. **Graduation adapter**: from `RobinhoodV3NativeGraduationAdapterV2` + `RobinhoodV3PoolRepair`.
   Changes: callback name, `slot0` `uint32` decode, `POOL_FEE` 10000 / `TICK_SPACING` 200 (and
   full-range ticks), and the factory/NPM addresses it is constructed with.
2. **Position locker**: from `PermanentV3PositionLocker`. Changes: callback name, and its pool-swap
   library (below).
3. **Creator vault**: from `CreatorRewardsVaultV2`. Changes: callback name, and its pool-swap library
   (below).
4. **Pool-swap library**: the locker and the vault swap through the shared `EvmGenPoolSwap` library
   (`contracts/EvmGenPoolSwap.sol`), which decodes `slot0` with `uint8 feeProtocol`. It is an existing
   contract and stays frozen, so the variants use a **MuchFi copy** of it whose only change is the
   `uint32` `slot0` interface.

Rules for the variants:
- No other logic change: the callback body, checks and accounting stay byte-for-byte the original's
  logic; the only substitution inside them is the MuchFi pool-swap library for `EvmGenPoolSwap`. The originals and every BNB/Robinhood deployment stay untouched.
- Each variant gets a written **audit diff** against its original (gate 2), covering the CLAUDE.md
  audit points, before it is used in any rehearsal.
- Each variant is tested on a **Hardhat fork of Chikyū against the real MuchFi contracts** (MuchFi
  bytecode cannot be built locally: no source). The fork tests cover graduation into a fresh 1% pool,
  graduation into a pool someone pre-created at a wrong price (the repair path), a swap after
  graduation through the SmartRouter, LP-fee collection through the locker, and a creator-vault
  buyback.
- If the fork test shows the unchanged `RobinhoodV3NativeSwapAdapterV2` cannot trade through the
  SmartRouter, stop and bring it back as a decision.

The canonical Uniswap V3 stack library (`scripts/lib/dogeosV3Stack.ts`) stays for local tests only.
Nothing Uniswap is deployed on Chikyū.

**New contract: DOGE/USD testnet oracle**
- A copy of `contracts/robinhood/testnet/RobinhoodTestnetEthUsdOracle.sol`, locked to 6281971:
  AggregatorV3 shape, 8 decimals, a single immutable updater, monotonic rounds, positive answers only.
  Local 31337 only with an explicit rehearsal flag.
- It holds and moves no funds. Per the audit rule it still gets a written diff review against the
  Robinhood original before it is tested (gate 2).
- Staleness bound: `GraduationOracle.maxPriceAge` = 3600 s, a constructor argument
  (`contracts/GraduationOracle.sol`). The 46630 manifest's `maxOracleAgeSeconds` feeds the stock
  adapter, which DogeOS doesn't deploy. 46630's GraduationOracle is a reused gen-6 instance, so read its
  on-chain `maxPriceAge` to compare; don't assume it.

**Keys and ownership**
- Deployer/owner/admin: EOA `0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8`, used only for deploys and
  admin calls. Funded with 42.069 DOGE (faucet tx `0x2eb60ae1595a026cfae0b954bc8bd3b72a1bae304957f5d6ba41c85de44ff919`).
- Oracle updater: EOA `0x7dBDFe829309B4170346CF7e4496094CD126E9c1`. It is the oracle's `updater` and
  holds no other role.
- Graduation keeper: EOA `0xb07B9E70D1759Fc42103458039AaE2413026B078`
  (`DOGEOS_TESTNET_GRADUATION_KEEPER_PRIVATE_KEY`). It holds no
  contract role, only gas DOGE, and calls the permissionless graduation path.
- The keeper and payout watchdog refuse only the addresses hard-coded in `FORBIDDEN_KEEPER_ADDRESSES`
  (`realtime-indexer/src/evm/evmGraduationKeeper.ts`, ~lines 1087-1091). That list does not yet include
  our keys. The DogeOS deployer `0x6c5C…82f8` and the oracle updater `0x7dBD…E9c1` are added to it,
  with a test, so neither can ever run as keeper.
- All keys live only in `config/dogeos.local` (gitignored by `config/*.local`). `hardhat.config.ts`
  loads that file.
- The Hardhat `dogeosTestnet` network reads **only** `DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY`. Unlike
  Robinhood, it has no fallback to `DEPLOYER_PK` / `PRIVATE_KEY_DEPLOY`: a missing key fails the run.
- The deployer key never goes into Coolify. Only the updater key (price push) and the keeper key
  (graduation) go there, on the TEST indexer.
- No Safe exists on Chikyū. Owner = the deployer EOA (testnet only).

**Deploy outputs**
- New `scripts/deploy-dogeos-*` scripts, siblings of the Robinhood gen-7 and V3-mock scripts.
- Addresses go to `deployments/dogeos/testnet.json`, in the same shape as
  `deployments/robinhood/testnet.gen7.json`.
- Everything lands paused with `live=false`. The scripts never call `enableLive`.
- All contracts are verified on L2Scan via its Etherscan-style `/api`.

### 2. Frontend (`frontend/src`)
- `lib/chainRegistry.ts`: entry `dogeos-testnet`.
  - family `evm`, network class testnet, staging runtime
  - RPC env `VITE_PUBLIC_RPC_6281971`, explorer L2Scan, native DOGE / 18
  - deployment manifest `deployments/dogeos/testnet.json`
- `lib/chainConfig.ts`: 6281971 in `SupportedChainId` and the supported-chain checks; a new
  `isDogeosChainId`.
- Native-symbol helpers return `DOGE` for 6281971 in the app, the API and the indexer. The indexer
  hard-codes `"ETH"`/`"BNB"` (e.g. `realtime-indexer/src/evm/evmCreatorChoicePass.ts:355`); the guard
  test covers these too.
- Wallet add/switch-chain parameters: name "DogeOS Chikyū Testnet", the RPC, DOGE/18, L2Scan.
- Feed isolation classifies 6281971 as a testnet, so it never appears in mainnet feeds.
- Shown only when `VITE_ALLOWED_CHAIN_IDS` includes it. Live leaves it out.

### 3. API (`frontend/api`)
- 6281971 is added to the EVM allowlists (`lib/defaultEvmChain.js`, `lib/chainNative.js`, the server
  read provider) and any other hand-kept set the guard test finds.
- Per-chain env vars follow the existing `<NAME>_<chainId>` convention (`FACTORY_ADDRESS_6281971`,
  RPC, adapter and vault addresses).
- Gen-7 route authorization gets 6281971's generation pair (below).
  `dev-fix/route-authorization-gen7.test.mjs:62` currently asserts 6281971 is *not* supported. It is
  flipped on purpose.
- The test-graduation-target gates in `dev-fix/route-auth.js` (the two `cid === 97 || cid === 46630`
  checks, ~lines 185 and 194) include 6281971, so the `$150` test tier is reachable.
- DOGE/USD for display: Binance spot `DOGEUSDT`, the same reader shape as `lib/bnbUsdPrice.js` and
  `lib/ethUsdPrice.js`, wired into the native-USD feed.
- Quote catalog (`api/data/approved-quote-catalog.v1.json`): **no change.** It is a mainnet-only
  snapshot (chains 56/101/4663); 97 and 46630 have no entry. 6281971 follows that pattern, and the
  catalog is a named mainnet-only exception in the guard test.
- Generation pair: `dev-fix/routeAuthorizationSigner.js` (`ALLOWED_GENERATION_PAIRS`, ~lines 164-170)
  is an explicit per-chain map. A
  fresh gen-7 set reports factory/campaign generation `[7, 6]`, so 6281971 gets exactly that pair, and
  the flipped test asserts it.

### 4. Indexer (`realtime-indexer`)
- 6281971 joins `KNOWN_EVM_INDEXER_CHAIN_IDS`. It does **not** join the hard-coded `ACTIVE` list; it
  is switched on through env on the TEST indexer only, the same way Robinhood is.
- A per-chain env block (RPC, factory addresses, start blocks), following the 46630 block in
  `src/env.ts`. The vote-treasury entries stay empty until sub-project 3.
- **`getLogs` limits.** The main campaign indexer needs no change: its default chunk
  (`LOG_CHUNK_SIZE` = 500) and adaptive splitting stay inside the 10k-block and 10k-result caps.
- **Off-chain `slot0` reads.** The keeper (`evmGraduationKeeper.ts`, observation and partial-repair
  reads) and the V3 pool indexer (spot price) decode `slot0` with `uint8 feeProtocol`, which rejects
  MuchFi's `uint32` value. For 6281971 they use a `uint32` `slot0` ABI; Robinhood's ABIs stay untouched.
- **Graduated trades.** Trades in the MuchFi pools are indexed and charted by reusing the V3 pool
  indexer. MuchFi is a PancakeSwap V3 fork, whose pool `Swap` event carries extra protocol-fee fields
  and so has a different signature from Uniswap's; the indexer must decode MuchFi's actual event for
  6281971 (verified on-chain from a real MuchFi swap log), with Robinhood's decoding untouched. That indexer currently scans in chunks of `Math.max(500, ROBINHOOD_V3_LOG_CHUNK_SIZE ||
  50_000)` blocks (`realtime-indexer/src/robinhoodV3PoolIndexer.ts:1435`), 5× the DogeOS cap. For
  6281971 the **starting** chunk is capped at ≤ 10,000 blocks per chain. The existing narrowing on a
  rejected call (chunk/4 down to `minChunk`, ~lines 1445-1455) already covers the 10k-result cap. A
  test pins that it does, and no second retry mechanism is added. Robinhood's chunk value and
  behaviour stay exactly as they are.
- In `realtime-indexer/src/evm/evmGraduationKeeperConfig.ts`, both `V3_GRADUATION_CHAINS` (line 25)
  and the hard-coded keeper enable list in `enabledKeeperChains` (`[56, 4663, 97, 46630]`, line 38)
  include 6281971. Without the second one the keeper silently stays off. The keeper's default
  `DEFAULT_MAX_GAS` (15M) is above Chikyū's 10M block gas limit, so 6281971 gets an explicit max gas
  of ≤ 10M.
- Every lookup that silently falls back to BSC/BNB/ETH for an unknown chain (RPC, start block,
  native symbol, native USD price) gets an explicit 6281971 branch. A DogeOS coin must never be read
  through a BSC RPC or priced in BNB.
- **Jobs that send transactions, one decision per job:**

  | Job | 6281971 in this sub-project |
  |---|---|
  | Graduation keeper (`evmGraduationKeeperWorker`) | **On**, with the keeper key, via `EVM_GRADUATION_KEEPER_ENABLED_6281971` + `EVM_GRADUATION_KEEPER_PRIVATE_KEY_6281971` |
  | DOGE/USD oracle push (new, below) | **On**, with the updater key |
  | Creator-choice operator (`evmCreatorChoiceWorker`) | Off. A named exception in the guard test |
  | Payout watchdog | Off. A named exception |
  | Import-fee workers | Off. Imports are out of scope. A named exception |

  Gate 3 must show that create → graduate → creator claim works with only the keeper and the oracle
  push running. If creator claim turns out to need the creator-choice operator, stop and bring it back
  as a decision. Don't quietly turn it on.
- **Reorgs: index at the tip.** `CONFIRMATIONS` stays the global value 1, the same as every chain, for
  a realtime UI (~3 s). Accepted risk: a reorg deeper than 1 block (up to 17 on DogeOS) can leave a
  phantom trade. That is cosmetic on testnet, and it is recorded as a known item for DogeOS mainnet.
- **DOGE/USD oracle push (new; no precedent).** On 46630 the testnet oracle is refreshed by hand: a
  `workflow_dispatch` GitHub workflow (`.github/workflows/agent4-robinhood-oracle-refresh.yml` →
  `scripts/rh46630-oracle-refresh-transport.ts`) takes a typed-in price. DogeOS needs it automatic,
  because a stale oracle (older than 3600 s) blocks graduation pricing. The push:
  - runs as a worker in the TEST indexer
  - reads Binance spot `DOGEUSDT` (the same source as the API display price)
  - converts it to 8 decimals and calls `updateAnswer` on the DogeOS oracle, signing only with the
    updater key
  - refuses any chain but 6281971, and refuses a key whose address is not the oracle's `updater`
  - pushes at least every 30 minutes, more often when the price moves more than a set deviation
  - skips the push and logs when Binance fails, and never writes a zero or negative value

  Reading the on-chain oracle for health checks reuses the shape of
  `realtime-indexer/src/robinhoodNativeUsdOracle.ts`. That module is gated to 4663/46630 (line 96), so
  DogeOS gets a parametrized sibling and the Robinhood one stays untouched.

### 5. Database
- One staging migration adds 6281971 to every chain `CHECK` constraint or enum that the launch path
  needs. The guard test and the plan enumerate them. The migration is idempotent and applied to
  staging (`vrnsbguutnwgtekcexls`) only.
- Production SQL is handed to the founder at the port. Never run.

### 6. Guard test
- A new test reads every hand-kept chain list (app, API, indexer, migration CHECKs) that contains
  46630. It fails if 6281971 is missing from any list it is expected in. Lists that intentionally
  exclude it are named exceptions in the test, each with a one-line reason: the hard-coded indexer
  `ACTIVE`, mainnet-only sets, stock/quote paths, and the creator-choice, payout-watchdog and
  import-fee job lists. An exception means "may exclude", not "must exclude". For example,
  `frontend/api/lib/importFeePartnersAdmin.js` `PARTNER_CHAINS` already contains 6281971 from an
  earlier commit; it stays as is.

### 7. Local hybrid development
- `npm run dev` (frontend) runs the app and local API from the checkout. Per the founder's
  hybrid-setup doc (8 Oct 2026, a local untracked file, not in the repo), DogeOS work points it at
  staging and the TEST indexer:
  - `DATABASE_URL` = staging
  - `VITE_REALTIME_API_BASE` = TEST indexer
  - `VITE_ALLOWED_CHAIN_IDS` includes 6281971
- `frontend/scripts/dev-vite.mjs:86` already keeps configured chain IDs and adds 56, 101 and 46630, so it needs
  no change.
- `.env.example` gets the DogeOS placeholders, with empty addresses until the deploy.

## Verification gates (in order; each must pass before the next)

1. **Tests, local.**
   - All existing suites stay green: Hardhat, API, indexer, frontend, and the CREATE/BUY/SELL pins.
   - New tests cover:
     - the DogeOS oracle: chain lock, updater-only writes, positive answers, rounds
     - the testnet-only guards in the deploy scripts
     - the no-fallback deployer key
     - the chain-list guard test
     - the flipped gen-7 route-authorization test and the `$150` test-tier gates for 6281971
     - the oracle push: chain and updater refusal, no push on source failure, never ≤ 0, cadence and
       deviation
     - the V3 pool indexer: starting chunk ≤ 10k for 6281971, existing narrowing pinned, Robinhood's
       chunk unchanged
     - `FORBIDDEN_KEEPER_ADDRESSES` refuses the DogeOS deployer, the updater and the route authority; the keeper is enabled
       for 6281971
     - registry, native-symbol and feed-isolation pins for 6281971
2. **Audit diffs.** Written diff reviews of the DogeOS oracle against
   `RobinhoodTestnetEthUsdOracle`, and of each MuchFi variant against its original, all PASS before
   gate 3.
3. **Fork rehearsal.**
   - Run the full deploy against a Hardhat fork of Chikyū.
   - Then: create → buy → sell → reach the `$150` target → graduate into a MuchFi 1% pool → a swap after graduation
     → creator claim.
   - The fork config sets `blockGasLimit` to Chikyū's 10M, so any transaction over the real limit
     fails in rehearsal. The fork can't model the L1 data & finality fee, so the budget adds
     `getL1Fee` (`0x5300…0002`) for each transaction's calldata.
   - A `$150` graduation needs real DOGE in buys on top of gas. The canary budget counts those buys.
   - Measures the DOGE budget, which must fit the deployer balance or say how many faucet claims are
     needed.
4. **Chikyū deploy (explicit founder go).**
   - Deploy with `0x6c5C…82f8` and verify every contract on L2Scan.
   - Write `deployments/dogeos/testnet.json`. Everything stays paused.
5. **Chikyū canary on TEST (explicit founder go).**
   - Wire the env on the TEST API, indexer and test frontend, then call `enableLive`.
   - Through the app with MetaMask: create → buy → sell → graduate → trade after graduation → creator
     claim.
   - The `$150` graduation is reached by **at least 5 separate buyer wallets**, like a real launch. They
     are ordinary test wallets, never the deployer, updater or keeper, funded from the founder's
     testnet DOGE (~40k available on 2026-10-10). The deployer never creates or trades.
   - Check each step on-chain and against the indexer and DB, using the same proofs as the 46630
     canary.

## Definition of done
- All five gates pass. The canary tx hashes and all addresses are recorded in
  `deployments/dogeos/testnet.json` and in `docs/claude/evm-deployments.md`.
- The oracle stays fresh for 24 h with nobody touching it.
- Live, BNB, Robinhood and Solana behave exactly as before. Proof:
  - all pre-existing test suites pass, with no re-pinned assertion
  - `git diff` of the branch shows no change to any existing file under `deployments/` (except new
    files under `deployments/dogeos/`)
  - no change to any LIVE env entry. On TEST, the only entries touched that are not suffixed
    `_6281971` or named `DOGEOS_*` are `VITE_ALLOWED_CHAIN_IDS`, the indexer active-chain list,
    and `ROUTE_AUTHORITY_PRIVATE_KEY` on the TEST API (§1 Route authority)
  - for every hand-kept chain list, the only change is the added 6281971
- A new `docs/claude/dogeos.md` topic file holds the verified facts, quirks and addresses, and is
  added to the CLAUDE.md topic index.

## Rollback
TEST only: remove 6281971 from `VITE_ALLOWED_CHAIN_IDS` and the indexer chain env, and DogeOS
disappears. The contracts remain paused on Chikyū. Nothing on live changes, so there is nothing to
roll back there.

## Known items carried forward
- Reorg depth up to 17 vs `CONFIRMATIONS=1` (decide for DogeOS mainnet).
- The L1 data & finality fee is not shown in our UI.
- Docs recommend 0.8.30/prague. Re-check if a Chikyū upgrade (the build-plan mentions `osaka`) drops
  cancun support.
- MuchFi trust: unverified source and an owner EOA that can change the per-pool protocol fee
  (re-check before mainnet). The factory's oracle and adapter pointers lock at the first campaign.
