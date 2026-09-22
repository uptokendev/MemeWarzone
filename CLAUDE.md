# MemeWarzone — working agreement

Carried over from `docs/build_plans/handoff-2026-09-22-solana-devnet-step1.md` (2026-09-22).
Everything below is verified fact unless marked **open**. Read the rules before touching anything.

## 1. Non-negotiable rules (from the founder, still in force)

- **Do not change unrelated logic.** "Constantly check yourself you don't change any other logic."
- **Facts over theories.** Diff against the last known-good commit/tx before theorizing about a cause.
- **Every Solana transaction is proven on a local validator before any program upgrade.** No exceptions.
- **Deployer `9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H` must never hold user money.** Protocol wallet stays capped; the rest goes to multisig `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv`.
- **Mainnet treasury `solana program extend` / buffer / Squads upgrade is ON HOLD** — "No go, we need to fix everything first." Do not run it.
- **Never send devnet transactions with founder keys without saying so first. Never touch mainnet.**
- **Auto-mode classifier blocks production DB writes, auth-row copies and permission grants.** Hand the founder the SQL to run in the Supabase SQL editor instead of running it.
- **Each step after step 1 needs an explicit founder go.** Don't roll forward on your own.

## 2. Environments

Never mix targets. The dashboard and all expansion work run on the TEST stack until the port at the end.

| | TEST (current work) | LIVE |
|---|---|---|
| API | `https://jkq5rjveklrueuuuputnpj6o.178.104.232.231.sslip.io` (Nixpacks from `frontend/`, `npm start`) | `api.memewar.zone` |
| Indexer | `https://s75mnp6dfpjtv8m8fcefxlay.178.104.232.231.sslip.io` | `indexer.memewar.zone` |
| Supabase | STAGING `vrnsbguutnwgtekcexls` — `STAGING_DATABASE_URL` in `frontend/.env.local`, session pooler :5432 | PRODUCTION `ellkfgoxnzykxqybajtn` — `DATABASE_URL` in `frontend/.env` |

- Node `pg` against the pooler needs `PG_SSL_ALLOW_SELF_SIGNED=1`.
- Work branch: `build/robinhood-full-expansion` (head `6e7ae665`, all pushed). Live frontend branch: `build/cross-chain-stabilization-rh-base` — pushes to it auto-deploy.
- League-root cron stays **off** on live until the port bundle `database/prod_apply_arena_schema_catchup.sh` is applied.
- `uptokendev/web-dashboard` (main) currently points at the TEST API + staging auth for the duration of the expansion.
- **Test API is at head `6e7ae665`** (verified 2026-09-22 via `GET /health` → `sourceCommit`), on staging `vrnsbguutnwgtekcexls`. No redeploy needed.
- **The indexer is NOT: it runs `0556d983`, 7 commits behind, and `solanaMarketStats.ts` does not exist in that commit.** Chain-101 `market_stats` is therefore frozen (5 rows, written once by a local run) while chain 46630 refreshes every ~4s. **Redeploying the indexer service to `6e7ae665` is the blocker for any chain-101 battle scoring.**
- Arena routes are mounted at `/api/arena/...` (see `frontend/api/server.mjs:415`), **not** `/api/postgrad/...`.

## 3. Done on this branch

- **Quote Asset Catalog admin** — dashboard page Graduation Markets, admin API `frontend/api/admin/quoteAssetCatalog.js`, automated verifier `frontend/api/lib/quoteAssetVerification.js` + `frontend/scripts/verify-quote-catalog.mjs` (Coolify scheduled task, `--chain all`), per-deployment policies, devnet cluster rows.
- **Solana per-campaign quote binding** (drafts + Direct Deploy) — `frontend/api/lib/solanaCampaignGraduationQuote.js`, `campaign_graduation_quote_bindings`, keeper dispatch native vs quote handoff.
- **Solana "accept all binding tokens", software half** — `frontend/api/dev-fix/solana-graduation-authorization-v2.js` maps every asset/provider class to the 5 on-chain quote profiles; gate env `SOLANA_GRADUATION_ALLOWED_QUOTE_PROFILES`. Token-2022 quotes still need a program change.
- **Solana battle data plane** — `realtime-indexer/src/solanaMarketStats.ts` writes `public.market_stats` for chain 101 so `getArenaMarketSnapshot(101, …)` scores through the shared authority (verified healthy for all 5 staging campaigns). Beat the Market opened to chain 101 (migration `20260921_000011`).

