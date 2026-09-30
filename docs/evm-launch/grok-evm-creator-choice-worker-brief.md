# Grok brief 3, EVM generation: the creator-choice operator worker

## Why

The new `CreatorRewardsVaultV2` (BNB 56 and Robinhood 4663) holds the creator share of coins whose creator
chose `holders`, `split` or `buyback`. The vault only moves that money when its operator calls it. Nothing
calls it yet. On Solana the same job is `realtime-indexer/src/dbc/dbcCreatorChoice.ts` (and its worker);
build the EVM equivalent. Read that Solana code first and follow its patterns (record before send, resume
after restart, dry run by default, weekly seed published afterwards).

Read also: `docs/evm-launch/EVM_LAUNCH_GENERATION_PLAN.md` (E5 fee choice, E9, E10, E15 caps, E16),
`docs/evm-launch/spec/C1-C6-fees.md` (the vault, including "As built" and the audit fixes: Safe-approved
holder roots, fee-scaled impact, fail-closed TWAP, conversion interval per route pool),
`docs/dbc/DBC_BUILD_PLAN.md` D5 (random buyback moments, seed published afterwards, at most ~0.5% impact),
`contracts/CreatorRewardsVaultV2.sol`.

## Rules (hard)

- Your own clone. Branch `grok/evm-creator-choice-worker` from `origin/build/evm-launch-staging`. One PR into
  `build/evm-launch-staging`. Never merge. Never push `build/*`.
- No transactions on mainnet or testnet. Every sender defaults to dry run; real sends only behind
  `EVM_CREATOR_CHOICE_SEND=true`. Local hardhat and forks are fine.
- No production database writes. Schema changes only as migration files in `db/migrations/`.
- Your files: new files under `realtime-indexer/src/evm/` (worker + tests), a registration line in the
  indexer's `main.ts`, new scripts under `scripts/` for the Safe signers, new migration files. Do not edit
  contracts, the keeper `evmGraduationKeeper.ts`, the API or the web app. Anything you need there goes under
  "Needs from Claude" in the PR.
- The operator key is its own key (`EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY[_<chainId>]`). Refuse the
  deployer address and the Safe. The operator can never choose a recipient; do not add code that tries.
- Plain sentences in logs and docs, no em dashes. No Claude trailer on your commits.

## What the worker does, per chain, per pass

1. `syncLpFees(pool)` for graduated non-keep coins whose locker paid the vault since the last sync
   (read `evm_campaign_events` / locker harvest events).
2. Buyback coins:
   - Before graduation: `buybackCurve(campaign, amountIn, minOut, deadline, sig)` needs a trade
     authorization signed by the route authority. Do NOT put the route authority key on the indexer. Ask for
     the signature from the API over an internal endpoint protected by a shared secret, and list that
     endpoint under "Needs from Claude" with its exact request and response.
   - After graduation: `buybackPool(campaign, amountIn)`, and `flushBuybackTokens(campaign)` once trading
     is enabled.
   - Moments: random within the week from a secret seed (`EVM_BUYBACK_SEED_SECRET`), the seed hash
     published before the week and the seed after, like Solana D5. Respect `limits()`: per buy, per coin per
     week, minimum interval, impact.
   - Quote-bound coins (E10): the buyback spends the quote in the coin's own pool;
     `convertBuybackNativeToQuote` only where the vault needs it.
3. Holders coins and the holders part of split: once a week, build the holder list (leaves), a Merkle root and
   the total, from the same holder snapshot rules the weekly airdrop uses (`frontend/scripts/weekly-airdrop`).
   Quote-bound coins: `convertHolderQuote` first (one conversion per route pool per `minBuyInterval`).
   Then `proposeHolderBatch`. Publish the leaf file (JSON, stored and served the way the weekly airdrop
   publishes its files). After the Safe approves and the 24 h veto window passes: `executeHolderBatch`.
4. Everything recorded in the database before it is sent, resumed after a restart, never sent twice.

## For the Safe signers (scripts)

- `scripts/evm-holder-batch-verify.mjs`: takes the published leaf file and the chain, recomputes the root
  and total, checks them against the proposed batch on chain, and prints the exact Safe batch to sign
  (`approveHolderBatch` plus the distributor `authorizeBatch`, built with `holderWeekCalls()` from
  `scripts/deploy-evm-treasury-router-v4.ts`). It refuses on any mismatch.

## Tests

- Unit tests for scheduling, caps, seed, leaves and root, resume after restart, and refusals.
- A hardhat test against the compiled `CreatorRewardsVaultV2`: one full week for a holders coin (propose,
  Safe approve, wait 24 h, execute, claim) and a buyback coin (curve buyback before graduation, pool buyback
  after, tokens burned to 0x…dEaD).
- `npx tsc --noEmit` clean in `realtime-indexer`; the indexer suite no worse than before.

## Hand-in

PR description: branch, head, files with one line each, full test output, the "Needs from Claude" list,
env names, and an audit block per operator action (what it moves, bounds, what a stolen operator key can do).
