# BNB mainnet factory + locker replacement (active)

Replacement is **complete** on chain 56. New CREATE uses the corrected 30 / 8000 / 2000 locker. Do not redeploy. Do not touch BNB contracts again unless a new defect appears.

Fork certification: **PASS** on Anvil chain-56 fork of real Topaz (local execution evidence, not GitHub Actions CI).
First live campaign on the new factory (BNBisTHeWay / BTW): CREATE, non-creator BUY, and non-creator SELL **PASS**.

Frozen Solana SBF remains `123469c581ddbd3a616518d7f47dc1248294e8548d239ea948b5699921cd97e8`.
Do not rebuild or substitute that binary.

## Current production (active)

| Piece | Address |
|---|---|
| **Creation factory** | `0xc378221E57898106079aE4B818a92978e4cd9559` |
| **Primary locker** | `0xFcE77642e22ef04B8398fB6dfEE99614CAb32f69` (30 / 8000 / 2000) |
| Support-only factory | `0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a` |
| Authorized legacy locker | `0x64710A4f87aBa3b5ED5B8B25e8ebA4DaC339C998` (30 / 6667 / 3333) |
| Deploy block | `117413737` |
| Manifest | `deployments/bscMainnet.factory-30bps-80-20.json` |

Public env (no secrets):

```bash
VITE_FACTORY_ADDRESS_56=0xc378221E57898106079aE4B818a92978e4cd9559
FACTORY_ADDRESS_56=0xc378221E57898106079aE4B818a92978e4cd9559
VITE_PERMANENT_LP_LOCKER_ADDRESS_56=0xFcE77642e22ef04B8398fB6dfEE99614CAb32f69
VITE_SUPPORTED_FACTORY_ADDRESSES_56=0xc378221E57898106079aE4B818a92978e4cd9559,0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a
SUPPORTED_FACTORY_ADDRESSES_56=0xc378221E57898106079aE4B818a92978e4cd9559,0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a
FACTORY_START_BLOCK_56=117413737
```

## Previous production (support only)

| Piece | Address |
|---|---|
| Legacy creation factory | `0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a` |
| Legacy locker | `0x64710A4f87aBa3b5ED5B8B25e8ebA4DaC339C998` |
| Campaign implementation | `0xbe3caF640F77e8436BCAF89730251A00fB01608f` |
| TopazRouterAdapter | `0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a` |
| Topaz router | `0x1E98c8226e7d452e1888e3d3d2F929346321c6c3` |
| Topaz factory | `0x65E6cD0eF5D3467030103cf3d433034E570b5784` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| GraduationOracle | `0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B` |
| TreasuryRouterV2 | `0xe157a6FDf19CAB61f2ECa048966f137A3240a921` |
| CreatorRegistry | `0x8194FB3745d027102ce7Da562c7045f28B2f42fD` |
| RiskRegistry | `0x92b1494CF7b80dA379EB96F59EeE4Ae7F8970597` |
| Route authority | `0xb989A99823eA96552c3E3198A40CdBF682EDf1aA` |
| ProtocolRevenueVault | `0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c` |
| **Production owner / Safe** | `0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7` |

Re-read live on `0x3068…` during this release-port (selector `0x43f40640`):

```text
eth_call launchProtectionConfig() at:
  bsc-dataseed.binance.org     block 117329882
  bsc-mainnet.public.blastapi.io block 117329885
  anvil fork of 117324094      block 117324194
result (all three):
  blocks_        = 0
  maxBuyWei      = 0
  maxWalletWei   = 0
owner()          = 0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7
requireRouteAuthorization = true
requireAuthorizedTrading  = true
securityDefaultsLocked    = true
live                      = true
createPaused              = false
protocolFeeBps            = 200
tradeRouteProfile         = 1
finalizeRouteProfile      = 1
config.graduationTarget   = 30000e18
```

Mirror those **exact** launch-protection zeros on the new factory with `setLaunchProtectionConfig(0, 0, 0)` before campaign #0. `setLaunchProtectionConfig` is `whenMutable` and locks after the first campaign. Constructor defaults are `createPaused=false` and `live=false`, so `setCreatePaused(true)` must be the first owner transaction after deploy.

## Constructor (reuse production impl/adapter/oracle/treasury)

