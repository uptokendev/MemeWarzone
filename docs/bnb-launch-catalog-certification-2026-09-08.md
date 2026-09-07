# BNB Launch Catalog Certification — 2026-09-08

Authority: `42f00b9c5cc56d9956efa79f1fdb5cfd8edd7566`

Certification branch: `agent3/bnb-launch-catalog-certification`

Scope: launch-day certification of the 21 canonical BNB candidates in `frontend/api/data/approved-quote-catalog.v1.json` against the production-compatible architecture that exists now. This document does not activate assets, change routing, or alter production code.

## Frozen launch architecture

- Native: `BNB -> WBNB -> MEME/WBNB`.
- Non-native: `BNB -> WBNB -> direct volatile Topaz-v2 WBNB/QUOTE -> MEME/QUOTE -> permanent LP custody`.
- No v3/Slipstream acquisition, mixed routes, arbitrary browser router input, or native fallback.
- `BnbQuoteGraduationAdapter.configureQuoteRoute()` requires the configured acquisition pool to equal `Topaz PoolFactory.getPool(WBNB, quoteToken, false)`.
- The adapter requires an `AggregatorV3`-compatible quote price feed and performs freshness, route-liquidity, price-impact, oracle-deviation, and graduation-price-deviation checks.
- Unsafe execution reverts atomically; `BnbQuoteLaunchCampaign` remains PENDING and permissionlessly retryable.

At the default production graduation target (`$30,000`), default `protocolFeeBps = 200` and `liquidityBps = 3300` imply approximately `$9,702` of graduation value enters the acquisition/final-LP liquidity leg before any supply cap. Route certification therefore requires meaningful executable liquidity at approximately that scale, not merely existence of a pool.

## Current evidence boundary

Topaz official current data says chain 56, v2 router `0x1E98c8226e7d452e1888e3d3d2F929346321c6c3`, v2 PoolFactory `0x65E6cD0eF5D3467030103cf3d433034E570b5784`; public pool snapshots refresh every 15 minutes. Topaz currently concentrates material WBNB liquidity for USDT, BTCB and ETH in Slipstream/v3, which this launch adapter cannot use.

The current direct v2 USDT/WBNB pool is `0xe030e94879204403db8eaa73251667551446ae01`; Topaz reported about `$1.16k` TVL on 2026-09-08, far below launch-safe acquisition size. The known direct v2 BTCB/WBNB pool is `0x35bf6c8375776ece4399bc17159ed97ab5dc5172` and the direct v2 ETH/WBNB pool is `0xa8b16d898d4a9f2334cce96eb4e830f6ea23b552`; the most recent indexed v2 inventory available in Topaz search evidence had only hundreds to low-thousands of dollars of TVL, while current material liquidity is in v3. These routes therefore fail closed because current launch-safe executable v2 liquidity is not proven.

Topaz's v2 inventory did not show direct volatile WBNB pools for the remaining canonical non-native candidates. Pool absence or lack of launch-safe current liquidity means ACQUISITION FAIL even if the asset is otherwise valid.

Chainlink standard BNB Chain feeds establish adapter-compatible price authority for BNB, BTC, ETH, USDT, USDC, FDUSD and CAKE. PYTH/USD was found as a Data Stream / Pyth pull-oracle style product rather than the simple `AggregatorV3.latestRoundData()` boundary this adapter consumes. xStocks use corporate-action rebasing/multiplier mechanics and Chainlink's xStocks oracle work is Data Streams-oriented; an underlying stock reference price must not be assumed to equal the token price without the token multiplier/rebase treatment.

## Candidate matrix

Legend: PASS = proven compatible with the current launch boundary; FAIL = does not meet launch boundary now; PENDING = potentially supportable later but not launch-certified; N/A = native exception.

