# Solana V0 Transaction Normalization

## Objective
Finish the remaining Solana user-wallet transaction paths using the same V0 transaction standard already proven in production for campaign creation and bonding BUY/SELL.

## Non-negotiable guardrail
The working Solana Create and bonding BUY/SELL flows are the reference implementation. Do not rewrite their transaction semantics, authorization model, account ordering, confirmation behavior, or wallet-facing behavior unless a failing regression test proves a necessary correction.

## Current priority
1. Re-audit current `main` for live Solana Legacy transaction callsites.
2. Extract/refine a generic V0 envelope/core without changing accepted Create/BUY/SELL behavior.
3. Convert League, Airdrop, Recruiter and Squad claims to one shared V0 claim executor.
4. Merge first-trade ATA creation into the existing authorized bonding V0 transaction.
5. Convert Solana UpVote to V0.
6. Re-envelope Meteora post-graduation BUY/SELL into V0 without replacing certified swap logic.
7. Audit creator/user-signed LP-fee claim paths and normalize them where applicable.
8. Normalize backend/operator transactions only after user-facing paths are accepted.
9. Delete or hard-quarantine dead Legacy mutation scaffolding.

## V0 architecture
The generic V0 core must provide reusable envelope behavior such as compilation, payer/signature checks, fresh blockhash handling, simulation, size/signer limits, submission and recovery.

Launchpad-specific Ed25519 -> MemeWarzone instruction adjacency stays in a specialized launchpad intent validator. Claims, UpVotes and Meteora must use their own intent validators and must not inherit an Ed25519 requirement they do not use.

## Reward claim requirements
One shared executor must cover:
- Weekly league claim
- Monthly league claim
- Airdrop claim
- Recruiter claim
- Squad claim

Before wallet signing, independently validate:
- Canonical rewards treasury program
- Connected wallet equals prepared recipient
- Canonical reward vault
- Canonical epoch/batch PDA
- Canonical claim receipt PDA
- Instruction discriminator/type
- Epoch
- Amount
- Proof
- Account writability/signer flags

Never trust an API payload to select a money-moving vault or recipient.

Execution order:
1. Build instructions.
2. Compile V0.
3. Validate intent.
4. Simulate.
5. Refresh blockhash immediately before signing.
6. Wallet signs.
7. Re-inspect wallet-returned transaction where supported.
8. Broadcast.
9. Confirm.
10. On timeout/expiry/ambiguous RPC result, inspect signature status and claim receipt/state before presenting retry.

Existing receipt means the claim succeeded and must not be submitted twice.

## First-trade ATA rule
Do not submit a separate Legacy ATA transaction.

For a wallet without the token ATA, the bonding transaction should be one V0 transaction containing:
1. `CreateAssociatedTokenAccountIdempotent` when needed.
2. Ed25519 authorization verification.
3. MemeWarzone BUY/SELL.

The Ed25519 instruction must remain directly adjacent to the MemeWarzone trade instruction.

Acceptance: a brand-new trader receives exactly one wallet prompt.

## UpVote rule
Use a V0 System Program transfer and validate:
- payer = connected wallet
- recipient = canonical Solana UpVote treasury
- amount = exact configured $3-equivalent lamports
- no unexpected recipient
- no unexpected instruction/program

No ALT is required unless transaction construction later proves otherwise.

## Meteora rule
Do not replace the certified Meteora swap logic merely to obtain V0.

Use the SDK to determine the correct swap instructions/accounts, then compile those instructions into our V0 envelope.

Validate expected pool, launch mint, SOL/wSOL mint, connected wallet, token accounts, amount-in, minimum-out and allowed program set. Reject unexpected programs or recipients.

## Separate recruiter availability dependency
Recruiter epoch publication / treasury program compatibility is separate from the frontend V0 claim conversion. V0 cannot fix a missing on-chain instruction or unpublished reward root. Verify treasury program/IDL/authority before any same-ID upgrade or epoch publication.

## Regression rules
Every change must prove the existing Create and bonding BUY/SELL paths remain unchanged and green.

Required user-wallet matrix:
- Create
- First bonding BUY without ATA
- Repeat BUY
- SELL
- UpVote
- Weekly league claim
- Monthly league claim
- Airdrop claim
- Recruiter claim
- Squad claim
- Meteora BUY
- Meteora SELL
- Creator/user LP-fee claim paths where present

Wallets:
- Phantom
- Solflare
- Backpack

For every live user transaction:
- V0 transaction
- expected wallet prompt count
- simulation before wallet signing
- expected signer only
- exact programs/recipients/amounts
- fresh blockhash
- deterministic recovery after ambiguous confirmation
- explorer success/state proof

Negative tests must reject wrong program, vault, recipient, claim receipt, epoch, amount, mutated wallet-returned transaction and duplicate claim submission.

## CI guardrail
After migration, no new live frontend user-wallet `Transaction()` construction should be allowed. Tests and explicitly quarantined/dead code may be exempted by a narrow allowlist.

# Final test and upgrade runway

The code-normalization phase is not considered releasable merely because the frontend compiles. The final release gate is the complete sequence below.

## Gate A - repository certification
All of the following checks must be green on the exact branch head that will be tested:
- Solana User V0 Normalization
- Solana Backend V0 Normalization
- Solana V0 Transaction Gate
- Solana Final Launch Blocker Gate
- Solana Rewards Treasury Upgrade Candidate
- Release certification (candidate SHA)
- Solana FeeEscrow DB lease CI
- frontend pull request proof
- Secret Scan
- Topaz Integration CI

