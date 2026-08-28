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
- winner takes the prize subject to the 85/5/10 routing;
- battle rules/scoring/eligibility/settlement are published before the battle starts;
- Support in the current Arena implementation is a donation and creates no supporter claim right;
- separate legally gated Battle Pools/betting are NOT silently included in this treasury candidate;
- battle/tournament sponsorship is a real product funding source and must not require a later program upgrade merely to add prize funding.

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
- Support cutoff/locked product state distinct from final settlement.

The on-chain program does NOT need to encode the current scoring formula. It must remain resolver-driven so scoring can evolve without another program upgrade.

## 3. Release-blocking gaps found in the existing Arena candidate

### 3.1 Independent stake amounts

PR #149 auto-match accepts queue candidates inside a 1.2x stake band. The current Solana candidate stores one `stake_lamports` value and requires owner A and owner B to deposit exactly the same value.

That is not sufficiently general.

Freeze requirement:

- store `stake_a_lamports` and `stake_b_lamports` independently;
- record the exact required amount for each participant before either final deposit is accepted;
- resolution signs/binds the exact total actually deposited;
- 85/5/10 applies to the full settled prize base;
- refunds return each participant's own exact deposited amount.

Equal-stake battles remain a normal special case.

### 3.2 Queue/challenge state remains off-chain until custody is required

`waiting` and the non-financial challenge invitation can remain API/wallet-message state. The Solana treasury should not duplicate discovery/matching state merely for UI parity.

However, once SOL leaves a wallet, custody state is authoritative on-chain.

The API must never mark a battle `live` merely because two rows auto-match. `live` must require the treasury to prove the required participant deposits are funded.

### 3.3 Direct challenge funding and immediate cancellation

The final UX may escrow the challenger's stake when a challenge is created, consistent with the product brief. If that behavior is enabled, decline/cancel must not strand the challenger until a generic timeout.

Freeze requirement:

Add a canonical cancellation path before certification. Preferred model:

- `cancel_pool` (or equivalent) changes an OPEN pool to CANCELLED;
- cancellation is authorized by a resolver-signed canonical cancellation message or another equally strict non-admin-drain mechanism;
- message binds program/domain, config version, pool id/PDA, reason code, deadline and nonce;
- it cannot redirect funds;
- existing stake/refund receipts return funds only to original stakers;
- support follows the frozen cancellation policy (currently charity allocation, never arbitrary receiver).

This also covers declined challenges and operational cancellation without waiting for expiry.

### 3.4 Independent Support cutoff

Current Solana candidate accepts Support while the pool is OPEN/LIVE until generic pool deadlines. The product has a separate Support open/locked state.

Freeze requirement:

Pool state must include either:

- `support_deadline`, or
- `support_closed` plus a canonical `close_support` instruction,

preferably both (automatic deadline plus explicit resolver/authority close).

After Support closes:

- `donate_support` must fail on-chain;
- battle settlement can still occur;
- claims/refunds remain available;
- depositsPaused remains an emergency global switch, not the normal per-pool Support cutoff.

### 3.5 Battle duration must be data, not program logic

Do not encode 12h, 24h, 3d or 7d as a program constant.

The pool already carries deadlines. Preserve configurable start/deposit/support/resolve timing so product duration options can change without another upgrade.

### 3.6 Bind battle assets separately from payout wallets

The current pool primarily binds owner wallets. The financial program should also be able to prove which two Solana assets/campaign identities the pool represents.

Freeze requirement for new ArenaPool accounts:

- `asset_a` / `asset_b` (Solana mint or canonical Pubkey identity where applicable);
- `owner_a` / `owner_b` remain payout/stake wallets;
- winner side and winner payout are not conflated;
- pool-open and resolver authorization bind the participant assets.

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

Provide a generic on-chain prize-funding primitive before certification. Two acceptable models:

A. `deposit_prize_boost(pool_id, amount)` receives an already-net prize contribution into the isolated pool vault and creates no depositor claim right. The 20% marketing / 10% protocol sponsorship routing occurs in the separate sponsorship payment rail before the 70% net amount reaches the Arena pool.

B. `deposit_sponsorship(pool_id, gross_amount)` performs the 70/20/10 sponsorship routing itself using fixed configured receivers.

Preferred for blast-radius simplicity: model A, as long as the API/payment rail cryptographically proves the net 70% prize funding and does not mislabel normal Support as sponsorship.

Sponsor funding must be separately observable from community Support in events/accounting.

## 4. Financial fields the final ArenaPool should be able to represent

At minimum, new Arena pool accounts should support:

- pool id
- kind (battle/tournament)
- custody state
- asset A / asset B
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
- winner side / winner payout
- outcome hash
- pending winner
- pending protocol
- pending MWL
- pending charity
- claim/refund flags or receipt PDAs
- pool/vault bumps
- resolution nonce

Because ArenaPool is a new PDA type and has not been deployed on mainnet, its layout should be made sufficiently complete NOW rather than extended after launch.

`RewardsConfig` remains unchanged.

## 5. Canonical resolver messages

### Resolution

Upgrade `MWZ_ARENA_RESOLVE_V1` to a final frozen domain/version before certification if the payload changes.

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
- winner side / winner payout
- result type
- outcome hash
- signature deadline
- resolution nonce

### Cancellation

A separate canonical cancellation domain should bind:

- program ID
- config version
- pool id/PDA
- cancellation reason
- deadline
- nonce

Cancellation cannot specify arbitrary refund destinations.

## 6. V0 transaction additions required

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
- tournament buy-in
- cancelled tournament buy-in refund

Operator/resolver V0 matrix must cover:

- close Support (if explicit)
- cancel pool
- resolve pool (Ed25519 immediately before Arena instruction)
- permissionless/keeper expiry settlement
- protocol/MWL/charity claims

No React component may construct a legacy Solana transaction for these paths.

## 7. Required new adversarial tests

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
- sponsor/prize boost increases only the intended pool;
- sponsor/prize boost creates no depositor claim;
- Support and sponsorship accounting remain distinct;
- one pool's prize boost cannot fund another pool;
- all pending buckets plus refundable principal remain <= distributable vault balance;
- full vault conservation proof after claims/refunds.

## 8. Deliberate non-scope for this same-ID upgrade

Do not add legally gated Battle Pool betting merely because old investor material mentions betting. The newer product brief explicitly separates it from normal project-vs-project battle entry and leaves it subject to jurisdiction/compliance/age/wallet eligibility/final configuration.

A future regulated Battle Pool product may use a separate contract/program generation if its legal/economic model materially differs. It must not be confused with current Support donations.

## 9. Freeze gate

PR #150 remains RED until this addendum is reconciled into `arena.rs`, the V0 client/operator builders, IDL checks and adversarial suite.

Do not produce or approve the final mainnet `.so` before Grok's final Arena battle branch has been re-audited one last time against this addendum.

If Grok changes any money-moving battle requirement after this point, classify it as one of:

- off-chain product state only -> no program change;
- already representable by the generic fields/instructions above -> client/API change only;
- new custody/economic primitive -> candidate audit must reopen BEFORE mainnet upgrade.
