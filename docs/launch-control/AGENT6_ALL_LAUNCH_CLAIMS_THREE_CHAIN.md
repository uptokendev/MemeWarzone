# Agent 6 — Every Claim, Three Chains

## Authority and certification state

Integration authority audited: `build/cross-chain-stabilization-rh-base` at `3f435afdf29353857243477a495b0348e4476400`.

Feature branch: `agent6/all-launch-claims-three-chain`.

Exact product state certified: `7a050d2c1612c429e29dc499f9c2748a10caeb9b`.

Certification run: GitHub Actions run `34186969763`, job `101937156176`.

All dedicated gates passed:

- Agent 6 three-chain source matrix: PASS.
- EVM League verifier tests: PASS.
- Claim API syntax + import checks: PASS.
- Frontend production build: PASS.

After that green run, only temporary certification/recovery tooling was deleted and this evidence document was updated. No claim product file was changed after the certified product state.

This certification is fail-closed: an absent entitlement, proof, configured contract/program, chain-native settlement lane, or authoritative on-chain confirmation is **NOT CLAIMABLE**. It is never silently mapped to another chain, wallet, currency, vault, or transaction.

## Document authority used

The repository is authoritative for what is actually wired on this branch. Product intent was cross-checked against the project document register, with newer/current chain plans and explicit founder decisions taking precedence over older treasury/economic assumptions.

Relevant locked principles:

- Incentive rewards are claim-based and user-initiated through dashboard/profile surfaces.
- Reward claim state needs expiry/recovery/reconciliation rather than database-only success.
- Native accounting stays chain-local; BNB/SOL accounting must not be mixed.
- The Solana plan requires claim authorization, claim nonce, program transaction, confirmed slot, retry state, reconciliation state, and one claim per wallet/batch where required.
- Older documents that describe League-only routing or direct Owners/Ops routing remain historical treasury-governance context where newer reward-bucket architecture supersedes them.
- The August feature inventory's warning that generic Solana claims were not yet fully live is treated as a deployment/marketing warning, not as permission to fake parity. This branch wires only the Solana claim types for which an actual native verifier/builder exists; everything else remains disabled.

## Claim matrix

Legend:

- **CODE CERTIFIED** — branch contains a chain-native preparation/verification/recovery path and dedicated certification passed.
- **CONFIG REQUIRED** — code supports the lane, but the production chain-specific contract/RPC/configuration must exist before it is claimable.
- **NOT IMPLEMENTED** — no legitimate native settlement lane exists in this product surface; fail closed.

| Surface | BNB | Solana | Robinhood |
|---|---|---|---|
| Generic reward ledger — Airdrop | **CODE CERTIFIED** via RewardDistributor when entitlement/proof is materialized | **CODE CERTIFIED / CONFIG REQUIRED** via rewards program, deterministic batch + receipt, finalized tx verification | **CODE CERTIFIED / CONFIG REQUIRED** via explicit chain-specific RewardDistributor only; native value is ETH |
| Generic reward ledger — Squad | **CODE CERTIFIED** via RewardDistributor when entitlement/proof is materialized | **CODE CERTIFIED / CONFIG REQUIRED** via `claim_squad`, deterministic batch + receipt, finalized tx verification | **CODE CERTIFIED / CONFIG REQUIRED** via explicit chain-specific RewardDistributor only; ETH |
| Generic reward ledger — other types (`creator`, `manual`, `future`, etc.) | **CODE CERTIFIED** when a valid RewardDistributor entitlement/proof exists | **NOT IMPLEMENTED** unless an explicit Solana rewards-program instruction is added; returns `solana_unavailable` | **CODE CERTIFIED / CONFIG REQUIRED** only with explicit chain-specific RewardDistributor + entitlement/proof |
| Recruiter native portal | **CODE CERTIFIED** native BNB portal | **CODE CERTIFIED / CONFIG REQUIRED** native SOL portal + Solana reward lane | **NOT IMPLEMENTED** in recruiter-native UI; no false BNB/ETH substitution |
| Weekly League / MWL | **CODE CERTIFIED** TreasuryVaultV2 Merkle claim + exact tx/event verification + reconciliation | **CODE CERTIFIED / CONFIG REQUIRED** rewards treasury claim receipt + finalized tx/account/vault-delta verification | **CODE CERTIFIED / CONFIG REQUIRED** TreasuryVaultV2 only with Robinhood-specific vault + RPC; ETH |
| Monthly League | **CODE CERTIFIED** monthly treasury path | **CODE CERTIFIED / CONFIG REQUIRED** Solana League treasury path; Profile no longer routes monthly Solana into EVM treasury | **CODE CERTIFIED / CONFIG REQUIRED** only with chain-specific EVM League vault/RPC |
| Quarterly Championship | Separate championship runtime. Claimable only when its final payout is materialized through an audited native claim rail. No League claim is synthesized from championship metadata. | Same rule | Same rule |
| LP-fee collection | Existing PermanentLpLocker harvest path; not converted into reward-ledger claims | Existing Solana LP collection path; separate from generic reward claims | Existing PermanentV3PositionLocker harvest path; registered locked position required |

