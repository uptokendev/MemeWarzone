# EVM launch generation 7: BNB and Robinhood matched to Solana DBC v2

Status 2026-10-08: steps 1-3 done on `build/evm-gen7` (local only, nothing deployed). Every step below needs an explicit founder go.
Authority for gen-6: `docs/evm-launch/EVM_LAUNCH_GENERATION_PLAN.md` (E1-E21). Solana reference:
`docs/claude/meteora-dbc.md` ("DBC v2 economics").

## 1. Decisions (founder, 2026-10-08: "match Solana")

| # | Gen-6 (live since 2026-10-01) | Gen-7 |
|---|---|---|
| G1 | 1B supply: 70% curve, 28% pool budget (unused part burned), 2% creator reserve | 1B: **85% curve, 13% pool, 2% creator reserve** |
| G2 | Linear curve `base + slope x sold`, factory-wide base/slope | **Constant-product curve with virtual reserves** (pump.fun / Meteora single segment) |
| G3 | Graduation when net raise >= USD target ($15K/$30K/$50K) via the oracle on every buy (E3) | **Graduation market cap $30K or $50K.** The oracle is read once at create to fix the curve in native; graduation = curve sold out (85% of supply) |
| G4 | Graduation fee 22%: creator 19.8% (claim), protocol 2.2% | **2%, all to `TreasuryRouterV4.routeFinalize`** (recruiter / squad / airdrop / protocol). Creator 0%; no creator graduation claim |
| G5 | Creator first buy max 10% of supply and cost <= 50% of the native target | **Max 70% of supply**, no cost cap |
| G6 | Launch fee 50% -> 2% over 60 s | **90% -> 2% over 60 s** |
| G7 | Later creator buys capped by trust tier (0.25 / 1 / 3 native) and escrowed | **No cap**; escrow unchanged (20% at 30 days, then 20% every 7 days) |
| G8 | Trade fee 2% and its split, fee choices, LP lock 80/20, graduation into Topaz V2 30 bps (BNB) / Uniswap V3 fee 3000 (Robinhood) | Unchanged |
| G9 | — | Gen-6 factories: `setCreatePaused(true)` the day gen-7 opens; existing coins keep trading and graduating on gen-6 rules |

Why a new generation: on the live factories (`0x1948411B...` BNB, `0xc673B116...` Robinhood) every economic setter
is `whenMutable`, which reverts once the factory has a campaign (both have test coins), and the fee splits and
first-buy cap are compiled into `LaunchCampaign`. Nothing in G1-G7 can change without new contracts.

## 2. The gen-7 curve

With 85% on the curve, 13% in the pool, a 2% graduation fee and the pool opening at the curve's last price, the
shape is the same for every target; only the native size scales:

- `MC` = target market cap in native wei = `oracle.nativeTargetForUsd(targetUsd)` at create (rounded up).
- Raise to graduate `R = ceil(MC x 13 / 98)` (pool gets 98% of R against 13% of supply at price `MC / 1B`).
- `r = sqrt(start price / end price) = 13 / (98 x 0.85) = 0.1560624...` (a constant).
- Virtual token reserve `Vt = 850M / (1 - r) = 1,007,180,...` whole tokens (constant).
- Virtual native reserve `Vn = r^2 x (MC / 1B) x Vt` (= 2.453% of MC). The starting market cap is
  `r^2 x MC` = 2.4355% of MC: $731 for $30K and $1,218 for $50K, exactly Solana's numbers.
- `k = Vn x Vt`. Buy: `tokensOut = Vt_cur - ceilDiv(k, Vn_cur + nativeInAfterFee)`; sell:
  `nativeOut = Vn_cur - ceilDiv(k, Vt_cur + tokensIn)`. Both round in the curve's favour.
- Sizes: Vt <= 1.01e27 (18 decimals), Vn <= ~1e21 wei for a $50K MC at a $50 native price; k < 1.1e48, far below
  2^256. Checked arithmetic (0.8.24) everywhere; `mulDiv` not needed for k but used for fee maths as today.
