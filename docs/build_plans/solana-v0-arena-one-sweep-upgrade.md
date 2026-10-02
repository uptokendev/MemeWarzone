# MemeWarzone Solana V0 + Arena One-Sweep Upgrade

Status: PREPARATION / NOT DEPLOYABLE YET

Branch: `prep/solana-v0-arena-upgrade`

Target same-ID program upgrade:

`mwz_rewards_treasury`

`2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX`

## 1. Decision

MemeWarzone will not deploy the previously prepared rewards-treasury candidate and then perform another Solana upgrade for Arena.

The release candidate is superseded by one final candidate that contains:

1. The already-normalized V0 reward and operator transaction work.
2. First-trade ATA creation inside the existing V0 bonding transaction.
3. Launchpad UP Vote V0.
4. Meteora post-graduation V0 trading.
5. Recruiter/Squad treasury functionality and recovery work.
6. The isolated Solana Arena treasury subsystem.
7. Arena user and operator transaction paths using the same V0 safety standard.

There will be one final certified `.so` and one same-ID mainnet upgrade after devnet/adversarial acceptance.

The launchpad/bonding program is not expanded for Arena.

## 2. Program boundaries

### Existing launchpad program

`memewarzone_solana`

Responsibilities remain unchanged:

- create
- bonding BUY/SELL
- graduation
- launchpad enforcement

Arena must not add instructions, accounts, state or custody to this program.

### Existing rewards treasury program

`mwz_rewards_treasury`

Existing responsibilities:

- league vault and claims
- airdrop vault and claims
- recruiter vault and claims
- squad vault and claims
- protocol routing

New isolated Arena namespace:

- `arena_config`
- `arena_pool`
- `arena_vault`
- `arena_buyin`
- `arena_claim`
- `arena_refund`

`RewardsConfig` is not resized or repurposed.

## 3. Arena financial invariants

These are release-blocking invariants.

- Native SOL only.
- Each Arena pool has its own PDA state and its own PDA vault.
- An Arena vault cannot debit to an arbitrary destination.
- Winner payout can only go to the winner recorded by the resolved pool.
- Tournament winner must have a valid, non-refunded buy-in receipt for that pool.
- Protocol share can only go to the configured protocol receiver.
- Major War League share can only go to the configured MWL receiver.
- Charity can only receive support assigned by a tie or cancelled/expired pool.
- Battle stake refunds can only return to the original staker.
- Tournament buy-in refunds can only return to the original entrant and original buy-in receipt.
- Support is a donation and never creates a supporter claim right.
- Rent reserve is excluded from distributable SOL.
- There is no admin drain.
- Arena does not route through launchpad FeeEscrow.
- Existing league, airdrop, recruiter and squad instructions cannot debit Arena vaults.
- Arena instructions cannot debit league, airdrop, recruiter or squad vaults.

Normal winner settlement is:

- 85% winner/prize
- 5% MemeWarzone protocol
- 10% Major War League

Integer rounding remainder stays with the winner so accounting always sums to the deposited prize.

Tie settlement for battles:

- original stakes become refundable to their original stakers
- support becomes charity-claimable
- no 5% or 10% fee is created from returned stakes

Expiry/cancellation settlement:

- unresolved support becomes charity-claimable
- battle stakes become refundable
- tournament buy-ins become refundable
- no admin receives stranded funds

## 4. Resolver authorization

Arena resolution reuses the established Solana authorization pattern:

1. backend/resolver signs the canonical result
2. Ed25519 verification instruction appears immediately before `resolve_pool`
3. treasury program parses and validates that preceding instruction
4. pool state is finalized on-chain
5. users pull their own claims/refunds

Canonical Arena resolver message domain:

`MWZ_ARENA_RESOLVE_V1`

The signed payload binds:

- treasury program ID
- Arena config version
- pool ID
- pool PDA
- winner
- result type
- total battle stake
- total support
- total tournament buy-ins
- signature deadline
- resolution nonce

A result signed for one pool cannot be replayed against another pool.

## 5. Arena instruction surface frozen for this candidate

Administration:

- `initialize_arena`
- `set_arena_resolver`
- `set_arena_receivers`
- `set_arena_pause`

Battle/tournament deposits:

- `open_battle_pool`
- `open_tournament_pool`
- `deposit_stake`
- `donate_support`
- `deposit_buy_in`

