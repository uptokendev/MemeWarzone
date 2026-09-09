# Topaz Testnet Graduation Flow

This runbook connects the Minimal Topaz deployment from `MemeWarzone-Topaz` to the MemeBattles `devpostgrad` deployment and produces the acceptance report required for the Topaz rollout.

## 0. Product rules (do not regress)

| Surface | Source of truth |
|---------|-----------------|
| Chart (bonding + post-grad) | **UnifiedMarketChart** (TradingView Lightweight) |
| Trading after graduation | **Topaz only** (`topazV2Trade`) |
| Not used | DexScreener, PancakeSwap |

## 0.1 Market continuity flags (Slice C)

**Realtime indexer (Railway)** — defaults are ON in code; set explicitly if your service still has `0`:

```text
ENABLE_GRADUATION_HANDOFF_RECONCILER=1
ENABLE_TOPAZ_POOL_INDEXER=1
ENABLE_UNIFIED_MARKET_API=1
ENABLE_UNIFIED_MARKET_CHART=1
ENABLE_TOPAZ_QUOTES=1
ENABLE_TOPAZ_TRADING=1
LP_LOCKER_ADDRESS_97=0xb083929D2bbabdE7fc580090D5B18bbD918Fda9a
```

Also apply schema: `db/migrations/202607290001_war_trade_room_market_continuity_foundation.sql` (and any later WTR migrations).

**Frontend (Netlify postgrad)**:

```text
VITE_ENABLE_POSTGRAD=true
VITE_ENABLE_UNIFIED_MARKET_CHART=1
VITE_ENABLE_TOPAZ_MARKET_API=1
VITE_TOKEN_API_BASE=<postgrad indexer host>
VITE_REALTIME_API_BASE=<same indexer host>
```

When `VITE_ENABLE_POSTGRAD=true`, the market continuity API client turns on automatically even without the two chart flags.

**Smoke after deploy** (PowerShell — use `curl.exe` and `$vars`):

```powershell
$TOKEN_API = "https://YOUR-INDEXER.up.railway.app"
$CAMPAIGN  = "0xYourCampaign"

curl.exe -sS "$TOKEN_API/api/token/$CAMPAIGN/market-state?chainId=97"
curl.exe -sS "$TOKEN_API/api/token/$CAMPAIGN/market-trades?chainId=97&limit=20"
curl.exe -sS "$TOKEN_API/api/token/$CAMPAIGN/market-candles?chainId=97&resolution=1m&limit=100"
```

Expect `marketStage` of `TOPAZ_ACTIVE` (or `TOPAZ_PENDING` while handoff finishes), `pairAddress` set, and trades/candles non-empty after Topaz volume.

If `indexingStatus.poolEnabled` stays `false`, the indexer lacked a full `dex_pools` row (fixed by self-heal on market-state + full upsert). Redeploy indexer, hit market-state again, wait for the pool indexer loop, then re-check trades.

**Internal repair** (needs `RANK_EVENTS_TOKEN` as Bearer — not public):

```powershell
# Wrong path (404): /internal/reconcile-graduations
# Correct:
curl.exe -sS -X POST "$TOKEN_API/internal/wtr/reconcile-graduations" -H "Authorization: Bearer $RANK_EVENTS_TOKEN"
curl.exe -sS -X POST "$TOKEN_API/internal/wtr/ensure-dex-pool?chainId=97&campaign=$CAMPAIGN&index=1" -H "Authorization: Bearer $RANK_EVENTS_TOKEN"
curl.exe -sS -X POST "$TOKEN_API/internal/wtr/index-topaz-pools" -H "Authorization: Bearer $RANK_EVENTS_TOKEN"
```

## 1. Deploy Minimal Topaz

The current repository-authoritative BSC Testnet 97 Topaz generation was deployed from `MemeWarzone-Topaz` authority `0507a2debf438c9d3b2e387c880c96394ffade9d` and is already deployed. Do not deploy another Topaz stack for this certification.

The authoritative integration manifest is:

```text
deployments/bscTestnet/minimal-topaz.json
```

The manifest must include the exact chain-97 Router, PoolFactory, FactoryRegistry and WBNB identities, `chainId: 97`, and `configuration.volatileFeeBps: 30`.

## 2. Deploy MemeBattles With The Topaz Manifest

Use the checked-in Minimal Topaz manifest or point to it with `TOPAZ_MANIFEST`.

```bash
npm run deploy:check-env:bsc-testnet
TOPAZ_MANIFEST=deployments/bscTestnet/minimal-topaz.json npm run deploy:with-topaz-manifest:bsc-testnet
```

The deploy script reads the manifest, sets `TOPAZ_ROUTER` from `contracts.Router`, deploys the protocol, and runs deployment verification. BSC Testnet verification requires the Topaz router/factory/WBNB wiring and the factory volatile fee to be exactly 30 bps.

## 3. Run A Graduation Scenario

Create a test campaign, buy until it graduates, confirm the graduated volatile Topaz pool, execute at least one buy and sell against the Topaz pool, then harvest LP fees through the locker path.

Record these values for the final report. Amount fields must be unsigned integer strings in wei/base units. `finalCurvePrice` and `initialDexPrice` must use the same units and match exactly in strict mode.

```json
{
  "campaign": "0x...",
  "token": "0x...",
  "creator": "0x...",
  "graduatedPool": "0x...",
  "graduationTx": "0x...",
  "buyTx": "0x...",
  "sellTx": "0x...",
  "harvestTx": "0x...",
  "lockerLpBalanceBeforeTrades": "10000000000000000000",
  "lockerLpBalanceAfterHarvest": "10000000000000000000",
  "claimedToken": "100000000000000000000",
  "claimedWbnb": "5000000000000000000",
  "creatorTokenReceived": "80000000000000000000",
  "creatorWbnbReceived": "4000000000000000000",
  "protocolTokenReceived": "20000000000000000000",
  "protocolWbnbReceived": "1000000000000000000",
  "finalCurvePrice": "123456789",
  "initialDexPrice": "123456789"
}
```

Save that file outside source control, for example `tmp/topaz-acceptance-input.json`.

## 4. Produce The Acceptance Report

Preflight mode checks deployment wiring and writes a report even before campaign evidence is available:

```bash
TOPAZ_MANIFEST=deployments/bscTestnet/minimal-topaz.json npm run testnet:topaz-graduation
```

Strict evidence mode fails if the campaign, pool, transaction, LP, price-continuity, and fee-harvest values are missing or inconsistent:

```bash
TOPAZ_MANIFEST=deployments/bscTestnet/minimal-topaz.json \
TOPAZ_ACCEPTANCE_INPUT=tmp/topaz-acceptance-input.json \
TOPAZ_ACCEPTANCE_REQUIRE_EVIDENCE=true \
npm run testnet:topaz-graduation
```

The script writes:

```text
reports/topaz-graduation-testnet-<timestamp>.json
```

The report validates BSC testnet chain id 97, Minimal Topaz manifest values, Topaz router/factory/WBNB bytecode, fixed volatile fee of 30 bps, MemeBattles deployment bytecode, optional campaign/token/pool bytecode, optional transaction receipts, pool reserves, pool stability, Topaz WBNB pairing, price continuity, locked LP preservation after harvest, nonzero claimed fees in both assets, and the exact 80/20 creator/protocol fee split.