## 4. Step 1 — devnet operations (accepted: "start 1")

State as of 2026-09-22: (a) flags verified — mostly already on; (b) `scripts/solana/init-arena-devnet.mjs` written and dry-run proven; (c) settlement path found and the `resolve-due` scheduler built. **Nothing has been sent on-chain: no `--execute`, no `--send`.**

Goal: battle flags on the test API → `arena_config` initialized and unpaused on devnet → a scheduler that resolves settled battles on-chain → one end-to-end devnet battle, SOL-quoted vs USDC-quoted token.

### Verified devnet facts
RPC `https://api.devnet.solana.com`, genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.

- Rewards treasury program `2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX` **is** deployed on devnet (upgradeable loader).
- `rewards_config` PDA `FHtimMcBY5Wn8KC3abxMh6NvzDfSu2LHY6HZFUDTkRmt` exists; authority `HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9` = the devnet deployer in `~/.config/memewarzone/solana-devnet/public-ids.txt`. The keypair file for `HuKfoF…` lives under `~/.config/memewarzone/solana-devnet/` — check the filename before use.
- In that same file: launchpad program `3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt`, route_signer `7hKQd798Z1ERmRUhm7shmstB1V13FQNnDLqtYjZBuJUz`.
- `route_state` `9yQvY5MenirGSgrYEBKyU9Rpjc36773eMTmsKP2UtrzE`, `protocol_vault` `BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que`, `monthly_league_vault` `68FNNeXDMAU8XaJsNYL4VFY2YnprnE36LCncCm8uRyJg` all exist.
- `arena_config` PDA `95NfXZY5woMg9GDKM8NeMz3wppuwQMCZ5xFxGVX2R9iJ` is **MISSING** → `initialize_arena(resolver, protocol_receiver, mwl_receiver)` must run, authority-signed.
- `arena_money_config_v2` `Bio7bTMDLo1rYhKbR26jW98N4YvdeQW3UzUw4cHEv8xX` already exists (139 bytes).
- Devnet USDC: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

