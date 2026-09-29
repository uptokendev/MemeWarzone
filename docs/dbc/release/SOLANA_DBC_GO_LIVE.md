# Solana DBC go-live runbook

Branch to release: `release/dbc-solana` (build/dbc-staging with the live branch merged in; it
fast-forwards onto `build/cross-chain-stabilization-rh-base`). Everything below was checked on
2026-09-30; the full regression passed the day before (docs/dbc/DBC_BUILD_PLAN.md, last sections).

Order matters: database first, then workers in dry run, then the API and app, then the canary, then
sending switched on. Every step can stop without harm.

## 1. Keys (your terminal)

Four new keys. None of them is the deployer, and none holds user money beyond what it routes.

| Key | What it does | Fund with |
|---|---|---|
| Collector | Partner fee claimer on every DBC pool; routes fees into the vaults; pays the creator pots; runs graduations | ~0.5 SOL for gas and account rent |
| Config payer | Creates the DBC configs (one per target, price step and quote) | ~0.3 SOL (about 0.006 SOL per config) |
| Referral owner | Owns the referral token accounts that get 20% of Meteora's cut on trades from our site. It never claims, so no claim can close its accounts | ~0.05 SOL |
| Buyback seed secret | Not a wallet: 32 random bytes. Picks the random buyback and snapshot moments; the hash is published before each week, the secret after | none |

```
solana-keygen new -o ~/.config/memewarzone/dbc-collector.json
solana-keygen new -o ~/.config/memewarzone/dbc-config-payer.json
solana-keygen new -o ~/.config/memewarzone/dbc-referral-owner.json
openssl rand -hex 32   # DBC_BUYBACK_SEED_SECRET
```

Referral token accounts, one per quote (owner = referral owner). SOL uses the script (it makes a
dedicated WSOL account, not the ATA a claim would close); the others are plain ATAs:

```
SOLANA_RPC_URL=<mainnet rpc> DBC_REFERRAL_OWNER_KEYPAIR="$(cat ~/.config/memewarzone/dbc-referral-owner.json)" \
  node scripts/dbc/create-referral-account.mjs          # dry run, then add --send
spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --owner <referral owner> --fee-payer <payer>   # USDC
spl-token create-account Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB --owner <referral owner> --fee-payer <payer>   # USDT
# xStocks are Token-2022: add --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
spl-token create-account Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --owner <referral owner> --fee-payer <payer>   # NVDAx
spl-token create-account XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --owner <referral owner> --fee-payer <payer>   # TSLAx
spl-token create-account XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --owner <referral owner> --fee-payer <payer>   # SPYx
spl-token create-account Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --owner <referral owner> --fee-payer <payer>   # QQQx
```

Write the result as one JSON map, quote mint -> referral account, for the env below:
`{"So11111111111111111111111111111111111111112":"<wsol ref>","EPjF…":"<usdc ref>", …}`

## 2. Database (Supabase SQL editor, production)

Run `docs/dbc/release/dbc-solana-migrations.sql` once. It is migrations 20260929_000001..000011 in
order, each in its own transaction.

Checked on 2026-09-30:
- Applied to a fresh copy of the staging schema: no errors, 11 `dbc_*` tables. A second run is also
  clean (safe if pasted twice).
- Production, read only: the tables it alters exist with the columns it needs, no `dbc_*` table
  exists yet, and all 81 existing drafts satisfy the widened draft-target check in 000011.

## 3. Env

API service:

| Name | Value |
|---|---|
| `DBC_LAUNCH_ENABLED` | `true` (the switch; `false` refuses new DBC launches, existing coins keep working) |
| `DBC_FEE_COLLECTOR` | collector public key |
| `DBC_CONFIG_PAYER_SECRET` | config payer keypair JSON |
| `RUNTIME_ENVIRONMENT` | `production` (Solana drafts refuse without it) |
| `SOLANA_CLUSTER` | `mainnet-beta` (already set) |
| `JUPITER_API_KEY` | optional; without it the free lite API is used |

App service:

| Name | Value |
|---|---|
| `VITE_DBC_LAUNCH_ENABLED` | `true` |
| `VITE_DRAFT_PUSH_LIVE_ENABLED` | `true` (draft and scheduled launches) |
| `VITE_RUNTIME_ENVIRONMENT` | `production` |
| `VITE_DBC_REFERRAL_TOKEN_ACCOUNTS` | the JSON map from step 1 |

Indexer service (workers start in dry run; `_SEND` switches on real transactions):

| Name | Value |
|---|---|
| `DBC_FEE_COLLECTOR_SECRET` | collector keypair JSON |
| `DBC_REFERRAL_OWNER_SECRET` | referral owner keypair JSON |
| `DBC_REFERRAL_TOKEN_ACCOUNTS` | same JSON map as the app |
| `DBC_FEE_ROUTING_ENABLED` / `DBC_FEE_ROUTING_SEND` | `true` / `false` first |
| `DBC_GRADUATION_ENABLED` / `DBC_GRADUATION_SEND` | `true` / `false` first |
| `DBC_CREATOR_CHOICE_ENABLED` / `DBC_CREATOR_CHOICE_SEND` | `true` / `false` first |
| `DBC_BUYBACK_SEED_SECRET` | the 32-byte hex secret |
| `JUPITER_API_KEY` | optional, as the API |

Defaults that need no setting: buyback at most 4 a day at 0.5% impact, $2 minimum on non-SOL pairings;
quote swaps capped at 1% impact; minimum holder payout 0.005 SOL.

## 4. Deploy

1. Fast-forward the live branch to `release/dbc-solana` (it contains the graduated-coin buy fix too).
2. Redeploy the indexer. Its log should show `[dbcIndexer] enabled` and the three workers enabled with
   `send: false`.
3. Redeploy the API, then the app.

## 5. Canary (your wallet, small amounts)

1. Launch a coin on the site: SOL pairing, $15K, "keep". One wallet signature.
2. After 60 s (the launch fee window), buy 0.02 SOL and sell half from the token page.
3. In Jupiter (or Phantom's swap), search the coin by address: it routes on the curve.
4. Indexer log: the trades are indexed, the fee accrual appears, the router logs a dry-run route.
5. Set `DBC_FEE_ROUTING_SEND=true`, redeploy the indexer, and watch one claim + route land (vault
   deltas match the split). Then `DBC_GRADUATION_SEND=true` and `DBC_CREATOR_CHOICE_SEND=true`.
6. Optional, the one path no test could run: launch a small USDC-paired coin and trade it. Its fees
   are swapped to SOL through Jupiter; the log shows the swap and the SOL that arrived.

## 6. If something is wrong

- Stop new launches: `DBC_LAUNCH_ENABLED=false` (API) and `VITE_DBC_LAUNCH_ENABLED=false` (app).
  Existing coins keep trading on Meteora; nothing on chain depends on our servers.
- Stop our transactions: set the three `_SEND` flags to `false`. Every send is recorded before it
  leaves, so a restart resumes instead of repeating.
