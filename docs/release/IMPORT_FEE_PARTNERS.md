# Swap-widget partners (Solana live, EVM after gen-7)

Founder 2026-10-09: a website that embeds the swap widget (first: CrypticPump) gets part of the 1% import
fee. Default split per partner: **0.50% creator / 0.25% partner / 0.25% MemeWarzone** (`import_fee_partners`
creator_bps 5000, partner_bps 2500, of the fee).

## How it works

- The partner mounts the widget with `partner: "<id>"`. The swap is the ordinary one: same route, same 1%, same
  fee receiver (Solana collector account, EVM ImportFeeVault). Nothing in the trader's transaction changes.
- When the API builds a swap for a partner it records a **fingerprint** of what it built
  (`import_swap_fingerprints`, `api/lib/importSwapFingerprint.js`):
  - EVM: `keccak256(to : data : value)` of the built transaction (wallets sign it as built).
  - Solana: `sha256(wallet : Jupiter instruction data)`. Wallets add their own instructions (compute budget,
    Lighthouse) and recompile the message, but leave the Jupiter instruction unchanged. Proven 2026-10-09 with a
    real Phantom swap (5QZx9vUK...): the landed transaction's fingerprint equals the stored one.
- The finance cron computes the same fingerprint from each landed fee transaction; on a match the fee row gets
  `partner_id` / `partner_raw` and splits by the partner row (default 0.50 creator / 0.25 partner / 0.25 us).
- Only the API builds the data, so no one can claim another swap for a partner.
- Adding a partner is **one row per chain**: no account, no contract, no deploy.
- Payouts: Solana worker pays the partner's share to `payout_wallet` (kind `partner`, minimum
  `IMPORT_PARTNER_MIN_PAYOUT_LAMPORTS`, default 0.05 SOL, same caps), after creators, before our sweep. EVM payouts
  from the default ImportFeeVault are in the EVM worker (gen-7).
- Revenue counts `fee_raw - creator_raw - partner_raw`.
- Fallback (Solana): a partner row with `fee_account` (a WSOL account owned by our collector, made with
  `scripts/create-import-partner-fee-account.mjs`) uses that account instead of fingerprints; the worker gathers
  it into the collector account (kind `consolidate`).
- Partners check their swaps through the list we give them (each with its explorer link).
- Robinhood: the API must build the swap to fingerprint it (today the browser builds Robinhood import swaps);
  that comes with the widget's BNB / Robinhood support.

## Auto-import

Coins that earn creator fees without a MemeWarzone page are imported by MemeWarzone (same pipeline as a user
import: lookup, safety scan, still-bonding refusal, admission scan; importer = the collector). Up to 5 per fee
scan, refused coins retried every 6 hours (`import_auto_imports`). On with the 1% split; `IMPORT_AUTO_IMPORT=false`
turns it off.

## Add a partner (founder)

1. Production SQL: `db/migrations/20261009_000010_import_fee_partners.sql` (before the merge).
2. One row per chain the partner uses (Supabase SQL editor, production):
   ```sql
   insert into public.import_fee_partners (id, chain_id, name, payout_wallet, creator_bps, partner_bps)
   values ('crypticpump', 101, 'CrypticPump', '<their Solana wallet>', 5000, 2500),
          ('crypticpump', 56,  'CrypticPump', '<their BNB wallet>',    5000, 2500),
          ('crypticpump', 4663,'CrypticPump', '<their Robinhood wallet>', 5000, 2500);
   ```
3. Their snippet: `MemeWarzoneSwap.mount("#mwz-swap", { mint: "<mint>", partner: "crypticpump" })`.

## BNB / Robinhood

No contract change and no extra vault: the fee goes to the chain's ImportFeeVault as for every import swap; the
fingerprint names the partner. The EVM worker (gen-7) pays the partner share from that vault with `payout(to, amount)`.
