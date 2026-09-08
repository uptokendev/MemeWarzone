# MemeWarzone Solana Final Fee + V0/ATR Freeze

Status: RELEASE BLOCKER for the final Solana same-ID upgrade package.

This document supersedes older Solana fee-routing tables for the final upgrade candidate. It must be read together with:

- `docs/build_plans/solana-v0-arena-one-sweep-upgrade.md`
- `docs/build_plans/solana-arena-battle-freeze-addendum.md`
- the current MemeWarzone Investor Pitch pre-grad economics
- the Recruiter/Airdrop/Squad implementation scope for OG and fallback routing
- `solanaupgradev2.md` for the Solana V0 normalization inventory

## 1. Locked pre-grad trading fee

The user-facing bonding BUY and SELL fee remains exactly 2.00% of trade notional. No new fee is added on top.

### Linked standard recruiter

| Destination | Trade notional |
|---|---:|
| Weekly + Monthly League | 0.75% |
| Creator | 0.10% |
| Recruiter | 0.25% |
| Squad | 0.05% |
| Protocol | 0.85% |
| **Total** | **2.00%** |

League remains 30% weekly / 70% monthly internally.

### Linked OG recruiter

OG adds 0.05% to the recruiter slice. The additional 0.05% comes only from Protocol, never from a higher trader fee.

| Destination | Trade notional |
|---|---:|
| Weekly + Monthly League | 0.75% |
| Creator | 0.10% |
| OG Recruiter | 0.30% |
| Squad | 0.05% |
| Protocol | 0.80% |
| **Total** | **2.00%** |

### Unlinked wallet

Unlinked recruiter and squad slices flow to Warzone Airdrops. Creator fee still belongs to the campaign creator.

| Destination | Trade notional |
|---|---:|
| Weekly + Monthly League | 0.75% |
| Creator | 0.10% |
| Warzone Airdrops | 0.30% |
| Protocol | 0.85% |
| **Total** | **2.00%** |

## 2. Finalize/graduation routing

The confirmed 0.10% creator fee is a BUY/SELL trading fee. It is not added again to finalize/graduation unless a later explicit product decision changes that rule.

Existing finalize fee remains 2.00%:

- standard linked: 0.30% recruiter + 0.05% squad + 1.65% protocol;
- OG linked: 0.35% recruiter + 0.05% squad + 1.60% protocol;
- unlinked: 0.35% to Airdrops + 1.65% protocol.

The OG finalize uplift also comes only from Protocol.

## 3. Current Solana mismatch

The current Solana FeeEscrow V1 account has pending fields only for weekly, monthly, recruiter, airdrop, squad and protocol. There is no creator field. Its stable deployed account size must not be changed in-place.

Current Solana route-profile math already supports the OG trade profile. The missing economic component is the 0.10% creator slice.

Therefore the final candidate MUST NOT resize existing `FeeEscrow` accounts merely to add Creator.

## 4. Creator fee custody design

Add a separate per-campaign creator-fee PDA namespace rather than resizing FeeEscrow V1.

Recommended canonical state:

- seed: `creator-fee-vault`, campaign pubkey
- immutable campaign binding
- immutable creator binding read from the Campaign account at initialization
- `pending_lamports`
- `total_received`
- `total_claimed`
- bump + version

The creator fee is claim-based and isolated from protocol/reward FeeEscrow custody.

### Trade accounting

For every bonding BUY/SELL:

1. calculate the existing 2.00% gross fee;
2. calculate creator slice = 0.10% of trade notional (5% of the 2% fee envelope, with deterministic integer rounding);
3. put creator slice into the canonical creator-fee vault;
4. put the remaining routed fee into the existing FeeEscrow V1;
5. FeeEscrow routing allocates League / Recruiter-or-Airdrop / Squad-or-Airdrop / Protocol using the locked table above;
6. verify creator + all routed buckets equals the exact original fee amount.

No developer, API or arbitrary wallet may select the creator receiver.

### Creator claim

Add a canonical creator claim instruction:

- signer must equal the creator stored/bound for the campaign;
- destination must equal that same creator wallet;
- no arbitrary receiver argument;
- claim is idempotent/replay-safe;
- event exposes campaign, creator, amount and cumulative totals;
- zero/empty claim fails cleanly;
- no admin drain.

The Warzone creator earnings UI must show pending, claimed and lifetime creator-fee earnings from authoritative chain/indexed data.

## 5. Route authorization / OG integrity

ATR-signed trade authorization remains the authoritative input for route profile. Backend attribution must resolve:

- `LINKED` only from the persisted locked wallet→recruiter relationship;
- `OG` only when that linked recruiter's persisted `is_og` state is true;
- otherwise `UNLINKED`.

The signed authorization digest must continue binding route profile, campaign, mint, trader, side, amount, minimum output, deadline and nonce.

Tests must prove a client cannot forge the OG route bit or substitute a different campaign/creator fee destination.

## 6. V0 + ATR transaction standard

Every live Solana mutation used by MemeWarzone must use the shared VersionedTransaction V0 envelope and the canonical ATR/lookup-table posture where the transaction family supports/needs it. There must be no live user-wallet Legacy `Transaction()` fallback.

### User-signed live paths

Must be V0 + canonical validation:

