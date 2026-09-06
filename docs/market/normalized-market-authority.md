# Generation-aware normalized market authority

Agent 4 adds an **additive** authority for NEW post-graduation market generations. Historical BNB Topaz, Solana Meteora and Robinhood Stock Token rows and semantics are not renamed, backfilled or reinterpreted.

## Ownership boundaries

- Agent 1 owns the Quote Asset Catalog and all quote eligibility decisions.
- Agent 3 owns BNB quote binding and BNB graduation execution.
- Grok owns Create UI and draft catalog-reference persistence.
- Agent 4 owns market/indexer/USD/LP-fee/Arena normalization.

## Agent 1 → Agent 3 → Agent 4 boundary

The source of quote truth is `frontend/api/lib/quoteAssetCatalog.js`. Agent 4 consumes the public Agent 1 catalog result exactly: deployment `id`, `assetId`, `provider.key`, `chainId`, `contractAddressOrMint`, `assetClass`, `newGraduationEligible`, and `policy.authority/policyKey/version`. Agent 4 does not derive identity/security/market-health/BASIC approval or any other eligibility gate.

For BNB BASIC markets, Agent 3's `buildBnbBasicQuoteCatalogBinding()` commits the exact deployment ID, quote token, provider and policy key/version used by BNB creation/graduation. Agent 4 verifies those identity fields still match the same Agent 1 result before normalizing the graduated MEME/QUOTE pool. The normalized identity then persists `quoteAssetId`, `quoteDeploymentId`, `quotePolicyKey`, `quotePolicyVersion`, `quotePolicyAuthority`, quote class, provider and chain ID. Symbols remain display metadata.

## USD and exact accounting

Trades store exact `baseAmountRaw` and `quoteAmountRaw` as integer strings. USD normalization is `price in QUOTE * authoritative QUOTE/USD`. The same reference binding (quote address + Agent 1 policy key/version) is used for price, market cap, liquidity, volume, chart values, LP-fee estimates and Arena snapshots. Missing/stale references yield explicit `missing`/`stale` state and null USD values. There is no native fallback, stable=$1 fallback or unknown=$1 fallback.

## Routing and compatibility

Wallet input/output does not define pool identity. BNB→WBNB→QUOTE→MEME remains MEME/QUOTE; SOL→QUOTE→MEME remains MEME/QUOTE; ETH→STOCK→MEME remains MEME/STOCK. Legacy Topaz/Meteora/Robinhood code paths remain unchanged. Arena receives one normalized USD snapshot shape and canonical Battle scoring remains quote neutral.
