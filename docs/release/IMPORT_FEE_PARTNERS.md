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

## Graduated gen-8 coins (BNB 56, Robinhood 4663)

Founder 2026-10-22: a widget partner earns **0.25% of the volume** of a graduated gen-8 MemeWarzone coin swap that
came through its widget, out of MemeWarzone's 0.50%. **Nothing during bonding.** Same fingerprint rule as imports.

- **Fees do not change.** The gen-8 hook keeps sending MemeWarzone's share hook -> MwzFeeSplitter -> ProtocolRevenueVault
  (Safe only). Nothing pays from there.
- **Ledger** (`gen8_partner_fees`, written by the indexer, `realtime-indexer/src/evm/gen8PartnerFees.ts`): post-graduation
  trade accruals (`evm_gen8_fee_accruals`, phase `post`) with the widget referrer tag -> the landed transaction's
  to / input / value -> the fingerprint the API recorded when it built that partner's swap (`api/gen8Swap.js`) -> the
  partner, if its row on that chain is **active**. Share = floor(volume x 25 / 10000), never above the trade's protocol
  slice. A failed RPC read is retried on the next run, never recorded as "no partner". Re-runs insert nothing twice.
- **Payout**: the existing EVM import worker pays it from the chain's **ImportFeeVault**, in the same partner payout as the
  import share (`import_fee_transfers` kind `partner`, `gen8_raw` = the gen-8 part), same operator key, caps, minimum,
  resend and dry-run rules. The gen-8 part only comes out of **MemeWarzone's free share** of the vault:
  min(vault balance - creator accruals waiting or paying - import partner dues, MemeWarzone's recorded import share +
  verified Safe top-ups - what gen-8 already took). Creator and import partner money is never used. When that share is
  short, the rest **waits** (the pass log says so) and the daily sweep keeps every gen-8 due in the vault.
- **Top-up** when the share is short: send ETH / BNB from the **Safe** (the vault admin) to the ImportFeeVault, then
  record it (production SQL, lower-case hex):
  ```sql
  insert into public.gen8_partner_topups (chain_id, vault, tx_hash, amount_raw, note)
  values (4663, lower('<ImportFeeVault>'), lower('<top-up tx hash>'), <wei>, 'gen-8 partner top-up');
  ```
  The worker counts it only after the receipt shows a Deposit of exactly that amount from the vault admin into the
  vault (and the transaction is not an import fee); otherwise the row becomes `rejected` with the reason.
- **Report**: `GET /api/admin/finance/gen8` partner block reads earned / paid / sending / due from the ledger once the
  indexer has run on the chain (`partner.ledger`).
- BNB has no ImportFeeVault yet: the ledger fills, nothing is paid until `IMPORT_FEE_VAULT_56` is set.

### Go-live (each step a founder go)

1. Production SQL: `database/prod_apply_gen8_partner_fees.sql` (same statements as
   `db/migrations/20261022_000010_gen8_partner_fees.sql`), then the check at its bottom.
2. Merge and redeploy the indexer (and the API for the report). Nothing changes yet.
3. Indexer env, ledger: `GEN8_PARTNER_FEES_ENABLED=true` (optional `GEN8_PARTNER_FEES_BATCH`,
   `GEN8_PARTNER_FEES_POLL_MS`). Log `[gen8] partner fees {...}`. Check `select * from public.gen8_partner_fees`.
4. Dry run of the payout: leave `GEN8_PARTNER_PAYOUT_SEND` unset. The `[import-fees-evm] pass` log shows `gen8.roomWei`,
   `gen8.outstandingWei` and `gen8.planned` (what it would pay); import partner and creator payouts run as today.
5. Send: `GEN8_PARTNER_PAYOUT_SEND=true` on the indexer. Existing env stays: `IMPORT_FEE_EVM_WORKER_ENABLED`,
   `IMPORT_FEE_PAYOUT_SEND`, `IMPORT_FEE_VAULT_<chainId>`, `IMPORT_FEE_PAYOUT_OPERATOR_PK_<chainId>`,
   `IMPORT_PARTNER_MIN_PAYOUT_WEI_<chainId>`.
