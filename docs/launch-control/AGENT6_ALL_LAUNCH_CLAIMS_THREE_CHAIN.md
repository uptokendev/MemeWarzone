# Agent 6 — Every Claim, Three Chains

Authority audited: `build/cross-chain-stabilization-rh-base` at `2f895b707260309ffa941fca55b0e408b597ab80`.

This certification is fail-closed: an absent entitlement or absent chain-native settlement lane is **NOT IMPLEMENTED / NOT CLAIMABLE**, never silently mapped to another chain or currency.

## Settlement rails

| Surface | BNB | Solana | Robinhood |
|---|---|---|---|
| Generic reward ledger (`battle`, `tournament`, `creator`, `sponsor`, `other`) | RewardDistributor when materialized | only types with a native rewards-program instruction are claimable; unsupported types fail closed | chain-specific RewardDistributor only; native value is ETH |
| Airdrop | RewardDistributor | rewards treasury + deterministic claim receipt | RewardDistributor only when chain-specific entitlement/config exists; ETH |
| Squad | RewardDistributor | rewards treasury `claim_squad` + deterministic claim receipt | RewardDistributor only when materialized/configured; ETH |
| Recruiter native portal | BNB native portal | SOL native portal | NOT IMPLEMENTED in current recruiter-native UI; no false BNB fallback |
| MWL / League | TreasuryVaultV2 Merkle claim | Solana rewards treasury League claim receipt | TreasuryVaultV2 only with chain-specific vault/RPC; ETH |
| Quarterly Championship | separate championship runtime; certify only where its final payout materializes through an audited claim rail | same rule | same rule; no claim is synthesized from League metadata |
| LP fees | PermanentLpLocker harvest | backend Solana LP collection path | PermanentV3PositionLocker harvest; registered locked position required |

## Cross-cutting proof

- Chain: every record/reconciliation path binds the entitlement chain; Robinhood cannot inherit generic BNB RewardDistributor or TreasuryVault addresses.
- Recipient and amount: EVM record/recovery decodes exact calls/events; Solana verifies deterministic program accounts/receipt data.
- Authorization/signature: user claim intent/record requires signed wallet action auth; League claim message binds chain, recipient, epoch, category, rank and nonce.
- Builder/wallet: EVM waits mined wallet transactions; Solana verification accepts Versioned Transaction V0 (`maxSupportedTransactionVersion: 0`).
- Confirmation: Solana reconciliation requires `finalized`; EVM requires successful receipt plus configured confirmation depth.
- State/accounting: database transitions are locked and occur only after chain verification. Replay of a tx against another entitlement is rejected.
- Reload/lost HTTP response: stale `claim_pending`/`failed` generic reward rows are reconciled from authoritative EVM events or finalized Solana receipt PDAs. EVM League has event/state discovery and locked repair.
- Double-click/concurrency: UI pending action guards reduce duplicate submits; database row locks/advisory locks serialize record/reconciliation; on-chain distributors/vault receipt state provides the payment-level exactly-once boundary.
- Failed transaction retry: reverted/missing/unfinalized transactions do not advance `claimed`; stale rows remain recoverable.

## Deliberately unsupported / blocked

Do not label a cell PASS merely because another chain has a similarly named button. Current repository evidence does **not** establish a Robinhood recruiter-native portal lane, and Solana generic reward types other than the explicitly wired rewards-program instructions remain fail-closed. Quarterly Championship uses its own championship runtime; it is not converted into an MWL payout by this certification.