```text
LaunchFactory(
  0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a,
  0xe157a6FDf19CAB61f2ECa048966f137A3240a921,
  0xbe3caF640F77e8436BCAF89730251A00fB01608f,
  0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B
)
```

New locker is created automatically. Source must be:

- `REQUIRED_POOL_FEE_BPS = 30`
- `CREATOR_FEE_BPS = 8000`
- `PROTOCOL_FEE_BPS = 2000`

No `$6` on chain 56.

## Who can send which transaction

A deployer EOA (`DEPLOYER_PK` / `PRIVATE_KEY_DEPLOY`) can only own a **newly constructed** factory. Live CreatorRegistry and TreasuryRouterV2 are already owned/admin'd by the Safe. After `transferOwnership`, the EOA cannot `enableLive` or unpause CREATE.

| Step | Actor | Why |
|---|---|---|
| Deploy factory + locker, `setCreatePaused(true)`, registries/routes/config, `setLaunchProtectionConfig(0,0,0)`, `lockSecurityDefaults()`, locker self-check, `transferOwnership(0x1edc…)` | Deployer EOA | New factory `onlyOwner` |
| `CreatorRegistry.setLaunchRecorder(newFactory, true)` | Safe `0x1edc…` | Registry `onlyOwner` |
| `setAuthorizedLpLocker(newLocker,true)` then `setPrimaryLpLocker(newLocker)`; keep `0x6471…` authorized | Safe `0x1edc…` | TreasuryRouterV2 `admin` is immutable |
| `enableLive()`, later `setCreatePaused(false)` | Safe `0x1edc…` | Factory owner after handoff |
| Turn route-auth or authorized-trading off | Nobody after lock | `SecurityDefaultsLocked` |

`live=true` is harmless while `createPaused=true`. Authorized CREATE is what the pause blocks after `enableLive`.

## Verify commands (read-only)

Never attach the deployer key. The verifier uses `JsonRpcProvider` only.

```bash
# Live production snapshot (Safe control, old locker 30/6667/3333, primary locker, protection (0,0,0))
npx hardhat run scripts/verify-bnb-factory-replacement.ts

# After ownership handoff + Safe wiring, before enableLive (defaults)
REPLACEMENT_FACTORY=0x... npx hardhat run scripts/verify-bnb-factory-replacement.ts
# asserts live==false, createPaused==true, campaignsCount==0, full production config

# After enableLive, CREATE still paused
REPLACEMENT_FACTORY=0x... REPLACEMENT_EXPECT_LIVE=true npx hardhat run scripts/verify-bnb-factory-replacement.ts

# After CREATE is reopened
REPLACEMENT_FACTORY=0x... REPLACEMENT_EXPECT_LIVE=true REPLACEMENT_EXPECT_CREATE_PAUSED=false \
  npx hardhat run scripts/verify-bnb-factory-replacement.ts

# Local sequence test (no chain-56 spend)
npx hardhat test test/BnbFactoryReplacementSecuritySequence.spec.ts
```

`REPLACEMENT_EXPECT_LIVE` defaults **false**. `REPLACEMENT_EXPECT_CREATE_PAUSED` defaults **true**. The replacement verifier must PASS with those defaults before `enableLive()`.

## Ordered transactions

Do **not** use `scripts/deploy-factory-only.ts` as-is. It enables live by default, never pauses creation, never copies launch protection, never `lockSecurityDefaults()`, and never `transferOwnership`. See audit below.

Phase A sender (EOA only, fail-closed):

```bash
CONFIRM_BNB_FACTORY_REPLACEMENT=I_UNDERSTAND_MAINNET \
  npx hardhat run scripts/deploy-bnb-factory-replacement-phase-a.ts --network bscMainnet
```

That script never `enableLive()`, never `setCreatePaused(false)`, and never writes CreatorRegistry or TreasuryRouter. After it, STOP for the Safe.

### A. Deployer EOA (new factory owner at construction)

