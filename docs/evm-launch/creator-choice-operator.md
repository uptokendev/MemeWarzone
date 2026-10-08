# EVM creator-choice operator (CreatorRewardsVaultV2)

The worker that moves the money of holders, split and buyback coins on BNB (56) and Robinhood (4663). The EVM
twin of the Solana DBC step 5b worker. Spec: `spec/C1-C6-fees.md` (C6, D19, E10, E15, F5).

## Files

| File | What |
|---|---|
| `realtime-indexer/src/evm/evmCreatorChoice.ts` | Pure rules: weeks, week secret and commitment, snapshot and buyback moments, caps, impact sizing, holder batch id, merkle tree, leaf file build and check |
| `realtime-indexer/src/evm/evmCreatorChoiceChain.ts` | Vault ABI, the chain and sender interfaces, ethers implementations, holder census from Transfer logs |
| `realtime-indexer/src/evm/evmCreatorChoicePass.ts` | One pass per chain: resolve, secrets, snapshots, weekly holder batch, flush, sync, buybacks, conversions |
| `realtime-indexer/src/evm/evmCreatorChoiceConfig.ts` | Env parsing, operator key refusal, API client |
| `realtime-indexer/src/evm/evmCreatorChoiceWorker.ts` | The loop, registered in `main.ts` |
| `realtime-indexer/src/evm/evmCreatorChoiceLanes.ts` | Every vault of a chain in one tick (gen-6 and gen-7's own vault), one key |
| `realtime-indexer/src/evm/evmGen7Fees.ts` | Gen-7 fees stack env (`EVM_GEN7_*_<id>`) |
| `frontend/api/evmCreatorChoice.js` | Internal buyback authorization endpoint, public week and leaf file reads |
| `scripts/evm-holder-batch-verify.mjs` | For the Safe signers: verify a proposed holder batch, print Safe batch H |
| `db/migrations/20260930_300001_evm_creator_choice_operator.sql` | Tables (not applied) |
| `db/migrations/20261008_000040_evm_holder_batches_per_vault.sql` | `evm_holder_batches` keyed per vault (needed before the gen-7 vault runs) |
| `scripts/make-holder-batch-preauth-calls.mjs` | Safe calls that pre-authorize the coming weeks' holder batch ids on a holder distributor |

## What a pass does

At most one transaction per chain in flight. Every call is simulated from the operator first, and written to
`evm_creator_choice_jobs` (hash, nonce, raw signed bytes) before it is broadcast. After a restart a `sending` row is
resolved by its receipt, the same bytes are re-broadcast while the nonce is unused, or the row becomes `dropped`
when the nonce went to another transaction. A live job per subject, action and moment is unique in the database.

1. Week secrets. `HMAC-SHA256(EVM_BUYBACK_SEED_SECRET, "evm-week:" + chainId + ":" + weekId)`. Its sha256 is stored
   for this and next week (before the week starts), the secret itself once the week is over. Served at
   `GET /api/evm/creator-choice?chainId=`.
2. Holder snapshot of every holders and split coin at the week's secret moment
   (`HMAC(week secret, "holders-snapshot:" + chainId) mod week`), first pass after it. Wallets only: no contract
   code (an EIP-7702 delegated EOA counts as a wallet), not the creator, the campaign, the token, the pool, the
   vault, the operator, DEAD, `EVM_HOLDER_EXCLUDED_WALLETS`, or a wallet the weekly airdrop refuses for risk.
3. Monday from 00:05 UTC, for the week just finished: pot per coin = `holderBalance` on chain, pro rata by snapshot
   balance, remainder to the largest holder, one leaf per wallet across coins, wallets under the minimum payout
   roll over, pots scaled into the vault's weekly holder cap and `EVM_HOLDER_BATCH_MAX_WEI`, at most 200 coins.
   The leaf file is stored (`evm_holder_batches.leaf_file`, served at
   `GET /api/evm/holder-batch?chainId=&weekId=`) and published to the Claim Center tables
   (`reward_batches` / `reward_ledger`, program `airdrop_holders`, claim contract = the holder distributor)
   before `proposeHolderBatch` is sent. Batch id: `keccak256("mwz-weekly-airdrop:<chain>:<week>:airdrop_holders")`,
   the id `holderBatchId()` in the deploy script computes.
4. The batch waits for the Safe (`approveHolderBatch` + distributor `authorizeBatch`) and the 24 h veto window,
   then `executeHolderBatch`; the Claim Center rows open. A veto archives the publication and the amounts are back
   in the coins' holder balances for next week. A refused proposal is rebuilt (3 attempts). A proposal event that
   does not match the published file stops the batch for a person.
5. `flushBuybackTokens` once a buyback coin's token trades. `syncLpFees` for graduated coins when the locker paid
   (FeesHarvested with a creator share since the last sync, or every 6 h), and once to bind a pool.
6. Buyback coins at their secret moments (`HMAC(week secret, chainId|campaign|day|i) mod day`, 4 per day, never
   caught up): before graduation `buybackCurve` with the route authority signature from the API; after, `buybackPool`
   on a native pool, and on a quote pool (E10) `buybackPool` with the quote balance or else
   `convertBuybackNativeToQuote`.
7. Quote-bound holders and split coins at their conversion moments: `convertHolderQuote`.

Dry run unless `EVM_CREATOR_CHOICE_SEND=true`: decisions are logged, nothing is signed, no signature is requested,
no batch is published. Week commitments and snapshots are kept in a dry run too.

## Two vaults per chain, one key (gen-7, founder decision 2026-10-08)

Gen-7 has its own CreatorRewardsVaultV2 (pinned to the gen-7 factory) and holder RewardDistributor beside the gen-6
ones. The same operator key (the vault `operator()` on both, set by the Safe) works both:

- `EVM_GEN7_CREATOR_VAULT_<id>` adds the second vault. Each tick runs one pass per vault, one after the other, never in
  parallel; the starting vault alternates per tick so a busy vault cannot starve the other.
- Nonce: the key has one nonce sequence per chain, so both vaults share the chain's single transaction in flight. A
  pass resolves every `sending` job of the chain (whichever vault it was for, through that vault's own reader) and
  queues its own sends while one is in flight; the `evm_creator_choice_jobs_one_in_flight_idx` unique index is the
  database backstop. A stuck or dropped transaction of one vault holds the other back until it is resolved, exactly as
  for a single vault.
- Each vault has its own holder program, so its own batch id, Claim Center batch and leaf file: gen-6
  `airdrop_holders` (unchanged), gen-7 `airdrop_holders_gen7` (`keccak256("mwz-weekly-airdrop:<chain>:<week>:airdrop_holders_gen7")`,
  the leaf file carries `"program"`). `evm_holder_batches` rows are per (chain, vault, week); the gen-7 vault does not
  run until migration `20261008_000040` is applied (logged every tick; gen-6 unaffected).
- Per-vault caps: the vault's own `limits()` on chain; `EVM_GEN7_HOLDER_BATCH_MAX_WEI[_<id>]` caps gen-7's weekly batch
  (default `EVM_HOLDER_BATCH_MAX_WEI[_<id>]`). Keep each at or below the Safe's authorization max on that vault's holder
  distributor.
- Buyback signatures: the API signs for either configured vault (`EVM_CREATOR_VAULT_V2_<id>`, `EVM_GEN7_CREATOR_VAULT_<id>`),
  with every other check unchanged.

## Holder batch authorizations (recurring Safe work and its alert)

Every holder batch needs two Safe acts before `executeHolderBatch` pays: `approveHolderBatch(batchId, root, total)` on
the vault (binds the exact root, so it can only be given after the week: weekly, by design) and
`authorizeBatch(batchId, max, after, deadline)` on the vault's holder distributor (batch ids are deterministic, so this
one can be given weeks ahead). To leave only the weekly approval:
`node scripts/make-holder-batch-preauth-calls.mjs --chain <id> --distributor <holder distributor> --cap <native> --program airdrop_holders|airdrop_holders_gen7 [--weeks 12]`
then `scripts/make-safe-batch.ts`, once per vault. A pre-authorization moves nothing on its own: only the vault (batch
operator) or the Safe can call `createBatch`, and the vault only does so for a Safe-approved root.

Fee routing alerts (`frontend/api/lib/financeHolderBatchAlerts.js`, rebuilt by `cron:finance-snapshots`), per vault:
a proposed batch waiting for the Safe (warning after 24 h, critical after 4 days, with the verify command for that
vault), a batch out of retries (critical), a batch the worker has not moved for 6 h (warning), and the distributor's
pre-authorizations running out (warning `FINANCE_HOLDER_PREAUTH_WARN_WEEKS`, default 3, weeks ahead; none at all is a
warning once the vault has holders or split coins).

## Env

Indexer: `EVM_CREATOR_CHOICE_ENABLED_<id>`, `EVM_CREATOR_CHOICE_SEND`, `EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY[_<id>]`,
`EVM_CREATOR_VAULT_V2_<id>` (existing), `EVM_BUYBACK_SEED_SECRET`, `EVM_CREATOR_CHOICE_API_URL`,
`EVM_CREATOR_CHOICE_API_SECRET`, optional `EVM_CREATOR_CHOICE_INTERVAL_MS` (30000), `EVM_BUYBACK_MAX_PER_DAY` (4),
`EVM_BUYBACK_MIN_WEI[_<id>]`, `EVM_HOLDER_MIN_PAYOUT_WEI[_<id>]`, `EVM_HOLDER_CLAIM_WINDOW_DAYS` (60),
`EVM_HOLDER_BATCH_MAX_WEI[_<id>]`, `EVM_GEN7_HOLDER_BATCH_MAX_WEI[_<id>]`, `EVM_GEN7_CREATOR_VAULT_<id>` (gen-7's own vault,
`0xaddr@startBlock`), `EVM_GEN7_ROUTER_<id>` (`0xaddr@startBlock`, RouteExecuted scan), `EVM_HOLDER_EXCLUDED_WALLETS[_<id>]`, `EVM_CREATOR_CHOICE_MAX_GAS[_<id>]`,
`EVM_CREATOR_CHOICE_FORBIDDEN_ADDRESSES`. The chain RPCs are the keeper's (`BSC_RPC_HTTP_56`,
`ROBINHOOD_RPC_HTTP_4663`). The operator key is refused when it is the deployer, the Safe, a configured forbidden
address or the factory's route authority, and nothing is sent while it is not the vault's `operator()`.

