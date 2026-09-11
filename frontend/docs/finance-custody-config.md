# Finance reward custody configuration

The Finance API compares canonical native-asset reward obligations with approved reward claim custody balances. These reads happen only on the Railway Frontend API. Custody addresses and RPC URLs are not returned to the dashboard Finance read model.

## BNB Chain

BNB Testnet uses chain ID `97`; BNB Mainnet uses chain ID `56`.

The active BNB claim-intent flow uses the Merkle `RewardDistributor` contract. Finance therefore treats that claim distributor as the default reward funding custody source, not the Community/Recruiter routing vaults.

Default claim-custody variables:

- `REWARD_DISTRIBUTOR_ADDRESS_97`
- `REWARD_DISTRIBUTOR_ADDRESS_56`

The existing claim-flow aliases are also accepted, including `BNB_TESTNET_REWARD_DISTRIBUTOR_ADDRESS`, `BNB_REWARD_DISTRIBUTOR_ADDRESS`, and `REWARD_DISTRIBUTOR_ADDRESS_BNB` where applicable.

If Finance later needs multiple approved claim-custody addresses, configure them explicitly as CSV:

- `FINANCE_REWARD_CUSTODY_ADDRESSES_97`
- `FINANCE_REWARD_CUSTODY_ADDRESSES_56`

When that explicit list is present it is authoritative and addresses are deduplicated before balances are summed.

`COMMUNITY_REWARDS_VAULT_ADDRESS_*` and `RECRUITER_REWARDS_VAULT_ADDRESS_*` remain important protocol-routing inventory, but Finance does not automatically count their balances as claim funding. Doing so could double-count routed funds that are not actually available to the active RewardDistributor claim lane.

Balance reads use CSV RPC failover from:

- `BSC_RPC_HTTP_97`
- `BSC_RPC_HTTP_56`

`VITE_PUBLIC_RPC_97` / `VITE_PUBLIC_RPC_56` are read-only compatibility fallbacks. Production should prefer server-only `BSC_RPC_HTTP_*` values.

## Solana

Current Solana Finance authority uses one application chain ID: `101`.

Environment is never inferred from a second product chain ID. Every environment-sensitive Solana Finance request must provide one canonical pair:

- staging: `chainId=101`, `environment=staging`, `solanaCluster=devnet`
- production: `chainId=101`, `environment=production`, `solanaCluster=mainnet-beta`

Legacy chain ID `102` is not a current Finance authority and must fail closed. Historical records may still retain `102` only where they are interpreted as legacy data rather than used to select a live network.

The current reward claim API explicitly keeps Solana claiming disabled. Finance therefore requires an explicit approved Solana reward-custody identity before reporting funded coverage and must not reuse the LP operator wallet merely because that wallet already exists.

Preferred explicit CSV variables:

- Devnet: `FINANCE_REWARD_CUSTODY_ADDRESSES_101_DEVNET`
- Mainnet: `FINANCE_REWARD_CUSTODY_ADDRESSES_101_MAINNET`
- Shared compatibility fallback: `FINANCE_REWARD_CUSTODY_ADDRESSES_101`

Compatibility single-address variables:

- Devnet: `SOLANA_DEVNET_REWARD_VAULT_ADDRESS`
- Devnet fallback: `SOLANA_REWARD_VAULT_ADDRESS`
- Mainnet: `SOLANA_MAINNET_REWARD_VAULT_ADDRESS`

RPC configuration:

- Devnet: `SOLANA_DEVNET_RPC_HTTP`
- Devnet fallback: `SOLANA_RPC_HTTP`
- Mainnet: `SOLANA_MAINNET_RPC_HTTP`

A missing or crossed environment/cluster pair, missing approved custody identity, or missing/unreadable RPC produces a blocked/fail-closed result. It never becomes a funded amount of zero by assumption and never falls back across devnet/mainnet.

## Obligation definition

For the first custody pass, outstanding native-asset reward obligation is the sum of canonical `reward_ledger` rows normalized to these states:

- `allocated`
- `claimable`
- `pending`

Rows normalized to `claimed`, `expired`, or `returned` are not outstanding obligations.

Only native BNB/SOL rows are admitted to this coverage calculation. Non-native reward tokens are intentionally excluded until token-specific decimals and custody identities are mapped. This prevents applying BNB's 18 decimals or SOL's 9 decimals to unrelated assets.

## Reconciliation semantics

`finance-reconciliation-v1` currently combines:

- approved Finance inventory coverage,
- reward claim-custody readability,
- native reward funding vs outstanding obligation,
- LP source errors and freshness from the realtime Indexer.

`balancedInventoryCount` should be interpreted as the number of tracked surfaces that currently have a passing balance/control check, not proof that every protocol balance has been fully ledger-reconciled.

A shortfall produces a funding break. Missing/unreadable custody configuration blocks reconciliation. Other treasury/protocol surfaces remain in `attention` until their expected-vs-observed balance rules are mapped.

## Mainnet readiness

Mainnet variables should remain unset until the corresponding contracts/programs are deployed and approved. The Finance network selector can still select production only with canonical `101 + production + mainnet-beta`; the correct result before deployment is blocked/unconfigured data, never automatic fallback to testnet/devnet.
