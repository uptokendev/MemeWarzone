# Grok brief, DBC step 7: binding tokens (USDC, USDT and stock tokens)

Read `docs/dbc/DBC_BUILD_PLAN.md` first: D20-D23 are the decisions for this step, and the step 3-6
reviews list the mistakes not to repeat. Steps 1-6 are merged (`build/dbc-staging`). Step 5b may run
in parallel; do not touch its files.

## Branch rules (hard)

Own clone; **two PRs**, in order: `grok/dbc-step-7a` (USDC/USDT), then `grok/dbc-step-7b` (stock
tokens) from `build/dbc-staging` once 7a is merged. Never merge. Run every proof yourself and paste
it; if you cannot fund one, say so and Claude runs it. Nothing on mainnet.
**SOL coins must behave exactly as today**: every existing DBC test and proof keeps passing unchanged.

## Facts (read 2026-09-29, mainnet and Meteora source; evidence in the plan's research note)

- A DBC config can use any classic SPL quote. A Token-2022 quote passes without a badge only with
  metadata extensions and a zero transfer fee; anything else needs a **TokenBadge**
  (PDA `["token_badge", mint]` under the DBC program), passed as remaining account 0 on `create_config`
  and on pool init. Only Meteora can create badges. A non-zero transfer fee is refused even with a badge
  and is checked on every swap. DBC and DAMM v2 never run a transfer hook on the quote side.
- Badges exist today on mainnet for NVDAx, TSLAx, SPYx, QQQx, AAPLx (DBC and DAMM v2). USDC and USDT need none.
- Mints: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`,
  NVDAx `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`, TSLAx `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`,
  SPYx `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`, QQQx `Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ`.
  Keep them in one config file with the cluster, not scattered literals.
- xStocks: **8 decimals**, Token-2022, extensions permanent delegate, pausable, default account state,
  transfer hook (no program today, authority set), ScaledUiAmount (multiplier ~1.001-1.004).
- DBC migration into DAMM v2 skips DAMM's mint check (the DAMM configs DBC uses carry
  `CreatePoolWithoutMintValidation`), and those configs are quote-agnostic. Our keeper migrates any quote.
- With our configs (`CollectFeeMode.QuoteToken`) every fee is paid in the bound token: trading-fee
  claims, the referral cut, the migration fee, LP fees. `migration_quote_threshold` is in the quote's
  smallest unit.
- Every place the DBC code assumes SOL: `docs/dbc/step7-sol-assumptions.txt` (70 lines, file:line).

## 7a: USDC and USDT (classic SPL)

1. **One quote registry** (`frontend/shared/dbcQuotes.mjs`): per cluster, mint, symbol, decimals, token
   program, kind (`native | stable | stock`), enabled flag. Devnet: SOL and devnet USDC
   `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Replace the SOL literals in the assumption list by
   lookups; SOL stays the default everywhere.
2. **Config ladder per quote.** The quote mint is already in the lock key; add it to params. Threshold
   = USD target converted to quote units (stables 1:1, so no price step; SOL keeps its SOL/USD steps).
   Curve prices through the SDK helpers with the quote's decimals. Parity tests per quote: the same
   dollar target gives the same economics (D6 split, supply, 2% reserve) whatever the quote.
