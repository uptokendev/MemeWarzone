# DogeOS sub-project 1: Foundation + Launch (Chikyū testnet)

Date: 2026-10-10 · Branch: `feat/dogeos-testnet` · Tracker: none

## Context

DogeOS is a Scroll-based zkEVM L2 for Dogecoin. Its only network is the Chikyū testnet, chain `6281971`.
No mainnet chain ID or date has been announced. This spec is the first of four DogeOS sub-projects:

| # | Sub-project | Depends on |
|---|---|---|
| 1 | **Foundation + Launch** (this spec): chain identity, gen-7 contracts, create/buy/sell/graduate on testnet | — |
| 2 | Adapter for an official DogeOS DEX (BarkSwap or similar), once one is named | 1 |
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
| EVM | solc 0.8.24 / cancun bytecode runs: PUSH0, TSTORE/TLOAD, MCOPY, BASEFEE, CHAINID all work. Disabled: SELFDESTRUCT, BLOBHASH, BLOBBASEFEE. PREVRANDAO = 0. COINBASE = fee vault. Precompiles RIPEMD-160, blake2f and point-eval revert; modexp only for inputs ≤ 32 bytes | `eth_call` probes; docs |
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
- The gen-7 contract set on 6281971 with unchanged bytecode, a staging V3 DEX on the real WDOGE, and
  one new contract: a DOGE/USD testnet oracle.
- 6281971 in every hand-kept chain list across app, API, indexer and staging DB, plus a guard test.
- Chain identity: native DOGE, RPC, explorer, add/switch chain for injected wallets (MetaMask, Rabby).
- Indexing, including graduated V3 trades, and a DOGE/USD price for display.
- Exposure on TEST only (test frontend, TEST API, TEST indexer, staging Supabase), plus the local
  hybrid dev setup pointed at the same.

**Out of scope**
- Sub-projects 2–4 above.
- Quote coins against the faucet mock tokens. Native DOGE is the only quote.
- Showing the L1 data & finality fee in our UI. Wallets show what they show.
- Any change to live (`build/cross-chain-stabilization-rh-base`), mainnet, Solana, or BNB/Robinhood
  contracts, config or behaviour.
- A shared chain-registry refactor. The chain lists stay hand-kept; the postponed refactor owns
  centralizing them.
- Reorg rollback or reconciliation in the indexer (see Indexer).

**Hard constraints**
- Bytecode identical to the audited gen-7 build: solc 0.8.24, the existing `hardhat.config.ts`
  compiler settings, no DogeOS compiler profile.
- CREATE/BUY/SELL transaction flow and shape unchanged. The pins in the existing tests stay green and
  are never re-pinned.
- No transaction on Chikyū without an explicit founder go per gate (Verification gates 4 and 5).
- Staging SQL only. Production SQL is handed to the founder, never run.
- Do not change unrelated logic.

## Design

### 1. Contracts and on-chain

**Deployed unchanged (gen-7 bytecode)**
- `LaunchFactoryGen7` and the `LaunchCampaignGen7` implementation. The `$6` test graduation target is
  already allowed for 6281971 (`contracts/gen7/LaunchFactoryGen7.sol:369`), so the factory needs no
  change.
- The fee stack: `TreasuryRouterV4`, its vaults, the holder distributor, and the community/airdrop
  vaults, wired as the 46630 gen-7 deploy wires them (`deployments/robinhood/testnet.gen7.json`).
- `CreatorRegistry`, `RiskRegistry`, and the generic `GraduationOracle`.
- `RobinhoodV3NativeGraduationAdapterV2` and `RobinhoodV3NativeSwapAdapterV2` (no chain checks),
  pointed at the staging DEX.
- `PermanentV3PositionLocker`.

Why graduation ships in this sub-project: a gen-7 campaign fixes its `graduationAdapter` and
`graduationOracle` at create time (`LaunchCampaignGen7.sol:322-339`). Coins created before a working
adapter exists would be bound to whatever adapter was set at that moment.

