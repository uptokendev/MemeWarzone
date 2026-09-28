# Grok brief, DBC step 6: graduation keeper and creator rewards

Read `docs/dbc/DBC_BUILD_PLAN.md` first (D6-D9, D16-D18). Start after step 5 is merged (it provides
the router this step reuses for the graduation fee). The full lifecycle is already proven on devnet:
`tools/dbc-rehearsal/rehearse-dbc-devnet.mjs` (migrate, both migration-fee withdrawals, LP fee claims).

## Branch rules (hard)

Own clone; branch `grok/dbc-step-6` from `origin/build/dbc-staging`; one pull request into
`build/dbc-staging`; never merge; run the devnet proof yourself where you can. Nothing on mainnet.
Do not touch the launchpad's graduation keeper (`scripts/solana/graduation-keeper.mjs`) or program.

## What this step delivers

When a DBC coin's curve completes, it graduates into its DAMM v2 pool without anyone waiting, our
share of the graduation fee is routed like today's graduation fee, the creator is made whole for
Meteora's 0.2% cut, the coin continues on the token page, leagues and feeds as graduated, and the
creator can claim what is theirs.

## Facts to build on

- Migration is permissionless. **Meteora's own migrator may migrate first** (it does so from 10 SOL /
  750 USDC; our targets are above that). The keeper must handle both: migrate when nobody has, and
  finish the rest when the pool is already migrated.
- Order: if the config has locked vesting (ours does: the 20M creator reserve) and
  `migrationProgress` is 1, `createLocker` first; then `migrateToDammV2` with the customizable DAMM v2
  config `DAMM_V2_MIGRATION_FEE_ADDRESS[6]` (`A8gMrEPJ…`). Two position NFT keys come back from the
  SDK: sign with them.
- `partnerWithdrawMigrationFee` (our 10% of the 22% fee) needs **our collector's** signature;
  `creatorWithdrawMigrationFee` (their 90%) and the locked reserve (Jupiter Lock escrow made by
  `createLocker`, recipient = creator) need the **creator's** signature. So the creator claims their
  graduation payout themselves (see "Creator rewards").
- Meteora takes 0.2% of the migrated liquidity (base and quote):
  `poolState.protocolMigrationBaseFeeAmount` / `protocolMigrationQuoteFeeAmount`.
- LP fees after graduation: the partner position (20%, ours) and the creator position (80%). Both are
  permanently locked; fees are claimable by each position's owner, in SOL only (D8).

## Build

1. **Keeper** (`realtime-indexer/src/dbc/dbcGraduationKeeper.ts`, flags `DBC_GRADUATION_ENABLED`,
   `DBC_GRADUATION_SEND`): watches DBC pools (the websocket on the pool account like the launchpad
   keeper, plus an interval scan); on curve complete: createLocker if needed, migrate, then
   partner-withdraw the migration fee. Idempotent; one pool at a time; retries with backoff.
2. **Our graduation fee**: route the partner migration fee like today's finalize fee (kind 1, the
   **creator's** profile: linked recruiter 15% / squad 2.5%, OG 17.5% / 2.5%, unlinked airdrop 17.5%,
   protocol the rest) through step 5's router, with a `reward_events` row `route_kind='finalize'`.
3. **D7 compensation**: before that split, pay the creator the value of Meteora's 0.2% cut from our
   share: the quote amount plus the base amount valued at the migration price, as SOL to the creator's
   wallet, recorded (`dbc_graduation_compensations`: pool, creator, lamports, tx). If our share cannot
   cover it, pay what it covers and record the shortfall (no silent skip).
4. **Mark graduated**: `campaigns.graduated_at_chain`, `graduated_block`, and `meta.solanaGraduation =
   { dex: 'meteora-damm-v2', pool, slot, quoteMint: SOL }` plus `meta.dbc.migration = { pool, slot,
   positions, locker }`, so the meteora swap indexer picks the pool up (after the 2026-09-28 fix it
   indexes every graduated pool) and step 3's trading switches to the pool. Send the existing
   "graduated" notification (`notifyCampaignGraduated`).
5. **Our LP fees**: claim the partner position's fees on a schedule and route them to `protocol_vault`
   (today's LP 20% goes to protocol).
6. **Creator rewards panel** on the DBC token page (creator only): "Graduation payout" (their 90% of
   the migration fee), "Creator reserve" (the 2% locked vesting, released at graduation), "LP fees"
   (their 80% position), each with the amount waiting and a claim button (same sign-time checks as
   step 3: fresh blockhash, intent allowlist, simulate the way web3.js accepts, then sign).

## Added 2026-09-28: D19, LP fees follow the creator's fee choice

- `frontend/api/lib/dbc/dbcLaunchConfigParams.mjs` (`liquidityDistribution`, ~310): for
  `creatorFeeMode = platform` set partner permanent lock **100**, creator permanent lock **0**; `creator`
  mode stays 20 / 80. Check with the SDK/program that a 0% creator share is accepted (config
  creation simulates on devnet) and that migration then creates one position, not two. The ladder keys
  configs by a params hash, so this makes new platform configs and leaves existing ones alone. Update
  the step-1 parity tests.
- LP fee claim for a platform coin: the partner position's fees are split 20% to `protocol_vault`
  (like item 5) and 80% into the coin's creator pool, recorded like a step-5 accrual with
  `creator_pool` (so step 5b pays it out and the router's held sum counts it). Integer split, remainder
  to protocol, stated in a test.
- The creator rewards panel shows no "LP fees" row for a platform coin. It shows the fee choice line
  from step 5b instead. Graduation payout and creator reserve rows are unchanged.
- Proof: one `keep` coin and one `holders` coin graduate. The holders coin has one position, owned by
  the collector; a swap, a claim, and the 80/20 split land to the lamport.

## Tests

- Unit: the keeper's state machine (not complete, complete, locker needed, already migrated by
  Meteora, partially done) is idempotent; the finalize split for each creator profile; compensation
  maths from a fixture pool state; meta written for the meteora indexer.
- `scripts/dbc/prove-graduation-devnet.mjs`: a $150 devnet coin, buy to completion, one keeper pass:
  migrated, our migration fee withdrawn and routed (vault deltas to the lamport), compensation paid,
  campaign marked graduated with `meta.solanaGraduation`; then the creator claims the graduation payout
  and the reserve through the panel's code path; a swap on the DAMM v2 pool and both LP claims.

## Hand-in (PR description)

Branch and commit, every file one line, test output, proof output, anything you could not follow.
