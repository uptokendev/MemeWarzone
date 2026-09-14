# MemeWarzone Solana Arena Battle Freeze Addendum

Status: RELEASE-BLOCKING DESIGN ADDENDUM

Applies to: `prep/solana-v0-arena-upgrade` / PR #150

Purpose: reconcile the latest Arena battle lifecycle in PR #149 and the wider MemeWarzone battle/sponsorship documents before the final same-ID `mwz_rewards_treasury` upgrade is certified. This addendum exists specifically to prevent a second Solana treasury upgrade caused by battle-product work landing after certification.

## 1. Product sources reconciled

The final Solana candidate must remain compatible with all project documents already listed in `solana-v0-arena-one-sweep-upgrade.md`, including the UPMEME treasury documents, MemeBattles/Investor Pitch documents, Incentive Systems scope, recruiter/squad/pool/airdrop phases, Phase 1, local hybrid setup, BNB/Solana master build plans, feature inventory, Solana/BNB mainnet combined plans, Interchain DEX outlines, dev/post-grad handoff, BNB Topaz trading, and `solanaupgradev2.md`.

Additional battle-specific source rules now frozen:

- challenger puts money into the battle;
- opponent accepts and puts money in;
- battle duration is a published fixed window (product documents currently describe 24h / 3d / 7d while PR #149 currently uses a 12h runtime constant; duration therefore belongs in pool state/configuration, not hard-coded in the program);
- winner takes the prize subject to the 85/5/10 routing for the normal battle financial base;
- battle rules/scoring/eligibility/settlement are published before the battle starts;
- Support in the current Arena implementation is a donation and creates no supporter claim right;
- separate legally gated Battle Pools/betting are NOT silently included in this treasury candidate;
- battle/tournament sponsorship is a real product funding source and must not require a later program upgrade merely to add prize funding;
- tournament entry identity is the participating token plus its controlling wallet, not merely the wallet.

## 2. Latest PR #149 lifecycle that Solana must support

Current pushed Arena product state uses:

`waiting -> challenged -> live -> finished / expired`

with three sources:

- queue
- direct challenge
- tournament

The API also supports:

- Open for Battle / waiting queue;
- direct challenge;
- accept;
- decline;
- 24h challenge expiry in current pushed code;
- automatic queue matching;
- battle result calculated from relative market-cap percentage change in the current pushed implementation;
- tournament advancement after a finished battle;
- Support cutoff/locked product state distinct from final settlement;
- token-address + owner-wallet tournament entries;
- bracket rounds created as individual battle records, including byes.

The on-chain program does NOT need to encode the current scoring formula or bracket algorithm. It must remain resolver-driven so scoring and tournament progression can evolve without another program upgrade.

## 3. Release-blocking gaps found in the existing Arena candidate

### 3.1 Independent stake amounts

PR #149 auto-match accepts queue candidates inside a 1.2x stake band. The current Solana candidate stores one `stake_lamports` value and requires owner A and owner B to deposit exactly the same value.

That is not sufficiently general.

Freeze requirement:

- store required stake A and required stake B independently;
- record the exact required amount for each participant before either final deposit is accepted;
- store actual deposited stake A and deposited stake B independently;
- resolution signs/binds the exact total actually deposited;
- 85/5/10 applies to the full normal settled prize base;
- refunds return each participant's own exact deposited amount.

Equal-stake battles remain a normal special case. Do not hard-code the current 1.2x matcher band on-chain; that is product/matching policy, not custody logic.

### 3.2 Queue/challenge state remains off-chain until custody is required

`waiting` and the non-financial challenge invitation can remain API/wallet-message state. The Solana treasury should not duplicate discovery/matching state merely for UI parity.

However, once SOL leaves a wallet, custody state is authoritative on-chain.

The API must never mark a battle `live` merely because two rows auto-match. `live` must require the treasury to prove the required participant deposits are funded.

### 3.3 Direct challenge funding and immediate cancellation

The final UX may escrow the challenger's stake when a challenge is created, consistent with the product brief. If that behavior is enabled, decline/cancel must not strand the challenger until a generic timeout.

Freeze requirement:

Add a canonical cancellation path before certification. Preferred model:

- `cancel_pool` (or equivalent) changes an OPEN/LIVE pool to CANCELLED;
- cancellation is authorized by a resolver-signed canonical cancellation message or another equally strict non-admin-drain mechanism;
- message binds program/domain, config version, pool id/PDA, reason code, deadline, current deposited totals and nonce;
- it cannot redirect funds;
- existing stake/refund receipts return funds only to original stakers;
- tournament buy-ins return only through their canonical entry receipt;
- sponsor prize boosts return only through their canonical funding receipt;
- Support follows the frozen cancellation policy (currently charity allocation, never arbitrary receiver).

This also covers declined challenges and operational cancellation without waiting for expiry.

### 3.4 Independent Support cutoff

Current Solana candidate accepts Support while the pool is OPEN/LIVE until generic pool deadlines. The product has a separate Support open/locked state.

Freeze requirement:

Pool state must include:

- `support_deadline`; and
- `support_closed` plus a canonical permissionless or resolver-authorized `close_support` instruction.

After Support closes:

- `donate_support` must fail on-chain;
- sponsor/prize-boost deposits must follow their own frozen cutoff policy and may not masquerade as Support;
- battle settlement can still occur;
- claims/refunds remain available;
- `deposits_paused` remains an emergency global switch, not the normal per-pool Support cutoff.

### 3.5 Battle duration must be data, not program logic

Do not encode 12h, 24h, 3d or 7d as a program constant.

The pool carries configurable deadlines. Preserve configurable deposit/support/resolve timing so product duration options can change without another upgrade.

The program does not need to know the marketing label for a duration. It only enforces the frozen timestamps supplied when the pool is created.

### 3.6 Bind battle assets separately from payout wallets

The current pool primarily binds owner wallets. The financial program should also prove which two Solana assets/campaign identities the pool represents.

Freeze requirement for new ArenaPool accounts:

- `asset_a` / `asset_b` as Solana mint/canonical Pubkey identities;
- `owner_a` / `owner_b` remain payout/stake wallets;
- winner side and winner payout are not conflated;
- pool-open and resolver authorization bind participant assets;
- a battle resolver cannot substitute a third unrelated mint while keeping the same owners.

This is especially important for imported coins, where Arena ownership validation is a separate application concern.

### 3.7 Outcome hash / scoring future-proofing

Do not hard-code market-cap percentage-change scoring into the Solana program.

Add a signed/stored `outcome_hash` (32 bytes) to resolution.

The backend derives this hash from the published battle rules and authoritative result snapshot. It may include/commit to:

- battle/source id;
- participant assets;
- scoring rule/version;
- start snapshot;
- end snapshot;
- winner side / tie;
- tournament round metadata where relevant.

The on-chain program only verifies that the resolver signed the hash together with pool/winner/amount/deadline/nonce fields. This allows scoring formulas to evolve without touching custody code.

### 3.8 Sponsorship / prize boosts

Project documents allow sponsors to fund battles and tournaments, with 70% of sponsorship contributing to the prize pool and separate marketing/protocol routing.

The final Arena treasury must not require another program upgrade simply to receive a sponsor-funded prize increase.

Freeze requirement:

Use a generic `deposit_prize_boost` primitive that receives an already-net prize contribution into the isolated pool vault. The external sponsorship payment rail performs the gross 70/20/10 sponsorship split before the 70% net prize amount reaches the Arena pool.

Critical accounting rule:

- normal financial base = deposited battle stakes + Support + tournament buy-ins;
- normal financial base resolves 85% winner / 5% protocol / 10% MWL;
- `prize_boost_total` is already-net sponsor prize funding and MUST NOT be routed through 85/5/10 a second time;
- on a normal winner result, the full `prize_boost_total` is additive to `pending_winner`;
- on tie/cancellation/expiry with no winner, prize boosts are refundable only to their original funders through canonical funding receipts;
- sponsor funding remains separately observable from community Support in events/accounting.

This avoids turning a documented 70% sponsorship prize contribution into an accidental 59.5% winner contribution through a second fee split.

Each sponsor/prize-boost deposit must create a deterministic receipt containing at least pool id, funding id, funder and exact lamports so multiple funders can be refunded independently without an admin-selected destination.

### 3.9 Tournament entry identity and paid-entry proof

PR #149 tournament entries are keyed by `tournament_id + token_address` and separately store `owner_wallet`. The current Solana `ArenaBuyInReceipt` only binds `pool_id + entrant wallet + amount`.

That is not sufficient because one wallet may control multiple eligible native or imported coins.

Freeze requirement:

- tournament buy-in instruction takes the participating `entry_asset`/mint explicitly;
- `ArenaBuyInReceipt` stores `pool_id`, `entry_asset`, `entrant_wallet`, exact buy-in amount, refunded flag and bump;
- receipt PDA derivation must include enough identity to prevent one paid receipt from proving payment for a different token owned by the same wallet;
- final tournament resolution binds both `winner_asset` and `winner_wallet`;
- final winner validation requires the canonical, non-refunded buy-in receipt for that exact asset/wallet pair;
- API `buy_in_paid` may only become true after authoritative on-chain receipt/transaction verification;
- tournament start must only count paid entries when the tournament requires a non-zero buy-in;
- database opt-in or signed intent alone is not financial proof.

The Solana treasury does not need to store the entire bracket. Bracket generation, byes and advancement remain off-chain; the final signed `outcome_hash` commits to the relevant published tournament result.

## 4. Financial fields the final ArenaPool should be able to represent

At minimum, new Arena pool accounts should support:

- pool id
- kind (battle/tournament)
- custody state
- asset A / asset B for battles
- owner A / owner B
- required stake A
- required stake B
- deposited stake A
- deposited stake B
- tournament buy-in amount
- buy-in total
- Support total
- sponsor/prize-boost total
- support deadline / closed state
- deposit deadline
- resolve deadline
- winner side
- winner asset
- winner payout wallet
- outcome hash
- cancellation reason
- pending winner
- pending protocol
- pending MWL
- pending charity
- claim/refund flags or receipt PDAs
- pool/vault bumps
- action/resolution nonce

Because `ArenaPool` is a new PDA type and has not been deployed on mainnet, its layout should be made sufficiently complete NOW rather than extended after launch.

`RewardsConfig` remains unchanged.

## 5. Canonical receipts

### Battle/tournament pool

`arena_pool` and `arena_vault` remain per-pool and isolated from all existing rewards vaults.

### Tournament buy-in receipt

Must bind:

- pool id
- entry asset/mint
- entrant wallet
- amount
- refunded state

A wallet controlling two tokens must require distinct entry proof for those two tokens.

### Sponsor/prize-boost receipt

Use a separate namespace such as `arena_boost` and bind:

- pool id
- funding id
- funder wallet
- exact amount
- refunded state

Support intentionally has no refund/claim receipt because it remains a donation.

## 6. Canonical resolver messages

### Resolution

Freeze a final resolution domain/version only after the payload below is implemented.

Final resolution must bind at minimum:

- program ID
- Arena config version
- pool id
- pool PDA
- kind
- asset A / asset B
- owner A / owner B or immutable ownership commitment
- exact deposited stake A
- exact deposited stake B
- Support total
- sponsor/prize-boost total
- buy-in total
- winner side
- winner asset
- winner payout wallet
- result type
- outcome hash
- signature deadline
- action nonce

### Cancellation

Use a separate canonical cancellation domain and bind:

- program ID
- config version
- pool id/PDA
- cancellation reason
- current stake A / stake B
- current Support total
- current buy-in total
- current prize-boost total
- deadline
- action nonce

Cancellation cannot specify arbitrary refund destinations.

## 7. V0 transaction additions required

User V0 matrix must cover, where enabled by final UX:

- open matched battle + first exact side stake
- challenger-funded direct challenge
- opponent exact side stake / acceptance funding
- Support donation before Support cutoff
- prize-boost/sponsor funding if user-wallet funded
- winner claim
- immediate cancelled challenge refund
- tie refund
- expired pool refund
- tournament buy-in bound to token/mint
- cancelled tournament buy-in refund
- cancelled/tied sponsor prize-boost refund

Operator/resolver V0 matrix must cover:

- close Support
- cancel pool with signed cancellation authorization
- resolve pool with Ed25519 immediately before Arena instruction
- permissionless/keeper expiry settlement
- protocol/MWL/charity claims

No React component may construct a legacy Solana transaction for these paths.

## 8. Required new adversarial tests

Before candidate certification:

- unequal required stake A/B accepted exactly;
- swapped stake amounts rejected;
- owner A cannot satisfy owner B deposit;
- API auto-match cannot make treasury LIVE before both exact deposits;
- Support accepted before cutoff;
- Support rejected after cutoff while battle remains live;
- Support cutoff cannot redirect custody;
- declined challenge cancellation immediately unlocks only original stake refunds;
- cancellation replay rejected;
- cancellation after resolved state rejected;
- wrong cancellation resolver rejected;
- asset A/B mismatch rejected;
- winner side cannot resolve to unrelated payout wallet;
- outcome hash mutation rejected;
- tournament buy-in receipt cannot prove payment for another token owned by the same wallet;
- tournament winner asset without its own non-refunded paid receipt rejected;
- database opt-in without on-chain paid receipt cannot become paid entry;
- sponsor/prize boost increases only the intended pool;
- sponsor/prize boost is 100% additive to winner after the external sponsorship split and is not charged 85/5/10 again;
- sponsor/prize boost can be refunded only to the original funder on tie/cancel/expiry;
- sponsor/prize-boost refund replay rejected;
- Support and sponsorship accounting remain distinct;
- one pool's prize boost cannot fund another pool;
- all pending buckets plus refundable principal remain <= distributable vault balance;
- full vault conservation proof after claims/refunds.

## 9. Deliberate non-scope for this same-ID upgrade

Do not add legally gated Battle Pool betting merely because old investor material mentions betting. The newer product brief explicitly separates it from normal project-vs-project battle entry and leaves it subject to jurisdiction/compliance/age/wallet eligibility/final configuration.

A future regulated Battle Pool product may use a separate contract/program generation if its legal/economic model materially differs. It must not be confused with current Support donations.

The future MemeWarzone Interchain DEX remains a separate protocol-generation build and is not part of this treasury upgrade.

## 10. Freeze gate

PR #150 remains RED until this addendum is reconciled into `arena.rs`, the V0 client/operator builders, IDL checks and adversarial suite.

Do not produce or approve the final mainnet `.so` before Grok's final Arena battle branch has been re-audited one last time against this addendum.

If Grok changes any money-moving battle requirement after this point, classify it as one of:

- off-chain product state only -> no program change;
- already representable by the generic fields/instructions above -> client/API change only;
- new custody/economic primitive -> candidate audit must reopen BEFORE mainnet upgrade.