- The last buy is a partial fill: it takes only the native that sells the remaining curve tokens and refunds the
  rest (Meteora PartialFill). Graduation becomes pending exactly at 850M sold.

For any target, a 70% first buy costs 42.1% of R and leaves 15% of supply for the public (on Solana at
$120.40: 14.2 of 33.05 SOL for $30K, 23.7 of 55.09 SOL for $50K).

## 3. Change list (audit as a diff before any test)

Per the working agreement, each money-path change states its reentrancy guard, CEI ordering, reachable states,
over/underflow and griefing.

| # | Change | Audit notes |
|---|---|---|
| C1 | `LaunchCampaignGen7` (new contract; gen-6 untouched): storage `virtualNative`, `virtualToken`, `curveTokens`, `sold`, `netRaisedWei`, `graduationRaiseWei`; init from factory-computed params; no `basePrice` / `priceSlope` | Init is `initializer`-guarded as today; params validated (Vn > 0, Vt > curveTokens, curveTokens + poolTokens + reserve == totalSupply) |
| C2 | Buy / sell on the CP curve (section 2) | `nonReentrant` as today. CEI: fee and curve state updated before the router call and the token/native transfers; the router call already reverts the trade on failure. Reachable only in `Trading` (not pending/graduated/paused). Rounding: tokensOut down, native out down, k division up, so a buy-then-sell round trip can never return more than paid (property test). Griefing: dust buys change nothing (min out / deadline as today); no `balanceOf`-based accounting, so donations cannot move the price |
| C3 | Partial fill on the completing buy, refund via the existing refund path | Refund after state update (CEI) under the same guard; refund failure handling as today (credit to pending refunds, never blocks graduation) |
| C4 | Graduation: pool native = `R - fee`, fee = `R x 2%` (pool rounded up, as the Meteora program does); pool tokens = `poolNative / endPrice` (= 13% by construction, rounding left to the burn); 2% to `routeFinalize`, escrowed to `pendingProtocolGraduationFee` if the router refuses (existing path); 2% reserve to the beneficiary (existing); leftover pool budget burned (existing) | Remove `GRAD_CREATOR_BPS`, `claimCreatorGraduation` and the creator graduation beneficiary state. Price band check (`NATIVE_PRICE_BAND_BPS` +-50 bps) kept; the band's upper bound now always applies because pool tokens are exact. Repair path (`repairPool`) and quote fallback unchanged, re-run all C7 griefer tests on the new curve |
| C5 | Creator first buy: `CREATOR_FIRST_BUY_MAX_SUPPLY_BPS = 7000`; drop the 50%-of-target cost cap | Still only while `totalBuyVolumeWei == 0`, inside the create tx, flat 2% fee, unlocked (as gen-6). 7000 < curve 8500 keeps 15% public (assert in init) |
| C6 | Launch fee `9000 -> protocolFeeBps` linearly over 60 s: `fee = start - (start - base) x elapsed / 60` | Constructor/initializer check base <= start (now 9000). Integer division floors toward the base fee (traders' favour by < 1 bps) |
| C7 | Creator later buys: no `creatorBuyCapWei`; escrow unchanged | The escrow is the only creator constraint; its claim path unchanged (re-run escrow suite) |
| C8 | `LaunchFactoryGen7`: allowed targets `30_000e18` / `50_000e18` (+ a market-cap test target on 97 / 46630 / 6281971, proposed `$150` as on Solana devnet instead of gen-6's `$6` raise; any on 31337); at create read the oracle (staleness check as `GraduationOracle`), compute `MC`, `R`, `Vn`, `Vt` and pass them to the campaign | Oracle read is a view; a stale or zero price reverts create (never a trade). Bounds: refuse `Vn` outside a sane band (native price $0.01-$100k equivalent) so a broken feed cannot create an absurd curve. `whenMutable` setters kept as gen-6 |
| C9 | New lockers per factory (`deployFactoryWithLocker`), same `PermanentLpLocker` / `PermanentV3PositionLocker` bytecode | Locker admin = the new factory, as gen-6 |
| C10 | Reused unchanged: `TreasuryRouterV4`, `ProtocolRevenueForwarder`, `CreatorRewardsVaultV2`, `CreatorRegistry` (tiers now unused for caps), `RiskRegistry`, adapters (Topaz native, RH V3 native V2, quote/stock adapters) | Re-run their suites against gen-7 campaigns; no bytecode change |
| C11 | Gen-6 factories: `setCreatePaused(true)` in the opening Safe batch | One call per chain, reversible |

## 4. Off-chain work

- Frontend: `frontend/src/lib/evmGen7.mjs` (quote maths mirroring C2/C5/C6, market cap = price x 1B, first-buy
  MAX like the Solana create page, graduation tiers $30K / $50K MC), create flow, coin page, trade panels,
  creator panel (no graduation payout row), Playbook copy.
- API: create signer / route authority for gen-7, `evmLaunchGen7.js` constants, finance lanes (graduation fee 2%
  all protocol-side; creator graduation lane only for gen-6).
- Indexer: gen-7 event ABI, market stats (CP price), graduation keeper (no creator claim), candles.
- Tests: port every `evmgen-core-*` suite to gen-7; new CP property/fuzz tests (monotonic price, no free tokens,
  graduation exactly at 850M, pool price continuity, supply bound over the oracle range);
  `LaunchFactoryGen7.targets.spec.ts`; fork specs for BNB and Robinhood; testnet lifecycle scripts
  (`test-*-testnet-gen7-lifecycle.ts`); mainnet-fork rehearsal with the real Safe.

## 5. Steps (each needs a founder go)

1. This plan signed off.
2. Contracts C1-C9 + unit/property tests (hardhat), internal audit write-up as a diff against gen-6.
3. Off-chain (section 4) against a local hardhat node.
4. BSC testnet (97) and Robinhood testnet (46630): deploy, lifecycle acceptance, browser test.
5. Mainnet-fork rehearsal on both chains with the real Safe (`rehearse-evm-gen7-mainnet-fork.ts`).
6. Mainnet deploy through Safe batches (lands `createPaused`), canary coin, then `enableLive` + C11.

DogeOS (`docs/build_plans/DogeOS/DOGEOS_FULL_INTEGRATION_PLAN.md`) builds on gen-7, not gen-6.

## 6. Step 3 result (2026-10-08, local hardhat node only)

- Shared maths `frontend/shared/evmGen7Curve.mjs`, checked to the wei against the contracts
  (`test/evmgen7-offchain-mirror.spec.ts`, 5 price / target pairs incl. DOGE $0.03).
- API (`frontend/api`): 7/6 pair accepted on 56 / 97 / 4663 / 46630 / 31337; first buy priced on the curve the factory
  sizes now (cross-checked with the factory's `curveForMarketCap` view, any mismatch refuses to sign); targets per
  generation; campaign-state gains `curve` and `economics`; finance lanes `evm_trade_v4_gen7` / `evm_finalize_gen7`.
- App (`frontend/src`): create and push-live with $30K / $50K market-cap tiers, 70% first buy with MAX and balance
  block, 90% launch-fee line, coin page price / market cap on the CP curve, creator panel without the 19.8% row.
- Indexer: CP spot and market cap, candles, 9000 bps launch-fee annotation, keeper due filter = sell-out only,
  buyback impact estimate on the CP curve, `EVM_GEN7_FACTORIES_<chainId>` force list.
- End to end on a local node: `scripts/local-gen7-stack.ts` then `scripts/check-gen7-local-offchain.ts`
  (API prices and signs a 70% first buy, create, campaign-state, indexer reader, sell-out to Pending, graduation:
  2% to the router, 0 to the creator): 32 / 32 checks.
- Open for later steps: gen-7 lockers into `evmLpHarvestCrank.js` and the finance locker lists after deploy; DogeOS
  6281971 route authorisation; scheduled arm takes the factory generation from the client (fails closed on chain).
