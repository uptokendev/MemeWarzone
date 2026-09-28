# Grok brief, DBC step 2: the create flow

Read `docs/dbc/DBC_BUILD_PLAN.md` first (decisions D1-D17 are the authority; where this brief and a
decision disagree, stop and say so in the PR). Step 1 is merged: `frontend/api/lib/dbc/*` gives you
`ensureLaunchConfig`, the price steps and `GET /api/dbc/launch-config`.

## Branch rules (hard)

- Your own clone, never `/mnt/e/network/Zakelijk/MemeWarzone`.
- Branch `grok/dbc-step-2` from `origin/build/dbc-staging`; push only that branch; one pull request
  into `build/dbc-staging` with the hand-in report in its description. Never merge, never push to
  `build/*` or `fix/*`.
- Do not change the existing launchpad's CREATE / BUY / SELL paths (`solana-direct-create.js`,
  `solana-create-authorization-v4.js`, `solanaV4CreateSubmit.ts`, the programs, the pinned tests).
  The only edits to existing code allowed are the guards in "Existing jobs" below.
- Nothing on mainnet. Devnet only, throwaway keys; Claude runs the devnet proof with a funder.

## What this step delivers

A creator launches a coin on Meteora DBC from our create page:
**one transaction, 2 signers** (the creator's wallet + the new token's key), optionally with the
creator's first buy of up to 10% of supply in the same transaction (D10, D11). The coin shows up in
our feeds and on its token page like any Solana coin. Trading screens are step 3; the indexer is step 4.

## Server: `POST /api/dbc/create` (new file `frontend/api/dbc/create.js`)

Model it on `solana-direct-create.js` (preflight / begin / authorize / finalize), reusing its helpers
where they are generic (wallet-signed message check, ticker reservation service, logo upload session),
never editing it.

1. **preflight**: target ($15K / $30K / $50K, $150 on devnet only), creator limits. Creator limits are
   today's numbers (`solana-create-authorization-v4.js:48-53`: max 3 live bonding coins, 24 h
   cooldown), enforced from our database for DBC coins (DBC has no CreatorProfile PDA).
2. **begin**: wallet-signed message, ticker reservation exactly like direct create
   (`ticker_reservations`, same uniqueness), returns a session token for the logo upload.
3. **authorize**: inputs: name, symbol, description, socials, logo URL, target, **creator fee choice**
   (`keep` | `holders` | `split` + creator share % | `buyback`), optional **first buy in lamports**, and
   the new token's public key (the client generates the keypair and keeps the secret).
   - fee choice -> config mode: `keep` -> `creator`, everything else -> `platform` (D5).
   - config = `ensureLaunchConfig(target, current price step, mode)`.
   - first buy: refuse if the tokens it buys (quote it on the config's curve with the SDK) exceed
     **10% of the config's total supply** (D11). No buy is fine.
   - token metadata URI: `https://api.memewar.zone/api/token-metadata/101/<mint>` (same endpoint as
     today), and write name, symbol, description, socials and logo to `token_metadata_registry` so the
     metadata JSON and the feeds show them (today's direct create loses description and socials:
     do not repeat that).
   - build the transaction with the SDK: `createPool` or `createPoolWithFirstBuy`
     (`enableFirstSwapWithMinFee` is in the config, so the first buy pays 2%). Payer and pool creator
     = the creator's wallet. Return it serialized, unsigned, plus the config and the expected pool
     address. Our server holds no key in this transaction.
4. **finalize** (after the client sent it): read the chain, not the client: the pool account exists
   and is owned by the DBC program, its config is the one we served, its creator is the wallet, its
   base mint is the reserved token. Then:
   - register the coin in `public.campaigns` (chain 101) with **`launch_type = 'dbc'`**
     (new column, default `'launchpad'`), `campaign_address` = the DBC pool, `token_address` = mint,
     creator, name, symbol, logo; `meta.dbc = { config, target, stepIndex, feeChoice, creatorSharePct,
     firstBuySignature, firstBuyLamports }` (step 4 excludes the first buy from leagues, D13);
   - mark the ticker reservation live.

## Existing jobs that assume every chain-101 coin is a launchpad campaign

These must skip `launch_type = 'dbc'` (a one-line guard each, nothing else changed):
- `realtime-indexer/src/solanaIndexer.ts` `listBondingSolanaCampaigns` (~1648): PDA-tip ingest.
- `realtime-indexer/src/solanaGraduationReconciler.ts:139-150`: graduation candidates.
- `frontend/api/dev-fix/campaign-registry.js:266`: fee-escrow enqueue.
- `frontend/api/solanaCreatorFees.js:50-62`: launchpad fee vault derivation.
- `frontend/src/pages/TokenDetailsLiveEntry.tsx`: must not read a DBC coin as a launchpad curve or
  call the graduation handoff; a DBC coin opens a DBC token page (for now: name, logo, socials, and
  the pool's price and progress to target read from the pool account; trading is step 3).
Keepers that already check the owner program (graduation keeper, fee-escrow worker, trade
authorization) need no change; say so in the PR if you find otherwise.

## Migration

`db/migrations/20260929_000002_campaigns_launch_type.sql`: `campaigns.launch_type text not null
default 'launchpad'` with a check (`launchpad`, `dbc`), and an index on (chain_id, launch_type).
Follow `db/migrations/` style.

## Create page (`frontend/src/pages/Create.tsx` and its step components)

Behind `VITE_DBC_LAUNCH_ENABLED`: when on, a new Solana launch is a DBC launch.
- Steps stay as they are; step 4 (graduation) gets:
  - **Creator fee**: Keep it / Give it to holders / Split / Buyback & burn (split: a percentage).
    One line each on what it means; buyback: "bought back at random times each week and burned".
  - **Your first buy (optional)**: SOL amount, with the tokens and % of supply it buys, capped at 10%;
    "Buys in the same transaction as the launch, at the normal 2% fee."
  - **Anti-sniper**: one line: the fee starts at 50% and falls to 2% within 60 seconds, so bots
    that buy at launch pay for it; your own first buy does not.
- Step 5 (Graduation Market): DBC coins graduate against SOL only for now (step 7 adds the rest):
  show SOL, selected, nothing else.
- Deploy: begin -> logo upload -> authorize -> the client generates the mint keypair, signs with it,
  the wallet signs, send -> finalize -> token page. Use `signTransaction` then `sendRawTransaction`
  like `solanaV4CreateSubmit.ts` does (no signAndSend).
- Drafts and scheduled launches: out of scope for step 2 (Direct deploy only). Say where a draft
  would plug in.
- Copy: plain sentences, no em dashes, no slogans (`memory: no-ai-tone-copy`).

## Tests

- `create.js` with fake chain + fake DB: each operation; first buy above 10% refused; fee choice ->
  config mode; finalize refuses a pool with a different config, creator or mint; the campaign row and
  `token_metadata_registry` row are written with the right fields; creator limits from the DB.
- The built transaction: **2 signers** (wallet + mint), measured bytes, for both with and without the
  first buy, serialized for every target.
- Each guard in "Existing jobs": a DBC row is skipped, a launchpad row is not.
- `scripts/dbc/prove-create-devnet.mjs` (optional funder like step 1): run the real `create.js`
  operations in-process against devnet with the $150 target and a throwaway creator: pool created in
  one transaction with 2 signers, first buy 10% paid 2%, finalize registered the coin (in-memory DB),
  metadata registry filled. Print every signature and the transaction size.

## Hand-in (PR description)

Branch and commit; every file, one line each; test output; the devnet proof output (or "Claude to
run"); transaction sizes with and without the first buy; anything you could not follow and why.
