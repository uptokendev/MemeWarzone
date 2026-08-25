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
