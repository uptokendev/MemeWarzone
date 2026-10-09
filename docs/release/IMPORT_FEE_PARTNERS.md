# Swap-widget partners (Solana live, EVM after gen-7)

Founder 2026-10-09: a website that embeds the swap widget (first: CrypticPump) gets part of the 1% import
fee. Default split per partner: **0.50% creator / 0.25% partner / 0.25% MemeWarzone** (`import_fee_partners`
creator_bps 5000, partner_bps 2500, of the fee).

## How it works

- The partner mounts the widget with `partner: "<id>"`. The API builds the same Jupiter swap with the same 1%,
  only the fee account is the partner's: a wrapped-SOL account **owned by our collector** `F12Pd...`. The API
  checks that on chain before using it; anything else falls back to the default fee account.
- The trader's transaction does not change (instructions, accounts, signers). Proven 2026-10-09: a Jupiter swap
  with a non-standard WSOL fee account simulates cleanly on mainnet.
- The finance cron reads the partner account as its own receiver: fee rows get `partner_id` / `partner_raw`;
  creator accruals as usual (90 days, paid to the verified owner).
- The indexer worker moves the partner account's balance into the collector account (kind `consolidate`), then
  pays creators, then the partner (kind `partner`, to `payout_wallet`, minimum `IMPORT_PARTNER_MIN_PAYOUT_LAMPORTS`,
  default 0.05 SOL, same caps), then sweeps our part.
- Revenue counts `fee_raw - creator_raw - partner_raw`.
- The partner can verify every fee from its site on Solscan: its fee account's inflows.

## Auto-import

Coins that earn creator fees without a MemeWarzone page are imported by MemeWarzone (same pipeline as a user
import: lookup, safety scan, still-bonding refusal, admission scan; importer = the collector). Up to 5 per fee
scan, refused coins retried every 6 hours (`import_auto_imports`). On with the 1% split; `IMPORT_AUTO_IMPORT=false`
turns it off.

## Add a partner (founder)

1. Production SQL: `db/migrations/20261009_000010_import_fee_partners.sql` (before the merge).
2. Create the partner's fee account (the collector pays ~0.002 SOL rent):
   ```bash
   cd ~/mwz-wt/import-creator-fees/frontend
   node scripts/create-import-partner-fee-account.mjs --partner crypticpump --name CrypticPump --payout <their Solana wallet>
   node scripts/create-import-partner-fee-account.mjs --partner crypticpump --name CrypticPump --payout <their Solana wallet> --send
   ```
   It prints the `insert into public.import_fee_partners ...` line: run it in the Supabase SQL editor.
3. Give the partner their snippet: `MemeWarzoneSwap.mount("#mwz-swap", { mint: "<mint>", partner: "crypticpump" })`.

## BNB / Robinhood (no contract change)

One more `ImportFeeVault` deployment per partner per chain (existing `RecruiterRewardsVault` bytecode), set as the
Kyber fee receiver / Universal Router `PAY_PORTION` recipient for that partner's widget swaps. A partner row with
`chain_id` 56 / 4663 (or testnets 97 / 46630), `fee_account` = that vault and `start_block` = its deploy block makes
the finance cron read it. EVM payouts of the partner share belong to the EVM worker (gen-7, CO-IMPORT-SWAP-FEE).
