# Solana V0 vs leftover Legacy inventory

Date: 2026-08-29
Branch: `build/cross-chain-stabilization-rh-base` (PR 158)

This is an inventory only. Do **not** rewrite the working Create / BUY / SELL V0 path unless a failing Phantom simulation proves a necessary correction.

## Live user path (keep)

These are the wallet-facing mutations Phantom actually signs. They compile `VersionedTransaction`, simulate, refresh blockhash, then sign.

| Flow | File | Envelope |
| --- | --- | --- |
| Create | `frontend/src/pages/Create.tsx`, `PushDraftLive.tsx` → `solanaV4CreateSubmit.ts` | V0 via `solanaV0Transaction.ts` |
| Bonding BUY/SELL | `TokenDetails.tsx`, `WarRoomTradePanel.tsx` → `solanaTradeV1.ts` | V0 via `compileLaunchpadV0WithLatestBlockhash` |
| UpVote | `UpvoteDialog.tsx` → `solanaUpvoteV0.ts` | V0 via `solanaUserV0Transaction.ts` |
| Meteora post-grad | `solanaMeteoraTrade.ts` | V0 via `compileSolanaUserV0WithLatestBlockhash` |
| League / airdrop / recruiter / squad claims | `solanaRewardV0Claim.ts` | V0 |
| Warzone SOL money (unwired) | `solanaArenaV0.ts` | V0 helper exists, **no UI caller** |

Gate: `frontend/scripts/check-solana-user-v0-normalization.mjs`

Phantom may append Lighthouse / priority instructions after signing. Do not reject signed bytes solely because they differ from the simulated envelope.

## Leftover Legacy `Transaction()` — quarantined, not live mutations

| File | What it is | Risk |
| --- | --- | --- |
| `frontend/src/lib/launchpad/adapters/solanaLaunchpadAdapter.ts` | `buildCreateTransaction` / `buildTradeTransaction` / `buildGraduateTransaction` / `buildClaimTransaction` still use `new runtime.web3.Transaction()`. Product `createCampaign` / `buyTokens` / `sellTokens` / `finalizeCampaign` **throw** `V4_ONLY_MUTATION_MESSAGE` and never call those builders. | Dead mutation code. If someone re-enables the adapter methods, Phantom gets Legacy txs. Quarantine; delete in a later cleanup, do not wire. |
| `frontend/src/lib/solanaLaunchpadAdapter.ts` | Stub adapter: create/buy/sell throw “not available yet”. | Safe. |
| `frontend/src/lib/solanaV0Transaction.test.mjs` | Builds a Legacy `Transaction` only to compare envelopes in unit tests. | Test-only. |
| `frontend/scripts/create-launchpad-alt.mjs` | Operator script creating an ALT. | Not a user wallet path. |
| `tools/solana-meteora-graduation/graduate.mjs` | Operator graduation helper still uses Legacy `Transaction`. | Operator, not Phantom user flow. Other file in that folder already uses `VersionedTransaction`. |

## Server / indexer (not Phantom)

These already use `VersionedTransaction`: `scripts/solana/send-server-v0.mjs`, `frontend/api/lib/solanaRewardLane.js`, `realtime-indexer/src/solanaLpFees.ts`, `solanaFeeEscrowWorker.ts`, `publishRecruiterSettlementRoot.ts`.

## Warzone UI (this honesty cut)

`ArenaStakeButton`, `ArenaSupportButton`, and `ArenaWarPoolClaimButton` fail closed on Solana. They must not grow `new Transaction()` or `ethers.Contract` calls for chain 101/102.

## Next (not this cut)

1. Delete or `#ifdef` the unused Legacy builders in `launchpad/adapters/solanaLaunchpadAdapter.ts` after confirming no dynamic import still reaches them.
2. Convert `tools/solana-meteora-graduation/graduate.mjs` to V0 if operators still use it.
3. Wire `solanaArenaV0.ts` only after the charity-free treasury upgrade is accepted.