- Create campaign
- First bonding BUY including idempotent ATA creation in the same V0 transaction
- Repeat bonding BUY
- SELL
- Pre-grad UpVote
- Arena UpVote
- Weekly League claim
- Monthly League claim
- Airdrop claim
- Recruiter claim
- Squad claim
- Creator fee claim
- Arena battle open/fund
- Arena stake deposit
- Arena Support
- Arena tournament entry/registration
- Arena sponsor prize boost
- Arena winner/charity/refund claim paths that require a user signature
- Meteora post-grad BUY
- Meteora post-grad SELL
- Creator LP-fee claim/harvest user path where applicable

### Server/operator mutation paths

Use the shared server V0 executor as well:

- recruiter root publication
- squad root publication
- League/Airdrop publication/claim-enablement operations
- FeeEscrow initialization/flush
- creator-fee vault initialization/ops
- expired trade-auth cleanup when server submitted
- Arena resolver/cancel/operator transactions
- LP fee harvest/split operations
- treasury setup/maintenance scripts that remain live

### V0 safety requirements

Every live transaction family must provide its own deterministic intent validator. Do not mechanically replace `Transaction` with `VersionedTransaction` while trusting API-provided accounts.

Required common rules:

- canonical program IDs only;
- canonical PDA derivation locally;
- connected wallet is exact expected payer/signer;
- exact allowed programs/accounts;
- exact recipient(s);
- exact amount/slippage/deadline semantics;
- fresh blockhash immediately before signature;
- simulate before wallet signature where possible;
- inspect the wallet-returned VersionedTransaction before broadcast;
- no arbitrary appended instruction;
- state-based recovery for timeout/expired/ambiguous RPC confirmation;
- idempotent retry semantics for claims and receipts.

For ATR/ALT-backed transactions, the lookup table address must be the canonical configured table and must be loaded/verified before compilation. Production must fail closed rather than silently fall back to Legacy.

## 7. Warzone wiring requirements

The fee model is not complete when only Rust math is correct. It must be wired through the full Warzone stack.

### Backend/API

- trade authorization returns/signs the authoritative route profile;
- OG state comes from persisted recruiter attribution;
- creator identity comes from the canonical campaign record/on-chain Campaign account, never client input;
- creator fee events are indexed idempotently;
- creator fee ledger/history has campaign, creator, trade signature, side, amount, status and timestamps;
- claimability is chain-backed;
- route preview API exposes current standard/OG/unlinked split;
- reconciliation proves indexed totals equal chain events/vault deltas.

### Realtime indexer/workers

- index creator accrual and claim events;
- expose creator pending/lifetime totals;
- include creator vault readiness in campaign market readiness;
- initialize creator-fee vaults for existing active campaigns before fee model activation;
- FeeEscrow/creator vault operations use server V0.

### Frontend / Warzone

- TokenDetails fee preview shows Creator 0.10%;
- War Trade Room uses the exact same shared trade engine and fee preview;
- Command Center → My Coins shows creator fee pending / claimed / lifetime earnings and claim action;
- Recruiter surfaces show 0.25% standard and 0.30% OG accurately;
- Squad/Airdrop copy follows actual linked/unlinked route;
- no duplicate Solana trade engine is permitted between TokenDetails and War Trade Room;
- wallet prompts use the same V0 standard across bonding, rewards and Arena.

### Admin / diagnostics

- show per-campaign FeeEscrow readiness;
- show per-campaign CreatorFeeVault readiness;
- show route-profile/OG decisions and source attribution;
- show reconciliation deltas;
- never offer an admin creator-fee withdrawal destination.

## 8. Required fee invariants

Using trade notional percentages, tests MUST cover:

- standard linked: 0.75 + 0.10 + 0.25 + 0.05 + 0.85 = 2.00;
- OG linked: 0.75 + 0.10 + 0.30 + 0.05 + 0.80 = 2.00;
- unlinked: 0.75 + 0.10 + 0.30 Airdrop + 0.85 = 2.00;
- weekly/monthly remains 30/70 of the 0.75 League slice;
- OG uplift reduces Protocol only;
- creator slice is identical for linked, OG and unlinked trades;
- no route exceeds or falls short of the exact 2% fee after deterministic rounding;
- legacy FeeEscrow V1 layout remains byte-for-byte compatible;
- no creator-fee claim can redirect the receiver;
- forged OG / forged recruiter linkage is rejected;
- missing creator-fee vault fails closed before a trade is authorized/executed.

## 9. Release gate

Do NOT start the final Solana mainnet upgrade until all of the following are green on the exact immutable candidate SHA:

- creator fee implemented on-chain without resizing FeeEscrow V1;
- OG route verified end-to-end from DB attribution → signed trade auth → on-chain split;
- frontend/server/indexer creator-fee wiring complete;
- all live Solana mutations conform to the V0 + ATR standard;
- no live user-wallet Legacy transaction path remains;
- both `memewarzone_solana` and `mwz_rewards_treasury` exact SBF artifacts are compiled/certified;
- IDLs and frontend builders match those exact artifacts;
- full fee-conservation and adversarial tests pass;
- Phantom / Solflare / Backpack matrix passes for the exact candidate;
- existing campaigns are migrated/prepared with required creator-fee vaults before activation;
- Arena/Battle final checks remain green;
- Grok PR #149 is reconciled to the canonical V0/chain-authoritative paths;
- final artifact hashes are recorded before deployment.

This changes the final deployment package from a rewards-treasury-only upgrade into a coordinated, audited two-program Solana upgrade where required: the launchpad program for corrected trade fee routing/V0 account surface and the rewards treasury for the already-frozen rewards/Arena changes. Main remains untouched until the package is certified.