| Asset | Exact canonical identity (chain 56) | Provider | Identity | Acquisition | Price | Final LP | Launch state | Blocker / evidence |
|---|---|---|---|---|---|---|---|---|
| BNB | `native:56` | `bnb-native` | PASS | PASS (native path; no acquisition pool required) | PASS — Chainlink BNB/USD | PASS — legacy/native MEME/WBNB Topaz path + permanent custody | **ACTIVE-SAFE** | Existing native generation path; not dependent on BNB BASIC quote adapter. |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | `bnb-native` | PASS | FAIL as BASIC quote — adapter explicitly rejects `quoteToken == WBNB` | PASS — BNB/USD equivalent | PASS as native final pair | **REJECTED (BASIC selection only)** | Duplicate of native BNB -> WBNB final market; not a separate BASIC quote. |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | `binance-peg` | PASS | FAIL — direct v2 pool `0xe030e94879204403db8eaa73251667551446ae01`, current TVL ~`$1.16k`, insufficient for launch-size execution | PASS — Chainlink USDT/USD standard feed | PASS — standard ERC-20 volatile v2 final pool compatible | **PENDING** | Direct-v2 liquidity/price-impact gate. |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | `binance-peg` | PASS | FAIL — no launch-safe direct volatile v2 WBNB/USDC route proven | PASS — Chainlink USDC/USD standard feed | PASS | **PENDING** | Acquisition route. Existing Topaz USDC/WBNB liquidity is not a usable direct v2 launch route. |
| FDUSD | `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409` | `first-digital` | PASS | FAIL — no launch-safe direct volatile v2 WBNB/FDUSD route proven | PASS — Chainlink FDUSD/USD standard feed | PASS | **PENDING** | Acquisition route. |
| BTCB | `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c` | `binance-peg` | PASS | FAIL — direct v2 pool `0x35bf6c8375776ece4399bc17159ed97ab5dc5172` exists but launch-safe current v2 liquidity is not proven; material liquidity is v3 | PASS — Chainlink BTC/USD standard feed | PASS | **PENDING** | Direct-v2 liquidity/price-impact gate. |
| ETH | `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` | `binance-peg` | PASS | FAIL — direct v2 pool `0xa8b16d898d4a9f2334cce96eb4e830f6ea23b552` exists but launch-safe current v2 liquidity is not proven; material liquidity is v3 | PASS — Chainlink ETH/USD standard feed | PASS | **PENDING** | Direct-v2 liquidity/price-impact gate. |
| CAKE | `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` | `pancakeswap` | PASS | FAIL — no launch-safe direct volatile v2 WBNB/CAKE route proven | PASS — Chainlink CAKE/USD standard feed | PASS | **PENDING** | Acquisition route. |
| PYTH | `0xb0188B0bb2cD4a6D2744637fC83C94a284B247Da` | `pyth` | PASS | FAIL — no launch-safe direct volatile v2 WBNB/PYTH route proven | FAIL for current adapter — no proven compatible AggregatorV3 token-price authority | PASS for standard ERC-20 final pool mechanics | **PENDING** | Acquisition + adapter-compatible price authority. |
| AAPLx | `0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a` | `xstocks` | PASS | FAIL — no launch-safe direct volatile v2 WBNB/AAPLx route proven | FAIL — token multiplier/rebase-aware AggregatorV3 authority not proven | PENDING — rebasing token exact-balance/permanent-LP behavior not certified | **PENDING** | Acquisition + price + rebasing integration. |
| NVDAx | `0xc845b2894dbddd03858fd2d643b4ef725fe0849d` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| TSLAx | `0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| AMZNx | `0x3557ba345b01efa20a1bddc61f573bfd87195081` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| MSFTx | `0x5621737f42dae558b81269fcb9e9e70c19aa6b35` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| METAx | `0x96702be57cd9777f835117a809c7124fe4ec989a` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| GOOGLx | `0xe92f673ca36c5e2efd2de7628f815f84807e803f` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| QQQx | `0xa753a7395cae905cd615da0b82a53e0560f250af` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| COINx | `0x364f210f430ec2448fc68a49203040f6124096f0` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| NFLXx | `0xa6a65ac27e76cd53cb790473e4345c46e5ebf961` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| HOODx | `0xe1385fdd5ffb10081cd52c56584f25efa9084015` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |
| SPYx | `0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48` | `xstocks` | PASS | FAIL | FAIL | PENDING | **PENDING** | Same xStocks blockers. |

## Gate counts

- Candidates audited: **21**
- Identity pass: **21**
- Acquisition pass: **1** (BNB native path); direct non-native acquisition pass: **0**
- Price pass: **8** (BNB, WBNB, USDT, USDC, FDUSD, BTCB, ETH, CAKE)
- Final LP pass: **9** at the token/pool-mechanics gate (BNB, WBNB, USDT, USDC, FDUSD, BTCB, ETH, CAKE, PYTH); xStocks remain unproven because of rebasing/multiplier behavior
- Active-safe: **1** (BNB native)
- Pending: **19**
- Rejected: **1** (WBNB as a separate BASIC quote selection only)

## Launch decision

**Launch catalog: BNB native only.**

No non-native BNB BASIC quote should be switched to ACTIVE for launch under the present direct-v2 architecture and current evidence. This is a fail-closed catalog decision, not a product failure: the BNB BASIC creator/API glue is independently launch-ready, unsafe quotes remain unavailable, and future ordinary direct-v2 assets can be enabled by catalog/policy + adapter route configuration once identity, price, liquidity, and final-LP gates are actually proven.

Material expansion beyond this launch set requires post-launch routing work (v3/Slipstream and/or mixed trusted routes) plus appropriate price adapters for assets such as xStocks. That work is explicitly out of scope for launch night.

## Evidence references

Repository authority:
- `frontend/api/data/approved-quote-catalog.v1.json`
- `frontend/api/lib/approvedQuoteCatalog.js`
- `frontend/api/lib/quoteAssetCatalog.js`
- `contracts/integrations/BnbQuoteGraduationAdapter.sol`
- `contracts/BnbBasicLaunchFactory.sol`
- `contracts/BnbQuoteLaunchCampaign.sol`
- `contracts/LaunchFactory.sol`

External production evidence:
- Topaz contracts: `https://www.topazdex.com/docs/contracts`
- Topaz integration: `https://www.topazdex.com/docs/developers/integration`
- Topaz data API: `https://www.topazdex.com/docs/developers/data-api`
- Topaz current stats: `https://www.topazdex.com/stats`
- Current USDT/WBNB v2: `https://www.topazdex.com/stats/pools/0xe030e94879204403db8eaa73251667551446ae01`
- Chainlink BNB/USD: `https://data.chain.link/feeds/bsc/mainnet/bnb-usd`
- Chainlink BTC/USD: `https://data.chain.link/feeds/bsc/mainnet/btc-usd`
- Chainlink ETH/USD: `https://data.chain.link/feeds/bsc/mainnet/eth-usd`
- Chainlink USDT/USD: `https://data.chain.link/feeds/bsc/mainnet/usdt-usd`
- Chainlink USDC/USD: `https://data.chain.link/feeds/bsc/mainnet/usdc-usd`
- Chainlink FDUSD/USD: `https://data.chain.link/feeds/bsc/mainnet/fdusd-usd`
- Chainlink CAKE/USD: `https://data.chain.link/feeds/bsc/mainnet/cake-usd`
- xStocks product/integration material: `https://xstocks.com/`, `https://xstocks.com/partner`, `https://xstocks.com/news/introducing-the-xbridge`
- Chainlink Data Streams: `https://chain.link/data-streams`
