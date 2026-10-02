# Binding tokens, pricing, create path and wallet fixes (2026-09-24)

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

### Live bug 2026-09-24: Solana draft save refused ("require canonical chain 101…")

User report with screenshot. `frontend/api/dev-fix/drafts.js` resolves the
Solana identity from the **request body first** (`body.cluster` before
`SOLANA_CLUSTER`), and `Create.tsx` sends `cluster: VITE_SOLANA_CLUSTER`, which
`.env.example` and `chainRegistry.ts` spell `solana-mainnet-beta`; the shared
resolver `frontend/shared/solanaCurrentAuthority.mjs` accepted only
`mainnet-beta`. Present on live since before 2026-09-22 (commit `46750e0f`),
not caused by today's push. Fixed at the resolver: the registry-key spellings
map to the bare cluster, everything else still fails closed; `draft-deploy.js`
reads the body the same way, so this covers Solana create authorization too.
Draft content is not cached in the browser (only an owner-session key), so a
user with an unsaved draft must keep the tab open until the fix is deployed.

### Explorer verification and vault caps — done 2026-09-24

All mainnet contracts are source-verified: **BscScan 12/12**
(`scripts/verify-mainnet-contracts.ts`, Etherscan v2 API) and **Sourcify 22/22**
for Robinhood (`scripts/sourcify-verify.mjs`; Blockscout blocks scripts with a
Cloudflare challenge and reads Sourcify; hardhat-verify 2.1.3 still targets
Sourcify's retired v1). Arguments live in
`config/verification/mainnet-contracts.json` — add every future deployment
there. Both `ProtocolRevenueVault`s are armed (operator `0x4CB68C7e…`, overflow
the Safe, lifetime $10k); BNB UP votes now enter the vault; Robinhood has its
own `UPVoteTreasury` `0x8C8141B8…`; the sponsorship rail
(`EventPrizeVaultV1` + `WarzoneSponsorshipRouterV1`) is deployed Safe-owned on
both chains with the boost signer as quote signer, no event enabled yet.

### Boost + sponsorship pricing is live-fed (2026-09-24, founder: option A)

The API is the only price oracle for boost and sponsorship quotes on all three
chains (the contracts verify signature + deadline, never the price). Until this
change the three pricing readers took **only** a static env snapshot with a
300 s max age and nothing refreshed it — on live every boost quote was 503.
`frontend/api/lib/arenaNativeUsdFeed.mjs` now prices from the existing Binance
spot readers (56 BNB, 4663 ETH, 101 SOL; the readers gained an `at` observation
time) through `resolveBoostPricingConfig` / `resolveSponsorshipPricingConfig` /
`resolveSolanaNativeUsdPricing`, which stamp the **observation** time and hand it
to the unchanged sync reader, so max age, treasury/router address and signer
checks run once, in one place. A pinned `*_NATIVE_USD_MICROS` env still wins and
is refused when stale, never replaced by the feed. No pricing env is needed on
the API. Audit note in `docs/build_plans/go-live-runbook.md` §P.

### Binding tokens on EVM — facts read 2026-09-24 (launch requirement)

- **Robinhood stock adapter `0xa48723e3…` had no campaign factory bound**
  (`campaignFactory() == 0x0`); the Robinhood deploy script never called
  `setCampaignFactoryOnce` (the BNB one did). Fixed by
  `scripts/configure-robinhood-stock-routes.ts` step 0, which also binds the
  routes: **14 stocks + USDG** meet feed + V3 pool ≥ $50k today
  (`config/robinhood/mainnet-stock-routes.json`, from Robinhood's asset API ×
  Chainlink's `feeds-robinhood-mainnet.json` × the V3 factory). Rehearsed.
- **BNB binding is gated by Topaz liquidity, not code**: the adapter accepts
  only the canonical Topaz volatile WBNB/token pool; on mainnet USDT ~$1.2k,
  BTCB ~$1.5k, ETH ~$185, every other candidate has no pool. Seeding is a
  capital decision (founder).
- **EVM sponsorships need two undeployed contracts** (`EventPrizeVaultV1`,
  `WarzoneSponsorshipRouterV1`), no tests, no deploy script. Not a launch
  blocker (founder), to be fixed the same day. `ARENA_SPONSORSHIP_*` stay off.
- Production `robinhood_stock_token_registry` is empty; it fills from
  `POST /api/admin/robinhood/stock-graduation-registry/sync`. The production
  quote catalog has no 56/4663 rows; `sync-quote-asset-catalog.mjs --db
  production --apply` ports the manifest (founder runs: production write).

### Robinhood binding = native ETH + registry stocks, nothing else (2026-09-24)

Robinhood Chain has two graduation paths, on chain and in the software: native
ETH (V3 adapter) and Robinhood Stock Token **registry** entries (stock adapter;
registry = Robinhood's canonical list, 195 stocks, the create path's sole
eligibility authority). No generic quote adapter exists there, so a catalog
asset like USDG has nothing to graduate through — the verifier's
`ROBINHOOD_GENERIC_ROUTE_NOT_DEPLOYED` is the truth, not a missing env.
`decideQuoteCatalogDeployment` now refuses `approve` for non-native catalog
assets on 4663/46630 (`ROBINHOOD_CATALOG_ROUTE_UNAVAILABLE`) so a hand approval
cannot offer creators a binding that cannot complete. The stock create path
also needs `ROBINHOOD_STOCK_GRADUATION=true` **and** `ROBINHOOD_STOCK_MARKETS=true`
on the API; both were missing from the go-live env until 2026-09-24.

### Two create-path bugs found by the founder's first mainnet tests (2026-09-24)

- **Robinhood create died on the last step: "chain 4663 requires 4/2".** The API's
  generation gate had moved to per-chain factory/campaign pairs (RH 4/3), but
  `frontend/src/lib/scheduledLaunchClientV2.ts` kept its own copy of the old rule.
  The copy is now the same pair table with numeric keys, and
  `route-authorization-signer.test.mjs` parses it and fails on drift. **When the
  API rule changes, the client mirror changes in the same commit.**
- **Solana direct-create answered 500 "Server error [TICKER_UNAVAILABLE]" for a
  taken ticker.** `solanaDirectCreateV4` did `return handleX(body, res)` inside
  its try; a returned promise's rejection skips the catch, so the route's own
  409 mapping never ran and the server's last-resort handler sent 500. Now
  `return await`, pinned by `solana-direct-create-dispatch.test.mjs`. Grep any
  new route for the same shape before trusting its catch.

### Wallet connect forced Robinhood the moment it was allowed (2026-09-24)

`ConnectWalletModal` chose the EVM connect target with
`resolveRobinhoodFeedChainId()`, which answers 4663 whenever Robinhood is
merely **allowed** (`VITE_ALLOWED_CHAIN_IDS`), not selected. So with Robinhood
enabled, every MetaMask connect force-switched to Robinhood and latched the
feed there — "I selected BNB in MetaMask but the frontend reads Robinhood",
and the reverse. Rule now (`frontend/src/lib/walletConnectTarget.mjs`): only an
EVM **token page** pins the chain (you trade a token on its chain); everywhere
else the wallet's own network is respected and `useLatchFeedChainToWallet`
follows it. The chain-first modal the founder remembered was `eda32af9`
(2026-08-28), replaced on purpose by `0983464c` (2026-09-17, "switch RH
in-place"); both are on live. Test pins the helper and the modal's call shape.

### Robinhood creators had no native ETH to pick (2026-09-24)

The Graduation Market step synthesises the chain's native quote client-side
(`evmNativeLaunchQuote`, formerly BNB-only `bnbNativeLaunchQuote`); the
catalog's WETH row is a wrapped duplicate the verifier never activates
(`WRAPPED_NATIVE_DUPLICATE`). Chain 4663 had no default, so the Robinhood
picker was empty and step 5 could not be passed. Now 56/97/4663/46630 all get
the native default, which keeps the native `createCampaignAuthorized` path
(no quote id, `directDeployBindPath` = native, draft fields
`chain-native-default`). Registry stocks join the list once SYNC + RESCAN run
on production. Also: with a Solana wallet connected and no EVM wallet, the
create page used to stay a Solana launch whatever chain was chosen; it now
follows the chosen chain.

### Robinhood factory: stock campaign implementation was never set (2026-09-24)

Running the stock registry sync in the API container surfaced it: every candidate stops at
"Stock campaign implementation is not configured", and `LaunchFactory 0x35E93D0b…` answers
`stockCampaignImplementation() == 0x0`. The generation deploy never deployed
`RobinhoodStockLaunchCampaign` nor called `setStockCampaignImplementation`; the hardhat specs
did both, so nothing caught it. **The setter is `whenMutable` (zero campaigns) — it must land
before create is unpaused on Robinhood (R5 before H) or stock bindings are dead for this
factory generation.** Script: `scripts/deploy-robinhood-stock-campaign-implementation.ts`
(+ Safe batch, + rehearsal spec). **Done 2026-09-24:** implementation
`0xC46D33FCce7030627254278716d4AEb536Cf46FF` (block 71604111, bytecode == artifact), bound by Safe tx
`0x7ae7abbf…` at block 71636126, read back from chain; factory still 0 campaigns, create paused. Lesson: a deploy rehearsal that copies the spec fixture
instead of the deploy script proves the fixture, not the deployment.

### Robinhood stocks: every canonical token is a candidate; the chain decides (2026-09-24)

Founder policy ("Stonk and the Robinhood launchpads allow them all"). The registry sync marks
every token on Robinhood's canonical list a release candidate; the hand-kept manifest entries
are metadata that must agree when present, never a gate. What makes a stock bindable is the
runtime certification alone: route configured on the stock adapter, fresh Chainlink price,
stock-side pool liquidity ≥ $50k, launch-size impact ≤ 500 bps (probe
`ROBINHOOD_STOCK_CERT_PROBE_NATIVE_WEI`, quotes through QuoterV2
`VITE_ROBINHOOD_V3_QUOTER_ADDRESS_4663`). A healthy stock is enabled automatically; the
dashboard's ENABLE is only an override among healthy ones and stays grey for a stock that
fails certification, by design.