## Critical defects repaired

### 1. Consumed League nonce reused for `record`

`action=claim` consumes the signed wallet nonce. Reusing that same nonce/signature for `action=record` is invalid and correctly fails replay protection.

Fixed in both user-facing League claim surfaces:

- Profile rewards requests a new `recordNonce`, builds a new bound League message, obtains a new signature, then records the confirmed payout.
- Command Center EVM League claims do the same after the on-chain Merkle claim confirms.
- The backend nonce boundary was **not weakened**.

### 2. Solana monthly Profile claim entered the EVM monthly-treasury path

Fixed so EVM monthly uses the EVM monthly-treasury loader only when `!solana`.

Solana monthly now uses the signed Solana League preparation/settlement path and the Solana transaction verifier. This prevents `wallet.signer.sendTransaction` / EVM treasury logic from being used for SOL rewards.

### 3. Database claim state was too easy to treat as payment truth

Claim recording/reconciliation now relies on chain evidence:

- EVM RewardDistributor: exact chain, contract, recipient/batch/amount and successful transaction/event evidence.
- EVM League: exact TreasuryVaultV2, epoch, category, rank, recipient, amount, `Claimed` event and confirmation depth.
- Solana reward lanes: expected program accounts, deterministic receipt/batch, finalized transaction and exact vault balance movement.
- Solana League: expected program/config/vault/epoch/claim-receipt accounts, finalized transaction and exact vault delta.

## Recovery and exactly-once boundaries

- Chain binding: every verifier/reconciliation path binds the entitlement chain. Robinhood cannot inherit a generic BNB contract or vault fallback.
- Recipient/amount binding: exact entitlement recipient and amount are verified from chain evidence.
- Authorization: signed user intent remains action-bound and nonce-backed.
- Replay: used authorization nonces remain consumed; record actions use fresh authorization.
- Confirmation: Solana requires finalized evidence in these recovery verifiers; EVM requires a successful receipt and configured confirmation depth.
- Lost HTTP response/reload: stale `claim_pending`/failed rows can be reconciled from authoritative chain evidence rather than paid twice.
- Concurrency: database row/advisory locks serialize record/reconciliation, while on-chain claim receipts/leaves are the payment-level exactly-once boundary.
- Failed/unconfirmed transactions never advance the claim to authoritative `claimed` state.
- Transaction reuse across a different entitlement is rejected.

## Deployment and marketing boundary

This PR certifies the **software paths and failure behavior**. It does not manufacture deployment evidence for a missing vault/program/configuration.

Before enabling any `CONFIG REQUIRED` cell in production, Launch Control must independently prove the exact deployed contract/program, chain/cluster, RPC, treasury/vault authority, funded entitlement/batch, and a real claim + reconciliation transaction on that chain.

In particular:

- Solana Airdrop/Squad/League code exists here, but production activation must still respect the revised Solana mainnet plan's program/deployment/reconciliation gates.
- Robinhood EVM claim support requires explicit Robinhood chain-specific addresses/RPC. Missing values fail closed; BNB defaults are not accepted.
- Recruiter native payouts remain BNB + Solana only in the current recruiter UI. Robinhood must not be marketed as supported for that surface.
- Do not describe all generic Solana reward types as live: only explicitly wired native instructions are claimable.

## PR hygiene

PR #234 contains only intentional runtime/verifier/recovery/frontend/test/evidence files. Temporary patch runners, recovery scripts and certification workflows were removed after use.

Do not merge this PR solely because source certification is green. Launch Control should first verify any production environment/deployment claims needed for the cells intended to be enabled at launch.