**Staging DEX**
- The same mock Uniswap-V3 set the 46630 stack uses (`scripts/deploy-robinhood-v3-mock.ts`: factory,
  position manager, swap router, quoter), with the **official WDOGE** as the wrapped native. No mock
  WETH.
- The deploy refuses any chain except 6281971, or 31337 with an explicit rehearsal flag.

**New contract: DOGE/USD testnet oracle**
- A copy of `contracts/robinhood/testnet/RobinhoodTestnetEthUsdOracle.sol`, locked to 6281971:
  AggregatorV3 shape, 8 decimals, a single immutable updater, monotonic rounds, positive answers only.
  Local 31337 only with an explicit rehearsal flag.
- It holds and moves no funds. Per the audit rule it still gets a written diff review against the
  Robinhood original before it is tested (gate 2).
- `maxOracleAgeSeconds` = 3600, the same as 46630.

**Keys and ownership**
- Deployer/owner/admin: EOA `0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8`, used only for deploys and
  admin calls. Funded with 42.069 DOGE (faucet tx `0x2eb60ae1595a026cfae0b954bc8bd3b72a1bae304957f5d6ba41c85de44ff919`).
- Oracle updater: EOA `0x7dBDFe829309B4170346CF7e4496094CD126E9c1`. It is the oracle's `updater` and
  holds no other role.
- Both keys live only in `config/dogeos.local` (gitignored by `config/*.local`), as
  `DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY` and `DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY`.
  `hardhat.config.ts` loads that file.
- The Hardhat `dogeosTestnet` network reads **only** `DOGEOS_TESTNET_DEPLOYER_PRIVATE_KEY`. Unlike
  Robinhood, it has no fallback to `DEPLOYER_PK` / `PRIVATE_KEY_DEPLOY`: a missing key fails the run.
- The deployer key never goes into Coolify. Only the updater key goes there, for the price-push job.
- No Safe exists on Chikyū. Owner = the deployer EOA (testnet only).

**Deploy outputs**
- New `scripts/deploy-dogeos-*` scripts, siblings of the Robinhood gen-7 and V3-mock scripts.
- Addresses go to `deployments/dogeos/testnet.json`, in the same shape as
  `deployments/robinhood/testnet.gen7.json`.
- Everything lands paused with `live=false`. The scripts never call `enableLive`.
- All contracts are verified on L2Scan via its Etherscan-style `/api`.

### 2. Frontend (`frontend/src`)
- `chainRegistry.ts`: entry `dogeos-testnet`.
  - family `evm`, network class testnet, staging runtime
  - RPC env `VITE_PUBLIC_RPC_6281971`, explorer L2Scan, native DOGE / 18
  - deployment manifest `deployments/dogeos/testnet.json`
- `chainConfig.ts`: 6281971 in `SupportedChainId` and the supported-chain checks; a new
  `isDogeosChainId`.
- Native-symbol helpers return `DOGE` for 6281971.
- Wallet add/switch-chain parameters: name "DogeOS Chikyū Testnet", the RPC, DOGE/18, L2Scan.
- Feed isolation classifies 6281971 as a testnet, so it never appears in mainnet feeds.
- Shown only when `VITE_ALLOWED_CHAIN_IDS` includes it. Live leaves it out.

### 3. API (`frontend/api`)
- 6281971 is added to the EVM allowlists (`lib/defaultEvmChain.js`, `lib/chainNative.js`, the server
  read provider) and any other hand-kept set the guard test finds.
- Per-chain env vars follow the existing `<NAME>_<chainId>` convention (`FACTORY_ADDRESS_6281971`,
  RPC, adapter and vault addresses).
- Gen-7 route authorization gets 6281971's generation pair (whatever the deployed factory reports).
  `dev-fix/route-authorization-gen7.test.mjs:62` currently asserts 6281971 is *not* supported. It is
  flipped on purpose.
- DOGE/USD for display uses the same off-chain reader shape as BNB/ETH/SOL, wired into the native-USD
  feed.
- Quote catalog (`api/data/approved-quote-catalog.v1.json`): one native-DOGE entry for 6281971.