1. Deploy `LaunchFactory` (locker created in constructor). Record `newFactory`, `newLocker`, deploy block.
2. **Immediately** `setCreatePaused(true)`.
3. `setRegistries(0x8194…, 0x92b1…)`.
4. `setRouteAuthority(0xb989…)`.
5. `setRouteProfiles(1, 1)` if not already.
6. `setProtocolFee(200)` if not already.
7. `setConfig` matching production: supply 1e9, curve 8400, LP tokens 1400, basePrice 1e9, slope 850, graduationTarget **30000e18**, liquidityBps 3300.
8. `setLaunchProtectionConfig(0, 0, 0)` — copy live `0x3068…` values.
9. Confirm `requireRouteAuthorization==true` and `requireAuthorizedTrading==true` (constructor defaults). **Do not** disable them.
10. `lockSecurityDefaults()`.
11. Read-only self-check: locker 30/8000/2000; `campaignImplementation==0xbe3c…`; `router==0x5c31…`; adapter unwraps to Topaz `0x1E98…` / `0x65E6…` / WBNB `0xbb4C…`; `getFee(0,false)==30`; `isGraduationTargetAllowedForChain(56, 6e18)==false`; `createPaused==true`; `live==false`.
12. `transferOwnership(0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7)`.
13. Verify `owner()==0x1edc…`. Deployer `enableLive` must revert. `REPLACEMENT_FACTORY` verifier will still fail recorder/primary until steps 14–15.

### B. Production Safe `0x1edc…` (TreasuryRouter + CreatorRegistry + live)

14. `CreatorRegistry.setLaunchRecorder(newFactory, true)`.
    RiskRegistry has no recorder; factory only uses its view `canCreatorLaunch`.
15. TreasuryRouterV2:
    - `setAuthorizedLpLocker(newLocker, true)`
    - `setPrimaryLpLocker(newLocker)`
    - keep `authorizedLpLocker[0x6471…] == true`
16. Verify:
    - `authorizedLpLocker[0x6471…] == true`
    - `authorizedLpLocker[newLocker] == true`
    - `permanentLpLocker() == newLocker`
    - `0x3068…` code unchanged
    - new factory `owner()==0x1edc…`, `createPaused==true`, `securityDefaultsLocked==true`, `live==false`
    - `REPLACEMENT_FACTORY=newFactory npx hardhat run scripts/verify-bnb-factory-replacement.ts` must PASS (`live==false`, `createPaused==true`, `campaignsCount==0`, full config)
17. `newFactory.enableLive()`.
    Then `REPLACEMENT_EXPECT_LIVE=true` verifier must PASS (`createPaused` still true).
18. Update frontend/API/indexer **only after** those checks pass:
    - `VITE_FACTORY_ADDRESS_56=newFactory`
    - `VITE_SUPPORTED_FACTORY_ADDRESSES_56=newFactory,0x3068eAE6…`
    - indexer factory list same pattern (old factory support-only)
    - write `deployments/bscMainnet.factory-30bps-80-20.json`; do not silently overwrite factory-only until reviewed
19. **Last:** `newFactory.setCreatePaused(false)`.

Old factory `0x3068…` and locker `0x6471…` remain on-chain for StandbyFolks. Creation moves to the new factory.

## `scripts/deploy-factory-only.ts` audit — do not reuse as-is

| Gap | What it does today | Required for this replacement |
|---|---|---|
| Creation pause | never `setCreatePaused(true)` | pause immediately after deploy |
| Live flag | `FACTORY_ONLY_ENABLE_LIVE` defaults **true** before wiring finishes | `enableLive()` only after lock, Safe wiring, ownership, and checks |
| Security lock | never `lockSecurityDefaults()` | lock before enableLive |
| Launch protection | never `setLaunchProtectionConfig` | copy live `(0,0,0)` before campaign #0 |
| Ownership | leaves factory owned by deployer EOA | `transferOwnership(0x1edc…)` then verify |
| Treasury | optional `FACTORY_ONLY_WIRE_LP_ROUTER`; may skip or attempt EOA writes | Safe-only `setAuthorizedLpLocker` then `setPrimaryLpLocker`; keep old locker authorized |
| Artifacts | overwrites `*.factory-only.json` / frontend env as the active factory | write a new 30bps-80-20 artifact; update env only at step 18 |
| Locker constants | no assert of 30/8000/2000 | fail closed if locker is not the corrected source |

Use a dedicated replacement script or a Safe batch derived from this checklist, not the existing helper.

## Fork harness reminder

`setRequireRouteAuthorization(false)` / `setRequireAuthorizedTrading(false)` exist only in `test/BnbMainnetForkTopazLifecycle.spec.ts`. They must not appear on the production replacement factory.
