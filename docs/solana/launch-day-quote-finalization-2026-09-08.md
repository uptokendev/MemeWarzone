# Solana launch-day quote finalization — 2026-09-08

Authority before BNB #230 merge: `42f00b9c5cc56d9956efa79f1fdb5cfd8edd7566`

Branch: `agent2/solana-approved-quote-expansion`

## Launch rule

Safe subset wins over target count. No asset is launch-active merely because its mint exists or an external market route appears to exist.

For launch activation every candidate must have all of the following at the MemeWarzone protocol boundary:

1. exact chain + mint + provider identity;
2. active runtime Quote Asset Catalog deployment + policy binding;
3. real SOL/WSOL -> QUOTE acquisition configuration and graduation-sized certification inside the supported adapter path;
4. fresh authoritative QUOTE/USD reference configured with correct token pricing semantics;
5. MEME/QUOTE Meteora final-market certification with permanent custody;
6. fail-closed recovery preserving the selected quote and never falling back to SOL.

The existing #216 generic architecture is preserved. No Solana program source, SBF, routing architecture, token import path, or arbitrary/custom quote path is changed by this finalization.

## Existing launch-safe authority

| Symbol | Exact identity | Runtime provider | Acquisition | Price | Final LP | Launch state |
|---|---|---|---|---|---|---|
| SOL | `native:101` (graduation WSOL mint `So11111111111111111111111111111111111111112`) | `solana-basic` | Native path | Existing SOL/USD authority | Certified Meteora MEME/WSOL permanent custody | **ACTIVE-SAFE** |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `solana-basic` | Existing mainnet `JUPITER` acquisition path | Existing active USDC policy (`USDCUSDT` / `usd-coin` reference with pinned stable reference) | Existing certified Meteora MEME/USDC path + permanent custody | **ACTIVE-SAFE** |

## Audited pending candidates

The integrated `approved-quote-catalog.v1.json` is a researched fail-closed inventory. The migration `20260907235000_approved_quote_catalog_expansion.sql` adds lifecycle fields and projects only the pre-existing SOL/USDC BASIC deployments to `ACTIVE`; it does **not** insert runtime provider/deployment/policy authority for the broader candidate inventory.

Accordingly, no candidate below is launch-safe tonight. External market availability does not substitute for protocol certification.

| Symbol | Exact mint | Candidate provider identity | Identity status | Launch blocker |
|---|---|---|---|---|
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `canonical-stable` / Tether | Snapshot identity verified | No active runtime deployment/policy; no graduation-sized Jupiter certification; no configured/fresh QUOTE/USD authority; no per-asset Meteora final-LP certification. |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | `canonical-stable` / PayPal USD | Snapshot identity verified | No active runtime deployment/policy; transfer/security still pending in snapshot; no graduation-sized Jupiter certification; no configured/fresh QUOTE/USD authority; no per-asset Meteora final-LP certification. |
| USDG | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | `canonical-stable` / Global Dollar | Snapshot identity verified | No active runtime deployment/policy; transfer/security still pending in snapshot; no graduation-sized Jupiter certification; no configured/fresh QUOTE/USD authority; no per-asset Meteora final-LP certification. |
| JupUSD | `JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD` | `jupiter` | Snapshot identity verified | No active runtime deployment/policy; security/route/price/LP pending; no graduation-sized Jupiter acquisition certification; no approved fresh USD authority; no per-asset Meteora final-LP certification. |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | `jupiter` | Snapshot identity verified | No active runtime deployment/policy; `SOLANA_GRADUATION_BASIC_RELEASE_ONLY` defaults fail-closed for non-native/non-stable profiles; no graduation-sized Jupiter + price + Meteora certification. |
| PYTH | `HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3` | `pyth` | Snapshot identity verified | No active runtime deployment/policy; BASIC release gate currently excludes CRYPTO profile; no graduation-sized Jupiter + price + Meteora certification. |
| JTO | `jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL` | `jito` | Snapshot identity verified | No active runtime deployment/policy; BASIC release gate currently excludes CRYPTO profile; no graduation-sized Jupiter + price + Meteora certification. |
| ORCA | `orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` | `orca` | Snapshot identity verified | No active runtime deployment/policy; BASIC release gate currently excludes CRYPTO profile; no graduation-sized Jupiter + price + Meteora certification. |
| AAPLx | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | `xstocks` | Snapshot identity verified | No active runtime deployment/policy; BASIC release gate excludes RWA profile; no graduation-sized acquisition certification; no approved fresh token-vs-underlying USD semantics; no per-asset Meteora final-LP certification. |
| NVDAx | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| TSLAx | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| GOOGLx | `XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| AMZNx | `Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| COINx | `Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| METAx | `Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| NFLXx | `XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| SPYx | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| QQQx | `Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ` | `xstocks` | Snapshot identity verified | Same xStocks blockers: runtime binding absent; RWA release gate; acquisition, authoritative pricing semantics, and Meteora certification absent. |
| PENGU | `2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv` | Pudgy Penguins identity; **no MemeWarzone runtime provider binding** | Exact Solana mint independently rechecked; not present in integrated broad snapshot | Must first enter the provider/deployment catalog fail-closed, then pass security/transferability, graduation-sized Jupiter acquisition, fresh price authority, and Meteora final-LP certification. No launch activation tonight. |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | BONK identity; **no MemeWarzone runtime provider binding** | Exact Solana mint independently rechecked; not present in integrated broad snapshot | Must first enter the provider/deployment catalog fail-closed, then pass security/transferability, graduation-sized Jupiter acquisition, fresh price authority, and Meteora final-LP certification. No launch activation tonight. |

## Gate counts

- Candidates audited: **22**
- Existing fully ACTIVE-SAFE: **2** (`SOL`, `USDC`)
- Broader candidates with integrated snapshot identity: **18**
- Additional exact mints independently identified but lacking MemeWarzone provider binding: **2** (`PENGU`, `BONK`)
- Acquisition PASS at launch authority: **2**
- Price PASS at launch authority: **2**
- Final LP PASS at launch authority: **2**
- Pending: **20**
- Rejected: **0**

## Recovery / fallback invariant

#216 already proved the required fail-closed model using the same campaign: an unhealthy selected non-native quote was rejected, the campaign stayed pending and recoverable, the selected quote was restored and retried successfully, and no MEME/WSOL fallback pool was created. This finalization does not alter that path.

**NO NATIVE FALLBACK: PASS**

## Program upgrade conclusion

The #216 architecture is already generic for ordinary approved quote additions through catalog/policy/route configuration. The current launch freeze does not require a Solana program upgrade or redeploy.

**PROGRAM UPGRADE REQUIRED FOR ORDINARY APPROVED ADDITIONS: NO**

## Launch decision

The truthful Solana launch-day creator quote catalog remains:

- `SOL`
- `USDC` — `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

All other audited candidates remain non-selectable and fail closed until their missing runtime and certification gates are independently closed.

This document is audit evidence only. It does not activate any quote asset, change Solana program code, change routing architecture, change token import, or change fallback behavior.