Settlement:

- `resolve_pool`
- `settle_expired_pool`

Claims/refunds:

- `claim_winner`
- `claim_protocol`
- `claim_mwl`
- `claim_charity`
- `refund_stake`
- `refund_buy_in`

No further money-moving Arena instruction should be introduced after certification begins without restarting the candidate audit.

## 6. V0 transaction standard

Every user-facing Solana money transaction uses a VersionedTransaction V0 path.

Required transaction flow:

1. derive canonical addresses locally
2. build exact instruction set
3. compile V0 with latest blockhash
4. assert payer, signer count, program, accounts, instruction bytes and packet size
5. simulate before wallet prompt
6. rebuild with a fresh blockhash after simulation
7. wallet signs
8. inspect wallet-returned transaction against the exact intent
9. submit with preflight enabled
10. confirm using blockheight-aware confirmation
11. recover from ambiguous confirmation using authoritative on-chain state/receipt where possible

V0 alone is not the security property. Deterministic addresses, exact intent validation, simulation and state recovery are required with it.

## 7. Transaction matrix

### Existing launchpad/rewards matrix

- Create V4
- first bonding BUY without ATA
- repeat bonding BUY
- bonding SELL
- weekly league claim
- monthly league claim
- airdrop claim
- recruiter claim
- squad claim
- launchpad UP Vote
- Meteora BUY
- Meteora SELL

### New Arena matrix

User wallet:

- Arena UP Vote
- open battle + first stake
- opponent stake
- support donation
- tournament buy-in
- winner claim
- battle stake refund
- tournament buy-in refund
- permissionless expiry settlement

Operator/resolver:

- Arena initialization/configuration
- tournament pool open
- Ed25519 + `resolve_pool`
- protocol claim
- MWL claim
- charity claim

Operator transactions must also use the normalized V0 server-send path; they are not exempt merely because a backend key signs them.

## 8. UP Vote isolation

Launchpad and Arena UP Votes share one canonical Solana V0 simple-payment executor.

Launchpad memo domain:

`mwz-upvote:<campaign>`

Arena memo domain:

`mwz-arena-upvote:<token>`

The lane changes the memo domain and ingest route only. It must not change the configured canonical treasury destination or weaken the signed-intent checks.

No Arena component may reintroduce `new Transaction()` for Solana UP Votes.

## 9. Required adversarial on-chain tests

The candidate is RED until all of these exist and pass.

### Configuration

- Arena cannot initialize from an authority different from `RewardsConfig.authority`.
- zero resolver rejected
- zero receiver rejected
- unauthorized config update rejected
- deposit pause blocks deposits but not claims/refunds

### Pool isolation

- pool A cannot use pool B state
- pool A cannot use pool B vault
- wrong vault PDA rejected
- wrong pool PDA rejected
- Arena paths cannot substitute league/airdrop/recruiter/squad vaults

### Battle deposits

- opener must be owner A or owner B
- first stake exact
- wrong stake amount impossible through instruction design
- duplicate owner stake rejected
- outsider stake rejected
- second valid stake transitions to LIVE
- unmatched battle can expire after deposit deadline

### Tournament deposits

- exact configured buy-in
- duplicate entrant rejected by buy-in PDA
- entrant receipt bound to pool and entrant
- tournament winner without a valid buy-in receipt rejected

### Support

- zero support rejected
- support cannot create claim rights
- support cannot enter an expired pool
- tie routes support only to charity
- cancellation/expiry routes support only to charity

### Resolution

- missing Ed25519 instruction rejected
- wrong resolver rejected
- wrong message rejected
- wrong pool replay rejected
- changed winner rejected
- changed amounts rejected
- expired signature rejected
- nonce replay rejected
- battle winner must be owner A or B
- tournament winner must be a valid entrant
- battle tie accepted only with zero winner
- tournament tie rejected

### Accounting

- exact 85/5/10 on clean amounts
- rounding remainder stays with winner
- pending buckets sum to total distributable prize
- vault rent is never distributable
- winner double claim rejected
- protocol double claim rejected
- MWL double claim rejected
- charity double claim rejected
- wrong fixed receiver rejected

### Refunds

- tie stake returns only to original staker
- cancelled stake returns only to original staker
- stake double refund rejected
- cancelled tournament buy-in returns only to original entrant
- tournament double refund rejected
- unresolved support is never refunded to supporters

