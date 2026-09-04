# Robinhood local acceptance environment

This profile exists so Robinhood Chain can be exercised without touching MemeWarzone production services.

## Hard boundary

Local acceptance uses:

- frontend: `http://127.0.0.1:5173`
- frontend API: `http://127.0.0.1:3001`
- realtime-indexer API: `http://127.0.0.1:3002`
- PostgreSQL: a dedicated loopback database whose name contains `robinhood` or `local`
- chain RPC: Robinhood Testnet `46630`

It does **not** use `api.memewar.zone`, `indexer.memewar.zone`, production Supabase storage, production Ably, production telemetry, BNB RPC workers, or Solana RPC workers.

The Robinhood testnet RPC is intentionally external: this profile isolates MemeWarzone application services and data, not the test chain itself.

## First-time setup

1. Copy `config/robinhood-local.env.example` to `config/robinhood.local`. The destination is ignored by git.
2. Set `DATABASE_URL` to a dedicated local PostgreSQL database, for example:

   `postgresql://postgres:<password>@127.0.0.1:5432/memewarzone_robinhood_local`

3. Set the Robinhood testnet RPC if you want a provider other than the public testnet endpoint.
4. Install dependencies in the root, `frontend`, and `realtime-indexer` workspaces as usual.
5. Bootstrap the local DB:

   `node frontend/scripts/prepare-robinhood-local-db.mjs`

The DB bootstrap creates the named database when possible, adds local compatibility roles used by the committed SQL migrations, then applies `db/migrations/*.sql` once in filename order. Applied filenames are recorded in `public._mwz_local_migrations`.

## Start the isolated stack

Run from the repository root:

`node frontend/scripts/dev-robinhood-local.mjs`

The runner refuses to reuse ports 5173/3001/3002. This is deliberate: an unknown process must never be mistaken for the intended local service.

Before spawning anything it:

- requires a loopback PostgreSQL URL;
- requires a dedicated local/Robinhood DB name;
- forces every frontend/backend API base to loopback;
- clears BNB and Solana RPC worker variables;
- disables Topaz and graduation reconciler workers;
- disables Ably;
- disables remote Supabase storage and enables data-URL logo uploads;
- disables telemetry;
- selects Robinhood Testnet `46630` in the frontend only through the local allow-list.

The frontend knows Robinhood mainnet/testnet as supported EVM networks, but the normal default allow-list remains BNB + BNB Testnet + Solana. Robinhood therefore remains hidden unless a runtime explicitly opts it in.

## Current readiness boundary

This commit prepares and isolates the local service topology. It intentionally does **not** repoint the existing production BNB/Solana indexer scanner to `46630`.

Until the dedicated RH-8 local scanner is added, port 3002 runs the local indexer/API process with BNB/Solana RPCs disabled. That lets us prove frontend/API/DB isolation now without pretending Robinhood trade indexing is already complete.

Full local acceptance is green only when all of these are available together:

1. Robinhood test factory + V3 graduation adapter/locker deployed on testnet.
2. Factory address/start block written to `config/robinhood.local`.
3. Robinhood bonding trade scanner writes chain `46630` rows to the local DB.
4. Robinhood V3 pool scanner writes post-grad swaps to the local DB.
5. Unified local market endpoints return continuous bonding + post-grad history.
6. Create, scheduled create, buy, sell, auto-graduate, post-grad buy/sell, LP fee harvest, rewards, and recovery paths pass against the local stack.

## CI isolation proof

`node scripts/check-robinhood-local-isolation.mjs`

The proof deliberately starts with fake production API/indexer/Supabase/Ably/RPC values and verifies the local environment builder removes or replaces them. It also proves remote/shared databases are rejected.

## Relationship to project plans

This profile implements the permanent environment separation required by the Robinhood build plan: `local`, `staging`, and `production` are separate runtime classes, and test data must never contaminate production. It follows the existing Local Hybrid Setup's localhost workflow while deliberately tightening it for Robinhood acceptance by making API, indexer, and PostgreSQL local rather than relying on deployed services.