API: `EVM_CREATOR_CHOICE_API_SECRET` (same value), `EVM_CREATOR_VAULT_V2_<id>`, `EVM_GEN7_CREATOR_VAULT_<id>`, the route
authority key as today. Finance (Fee routing, Payouts): `EVM_GEN7_ROUTER_<id>`, `EVM_GEN7_CREATOR_VAULT_<id>`,
`EVM_GEN7_HOLDER_DISTRIBUTOR_<id>` (`0xaddr@deployBlock`), `EVM_GEN7_COMMUNITY_VAULT_<id>` (or the airdrop runner's
`COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_<id>`), optional `FINANCE_HOLDER_PREAUTH_WARN_WEEKS`.

## The internal endpoint

`POST /api/internal/evm/creator-choice/buyback-authorization`, header `x-mwz-internal-secret`.
Request `{ chainId, campaign, vault, amountIn, minOut, ttlSeconds? }`; response
`{ ok, signature, deadline, routeProfile: 1, action: 1, actor, campaign, amountIn, minOut, routeAuthority }`.
Signed only for the configured vault as actor, a generation 6 campaign of the vault's factory whose choice is
buyback in both the factory and the vault, an unpaused operator, `amountIn <= limits().buyPerTx` and
`<= buybackBalance`, a curve still trading, `minOut` within 5% under the campaign's quote, the factory's route
authority equal to the API signer, deadline 60 to 600 s. Fails closed without the secret.