## 10. Required wallet QA

Wallets:

- Phantom
- Solflare
- Backpack

For every user transaction:

- one expected wallet prompt
- V0 transaction
- expected signer only
- exact program and recipients
- exact amount
- simulation succeeds before wallet
- fresh blockhash
- no wallet-returned mutation accepted
- explorer success
- UI state reconciles from authoritative chain/API state

Malicious client tests:

- wrong program: REJECT
- wrong vault: REJECT
- wrong recipient: REJECT
- wrong receipt PDA: REJECT
- wrong pool: REJECT
- wrong amount: REJECT
- modified wallet-returned transaction: REJECT
- expired blockhash: RECOVER or clean error
- existing receipt: DO NOT submit twice

## 11. Release gates

Gate A - source integration

- Arena module compiled into `mwz_rewards_treasury`
- same program ID unchanged
- deployed `RewardsConfig` layout unchanged
- final IDL contains all frozen Arena instructions/accounts

Gate B - unit/adversarial tests

- all existing rewards treasury tests green
- all Arena tests green
- V0 helper tests green

Gate C - static transaction guard

- no user Solana legacy transaction constructor remains for covered paths
- Arena UP Vote cannot regress the launchpad V0 helper
- backend/operator covered sends are V0

Gate D - build artifact

- deterministic candidate `.so`
- candidate SHA recorded
- program ID verified
- upgrade authority verified
- IDL generated from the exact candidate

Gate E - devnet

Full matrix passes on devnet with Phantom, Solflare and Backpack.

Gate F - reward recovery

- Recruiter/Squad root publication and blocked claims proven against candidate
- no regression to weekly/monthly League or Airdrop claims

Gate G - Arena lifecycle

- battle win lifecycle
- battle tie lifecycle
- unmatched battle expiry
- unresolved live battle expiry
- tournament lifecycle
- tournament expiry/refund lifecycle
- support/charity lifecycle
- protocol/MWL pull claims

Gate H - production preflight

- final current-main diff audited immediately before upgrade
- required env/program addresses verified
- treasury receiver addresses verified
- resolver address verified
- pause state verified
- upgrade buffer and authority verified

Gate I - same-ID mainnet upgrade

Only after Gates A-H are green.

## 12. Merge/release policy

`main` remains untouched while this candidate is prepared.

PR #143 remains historical evidence for the original V0 normalization work. The one-sweep candidate supersedes it for deployment.

Arena product PR #149 must be reconciled into this architecture rather than reintroducing legacy Solana transaction code.

Do not deploy the old rewards-treasury candidate first.

Do not upgrade `mwz_rewards_treasury` twice merely to add Arena.

Do not mark this branch deployment-ready until the compiled program, final IDL, adversarial suite and devnet evidence all refer to the same candidate commit.

## 13. Project document alignment

This one-sweep build must remain consistent with the full MemeWarzone project document set, including:

1. `UPMEME – Treasury & Revenue Setup`
2. `UPMEME – Revenue & Treasury Structure (Simple Explanation)`
3. `MemeBattles - Investor Pitch`
4. `MemeWarzone_Incentive_Systems_Implementation_Scope`
5. `buildphasesrecruitersquadpoolairdrop`
6. `phase 1`
7. `localhybridsetup`
8. `Investor Pitch`
9. `MemeWarzone_Master_Build_Plan_BNB_Solana`
10. `featurelist`
11. `revisedMEMEWARZONE SOLANA MAINNET COMBINED BUILD PLAN(4)`
12. `MemeWarzone Interchain DEX Build outlines(1)`
13. `MemeWarzone devpostgrad handoff(4)`
14. `revisedMEMEWARZONE BNB MAINNET COMBINED BUILD PLAN(9)`
15. `MEMEWARZONE BNB Topaz trading(1)`
16. `solanaupgradev2.md`

The implementation hierarchy for this candidate is:

1. live repository behavior and already-proven Create/bonding transaction standard
2. current Solana mainnet combined build/security requirements
3. incentive/treasury custody and claims rules
4. Arena one-sweep architecture frozen in `solanaupgradev2.md`
5. cross-chain product equivalence where BNB/Solana use different technical primitives

The future MemeWarzone Interchain DEX remains a separate protocol-generation build and is not added to this treasury upgrade.
