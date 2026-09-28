# Grok brief, DBC step 3: trading on our site

Read `docs/dbc/DBC_BUILD_PLAN.md` first: decisions D1-D18 are the authority, and "Groundwork for
steps 3-6" has the facts this brief rests on. Steps 1 and 2 are merged.

## Branch rules (hard)

- Your own clone. Branch `grok/dbc-step-3` from `origin/build/dbc-staging`; push only that branch;
  one pull request into `build/dbc-staging`, hand-in report in its description. Never merge.
- Do not change the existing launchpad's CREATE / BUY / SELL paths (`solanaTradeV1.ts`,
  `solana-trade-authorization-v1.js`, `solanaV4CreateSubmit.ts`, the programs, pinned tests). A DBC
  branch sits **in front of** them in `TokenDetails.tsx`; launchpad coins behave exactly as today.
- Nothing on mainnet. Devnet only, throwaway keys. The proof script must run: execute it yourself
  with a funder you create on devnet if you can, and paste the output; Claude re-runs it.

## What this step delivers

On a DBC coin's token page: buy and sell on the bonding curve, a correct quote including the
anti-sniper fee in the first 60 seconds, our referral account on every trade, the creator's extra
buys locked (D12), and trading on the graduated pool once a DBC coin has migrated.

## 1. Quote, buy, sell (bonding curve)

- New `frontend/src/lib/dbcTrade.mjs` (+ `.ts` wrapper if needed), modeled on
  `solanaMeteoraTrade.ts` and step 2's `dbcCreateIntent.mjs`:
  - quote with the DBC SDK (`swapQuote` / `swapQuote2`) from the live pool and config state and the
    **current time**, so the anti-sniper fee is in the quote;
  - build with `swap` / `swap2`; `minimumAmountOut` from the quote with today's fixed 5% slippage;
  - **before signing**: fresh blockhash, intent check (fee payer = trader; programs only DBC, System,
    SPL Token, Associated Token, Compute Budget; the pool account present), simulate the way web3.js
    accepts for the transaction type (a legacy `Transaction` takes no config object: that exact bug
    broke step 2), then `signTransaction` + `sendRawTransaction`, confirm against that transaction's
    blockhash and `lastValidBlockHeight`.
- `TokenDetails.tsx`: branch on `launch_type = 'dbc'` **before** the launchpad quote (~3270) and
  `handlePlaceTrade` (~3762). Without a Campaign PDA the launchpad quote falls back to hard-coded
  defaults; a DBC coin must never reach that code.
- In the first 60 seconds show the live fee: "Launch fee: 38% now, 2% from 12:04:31." (plain text).

## 2. Our referral account (D2)

- Every DBC swap built by our site names our **referral token account**: a WSOL token account whose
  owner is a dedicated referral key that **never claims anything** (the SDK's fee claim closes the
  claimer's WSOL account; the referral account must not be one a claim closes).
- `scripts/dbc/create-referral-account.mjs`: dry run by default, `--send` creates it (devnet in your
  proof; mainnet is the founder's terminal). Config: `DBC_REFERRAL_TOKEN_ACCOUNT` (API) and
  `VITE_DBC_REFERRAL_TOKEN_ACCOUNT` (app).
- If the account is missing or not a WSOL account at trade time, trade **without** a referral and log
  it; never block a trade over the referral.

## 3. Creator buys are locked (D12, D13)

- When the connected wallet is the coin's creator and the coin is still on the curve, a buy is a
  **locked buy**, in one transaction: `swap2` ExactOut (exactly X tokens) + create the escrow's token
  account + Jupiter Lock `create_vesting_escrow(X)` with **cliff = now + 30 days, 20% at the cliff,
  then 20% every 7 days (4 periods)**, `cancel_mode 0`, `update_recipient_mode 0`. Two signers: the
  wallet and a fresh escrow `base` key generated in the browser. This exact shape is proven:
  `tools/dbc-rehearsal/prove-creator-lock-devnet.mjs` (IDL in `jup-lock-idl.json`, program
  `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`). X must be divisible so 5 x 20% is exact.
- The buy panel tells the creator before they sign: "As the creator, your buys are locked: 20% is
  released after 30 days, then 20% every 7 days."
- Record each locked buy through a new API route that **verifies it on chain** (escrow owned by the
  lock program, recipient = creator, mint = the coin, amount, schedule) and stores it
  (`dbc_creator_locks`: pool, mint, creator, escrow, amount, cliff, frequency, periods, tx, created_at).
- Token page badge: "Creator holds X% of supply, Y% locked until <date>". A creator sees a
  "Claim released tokens" button when anything is released (Jupiter Lock `claim`, same sign-time
  checks).
- Creator **sells** are normal (their unlocked tokens).

## 4. After graduation

- A migrated DBC coin trades on its DAMM v2 pool. Step 6 writes `meta.dbc.migration.pool`
  (and `meta.solanaGraduation` like today's graduations). Here: when that pool is present, trade
  through `solanaMeteoraTrade.ts`, and relax `loadVerifiedMarket` (~131) **for DBC coins only** to
  accept the pool from meta after verifying on chain that it is a DAMM v2 pool of this mint and SOL.
  The launchpad's deterministic-pool check stays for launchpad coins.

## Tests

- Unit: quote with a fake pool at t = 0 / 5 / 30 / 60 / 120 s (fee 50% -> 2%); intent check refuses a
  foreign program, a wrong fee payer, a missing pool; referral fallback when the account is missing;
  locked-buy transaction has 2 signers and the exact schedule parameters; the lock-record route refuses
  an escrow with another recipient, mint, amount or cancel mode; `TokenDetails` never calls the
  launchpad quote for a DBC coin.
- `scripts/dbc/prove-trade-devnet.mjs` (optional `DBC_PROVE_FUNDER_KEYPAIR`, like steps 1 and 2): on a
  $150 devnet coin made through step 2's handler: a buy and a sell through `dbcTrade.mjs`'s real
  path (sign exactly like the browser); the referral account receives 20% of Meteora's cut of each
  fee; a buy in the first seconds pays the fee the quote showed; a creator locked buy (escrow holds X,
  creator's wallet delta 0, 2 signers); the lock-record route accepts it. Print every signature and
  transaction size.

## Hand-in (PR description)

Branch and commit, every file one line, test output, the proof output you ran (or why not), sizes,
and anything you could not follow and why. Copy: plain sentences, no em dashes, no slogans.