3. **Create flow:** the creator picks the quote on the create screen (reuse the graduation market
   step's picker look); drafts store it; authorize and finalize refuse a quote that is not enabled.
4. **Trading:** the buy/sell panel is priced and paid in the bound token (SOL coins unchanged). If
   the wallet does not hold enough of it, the panel offers a Jupiter swap from SOL first, as its own
   transaction the user signs and sees. The DBC swap is unchanged apart from the quote accounts. Our
   **referral account is one token account per quote mint**, owned by the referral key and never
   closed (`DBC_REFERRAL_TOKEN_ACCOUNTS`, JSON mint -> account).
5. **Indexer:** new nullable columns `curve_trades.quote_mint`, `quote_amount_raw`. For a bound trade,
   `bnb_amount_raw` holds the **SOL value at trade time** (leagues and the pot compare SOL across all
   coins), converted with a quote/SOL price you record in `activity_events.meta` (source + time).
   market_stats: price and liquidity in USD through the quote's price.
6. **Fees to SOL (D21):** after a claim (step 5) or a migration-fee withdrawal / LP claim (step 6), the
   collector holds quote tokens. Swap them to SOL through Jupiter with
   `DBC_QUOTE_SWAP_MAX_IMPACT_BPS` (default 100), sign-store-send like every money move, then split the
   **SOL actually received** in the same proportions the quote amounts had (remainder to protocol).
   Reconcile in quote units first (as step 5 does), then record the swap (quote in, SOL out, signature).
   A swap refused by the impact cap waits and retries; it never routes a partial amount as if whole.
   D7 compensation is paid to the creator **in the quote**, from the protocol slice, before the swap.
   The referral sweep swaps its quote balance to SOL into `protocol_vault`, leaving the account open.
7. **Graduation keeper:** quote-agnostic already except the SOL literals; `mark` writes the quote mint
   and decimals into `meta.solanaGraduation`.

Proof (devnet, devnet USDC): a $150 USDC-bound coin: create, buys and a sell paying USDC, indexer rows
(quote columns and SOL value), claim in USDC to the lamport of the pool counter, graduation by the keeper
(case A), migration fee and LP fees in USDC. Jupiter does not run on devnet: prove the swap step with a
stub that returns a fixed SOL amount, and state that the live swap is proven by the mainnet canary
(Claude runs it from the founder's terminal after merge).

## 7b: stock tokens (Token-2022)

1. Registry entries for the four stocks with `tokenProgram = Token-2022`, the DBC and DAMM badge PDAs.
   **Create is refused unless**, read from chain at authorize time: the DBC badge exists; transfer fee
   is zero; the transfer-hook program is none; the mint is not paused. The same check runs in the
   keeper before migrate (a stock paused after launch stops at a clear `blocked` reason, not a loop).
2. Pass the badge as remaining account 0 on `createConfig` and on pool creation (check what SDK 1.5.13
   does; add it if the SDK does not).
3. **Price (D23):** the USD target converts at the stock's live price times its ScaledUiAmount
   multiplier, from the Jupiter price API with a max age (same staleness rule as SOL), in 2% price steps
   like SOL's ladder so configs are reused.
4. **Amounts:** raw amounts everywhere in money code; UI amounts apply the ScaledUiAmount multiplier.
   Every token transfer is `TransferChecked` with the mint and its real decimals (the live launchpad
   had a plain Transfer that Token-2022 refuses for these accounts; fixed 2026-09-29 in
   `solanaLpFees.ts`, reuse that helper's shape).
5. **Risk dialog (D22):** stock quotes open the existing `BindingRiskDialog` with the catalog's issuer
   powers, plus this line: "The issuer can switch on a transfer check later. If they do, trading on
   this coin stops." Selection only commits on confirm, like the old launchpad.

Proof: local validator with state cloned from mainnet: the DBC program, DAMM v2, the NVDAx mint and
its DBC and DAMM badge accounts (`--clone` / `--clone-upgradeable-program --url <mainnet RPC>`; mint
authority is not ours, so fund test wallets by cloning a holder's token account or by `--account`
with a crafted token account). Run: create (badge passed), buys and a sell in NVDAx, completion,
keeper migrate, claims; every amount to the raw unit; refusals for a paused mint and a non-zero
transfer fee (craft those mints locally). Devnet has no badged stocks, so no devnet proof is asked.

## Tests (throwaway Postgres)

- Registry: SOL unchanged; each quote's decimals and program.
- Config parity per quote; threshold conversion for USDC (6), SOL (9), an 8-decimal stock with a multiplier.
- Fee split in quote units, then the proportional SOL split of a stubbed swap output, conserving every lamport.
- Swap refused by the impact cap leaves rows unrouted.
- Create refusals for 7b: no badge, transfer fee, hook program set, paused.

## Hand-in (each PR)

Branch and commit, every file one line, test output, proof output, what you could not run and why.
Copy: plain sentences, no em dashes, no slogans.
