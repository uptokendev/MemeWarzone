# Swap-widget partners (Solana live; Robinhood built by the API; BNB waits on its vault)

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
- Robinhood (2026-10-22): the widget's Robinhood import swaps are built by the API (`api/importSwap.js`
  `robinhoodBuildCore`, the app's own encoders from `src/lib/robinhoodImportSwap.mjs`), so they carry a recorded
  fingerprint. A widget sell spends a standing Permit2 allowance (the build answers `needsAllowance` with the two
  one-time approvals first) instead of a signed permit inside the calldata, which would change the data after the
  fingerprint is recorded. The app keeps building its own Robinhood swaps in the browser (no partner there).
  Fork proof: `api/importSwap.robinhood.fork.test.mjs` (fee to the ImportFeeVault, Deposit from the Universal
  Router, landed fingerprint = recorded).
- BNB: the widget's BNB imports are Kyber builds by the API (fingerprint recorded as before). A sell without an
  allowance first gets `needsAllowance` with approve(Kyber router, exact amount). Until the BNB ImportFeeVault is
  deployed and switched on, the fee is 0.5% to the ProtocolRevenueVault with no creator or partner share; the
  fingerprints are already recorded, the partner payout starts with the vault. Builds that fall back to the Topaz
  fee router are browser-built and cannot carry a fingerprint, so the widget does not build them: a coin with no
  Kyber route shows a link to its MemeWarzone page.

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
3. Their snippet: `MemeWarzoneSwap.mount("#mwz-swap", { mint: "<mint>", partner: "crypticpump" })` on Solana,
   `MemeWarzoneSwap.mount("#mwz-swap", { chainId: 4663, token: "0x...", partner: "crypticpump" })` on Robinhood
   Chain (56 for BNB Chain).

## BNB / Robinhood

No contract change and no extra vault: the fee goes to the chain's ImportFeeVault as for every import swap; the
fingerprint names the partner (`financeImportSwapFees.js` scanEvmImportSwapFees matches `import_swap_fingerprints`).
The indexer (`realtime-indexer/src/importCreatorFeesEvm.ts`) pays the partner share from that vault. Robinhood has
its vault live; BNB waits for its ImportFeeVault (see above). The API refuses a Robinhood widget build when the
Robinhood split is not configured (`IMPORT_FEE_VAULT_4663` = `IMPORT_SWAP_FEE_RECEIVER_4663`): never a fee-free swap.