Do not waive an unrelated red check just because the Solana-specific gates are green. Fix or prove the failure before release.

## Gate B - certified rewards treasury artifact
Use only the artifact emitted by `Solana Rewards Treasury Upgrade Candidate` for the exact accepted commit.

The artifact must contain:
- `mwz_rewards_treasury.so`
- `mwz_rewards_treasury.json`
- `rewards-treasury-sha256.txt`
- `rewards-treasury-candidate.txt`

The expected rewards treasury program ID is:
`2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX`

The IDL must include:
- `set_recruiter_batch_root`
- `claim_recruiter`
- `set_squad_batch_root`
- `claim_squad`

Before any upgrade, run:

```bash
export SOLANA_RPC_URL="<target RPC>"
export SOLANA_REWARDS_UPGRADE_AUTHORITY="<expected upgrade authority pubkey>"
bash scripts/solana/preflight-rewards-treasury-upgrade.sh \
  target/deploy/mwz_rewards_treasury.so \
  target/idl/mwz_rewards_treasury.json \
  rewards-treasury-sha256.txt
```

The preflight must prove the exact program ID, upgradeability, readable/matching authority, artifact hashes and required IDL instructions. It also dumps the live program and records the deployed/candidate SHA256 values so we know whether an upgrade is actually required.

## Gate C - testnet wallet acceptance
Run the complete transaction matrix on the test deployment before touching mainnet. Do not use a single warm wallet for the whole matrix.

Use at least:
- one brand-new wallet with no launch-token ATA
- one funded repeat-trader wallet
- one claim-eligible wallet per reward lane where practical
- Phantom
- Solflare
- Backpack

For CREATE and bonding BUY/SELL, this is regression-only. The already accepted transaction semantics must not be modified to make another test pass.

For first BUY, require exactly one wallet transaction prompt containing the idempotent ATA creation plus the authorized BUY path.

For every wallet-signed transaction record:
- wallet
- transaction family
- signature
- V0 confirmation
- simulation pass
- expected signer count
- expected programs/accounts
- expected amount/minimum-out where applicable
- resulting state
- explorer link

## Gate D - reward claim acceptance
Prepare test batches for each claim family and prove:
- weekly league claim succeeds
- monthly league claim succeeds
- airdrop claim succeeds
- recruiter claim succeeds
- squad claim succeeds
- duplicate claim is rejected or recovered as already complete without a second payout
- ambiguous confirmation recovers from receipt/state
- wrong recipient is rejected client-side
- wrong vault/PDA is rejected client-side
- wrong amount/epoch/proof is rejected before broadcast or by the on-chain verifier as appropriate

For recruiter and squad lanes, root publication must be tested independently from the user claim transaction.

## Gate E - Meteora acceptance
Use the pinned/certified Meteora SDK path. Do not change SDK version during this release test.

Prove on the test deployment:
- graduated token resolves to the expected Meteora pool
- post-grad BUY is V0
- post-grad SELL is V0
- amount-in and minimum-out match the displayed quote
- only the allowed program set appears
- no unexpected recipient appears
- chart/indexer continuity survives bonding -> graduation -> Meteora trading
- LP fee harvest does not move LP principal
- creator/protocol split matches the configured economics

## Gate F - mainnet pre-upgrade dry run
Before sending any upgrade transaction:
1. Download the exact certified artifact from the accepted commit.
2. Verify the artifact digest and embedded SHA256 manifest.
3. Run `preflight-rewards-treasury-upgrade.sh` against mainnet RPC.
4. Confirm the live upgrade authority is the expected authority/multisig path.
5. Save the current deployed program SHA256 and ProgramData address.
6. Save the candidate SHA256.
7. Confirm the same program ID will be retained.
8. Confirm no settlement exporter will be rerun for recruiter epoch 44.
9. Confirm the exact post-upgrade recovery/rollback owner is available.

If the live hash already equals the candidate hash, do not submit an upgrade merely because one was planned.

## Gate G - same-ID treasury upgrade and immediate verification
Only after Gates A-F pass:
1. Upgrade `2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX` using the certified `.so`.
2. Immediately `solana program dump` the live program again and compare its SHA256 with the candidate.
3. Verify ProgramData and upgrade authority remain expected.
4. Verify config and all existing vault PDAs still exist and are owned by the same program.
5. Verify existing balances were not changed by the program upgrade.
6. Read-test the recruiter/squad instruction surface against the upgraded program.

Do not publish any production reward root until these checks pass.

## Gate H - recruiter epoch 44 recovery
After the treasury upgrade is proven:
1. Publish only the already-prepared recruiter epoch 44 root.
2. Do not rerun the settlement exporter.
3. Require database batch state `prepared -> claim_open`.
4. Require the prepared user claim state to become claimable.
5. Chain-read root, total lamports, deadline, recipient and claim receipt PDA.
6. Execute one controlled V0 recruiter claim.
7. Verify exact payout, claim receipt and final database state.
8. Attempt duplicate/recovery path and prove no second payout can occur.

Only after this controlled claim passes should recruiter claims be considered production-open.

## Final go/no-go rule
The release is upgrade-ready only when the exact accepted commit has a fully green Gate A, the certified artifact from that commit passes the mainnet preflight, and the complete testnet wallet/reward/Meteora matrix has evidence attached or recorded.

A green build alone is not an upgrade approval.