## Weekly routine for the Safe signers

```
node scripts/evm-holder-batch-verify.mjs --chain 56 \
  --file "https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=2026-09-28" \
  --auth-max <EVMGEN_HOLDER_BATCH_AUTH_MAX wei> --out holders-2026-09-28.safe-batch.json
```

For gen-7's own vault add `&vault=<gen-7 vault>` to the file URL (each vault publishes its own file per week; without
`vault` the gen-6 file comes first). It recomputes root and total from the leaves, checks the vault's `HolderBatchProposed` and the proposing calldata
(campaigns and amounts in order), each campaign's choice, that the batch was not vetoed or executed, and the cap,
then writes Safe batch H (`approveHolderBatch` + `authorizeBatch`, from `holderWeekCalls()`). Any mismatch refuses.

## Audit, per operator action

| Action | Moves | Bounds | A stolen operator key can |
|---|---|---|---|
| `syncLpFees` | nothing out; credits what the locker paid to the coin under its choice | locker's cumulative paid; permissionless anyway | nothing anyone cannot |
| `flushBuybackTokens` | held buyback MEME to DEAD | only after trading is enabled; permissionless | nothing anyone cannot |
| `buybackCurve` | vault native into the coin's own curve, tokens held by the vault | per buy and per coin per week caps, 6 h interval, 0.5% impact, 95% progress, flat fee only, plus an API signature (actor = vault, 10 min, minOut within 5%) | buy at bad moments within the caps; nothing leaves to a wallet; also needs the API secret |
| `buybackPool` | native or quote into the coin's locked pool, MEME to DEAD | native caps per buy and week, fee-scaled 0.5% impact, fail-closed TWAP, interval | same: timing only, sandwich loss bounded by the impact bound |
| `convertBuybackNativeToQuote` | native to quote through the Safe-chosen route pool | native caps, impact, TWAP, interval per route pool | timing only |
| `convertHolderQuote` | holder quote to native through the route pool | 0.5% fee-scaled impact, TWAP, interval per route pool | timing only |
| `proposeHolderBatch` | debits holder balances into a pending batch | weekly holder cap; nothing pays until the Safe approves the exact root and total | park holder money until the Safe vetoes (a veto returns it and frees the cap) |
| `executeHolderBatch` | a Safe-approved batch into the holder distributor | Safe approval, 24 h veto window, distributor `authorizeBatch` max and window | only execute what the Safe approved, or stall (the Safe rotates the operator) |

A stolen API secret alone gets signatures whose actor is the vault; only the vault's `buybackCurve`, behind the
operator, can use them.
