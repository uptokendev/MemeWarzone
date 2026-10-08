# Import swaps 1%, half to the creator: Solana go-live

Founder decisions 2026-10-08: imported-coin swaps pay 1% (was 0.5%). Half is ours, half the coin creator's. The
creator's half accrues for every import, claimed or not, waits 90 days per trade, is paid automatically to the
verified owner once the claim is 7 days old (minimum about $5), and expires to the protocol wallet after 90 days.
The whole 1% is taken in the swap and split afterwards, never inside the trader's transaction.

BNB and Robinhood: change order `docs/evm-launch/CO-IMPORT-SWAP-FEE.md` on `build/evm-gen7`. This file is Solana.

## What runs where

| Piece | Where | Off until |
|---|---|---|
| Fee account + rate (1% to the collector's WSOL account) | API `frontend/api/importSwap.js` | `SOLANA_IMPORT_FEE_COLLECTOR` is set on the API |
| Ledger: fee rows with `creator_raw`, `import_creator_fees` accruals | API cron:finance-snapshots, `financeImportSwapFees.js` (every 5 min) | same env on the API |
| Pay creators, expire after 90 days, sweep our half to `9Cex7YLo…` (operator `2AMfRaxS…`) | indexer `importCreatorFeeWorker.ts` (every minute) | `IMPORT_FEE_WORKER_ENABLED=true`; dry run until `IMPORT_FEE_PAYOUT_SEND=true` |
| Coin page: "the creator has earned X" + claim button; claimed coins: waiting / paid | app, `GET /api/imports/creator-fees` | shows once there are accruals |
| Revenue: lane counts `fee_raw - creator_raw`; new lane `import_swaps_expired` | finance | migration applied |

## Keys and accounts

- Collector (new, dedicated, holds creator money until paid): `F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw`,
  WSOL account `Di768LkpDUq2WV97UjukYxg8yFX6XWzHi5716fE4wN7o`. Key file on the build machine:
  `~/.config/memewarzone/mwz-sol-import-fee-collector.json` (mode 600). Not the deployer, not the protocol operator.
- Protocol wallet for our half: unchanged, the WSOL account `9Cex7YLoBHu5fszVsxzHxrxkzJjQbeE6EBDyYnYuMKds` of
  operator `2AMfRaxS…` (where import fees went until now).

## Order (each step a founder go)

1. **Production SQL** (Supabase SQL editor, production `ellkfgoxnzykxqybajtn`):
   `db/migrations/20261008_000020_import_creator_fees.sql`. Idempotent; applied twice on staging 2026-10-08.
   Must run **before** the merge: the revenue lane reads `creator_raw`.
2. **Mainnet accounts** (founder terminal; the only on-chain step):
   ```bash
   # fund the collector for fees and the temporary unwrap account (about 0.002 SOL each payout, returned)
   solana transfer F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw 0.05 --allow-unfunded-recipient --url mainnet-beta --keypair <your wallet>
   # create its wrapped-SOL account (the API refuses to quote until it exists)
   spl-token create-account So11111111111111111111111111111111111111112 --owner F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw --fee-payer <your wallet> --url mainnet-beta
   ```
   Check: `spl-token accounts --owner F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw --url mainnet-beta` lists WSOL at `Di768Lkp…`.
3. **Merge** the PR (API + indexer + app deploy). Nothing changes yet: no env set.
4. **Indexer env** (dry run first):
   ```
   IMPORT_FEE_WORKER_ENABLED=true
   IMPORT_FEE_COLLECTOR_SECRET=<contents of mwz-sol-import-fee-collector.json>
   SOLANA_IMPORT_FEE_COLLECTOR=F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw
   IMPORT_FEE_PAYOUT_SEND=false
   # optional, defaults shown
   IMPORT_CREATOR_MIN_PAYOUT_LAMPORTS=40000000        # ~$5 at $120/SOL
   IMPORT_CREATOR_MAX_PAYOUT_LAMPORTS=50000000000     # 50 SOL per payout
   IMPORT_CREATOR_DAILY_CAP_LAMPORTS=200000000000     # 200 SOL per UTC day
   IMPORT_FEE_MIN_SWEEP_LAMPORTS=50000000
   IMPORT_CREATOR_HOLD_DAYS=7
   ```
   Log line `[import-fees] enabled { send: false, collector: F12Pd3f6… }`.
5. **API env, the switch**: `SOLANA_IMPORT_FEE_COLLECTOR=F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw`
   (`IMPORT_SWAP_FEE_BPS_101` defaults to 100). Check: a quote shows `feeBps: 100`, `creatorShareBps: 50`:
   ```bash
   curl -s -X POST https://api.memewar.zone/api/imports/swap/quote -H 'content-type: application/json' \
     -d '{"chainId":101,"token":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","side":"buy","amountRaw":"100000000"}' | jq '{feeBps,creatorShareBps,feeNativeRaw}'
   ```
6. **First swap**: one small buy on an imported coin. Within 5 minutes a `finance_import_swap_fees` row with
   `fee_receiver = Di768Lkp…`, `creator_raw` = half, and an `import_creator_fees` row `waiting`.
7. **Live payouts**: watch the dry-run log (`[import-fees] pass {"payouts":[…],"sweep":…}`) for a day, then
   `IMPORT_FEE_PAYOUT_SEND=true`.

## Safety rules in the worker

- Sign, store `sending` with the signature and mark the accruals `paying` in one db transaction, then send. The
  next pass resolves it; only a failed or expired signature puts accruals back to `waiting`.
- Nothing new starts while a movement is `sending`. Creators are paid before our sweep in a pass.
- Caps bound a stolen key; they do not review claims. A day over the cap continues the next UTC day by itself.
- An owner that is not an on-curve wallet is skipped and logged.

## Rollback

API: unset `SOLANA_IMPORT_FEE_COLLECTOR` (back to 0.5% to `9Cex7YLo…` at once). Indexer: `IMPORT_FEE_PAYOUT_SEND=false`
or `IMPORT_FEE_WORKER_ENABLED=false`. Accrued creator money stays in the collector and in the ledger.