### Tooling notes
- `scripts/solana/init-arena-mainnet.mjs` — dry-run by default, `--execute` sends. Env: `SOLANA_RPC_URL`, `SOLANA_TREASURY_AUTHORITY_KEYPAIR` (must equal the rewards_config authority), `ARENA_RESOLVER`, `ARENA_PROTOCOL_RECEIVER`, `ARENA_MWL_RECEIVER`, `ARENA_MARKETING_RECEIVER`, `ROUTE_OVERFLOW_TREASURY`. **`ROUTE_OVERFLOW_TREASURY` defaults to the MAINNET multisig `fk5Y…`** — pass a devnet value explicitly or the script calls `set_route_params` on devnet with a mainnet address. It **pauses** war pool v1 at the end and has no unpause; `set_arena_pause(false)` via `SetArenaConfig{authority, rewardsConfig, arenaConfig}` is needed afterwards. Uses `tests/solana/node_modules/@coral-xyz/anchor` and `target/idl/mwz_rewards_treasury.json`.
- Layout/parsers: `frontend/src/lib/solanaArenaLayout.mjs` (`ARENA_CONFIG_SEED`, `parseArenaConfig`, `validateCanonicalArenaConfig`, genesis table `SOLANA_GENESIS`); `frontend/api/lib/solanaArenaPoolRead.js` `probeCanonicalArenaLive` returns `{live:false, reason:"paused"}` while `depositsPaused`.
- Operator CLI `scripts/solana/arena-operator-worker.mjs` — commands `resolve --battle-id`, `resolve-tournament --tournament-id`, `claim-protocol`, `claim-mwl`, and now `resolve-due`; flag `--send`; keys `ARENA_RESOLVER_KEYPAIR`, `ARENA_OPERATOR_PAYER_KEYPAIR`. Imports `../../frontend/src/lib/solanaArenaLayout.mjs`, `../../frontend/api/lib/arenaTournamentPlaces.js`, `./arena-operator-resolve.mjs`, `./arena-operator-v0.mjs`, `./send-server-v0.mjs`; 5 tests in `scripts/solana/*.test.mjs`. The API image is built from `frontend/` only, so a scheduler must either relocate these modules under `frontend/` (keeping the tests) or run as a separate Coolify service from the repo root.
- **Answered (was open): nothing bridged DB settlement to the on-chain resolver.** The path is
  `frontend/scripts/run-arena-battle-realtime-worker.mjs` → `settleDueNormalBattles`
  (`arenaBattleSettlementRuntime.js`) → `arenaBattleSettlementV2Service.js` /
  `V3Service.js`. Those two services contain **zero** references to solana or a resolver: settlement
  scores the battle, writes the winner and flips `state` to `'finished'` in Postgres, and the arena
  pool on chain stays LIVE until someone runs the operator by hand. That gap is what `resolve-due`
  (below) closes.

### Flags — verified against the code and the live test API (2026-09-22)

**Route gating is already open on the test API.** Every arena route returns 200 with no
`featureFlag`/`disabled` marker, so the `POSTGRAD_*` list below is already satisfied — most
likely via the master switch. Do not re-send that list as if it were missing.

`frontend/api/lib/postgradFlags.js` resolves a route flag as: explicit falsy wins → explicit
truthy wins → else `POSTGRAD_API_ENABLED=true` opens everything → else
`VITE_ENABLE_POSTGRAD` + `VITE_ENABLE_POSTGRAD_ARENA` both truthy opens everything.

