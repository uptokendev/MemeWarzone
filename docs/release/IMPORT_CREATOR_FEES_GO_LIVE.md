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
2. **Mainnet accounts** (founder; the only on-chain step):
   - Send about 0.05 SOL to `F12Pd3f67e1jFQ1Ny5pZNPkgPZWqbfPCsWUUy7dsXCAw` from any wallet (Phantom is fine).
   - Create its wrapped-SOL account (the API refuses to quote until it exists):
     ```bash
     cd ~/mwz-wt/import-creator-fees/frontend
     node scripts/create-import-fee-collector-account.mjs          # read-only check
     node scripts/create-import-fee-collector-account.mjs --send   # creates Di768Lkp... (idempotent)
     ```
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
   MINT=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263   # any Solana coin with a Jupiter route
   curl -s -X POST https://api.memewar.zone/api/imports/swap/quote -H 'content-type: application/json' \
     -d "{\"chainId\":101,\"token\":\"$MINT\",\"side\":\"buy\",\"amountRaw\":\"100000000\"}" | jq '{feeBps,creatorShareBps,feeNativeRaw}'
   ```
6. **First swap**: one small buy on an imported coin. Within 5 minutes a `finance_import_swap_fees` row with
   `fee_receiver = Di768Lkp…`, `creator_raw` = half, and an `import_creator_fees` row `waiting`.
7. **Live payouts**: watch the dry-run log (`[import-fees] pass {"payouts":[…],"sweep":…}`) for a day, then
   `IMPORT_FEE_PAYOUT_SEND=true`.

## Graduated MemeWarzone coins (Solana)

Founder 2026-10-09: graduated coins get the same as imports. A launchpad coin whose curve graduated on chain, or a
DBC coin whose pool migrated, trades through the import route in the app (token page, mobile sheet, war room rows)
and in the widget: Jupiter, 1%, half to the coin's creator. Bonding coins and the CREATE / BUY / SELL transactions do
not change.

- Ledger: a fee on a token that has a `campaigns` row accrues as `payee_kind = 'campaign_creator'`, `expires_at` NULL
  (migration `20261009_000020_graduated_creator_fees.sql`).
- Worker: pays those to `campaigns.creator_address` at once (no claim, no hold, never expires), same minimum, caps,
  own-wallet and moderation skips. Command Center (Claims) lists them for the creator.
- Switches, both off by default, on only after `SOLANA_IMPORT_FEE_COLLECTOR` is set:
  API `SOLANA_GRADUATED_IMPORT_ROUTE=true` (widget), app build `VITE_SOLANA_GRADUATED_IMPORT_ROUTE=true` (app).
  The app also refuses a graduated coin's quote without the creator's half. Off: the direct Meteora trade as before.
- BNB / Robinhood graduates: gen-7 (`graduatedEvmTradeRoute.mjs`).

## Safety rules in the worker

- Sign, store `sending` with the signature and mark the accruals `paying` in one db transaction, then send. The
  next pass resolves it; only a failed or expired signature puts accruals back to `waiting`.
- Nothing new starts while a movement is `sending`. Creators are paid before our sweep in a pass.
- Caps bound a stolen key; they do not review claims. A day over the cap continues the next UTC day by itself.
- An owner that is not an on-curve wallet is skipped and logged.

## Rollback

API: unset `SOLANA_IMPORT_FEE_COLLECTOR` (back to 0.5% to `9Cex7YLo…` at once). Indexer: `IMPORT_FEE_PAYOUT_SEND=false`
or `IMPORT_FEE_WORKER_ENABLED=false`. Accrued creator money stays in the collector and in the ledger.