### 4. Indexer (`realtime-indexer`)
- 6281971 joins `KNOWN_EVM_INDEXER_CHAIN_IDS`. It does **not** join the hard-coded `ACTIVE` list; it
  is switched on through env on the TEST indexer only, the same way Robinhood is.
- A per-chain env block (RPC, factory addresses, start blocks), following the 46630 block in
  `src/env.ts`. The vote-treasury entries stay empty until sub-project 3.
- `getLogs` limits need no new code: the default chunk (`LOG_CHUNK_SIZE` = 500) and adaptive splitting
  are well inside the 10k-block and 10k-result caps.
- Graduated trades on the staging V3 DEX are indexed and charted by reusing the V3 pool indexer the
  way 46630 does. Robinhood's behaviour must not change; the plan decides how to parametrize it.
- **Reorgs: index at the tip.** `CONFIRMATIONS` stays the global value 1, the same as every chain, for
  a realtime UI (~3 s). Accepted risk: a reorg deeper than 1 block (up to 17 on DogeOS) can leave a
  phantom trade. That is cosmetic on testnet, and it is recorded as a known item for DogeOS mainnet.
- **Oracle updater job:** a DogeOS price push modelled on `src/evm/robinhoodNativeUsdOracle.ts`. It
  signs only with the updater key and keeps the oracle inside its 3600 s freshness window.

### 5. Database
- One staging migration adds 6281971 to every chain `CHECK` constraint or enum that the launch path
  needs. The guard test and the plan enumerate them. The migration is idempotent and applied to
  staging (`vrnsbguutnwgtekcexls`) only.
- Production SQL is handed to the founder at the port. Never run.

### 6. Guard test
- A new test reads every hand-kept chain list (app, API, indexer, migration CHECKs) that contains
  46630. It fails if 6281971 is missing from any list it is expected in. Lists that intentionally
  exclude it (the hard-coded indexer `ACTIVE`, mainnet-only sets) are named exceptions in the test.

### 7. Local hybrid development
- `npm run dev` (frontend) runs the app and local API from the checkout. Per the hybrid-setup doc
  (8 Oct 2026), DogeOS work points it at staging and the TEST indexer:
  - `DATABASE_URL` = staging
  - `VITE_REALTIME_API_BASE` = TEST indexer
  - `VITE_ALLOWED_CHAIN_IDS` includes 6281971
- `scripts/dev-vite.mjs:86` already keeps configured chain IDs and adds 56, 101 and 46630, so it needs
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
     - the flipped gen-7 route-authorization test
     - registry, native-symbol and feed-isolation pins for 6281971
2. **Oracle audit diff.** A written diff review of the DogeOS oracle against
   `RobinhoodTestnetEthUsdOracle`, done before gate 3.
3. **Fork rehearsal.**
   - Run the full deploy against a Hardhat fork of Chikyū.
   - Then: create → buy → sell → reach `$6` → graduate into the staging V3 → a swap after graduation
     → creator claim.
   - Measures the DOGE budget, which must fit the deployer balance or say how many faucet claims are
     needed.
4. **Chikyū deploy (explicit founder go).**
   - Deploy with `0x6c5C…82f8` and verify every contract on L2Scan.
   - Write `deployments/dogeos/testnet.json`. Everything stays paused.
5. **Chikyū canary on TEST (explicit founder go).**
   - Wire the env on the TEST API, indexer and test frontend, then call `enableLive`.
   - Through the app with MetaMask: create → buy → sell → graduate → trade after graduation → creator
     claim.
   - Check each step on-chain and against the indexer and DB, using the same proofs as the 46630
     canary.

## Definition of done
- All five gates pass. The canary tx hashes and all addresses are recorded in
  `deployments/dogeos/testnet.json` and in `docs/claude/evm-deployments.md`.
- The oracle stays fresh for 24 h with nobody touching it.
- Live, BNB, Robinhood and Solana behave exactly as before. The test suites and an unchanged-config
  diff prove it.
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
- The official DEX adapter is sub-project 2. Coins created before it stay bound to the staging-DEX
  adapter.