Corrections to the names the earlier handoff listed:
- `ARENA_OPS_ENABLED` **does not exist** — the real name is `POSTGRAD_ARENA_OPS_ENABLED`.
- War Room's canonical flag is `WAR_ROOM_ENABLED`; `POSTGRAD_WAR_ROOM_ENABLED` is only a `legacyFlag` fallback.
- `POSTGRAD_ARENA_VOTES_ENABLED` is declared in `.env.example` but **read nowhere** — a dead flag. Setting it does nothing. `/arena/votes` is gated by `POSTGRAD_BATTLES_ENABLED`.
- Topaz env is `VITE_TOPAZ_ROUTER_ADDRESS_56` / `VITE_TOPAZ_FACTORY_ADDRESS_56` / `VITE_TOPAZ_WBNB_ADDRESS_56` (grep-verified; the handoff's shorthand was abbreviated).

**Route flags** (permissive — covered by the master switch): `POSTGRAD_ARENA_OPS_ENABLED`,
`POSTGRAD_BATTLES_ENABLED`, `POSTGRAD_EVENTS_ENABLED`, `POSTGRAD_LEAGUE_ENABLED`,
`POSTGRAD_WAR_POOLS_ENABLED`, `POSTGRAD_SPONSORSHIPS_ENABLED`, `POSTGRAD_ARENA_IMPORTS_ENABLED`,
`WAR_ROOM_ENABLED`.

**Behavioural flags are strict and still matter.** `frontend/api/lib/arenaFeatureFlags.js` uses its
own `readFlag`, which reads *only* the literal env var — the master switch does **not** turn these
on. All 8 names confirmed exact: `ARENA_BATTLE_POINTS_V3`, `ARENA_BATTLE_BOOSTS`,
`ARENA_VOTE_TOURNAMENTS`, `ARENA_FINAL_SALVO`, `ARENA_POOL_V2`, `ARENA_SPONSORSHIP_V1`,
`ARENA_SPONSORSHIP_PRICING`, `ARENA_POSTGRAD_LEAGUE_V2`.
Note `ARENA_BATTLE_BOOSTS` is used *both* as a route flag (permissive) and a behavioural flag
(strict), so the boosts route can be open while the behaviour stays off.

**Solana env still to confirm on the test API:** `SOLANA_GRADUATION_ALLOWED_QUOTE_PROFILES=NATIVE,STABLECOIN,COMMUNITY,PROVIDER_RWA`,
`SOLANA_CLUSTER=devnet` (exactly — aliases rejected), `SOLANA_CLUSTER_HASH_HEX` (required by
`solana-direct-create.js` / `solana-create-authorization-v4.js`), `DIAGNOSTICS_TOKEN`,
`X_OAUTH_REDIRECT_URI`, plus the three chain-56 Topaz vars above.

### Built 2026-09-22 (nothing sent on-chain)

- **`scripts/solana/init-arena-devnet.mjs`** — the devnet sibling of the mainnet init. Differs in
  the three places that matter: it decides the cluster from the **genesis hash the RPC reports**
  (refuses mainnet and testnet, proven), it leaves war pool v1 **unpaused**, and it **never touches
  `route_state`** (the mainnet script would have pointed devnet's overflow at the mainnet multisig).
  Dry-run verified: `initialize_arena` simulates ok at 13441 CU → `95NfXZY5…R9iJ`, money-v2 already
  exists and is skipped, signer is `HuKfoF…` from `deployer.json`, deployer holds 9.95 SOL vs
  ~0.0014 SOL rent. `initialize_arena` is born unpaused, so **no separate unpause step is needed**.
- **`scripts/solana/arena-operator-scan.mjs` + `.test.mjs`** — pure, injectable selection and loop
  logic for `resolve-due` (9 tests). Terminal vs retryable outcomes: an already-resolved pool is
  never re-read; a blocked one is retried next pass; a dry run never marks anything terminal.
- **`resolve-due` command** on the operator worker — `[--watch] [--interval-ms] [--lookback-days]
  [--limit]`, one shared pg pool, passes never overlap, SIGINT finishes the current pass. Verified
  against staging: single pass and a 3-pass watch both clean (0 due — no chain-101 battles exist yet).
- **Fixed: both genesis constants in `frontend/src/lib/solanaArenaLayout.mjs` were wrong.** devnet
  read `…wavy2uVvL2jH` and mainnet `…KvcnbdEad4t`; the chain reports `…wcaWoxPkrZBG` and
  `…Kuc147dw2N9d`, and five other repo files already carried the correct values. The table's own
  test compared it against itself, so the typos passed. The literals are now pinned.
- **`pg` declared in the root `package.json`** — it existed only in `frontend/node_modules`, so the
  pre-existing `resolve`/`claim` commands would also have failed from a repo-root checkout.
  Required for the chosen deployment (below).

### Executed on devnet 2026-09-22 (founder go)

- **Indexer redeployed to `6e7ae665`.** Chain-101 `market_stats` now refreshes on a ~60s cycle for
  all 5 staging campaigns (was frozen). The Solana battle data plane is live.
  - Open: indexer `/health` reports `solana.lastError: "Solana RPC getGenesisHash HTTP 403"`. Market
    stats refresh regardless, so it is not blocking, but the Solana RPC endpoint is rejecting that
    call — likely a rate-limited public endpoint that wants a keyed RPC.
- **`arena_config` created on devnet.** `init-arena-devnet.mjs --execute`, signature
  `3XXbbgSHbGcUsQSaTvJ6H5MtSiQLsstvgXFRk8UafpkpmufuPJrfqhnkP8MUoLvrPWUPDqEjzpWUftPvGsE8SV8C`,
  slot 502371372, `err: null`, fee 5000 lamports. Independently verified on chain: account
  `95NfXZY5…R9iJ` exists, 139 bytes, owned by `2Nzth…ZBKX`; version 2, authority and resolver
  `HuKfoF…`, protocol receiver `BvQHb…2que`, MWL receiver `68FNN…uRyJg`, `depositsPaused: false`.
  Deployer spent 0.00136136 SOL, exactly the predicted rent + fee. Money-v2 was already present and
  was skipped; no unpause step was needed. `route_state` untouched.
- **Fixed: `probeCanonicalArenaLive` could never return live.** With the arena healthy on chain the
  app still read it as dead. `frontend/api/lib/solanaArenaPoolRead.js` called
  `validateCanonicalArenaConfig` without `environment`/`cluster`, so it could not resolve a genesis
  hash and returned `authority-mismatch` — which reads like a key problem and never was one. The
  probe now resolves the pair through `arenaEnvironmentIdentity` (the one place that knows
  staging↔devnet and production↔mainnet-beta belong together) and reports `cluster-unconfigured`
  when the cluster env is absent. Verified: `SOLANA_CLUSTER=devnet` → `live: true`; unset →
  `cluster-unconfigured`; `mainnet-beta` against a devnet RPC → `cluster-mismatch`. 5 regression
  tests in `solanaArenaPoolRead.test.mjs`. Both callers only read `.live`, so the new reason string
  is safe.

**This fix is not deployed.** The test API runs `6e7ae665`, which still has the broken probe, so it
needs a redeploy **and** `SOLANA_CLUSTER=devnet` in its env — both are required; either alone leaves
the arena reading as not-live.

### Deployment decision (founder, 2026-09-22)

`resolve-due` runs as **a new Coolify resource whose base directory is the repo root** — not folded
into the API image, which is built from `frontend/` only and cannot import `scripts/`. This was
chosen over relocating the operator modules so the on-chain money code and its tests stay put.
Needs: `DATABASE_URL`, `SOLANA_RPC_URL`, `ARENA_RESOLVER_KEYPAIR`, `ARENA_OPERATOR_PAYER_KEYPAIR`,
`PG_SSL_ALLOW_SELF_SIGNED=1`.

### Suggested order (remaining)
1. Commit + push this branch, redeploy the **test API**, and set `SOLANA_CLUSTER=devnet` on it, so
   the probe fix takes effect and the arena reads live to the app.
2. Stand up the `resolve-due` Coolify resource (repo-root base dir), dry-run without `--send` first.
3. E2E devnet battle, SOL-quoted vs USDC-quoted — needs a USDC-bound devnet graduation via the Orca
   devnet route (devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).

## 4b. Program changes — done and proven on a local validator (2026-09-22)

Both program changes are committed, built to SBF and proven. **Neither is deployed
anywhere**: no devnet upgrade, no mainnet (that remains ON HOLD).

- **Launchpad accepts Token-2022 quote assets.** `programs/memewarzone_solana/src/graduation.rs`.
  The quote side takes either token program; the launch token is minted by this program and stays
  classic SPL, so the staging account, the Meteora launch vault and the creator account are
  untouched. Which program owns the quote is read off the mint — the route signer already
  authorizes `quote_mint` in the digest, so `GRADUATION_AUTH_SCHEMA_VERSION` stays 4 and the
  signing contract is unchanged. Extensions are an **allowlist** (metadata, grouping,
  ImmutableOwner); transfer fees, transfer hooks, permanent delegates and confidential transfers
  are refused with `UnsupportedQuoteTokenExtension` (IDL error 6074). A classic-SPL graduation
  keeps its exact account list; a Token-2022 quote appends its program after the 3-account prefix.
- **Competition V2 is 75/20/5 on Solana.** `ARENA_MWL_BPS` 1000 → 2000, taken from
  `ArenaWarPoolTreasuryV2.ENTRY_LEAGUE_BPS` so Solana and EVM agree by construction. The signed
  resolution message binds totals and outcome, never the split, so no pending authorization broke.
  Note the raised factor halves the `split_arena_prize` overflow ceiling (~18.4M → ~9.2M SOL); it
  fails closed with `MathOverflow` and a test pins that boundary.
- **App alignment:** `isCompetitionV2Chain` in `frontend/api/arenaWarPools.js`. `warPoolGeneration`
  only recognises an EVM treasury address, so chain 101 fell through to the V1 branch and the UI
  would have quoted 85/5/10 while the program paid 75/20/5.

### The gate was passing while graduation skipped

`tests/solana/v4-lifecycle-acceptance.cjs` has always held "Gate K: graduate closed campaign into
pinned DAMM v2 and swap", and it calls `this.skip()` when the Meteora program is not executable on
the validator. `run-local-sbf-gate.sh` never loaded Meteora, so that test reported **pending** on
every run and the gate printed GATE PASS anyway. It now loads the pinned DAMM v2 binary plus its
account fixtures (fetching them if absent) and **fails if that test reports pending**.

With Meteora loaded the proof actually runs — verified 2026-09-22 against the modified program:
create 10 passing, lifecycle 4 passing including a real graduation into a pool plus a swap,
`sha256=9ee52111ccd5e9f22f32cd6314e864405388f22490efece264129b921b04cb4a` (stable across runs; the
`cfg(test)` additions do not change the artifact). 106 launchpad unit tests, 22 treasury.

`solana-local-validator-ci.yml` now calls that same script instead of keeping its own validator
choreography that only ran the create suite, and triggers on PRs into `main` too. The treasury has
its own path: `solana-rewards-treasury-upgrade-candidate.yml` runs `cargo test -p
mwz_rewards_treasury --lib`, builds the SBF and records candidate hashes.

Run it locally with:
`ANCHOR_WALLET=<keypair> bash scripts/solana/run-local-sbf-gate.sh`

### Binding tokens: allow the full list, warn the creator (2026-09-22)

Which asset a campaign graduates against is the **creator's** decision, so the
extension allowlist is no longer a gate. Refusing removed the asset from the
list rather than explaining the trade-off, and a refusal reached at graduation
would strand a campaign that had already closed.

- **Program** accepts any mint owned by either token program and reads only the
  base layout. That also removed an accidental cliff: `spl-token-2022` 3.0.5
  cannot *enumerate* extensions it postdates (ScaledUiAmount, Pausable — both on
  every xStock) while unpacking the base mint still succeeds. Enumerating would
  have refused those assets purely for being newer than the dependency. **No
  dependency upgrade needed.**
- **Catalog** returns `metrics.bindingRisks` — one entry per issuer power with
  `code`, `armed`, `severity`, `title`, `detail`, for the "Are you sure?" dialog.
  `armed` is real: on live NVDAx the permanent delegate, pausable and
  transfer-hook authorities are all set; no transfer fee is charged. Freeze
  authority is reported too, noting USDC has one as well.
- **`quote_extension_allowed` stays** as a classification the catalog reads.

**The check runs once, at graduation, and the pool is then locked forever.** An
authority armed afterwards cannot be caught — the dialog copy must say so.

### LP fee economics survive a Token-2022 binding

Proven on a validator: a swap against a Token-2022 quote accrues an LP fee and
claiming pays the position **in full — owed 181818182, claimed 181818182,
nothing skimmed**. A permanently locked position accrues and pays identically to
an unlocked one, so the lock is not what would break it. The xStocks charge no
transfer fee, the one extension that would have skimmed the creator/protocol cut.

### Devnet state (both programs upgraded and byte-verified)

| | sha256 | bytes | slot |
|---|---|---|---|
| Launchpad `3JSGNiFst…` | `e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2` | 1218568 | 502512217+ |
| Treasury `2Nzth…` | `5638c9923d2a3025197243ab6f62e565c832b6fa69d3ce4265abecc90594cdfc` | 1276472 | 502458587 |

IDL sha256 `6ad692989c7445ff079aecf185b23ebf54ceb2bfe21f3e9df06802c6b40b8a16`.
`SOLANA_LAUNCHPAD_PROGRAM_SHA256` / `_IDL_SHA256` / `_PROGRAM_BYTES` must move
with any upgrade — the create and trade authorization paths read them, and
`network-canary.mjs` pins the same program hash.

Gate (`bash scripts/solana/run-local-sbf-gate.sh`): create 10, lifecycle 4
(incl. graduation into pinned DAMM v2), Token-2022 5. Fails if any reports
pending. Treasury gate: 11.

Mainnet runbook with the Squads ceremony: `docs/solana-mainnet-squads-upgrade-runbook.md`.

### The bound graduation runs end to end (2026-09-22)

Gate B in `v4-lifecycle-acceptance.cjs` drives a campaign from a closed curve to
a bound Token-2022 pool in the production transaction shape: Ed25519,
begin_graduation, the Orca acquisition that turns raised SOL into the quote,
Meteora creating the MEME/quote pool, then confirm_graduation with the
Token-2022 program appended to the quote prefix. Campaign ends `graduated:true`
and the pool's quote vault is owned by Token-2022.

The main gate now loads four programs — launchpad, Metaplex, Meteora, Orca —
cloning the Orca program and its config/fee-tier accounts on demand like the
Meteora fixtures. Gate: create 10, lifecycle 5 (native **and** bound),
Token-2022 5.

**Two bytes of headroom.** The bound envelope is 1230 bytes against a 1232 hard
limit, and the program requires the acquisition before Meteora in the *same*
transaction, so it cannot be split. It only fits because the swap's account
setup is sent separately and only the Orca instruction is packed. Anything that
adds an account to that transaction breaks it.

Other things only running it revealed: the fee escrow must be flushed before
`begin_graduation`; the acquisition pool price must agree with the binding's
declared oracle and quote reference (a 33% disagreement against a 1.5% cap
rejects the pool the graduation just built); the Meteora initial price is whole
units per whole token, not a raw ratio; and `sendCreate` needed a label because
the campaign id seeds every campaign PDA.

### Still open

- **The binding confirmation dialog is not built.** `metrics.bindingRisks` is
  returned and tested; nothing renders it. Until it does, a creator can bind to
  an asset whose issuer can claw back, pause or freeze the locked pool without
  being told.
- **Orphaned devnet buffer** `HbmmrEjPJL7hvrk7DJrvwFSqqFoNz9yiyzoFxAmEzZZv`
  holds 7.55857772 SOL on the devnet deployer. Predates this work.

## 5. After step 1 (founder go required for each)

2. Local-validator graduation harness → Token-2022 program change in `programs/memewarzone_solana/src/graduation.rs`, with proofs, then devnet upgrade via `scripts/solana/upgrade-devnet-launchpad.cjs`.
3. Arena competition V2 (75/20/5) program change in `programs/mwz_rewards_treasury/src/arena.rs`.

Then: Robinhood (step 2 of the earlier plan) and BNB (step 3) fully ready → production port bundle → merge the expansion branch into the live branch → dashboard back to production.

## 6. Known loose ends

- Chart panel / WarRoom / Imported trade panels still assume WSOL.
- `market_trades_v` labels Solana `dex_trades` as TOPAZ.
- No Solana arena e2e test — the vote-battle one runs on chain 97.
- Untracked and expected: `database/staging_rls_grants_fix.sql`, `frontend/.mwz-feed-isolation-*/` (scratch dirs, safe to delete), the handoff file itself.

## 7. Memory files to trust

`solana-expansion-state.md`, `quote-catalog-verification.md`, `testnet-quote-token-facts.md`, `test-environment-workflow.md`, `solana-upgrade-runbook.md`.
