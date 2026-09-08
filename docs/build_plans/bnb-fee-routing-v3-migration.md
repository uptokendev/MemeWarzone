# BNB Fee Routing V3 Migration

Status: deployment plan for branch `fix/bnb-fee-routing-v3`.

## Scope

This branch introduces the canonical EVM fee stack:

- `TreasuryRouterV3`
- `CreatorRewardsVault`
- `LaunchCampaign` strict fee routing
- next launch factory / campaign generation

Historical BNB campaigns remain legacy unless a separate migration proves they can safely route with campaign-aware creator custody.

## Deployment order

1. Deploy `CreatorRewardsVault` with the staging or production admin and temporary router placeholder if needed.
2. Deploy `TreasuryRouterV3`.
3. Configure weekly league, monthly league, recruiter, community, protocol and creator vaults.
4. Authorize the permanent LP locker on `TreasuryRouterV3`.
5. Deploy the new `LaunchCampaign` implementation.
6. Deploy the new `LaunchFactory` generation pointing at `TreasuryRouterV3`.
7. Lock factory security defaults after route authority and registries are confirmed.
8. Run new acceptance against Standard, OG and Unlinked fee vectors plus creator claim.

## Legacy classification

Before promising retroactive creator royalties, classify each existing BNB campaign into one of:

- already upgradeable to V3 routing safely
- permanently bound to V2 routing
- adapter candidate
- legacy and unchanged

Do not use proxy shortcuts or economic fallbacks to retrofit creator fees onto campaigns that cannot prove safe campaign-aware routing.

## Acceptance minimums

- trade preview matches the V3 parity table
- Standard linked BUY and SELL credit creator 0.10%
- OG linked BUY and SELL credit creator 0.10% and recruiter 0.30%
- Unlinked BUY and SELL credit creator 0.10% and Airdrop 0.30%
- finalize preserves existing 2.00% routing without creator
- creator claim succeeds only for the canonical creator
- router failure on the new campaign generation fails closed
