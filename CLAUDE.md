# MemeWarzone — working agreement

Carried over from `docs/build_plans/handoff-2026-09-22-solana-devnet-step1.md` (2026-09-22).
Everything below is verified fact unless marked **open**. Read the rules before touching anything.

## 1. Non-negotiable rules (from the founder, still in force)

- **Do not change unrelated logic.** "Constantly check yourself you don't change any other logic."
- **Facts over theories.** Diff against the last known-good commit/tx before theorizing about a cause.
- **Every Solana transaction is proven on a local validator before any program upgrade.** No exceptions.
- **Never change the CREATE / BUY / SELL transaction setup or flow.** Every transaction path runs the same way as those three. **Graduation is the only exception** — it is a different path by design and is measured on its own. The create/buy/sell shape was built to stop Phantom flagging us (fee router, account layout, writable count, one ALT, one signer), so a change there is not a refactor, it is a relapse. It is pinned in `tests/solana/v0-launchpad-onchain.cjs`: CREATE 844 bytes / 2 ix / 1 table / 17 accounts, 9 writable; BUY 764 bytes / 2 ix / 1 table / 14 accounts, 7 writable. If a change makes those assertions fail, the change is wrong — do not repin them to make the gate pass.
- **Deployer `9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H` must never hold user money.** Protocol wallet stays capped; the rest goes to multisig `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv`.
- **No Solana mainnet upgrade until BNB and Robinhood are ready.** One combined release: new launchpad contracts on BNB and Robinhood, both Solana programs upgraded, tested together, then live. Both Solana candidates are finished and staged; nothing goes up on its own. The treasury additionally needs `MWZ_TREASURY_RELEASE=1` to lift its own hold. See §5.
- **Contracts are written to pass a real audit on the first pass.** EVM contracts are immutable once deployed — there is no upgrade to fix a miss, so the audit happens before deployment, not after. Every change to a money path states its reentrancy guard, its checks-effects-interactions ordering, which states can and cannot reach it, what happens on over/underflow, and how it can be griefed. A new external function on a treasury is audited as a diff before it is tested, and tested before it is deployed. Write it so an external auditor finds nothing, not so it passes our tests.
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
| Treasury `2Nzth…` | devnet runs `5638c992…` (1276472); the **candidate is now `1028f6f8a52037f1aea8ab2e6ae86f9e2c1224eed7e1e7b71675cdfca2508a95`, 1306640 bytes** | | 502458587 |

IDL sha256 `6ad692989c7445ff079aecf185b23ebf54ceb2bfe21f3e9df06802c6b40b8a16`.
**The certified binary is named in exactly one place:**
`config/solana/launchpad-binary.certification.json`. `network-canary.mjs`, its
shell wrapper and the CI workflow all default from it. They each held their own
literal until 2026-09-22, and two stayed on `27ad65b5…`/1165328 after the devnet
upgrade, so `solana-network-canary.yml` was failing against the runner's own pin
with a binary that was in fact the deployed one. Change the file, not the copies.

`SOLANA_LAUNCHPAD_PROGRAM_SHA256` / `_IDL_SHA256` go on the API and must move
with any upgrade. Know what they are: `hashEnv` checks presence and 64-hex form
(missing → 503, **wrong → accepted**), neither is compared against the chain,
neither enters the signed digest, and both are attached to every create
authorization as `auditMetadata`. A stale hash breaks the audit trail, not
create/buy/sell. Only `SOLANA_GENERATION_MANIFEST_HASH` is checked on-chain.
`_PROGRAM_BYTES` is canary-only and is **not** read by the API.

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

**54 bytes of headroom, measured.** The bound envelope sends 1178 bytes against
a 1232 hard limit, and Gate B prints a byte budget every run. An earlier 1230
reading was the test packing ATA creates the production operator already sends
separately; splitting them recovered 52 bytes. The program requires the
acquisition before Meteora in the *same* transaction, so it cannot be split
further. Levers if a longer route eats the margin: payouts to a claim model
saves 14B, and `begin_graduation` carries 128B of pubkeys naming accounts the
transaction already has (a v4→v5 digest schema change).

Other things only running it revealed: the fee escrow must be flushed before
`begin_graduation`; the acquisition pool price must agree with the binding's
declared oracle and quote reference (a 33% disagreement against a 1.5% cap
rejects the pool the graduation just built); the Meteora initial price is whole
units per whole token, not a raw ratio; and `sendCreate` needed a label because
the campaign id seeds every campaign PDA.

### The binding confirmation dialog (2026-09-22)

The risk of binding to a non-SOL quote is the creator's to take, so the product
moves it to them explicitly instead of the program refusing assets.

- `quote_asset_deployments.verification` is now read by the creator-facing
  catalog: `GENERIC_SELECT` selects `d.verification` and `mapGenericRow` maps
  `metrics.bindingRisks` onto every asset as `bindingRisks`. Both the list and
  the detail path go through it, and `decorateQuoteAsset` spreads it through.
  The snapshot is read back, never recomputed — the scan is what the gate saw.
- `frontend/src/lib/graduationBindingRisks.mjs` merges those issuer powers with
  three structural risks true of any non-native binding (liquidity locked
  forever, price follows the quote, checked once at graduation), so an unscanned
  quote never yields an empty dialog. A power that exists but is **not armed** is
  demoted to `info` — a permanent delegate with nobody set is not a delegate
  that is set, and flattening the two makes every Token-2022 asset look equally
  dangerous.
- `GraduationMarketStep` routes every card through `requestSelect`. Native goes
  straight through; anything else opens `BindingRiskDialog` and the selection is
  only committed on confirm, remembered per asset for the session. The auto-select
  on load now picks **only** a native quote — a non-native default would be a
  binding nobody agreed to, and with nothing selected `canGoNext(5)` already
  blocks Next with a clear toast.

Tests: `npm run test:graduation-market` (42) covers the risk merge, the severity
demotion, the headline and the catalog mapping, plus a guard that
`GENERIC_SELECT` still carries `d.verification` — drop that column and every
asset silently reports no issuer powers.

### The mainnet upgrade, end to end (2026-09-23)

**Nothing is upgraded until BNB and Robinhood are ready.** Founder decision
2026-09-23: the new launchpad contracts and the battle system go out as one
release — BNB and Robinhood deployed, both Solana programs upgraded, then tested
together and put live. Both Solana candidates are finished and staged; they wait.

Both are certified by their gates and byte-verified on devnet:

| | Program | Candidate sha256 | Bytes | Allocation |
|---|---|---|---|---|
| Launchpad | `3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt` | `e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2` | 1218568 | 1310936 — **fits** |
| Treasury | `2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX` | `1028f6f8a52037f1aea8ab2e6ae86f9e2c1224eed7e1e7b71675cdfca2508a95` | 1306640 | 660016 — **must extend 646624 B first** |

#### The half we do, and the half Squads does

The multisig `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv` owns both programs, so
only it can execute the upgrade. Everything before that — uploading the binary
into a buffer, extending an allocation — is permissionless and paid by the
deployer. We do that half and hand over four values.

```
bash scripts/solana/prepare-mainnet-squads-buffer.sh launchpad                    # reads only
MWZ_STAGE_SEND=1 bash scripts/solana/prepare-mainnet-squads-buffer.sh launchpad   # sends
```

It verifies the .so against the certified sha, checks the allocation can hold
it, uploads, dumps the buffer and byte-verifies it, transfers buffer authority
to the multisig, then prints the Squads proposal values. For the treasury add
`MWZ_TREASURY_RELEASE=1`, and run `solana program extend` first.

**It does nothing without `MWZ_STAGE_SEND=1`.** Every other check is free and
the upload is not: once buffer authority moves to the multisig the rent is
recoverable only by the multisig, so an accidental run costs a Squads
transaction to undo. That guard exists because the script was run without it on
2026-09-23 and staged the launchpad buffer for real.

**The mainnet RPC is already in the build** — `SOLANA_RPC_URL` in
`frontend/.env.local`, a paid Helius mainnet endpoint. The script prefers an
explicit `SOLANA_MAINNET_RPC_URL` and otherwise reads that one, then asks the
chain for its genesis hash and refuses anything that is not mainnet-beta. A URL
cannot be trusted to say which cluster it is, and that file is the staging env.

The proposal is a `BPFLoaderUpgradeable::Upgrade` with four fields — program,
buffer, spill (the deployer, which receives the reclaimed rent), authority (the
multisig). **The buffer address is the entire payload; everything else is
fixed.** Confirm with signers that it is the address whose hash was verified.

#### What the script refuses, and why each one cost something to learn

- **No `SOLANA_MAINNET_RPC_URL`** → stops. No Solana mainnet RPC is in any local
  env file; the paid endpoint is supplied at run time.
- **The public `api.mainnet-beta.solana.com`** → refused. A 1.2MB binary is
  several hundred write transactions and the public endpoint drops enough to
  abort the deploy with the rent already spent. On devnet that stranded 6.49 SOL
  in a buffer whose only handle was a seed phrase printed once.
- **A candidate whose sha does not match** → stops. The tree is then not what
  the gate certified.
- **An allocation smaller than the binary** → stops, naming the extend. An
  upgrade into an allocation that cannot hold the binary fails *on execution*,
  which is the worst place to discover it.
- **`treasury` without `MWZ_TREASURY_RELEASE=1`** → refused while held.

Buffer keypairs are **generated ahead of time and named**, so the address is
known before a lamport is spent, an aborted upload resumes into the same
account, and the rent is always recoverable with
`solana program close <BUFFER> --recipient <deployer>`.

| | Address / path | State |
|---|---|---|
| Launchpad buffer | `EdmGZHL5fNGQuT8b8wRz5JbT4uhUwHyptuoSoBjLkJbg` | **staged on mainnet 2026-09-23**, 6.19120428 SOL, bytes verified, authority `fk5YYWb…` |
| | `~/.config/memewarzone/mwz-launchpad-mainnet-buffer-e6ed7df3.json` | |
| Treasury buffer | `~/.config/memewarzone/mwz-treasury-mainnet-buffer-1028f6f8.json` | **not generated** — `solana-keygen new --no-bip39-passphrase -o <that path>` |

The launchpad buffer exists and is in the multisig's hands. The program itself
is untouched (`Last Deployed In Slot` still 448871337), so nothing has been
upgraded — the proposal simply has its payload waiting. Its 6.19120428 SOL
returns to the spill account when Squads executes, or the multisig can close the
buffer to reclaim it. **The deployer cannot close it; authority has moved.**

#### Money, and why the two cannot be staged together

| Item | SOL | Comes back? |
|---|---|---|
| Launchpad buffer | 6.19116364 | yes, to the spill account on execution |
| Treasury buffer | 6.63856940 | yes, same |
| Treasury extend top-up | 2.04369460 | **no — permanent rent** |

The launchpad buffer is already paid, so the deployer now holds **7.038237636**
against the treasury's 8.68226400 — **short 1.64402764**. The treasury therefore
cannot be staged until either Squads executes the launchpad upgrade (returning
6.19120428 to the spill account) or the deployer is topped up by ~1.7 SOL.

#### After the launchpad executes

One env var moves, on the API **and** the indexer, then redeploy both:

```
SOLANA_LAUNCHPAD_PROGRAM_SHA256=e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2
```

`SOLANA_LAUNCHPAD_IDL_SHA256` does **not** move: the candidate IDL is
byte-identical to what is deployed (`6ad69298…`), because the Token-2022 change
added no instruction, account or error. Clients need no regeneration.

Know what these are before treating a mismatch as an outage: `hashEnv` checks
presence and 64-hex form — missing is a 503, **wrong is accepted** — and the
values are attached to every create authorization as `auditMetadata`. Neither is
compared against the chain. A stale hash breaks the audit trail, not
create/buy/sell. Only `SOLANA_GENERATION_MANIFEST_HASH` is checked on-chain.
`_PROGRAM_BYTES` is canary-only and not read by the API.

#### After the treasury executes

The upgrade adds the arena instruction set but **creates no accounts**.
`arena_config` and `arena_money_config_v2` do not exist on mainnet, so until the
initializer runs the arena cannot take a lamport.

```
SOLANA_RPC_URL=<rpc> node scripts/solana/init-arena-mainnet.mjs --status   # keyless, sends nothing
SOLANA_RPC_URL=<rpc> SOLANA_TREASURY_AUTHORITY_KEYPAIR=<deployer> \
  node scripts/solana/init-arena-mainnet.mjs            # dry run
  ... --execute                                         # creates both configs, CLOSED
  ... --open --execute                                  # after the canary: unpauses both
```

Everything lands closed — war pool v1 paused as the last step, money v2 born
paused — so a half-finished run is inert. Opening is a separate deliberate act.
The script refuses any cluster but mainnet-beta by genesis hash, and is
rehearsed end to end against the candidate by
`scripts/solana/rehearse-mainnet-arena-init.sh`.

Verify after either upgrade: `Last Deployed In Slot` advanced, `Authority` is
still `fk5YYWb…`, and the deployed bytes equal the candidate followed by zeros.
`Data Length` stays at the allocation, not the binary size — expected, not a
failure. A plain `sha256sum` of a dump disagrees with a perfectly good buffer;
use `scripts/solana/program-upgrade-verify.cjs`.

Full runbook: `docs/solana-mainnet-squads-upgrade-runbook.md`.

### The treasury audit (2026-09-22)

Asked before spending rent: is the whole battle system actually ready? The gate
was green on **31 of 47** instructions and silent on the rest. Auditing the
silence found one real hole and several facts worth keeping.

- **Cancelled pools stranded their supporters' money.** `donate_support_v2` kept
  only an aggregate `support_total` and no per-donor receipt, so there was
  nothing to refund against and no `refund_support` to call. Fixed:
  `ArenaSupportReceipt` (accumulating, one per donor per pool) plus
  `refund_support_v2`. All refunds are **pull-claims** — the contributor signs
  and takes their own lamports; nothing is ever pushed, so a pool with hundreds
  of contributors costs nothing to unwind.
- **`cancel_pool_v2` is removed.** Founder rule: once a battle or tournament
  starts it runs to a winner. Deleting the instruction makes that structural
  rather than a promise about who holds the resolver key. The only way a pool
  ends without a winner is `settle_expired_pool` — no-show past the deposit
  deadline, or we missed our own resolve deadline — and it is permissionless, so
  nobody can hold the money by doing nothing.
- **Money V2 is born paused.** `initialize_arena_money_v2` sets `paused = true`.
  Standing the sponsorship rail up on mainnet takes no money until an explicit
  `set_arena_money_v2_pause(false)`. Same shape as `init-arena-mainnet.mjs`
  pausing war pool v1 with no unpause.
- **Nothing on the checklist was missing from the program.** Vote vs metrics,
  both tournament types and final-salvo tie-breaks need no on-chain support:
  `result_type` is only WINNER/NONE and the resolver signs an `outcome_hash`.
  Tournament place splits are resolver-supplied bps (distinct, non-zero, summing
  to 10000), so 60/30/10 can change without a program upgrade. Quarterly finals
  ride the league root and claim rail with period 2. Split parity with EVM is
  exact: `ENTRY_LEAGUE_BPS 2000 / ENTRY_PROTOCOL_BPS 500 / BOOST_PROTOCOL_BPS 1000`.
- **47 of 47 instructions now execute** against the compiled .so. Treasury gate
  14 tests, Rust 22.

**Static analysis could not answer "what is untested" here** — it lost to
dynamic dispatch three separate times (operator helpers building instructions
under computed names, table-driven `program.methods[row.claim]`, and
continuation-line calls). Count coverage by tokenising the whole test file,
including string literals, or by watching execution. Do not trust a grep.

### Still open

- **Orphaned devnet buffer** `HbmmrEjPJL7hvrk7DJrvwFSqqFoNz9yiyzoFxAmEzZZv`
  holds 7.55857772 SOL on the devnet deployer. Predates this work.

## 4c. BNB and Robinhood contracts — audit before deployment (2026-09-23)

Mandate: BNB and Robinhood behave exactly as Solana, EVM-adapted. Contracts are
immutable once deployed, so the audit is a precondition, not a review.

**EVM suite: 683 passing, 0 failing.** It was 618 passing / 67 failing.

### Four contract bugs, all found before deployment

1. **`setCoreRouting` bricked the launchpad.** `LaunchFactory.leagueReceiver` was
   `immutable` while `feeRecipient` was not. `LaunchCampaign` only takes the
   unified routing path when they are equal, and the factory stamps every
   campaign `strictFeeRouting: true` -- so the first treasury-router migration
   left them permanently apart and every campaign created afterwards reverted
   `FeeRoutingFailed` on every buy and sell. Reachable by a routine admin action.
   They now move together in one transaction.
2. **A Live war pool that was never resolved locked every wei.**
   `ArenaWarPoolTreasuryV2` stored `resolveDeadline` and never read it; the only
   exits from Live needed a signed outcome. `settleExpiredPool` is permissionless
   and deadline-gated. Boosts were a pool aggregate with funders only in events,
   so the per-wallet `boosts` mapping and `refundBoost` had to land in the same
   change or expiry would have stranded them.
3. **`cancelOpenPool` had a discretionary branch.** `pool.ownerA` or the owner
   could close a pool before its deadline, and `openTournamentPool` sets `ownerA`
   to the creator -- so a tournament creator could close a pool already holding
   other people's entry fees. Removed, matching the Solana rule. Both remaining
   exits are permissionless and gated on deadlines fixed at open time.
4. **Robinhood stock graduation could never complete.**
   `RobinhoodStockTokenGraduationAdapter` minted the LP position straight to the
   locker, but `NonfungiblePositionManager.mint` uses `_mint`, not `_safeMint`,
   so `onERC721Received` -- the locker's only way to record a position -- never
   fired. Every graduation reverted `PositionMissing`, on every retry.
   `RobinhoodUniswapV3GraduationAdapter` already documented the trap and minted
   to itself before safe-transferring in; the stock adapter now does the same.
   Those are the only two position mints in the codebase.

**Three of the four were invisible behind the broken test suite.** The suites
that would have caught them were failing for unrelated reasons, so nobody could
see them. That is the argument for fixing tests before an audit, not after.

### Two facts that change the BNB deployment

- **The existing treasury router cannot serve the new contracts.**
  `0xe157a6FDf19CAB61f2ECa048966f137A3240a921` has no `creatorRewardsVault()`,
  and `TreasuryRouterV3._routeTrade` requires it. A new `TreasuryRouterV3` is a
  mandatory part of the deployment set. Production is fine today only because the
  deployed campaign implementation `0xbe3caF64…` predates `strictFeeRouting`.
- **Pausing the treasury router halts all trading.** Under strict routing a fee
  that cannot route reverts the trade instead of escrowing into `pendingNative`.
  No fee limbo, but it is an operational property worth knowing.

### The V3 fee model, now pinned

A trade fee pays the creator **5%**, taken from what was the protocol's: on a
2 BNB fee, protocol takes 0.85 where the old model took 0.95. League is 37.5%,
split weekly/monthly. Finalize fees carry no creator or league share.
Conservation is asserted across all six destinations for every profile.

### Why the suite was broken

Fixtures deployed `TreasuryRouter` V1 where the factory demands V3's
`routeTrade`/`routeFinalize`; against V1 the call reverts with no reason at all,
which was 54 of the 67. Then `RouteAmounts` gained a `creator` field and league
split weekly/monthly, so balance helpers reading only the weekly vault saw 30% of
the league and none of the creator -- a correctly routed fee looked like lost
money. `deployConfiguredTreasuryRouter` stays on V1 because the V1 router specs
are its subject; campaign and factory fixtures use `…V3`. Switching the shared
one silently stopped testing V1 and cost five passing tests before I caught it.

### The BNB deployment, in order

Two scripts, and they are not interchangeable. Running both factories would put
two active factories in front of users.

1. **`scripts/deploy-evm-treasury-router-v3.ts`** — `TreasuryRouterV3` plus its
   vaults, and nothing else. This is the one proven on BSC testnet (router
   `0x529C0c4A…`, all four vaults wired and read back). The router's admin is
   the Safe on mainnet, so the four vault-wiring calls come back as Safe
   transactions rather than EOA calls. It refuses to invent placeholder vaults
   on a mainnet profile: a placeholder is an `AcceptingReceiver`, which takes
   league fees and can never pay them out, and nothing about that fails loudly.

   **Not `scripts/deploy-bnb-mainnet-v3-cutover.ts`.** It deploys the same
   router and vaults *plus* a plain `LaunchFactory` and campaign implementation
   that the quote generation supersedes — a second factory in front of users and
   wasted mainnet gas. It has never been run and stays for
   `prove-bnb-mainnet-v3-cutover.test.mjs`, which pins its shape.
2. **`scripts/deploy-bnb-quote-generation.ts`** — everything from the factory up:
   `LaunchCampaign` impl, `BnbQuoteLaunchCampaign` impl, `BnbBasicLaunchFactory`
   (which deploys its own locker), `BnbQuoteGraduationAdapter` (needs that
   locker, so it cannot come earlier), `PostGradLeagueTreasuryV2`,
   `ArenaWarPoolTreasuryV2`. Takes the router from step 1 as input.

Everything lands closed: `createPaused` true, `live` false, war pool deposits
paused, and the script never calls `enableLive`. Quote routes, ownership
transfer to the Safe, and going live are separate deliberate steps.

**The script refuses a router that cannot serve strict routing.** It probes
`creatorRewardsVault()` and the other five vaults and refuses with the
consequence named. BNB mainnet's current router fails that check — which is the
point, since pointing the new factory at it would brick the generation on day
one. A paused router is refused for the same reason.

Rehearsed on a throwaway chain by `test/BnbQuoteGenerationDeploy.spec.ts`, which
drives the same wiring in the same order, asserts the end state including that
`createCampaign` is rejected, and proves both refusals fire.

### Still to do on BNB

Superseded by §4d: both steps have now run on BSC testnet against real Topaz,
and the launchpad and battle system are proven there end to end. What remains
is in §4d's "Still to do".

## 4d. Both testnets deployed and driven end to end (2026-09-23)

Founder: "There is no launch on BNB or Robinhood so we need to do whatever it
takes to get it right and deploy on mainnet when ready." Nothing live means
nothing to protect, so the acceptance records pinned to the previous
generations are superseded rather than sacred.

### What is deployed, closed, and proven

**BSC testnet (97)** — bound to the *authoritative* 30 bps Topaz.

| | |
|---|---|
| BnbBasicLaunchFactory | `0xFb8159f46BAB4e214F658c2c8f5CfF76C102E848` |
| PermanentLpLocker | `0xdb3E9A2aa097c95e65ED67bfB9ACc58Dd2c776d1` |
| LaunchCampaign impl | `0xE0e3b38e2F9EE0CCb416f81FD6E19e6aF2B56975` |
| BnbQuoteLaunchCampaign | `0x6132b87fd2648ef2818831501d6AB6dA4ec2A435` |
| BnbQuoteGraduationAdapter | `0xc6FcfAaceF6A64998af523eb8124877de4Cce782` |
| PostGradLeagueTreasuryV2 | `0x8A8aCCAe4E2dA530A7A1AB7CA3fDD5014DaDE401` |
| ArenaWarPoolTreasuryV2 | `0x014816B8063ae091d5EFEFcA181ca2aF53A16813` |
| CreatorRegistry | `0x13D803b58E3Dd43650f53Bd7BBe4f430E850859f` |
| TopazRouterAdapter (30 bps) | `0x13537C6273dF312067cE775AAf9635c217A931fd` |
| TreasuryRouterV3 | `0x529C0c4AC803325F9D7a736eF2067D1C0e1C0ed4` |

**Robinhood testnet (46630)** — factory `0xde9f7055f768A6A1AFBCD5263be64961241927a4`,
locker `0x387E178ac36d386ed648E282F377Cb9Ce2B9F8A9`, war pool
`0xE6Dd149E7E447dAfB1527784252f1A1873c64B74`, league
`0x4Ce88dCd64631AFb7E321Ff1f49DC1b4F423fE74`, stock adapter
`0x52e45372C7a191814039D0089ba79808f435b2d3`, native swap adapter
`0x1295966E4C250f612F7347fd42196ADd0673D7F0`, CreatorRegistry
`0x77ca02849c0AcdC8BDFF81E2BcC0062411846D78`, RiskRegistry
`0x3D79cFeF21eF34eD7e499d702C2D77A5d8dAaa34`.

Both end closed: `createPaused` true, war pool deposits paused. `enableLive`
has no inverse, so a factory that has been live stays `live=true` and **create
is the only gate** — do not read `live` as "open".

### The launchpad runs end to end on BSC testnet against real Topaz

Authorized create → buy → sell → creator fee claim → graduation into the real
30 bps Topaz → post-graduation buy and sell on that pool → LP principal
unchanged → harvest. Proven by transfer logs, not by events: the pool paid the
locker 11999999999949 WBNB, the locker paid the creator 9599999999959 and the
protocol vault 2399999999990. Exactly 80/20, nothing parked, second harvest
collects nothing.

Harness: `scripts/test-bnb-real-topaz-testnet-lifecycle.ts` with
`reports/bnb-real-topaz-testnet-stage.json`.

### The battle system runs end to end on **both** chains

`scripts/canary-arena-war-pool.ts` — one real battle: open, both sides stake,
a boost priced by a signed `BoostQuote`, resolution by the resolver's EIP-712
signature, then all three claims. Identical results on 97 and 46630:

```
entry 0.004 -> league 0.0008 (20%)  protocol 0.0002 (5%)  prize 0.003 (75%)
boost 0.001 -> protocol 0.0001 (10%)  prize 0.0009 (90%)
```

Checked against balances that moved, not against the event. `claimWinner` is
callable only by `winnerPayout` and pays `msg.sender`, so the winner's gas has
to be added back; `claimProtocol`/`claimLeague` are permissionless and are sent
by a third party so the recipient's balance moves by the payout alone;
`claimLeague` rejects a zero epoch. Deposits are closed again unconditionally.

### Five deployment bugs, every one of them mainnet-reaching

1. **Two Topaz addresses, not one.** `LaunchFactory`'s constructor calls
   `poolFactory()`; `BnbQuoteGraduationAdapter`'s calls `defaultFactory()` and
   `weth()`. On BNB mainnet the adapter `0x5c3135Df…` answers only the first
   and Topaz's router `0x1E98c822…` only the second. The profile pinned one
   address for both, so the factory constructor would have reverted on mainnet.
2. **`setCreatorRegistry` / `setRiskRegistry` do not exist.** The setter is
   `setRegistries(creator, risk)`.
3. **Nothing registered the factory as a launch recorder.** `createCampaign`
   calls `creatorRegistry.recordLaunch` behind `onlyLaunchRecorder`, so an
   unregistered factory cannot create one campaign.
4. **The testnet Topaz we first reused charges 100 bps.**
   `PermanentLpLocker.REQUIRED_POOL_FEE_BPS` is 30 and `lockPosition` reverts on
   anything else, so that generation would have graduated nothing — failing
   *after* a campaign had already sold out. BSC testnet has two Topaz
   deployments and nothing in the addresses says which is which. **The
   authoritative one is `deployments/bscTestnet/minimal-topaz.json`**: router
   `0xa241AEd1…`, pool factory `0xb9F2b64D…`, WBNB `0xcd2c3492…`, 30 bps. The
   100 bps one is router `0xe559d936…` / pool factory `0xE3434671…`.
5. **The locker was never authorized on the treasury router, and that fails
   silently.** Both lockers route the protocol's share of every LP harvest
   through `TreasuryRouterV3.routeLpToken` behind `authorizedLpLocker`, and both
   wrap it in try/catch on purpose — a treasury that refuses money must not be
   able to brick a harvest. So an unauthorized locker does not revert: it pays
   the creator in full, parks the protocol share in `pendingProtocolToken`,
   emits `HarvestPaymentPending`, and reports success. Every surface a
   deployment looks at reads healthy; only the protocol vault, which nobody
   watches, stays at zero. On BSC testnet it stranded 38.223939265110348711
   tokens and 0.000005999999999996 WBNB. `retryPendingProtocolToken` is
   permissionless, so it is recoverable — after authorizing, every parked unit
   landed in the vault to the last digit.

The wiring lives in **one** place, `scripts/lib/evmLpLockerWiring.ts`, and both
deploy scripts call it. It handles all three real cases: a fresh router takes
one call; a router that has served a previous generation needs
propose → `upgradeDelay` → accept and the script says how long; a router whose
admin is not the deployer — **which is what mainnet is** — gets its transactions
printed with the consequence named.

Bugs 1–3 were invisible because the rehearsal deployed the registries and never
handed them to the factory or drove a create. 4 and 5 are invisible to any
rehearsal at all: only a real graduation and a real harvest show them.

### Things that will waste time if forgotten

- **BSC RPCs load-balance and lag.** A read straight after a confirmed
  transaction can land on a node a block behind. It aborted one deployment with
  all the gas spent. `readBack` in the deploy script retries; do the same in any
  new script rather than treating the first read as truth.
- **Robinhood's V3 side has no equivalent fee trap** — its locker reads
  `feeTier` off the adapter instead of pinning one. Deployed stack agrees at
  3000 with tick spacing 60.
- **The mainnet-fork proofs had never once executed.** Both reported *pending*
  on every run. One needed three signers where the fork config made two; both
  died on the first read because straight after forking `"latest"` is still the
  remote block and EDR will not execute on a historical block of a chain it has
  no hardfork history for. Mine one local block first. The V3 fee-stack proof
  now passes against real 30 bps Topaz on a mainnet fork. The older lifecycle
  fork proof needs an external anvil (`--network bscMainnetFork`) and a fast
  archive RPC; on a public endpoint it exceeds 40 minutes and it certifies the
  *old* production factory, not this generation.
- **Creator gating now applies on all three chains.** One wallet, one launch per
  24h, three live campaigns on the default tier. Canary runs that need several
  launches need several wallets. `CreatorGatingChainParity` pins the EVM tiers
  to Solana's `TIER_COOLDOWN_SECONDS 86_400` and 3/5/10.

### Robinhood: accepted (2026-09-23)

The locker's timelocked authorization was accepted after `upgradeDelay`
(`acceptAuthorizedLpLocker` `0x11a68b95…`, `setPrimaryLpLocker` `0x3de8a69a…`),
and `scripts/test-robinhood-testnet-lifecycle.ts` ran against the new
generation with `deployments/robinhood/testnet.staged.new-generation.json`:
**`accepted: true`.** Create, scheduled create, pre-launch rejection,
post-launch scheduled trade, pre-grad buy/sell, creator claim, $6 graduation,
permanent V3 lock (position 3, pool `0x3dC5648d…`), native post-grad buy/sell,
80/20 harvest (creator 240000000000 / protocol 60000000000 — the proof the
locker authorization took), create paused after, indexer continuity.

Two things only running it showed:

- **The harness itself had drifted.** `RobinhoodV3NativeSwapAdapter` gained a
  `deadline` argument in the audit and the harness kept the old shape; the
  first run died *after* graduation with the chain in perfect health. A
  harness the freeze forbids from running cannot drift visibly.
- **Creator cooldown is real now.** A re-run with the same creator wallets
  would have been refused (`CreatorCooldown`, 24h), so the second run used two
  throwaway creators funded 0.01 each from the testnet deployer. Plan wallets
  for any canary that launches more than once a day.

The acceptance freeze is re-issued for the new generation:
`deployments/robinhood/testnet.accepted.json` pins factory `0xde9f7055…`, tree
`8832ad77…`, start block 123211064 (`ACCEPTED_5B_SHA` /
`ACCEPTED_FACTORY_START_BLOCK` in `scripts/robinhoodTestnetFreeze.mjs`). The
superseded `0xF170a2C9` record stays archived beside it. The freeze again
forbids lifecycle runs on 46630 — that is the point; the next generation cut
moves the pin the same way.

### Mainnet inputs, verified on chain (2026-09-23)

**Deployer `0x77F96A7d…` funded:** 0.1716 BNB on 56, 0.1030 ETH on 4663.
Measured gas (real bytecode): BNB 28.39M units deployer-paid, Robinhood
31.56M. Both chains report ~0.05 gwei; hardhat pins no gasPrice, so deploys
pay what the node reports. The Safe `0x1edcEdf5…` has code on both chains.

**BNB mainnet** — every reused input checked: Topaz adapter `0x5c3135Df…`
(`poolFactory()`) and Topaz router `0x1E98c822…` (`defaultFactory()`/`weth()`)
agree on pool factory `0x65E6cD0e…` and WBNB; volatile fee **30 bps**;
`GraduationOracle 0x9D204406…` reads Chainlink BNB/USD `0x0567F232…` (8 dec,
updates every ~33 s, so its 3600 s max age is fine); `CreatorRegistry
0x8194FB37…` and `RiskRegistry 0x92b1494C…` are Safe-owned; the four existing
vaults (weekly `0xC9286EE3…`, monthly `0xF62A09de…`, recruiter `0x40ac5cD7…`,
protocol `0xc2d4E6f8…`) all accept plain value (`receive()`), so a new
`TreasuryRouterV3` can pay them — strict routing would otherwise revert every
trade. Route authority is `0xb989A998…` (production `ROUTE_AUTHORITY_PRIVATE_KEY`
derives to it; matches the profile pin).

**Robinhood mainnet** — nothing of ours exists (`contracts: {}`). The canonical
Uniswap addresses (`0x1F98431c…` etc.) hold a 2109-byte placeholder that
answers every call with empty data — **not V3**. The real deployment, from
developers.uniswap.org and verified on chain (NPM and router both report the
factory and the same WETH9; fee tier 3000 → spacing 60):

| | |
|---|---|
| UniswapV3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| WETH9 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Chainlink ETH/USD proxy | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` (8 dec, aggregator `0x6091E64e…`) |

**The ETH/USD feed has an 86,400 s heartbeat** and was 121 minutes old when
read. `GraduationOracle.maxPriceAge` and the stock adapter's
`maxOracleAgeSeconds` are both **immutable**, and both were 3600 — on this
feed every price read would revert stale for most of the day. The Robinhood
scripts now default to 90,000 s on 4663 (`RH_MAX_ORACLE_AGE_SECONDS` to
override) and refuse a value the live feed already exceeds, before anything
immutable is written.

**Prerequisites are their own step:** `scripts/deploy-robinhood-prerequisites.ts`
deploys the oracle, weekly `TreasuryVaultV2`, `CharityTreasury`,
`MonthlyLeagueTreasury` (cap **30000**, mirroring BNB mainnet; rootPoster and
weekly operator left zero for the Safe, also mirroring BNB), recruiter and
protocol vaults, and `RobinhoodUniswapV3GraduationAdapter`, then prints the
exact env for the router and generation steps. Rehearsed in
`RobinhoodPrerequisitesDeploy.spec.ts`.

**Arena signers:** the API reads `ARENA_WAR_POOL_RESOLVER_KEY` and
`ARENA_BOOST_QUOTE_SIGNER_PRIVATE_KEY` (+ `_ADDRESS`); **neither is set in any
env**. Both roles have `onlyOwner` setters on the war pool, so they do not block
the deploy — deploy with a placeholder and let the Safe `setResolver` /
`setBoostQuoteSigner` once the key exists. `protocolReceiver` has no setter and
defaults to the Safe.

**Robinhood's config default graduation target was 10** — allowed on no chain.
Fixed per chain (30,000 mainnet / 6 testnet), checked against the factory's
own view before it is set. The accepted testnet factory still carries 10; the
app passes a per-campaign target so it is not on the app path.

### BNB mainnet — DEPLOYED (2026-09-23)

Every step ran from the founder's terminal (the auto-mode classifier refuses
mainnet sends from the agent, correctly); every state below was read back from
chain independently of the script that wrote it. 21 deployer transactions,
0.00144 BNB. All closed: `createPaused` true, `live` false, war pool deposits
paused. **Everything is owned by the Safe** `0x1edcEdf5…`; the deployer keeps
only the quote adapter's `admin` (immutable, no transfer), which is what
configures quote routes.

| | |
|---|---|
| TreasuryRouterV3 | `0xe635AA43fE5707561c8c3C655225da5C3e4C2239` (admin Safe) |
| CommunityRewardsVault | `0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e` |
| CreatorRewardsVault | `0x72A963682B261195EB43F8f75e0515ab279EbD14` |
| BnbBasicLaunchFactory | `0x632061cA786f7B585Bbd46A792FDA92B02f70671` |
| PermanentLpLocker | `0xdd41E0d13c637657A28b60F860205048221F325A` |
| LaunchCampaign impl | `0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238` |
| BnbQuoteLaunchCampaign impl | `0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7` |
| BnbQuoteGraduationAdapter | `0xfdF80819CCaE7103165c2EAd9057BA7Eb2fa8aee` (admin deployer) |
| PostGradLeagueTreasuryV2 | `0xD9E381408A4e361C66D8b1e657583bdE6c52402d` |
| ArenaWarPoolTreasuryV2 | `0xe69a6a41363a48179beaB9b1E6122885bbFe8C65` |

Reused: Topaz adapter `0x5c3135Df…`, Topaz router `0x1E98c822…`, oracle
`0x9D204406…`, BNB/USD feed `0x0567F232…`, CreatorRegistry `0x8194FB37…`,
RiskRegistry `0x92b1494C…`, the four existing vaults, route authority
`0xb989A998…`. Arena resolver `0x2b72A9E6…`, boost signer `0xFCA7DF58…` (both
EOAs, **unfunded** — the resolver pays gas for `resolve`).

Safe batches (in `deployments/bnb/`, generated from the ABI by
`scripts/make-safe-batch.ts`): B2 vault setters, safeTx `0x12f50c4e…`,
executed `0xf16be625…`; B4 launch recorder + locker authorization + primary,
safeTx `0x443fa345…`. **Several of these addresses coincide with Robinhood
testnet addresses** (`0x632061cA…` was RH testnet WETH, `0xfdF80819…` its V3
factory, `0xe69a6a41…` its graduation router) — same deployer, same nonces.
Always read the chain, never match an address by eye.

`anyLpLockerAuthorized` is now true on this router: the next locker on it
(any future generation) needs propose → 3600 s → accept.

### Robinhood mainnet — DEPLOYED (2026-09-24), R3b pending the Safe

Same discipline as BNB: founder's terminal, every state read back from chain.
34 deployer transactions, ~0.0009 ETH. All closed. Everything Ownable is the
Safe's (R4 verified: factory, league, war pool, both registries); the deployer
keeps the stock adapter's immutable `admin`. **Still owed by the Safe: R3b**
(`setAuthorizedLpLocker` + `setPrimaryLpLocker` on the router, batch
`deployments/robinhood/mainnet.R3b-locker-authorization.safe-batch.json`) —
until it executes every LP harvest strands the protocol share.

| | |
|---|---|
| GraduationOracle (maxPriceAge 90000) | `0xe635AA43fE5707561c8c3C655225da5C3e4C2239` |
| TreasuryVaultV2 (weekly) | `0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e` |
| CharityTreasury | `0x72A963682B261195EB43F8f75e0515ab279EbD14` |
| MonthlyLeagueTreasury (cap 30000) | `0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238` |
| RecruiterRewardsVault | `0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7` |
| ProtocolRevenueVault | `0x632061cA786f7B585Bbd46A792FDA92B02f70671` |
| RobinhoodUniswapV3GraduationAdapter | `0xfdF80819CCaE7103165c2EAd9057BA7Eb2fa8aee` |
| TreasuryRouterV3 (admin Safe) | `0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb` |
| CommunityRewardsVault | `0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a` |
| CreatorRewardsVault | `0xD9E381408A4e361C66D8b1e657583bdE6c52402d` |
| LaunchFactory | `0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA` (start block 70863388) |
| LaunchCampaign impl | `0x107231eBDe5DF14Ec0ec419b677d4ac0016DD70d` |
| PermanentV3PositionLocker | `0xe2B3449491E4d5BE73E7E73A4DF9498eD9f3064C` |
| RobinhoodStockTokenGraduationAdapter (maxOracleAge 90000) | `0xa48723e35061380Feb6D269f7c26D6E426F83efc` |
| RobinhoodV3NativeSwapAdapter | `0xffF3aFBC7853d4B20F523d69c146169Ef4C3c1DF` |
| PostGradLeagueTreasuryV2 | `0x5D5CC19B5BE86BA28b8164f85883F17843B69810` |
| ArenaWarPoolTreasuryV2 (runtime `0xa902d91e…`) | `0xD3E00E476b72e49Ec4587df58b23Ea5BAd1F151C` |
| CreatorRegistry / RiskRegistry | `0xDc77CAACDEB6affA0a5791f62BBB958D99Edc58B` / `0xe10e9c26D7CA80390831884CA17919E22fF44938` |

Reused: Uniswap V3 factory `0x1f7d7550…`, position manager `0x73991a25…`,
SwapRouter02 `0xCaf681a6…`, WETH9 `0x0Bd7D308…`, Chainlink ETH/USD
`0x78F3556b…`. Route authority `0xb989A998…` (production). **The first seven
addresses collide with BNB mainnet's** (same deployer, nonces 0–6): the
oracle here is the router there. Chain-pair every address.

### Still to do

- **Robinhood mainnet battles are no longer gated in code.** `arenaWarPoolEscrow.js`
  used to refuse 4663 outright; it now takes `ARENA_WAR_POOL_TREASURY_V2_ADDRESS_4663`
  like every other chain, V2-only, runtime hash enforced. The staging authority map
  (`arenaTournamentBuyInV2.mjs`) points at today's testnet war pools, and
  `frontend/.env.example` names the V2 and signer variables. Arena test set 515, 0 failing.
- **Go-live runbook** with every env name and address, the merge order and the
  dashboard switch: `docs/build_plans/go-live-runbook.md` (gitignored dir, on
  disk — `git add -f` if it should travel).
- **Robinhood mainnet**: R1 prerequisites → R2 router (+4 Safe setters) →
  R3 generation (+2 Safe locker calls) → R4 handover. Runbook in
  `docs/build_plans/mainnet-deploy-runbook.md` (gitignored dir, on disk).
- Configure a quote route per approved quote token on each adapter (BNB
  `BnbQuoteGraduationAdapter`, Robinhood stock adapter).
- Then mainnet, as one release with the two Solana upgrades — BNB step 1 is
  `deploy-evm-treasury-router-v3.ts` with the real league vaults supplied and
  the Safe as admin, then `deploy-bnb-quote-generation.ts`; both print the Safe
  transactions they cannot send (vault wiring, launch recorder, locker
  authorization). Robinhood mainnet the same way with its own script.

## 5. One combined release (founder decision, 2026-09-23)

**Solana does not go up on its own.** Both programs are finished, certified and
staged, and they wait for BNB and Robinhood. The release is a single event: the
new launchpad contracts deployed on BNB and Robinhood, both Solana programs
upgraded through Squads, everything tested together, then put live.

The reason is that a launchpad that accepts binding tokens and a battle system
that pays 75/20/5 are the same product change across three chains. Shipping
Solana early means running two economics for however long the others take, and
proving the combination only afterwards.

Done and waiting:

1. ~~Solana launchpad: Token-2022 quote assets at graduation.~~ Certified
   `e6ed7df3…`, devnet byte-verified, 20-test gate, bound graduation proven end
   to end at 1178/1232 bytes, creator confirmation dialog live in production.
2. ~~Solana treasury: competition V2 at 75/20/5.~~ Certified `1028f6f8…`, 14-test
   gate, 47/47 instructions executed, support refunds fixed, cancellation
   removed, mainnet initializer rehearsed.

Remaining before the release:

3. **BNB** — factory/launchpad contracts for binding tokens and the battle system.
4. **Robinhood** — the same, on its own chain.
5. Then: stage both Solana buffers → Squads executes both → `init-arena-mainnet.mjs`
   → canary → `--open` → test the whole thing across all three chains → live.

The production port bundle and the live-branch fast-forward are already done
(2026-09-22): `api.memewar.zone` and the indexer both run the expansion tree on
the production database.

## 6. Known loose ends

- Chart panel / WarRoom / Imported trade panels still assume WSOL.
- `market_trades_v` labels Solana `dex_trades` as TOPAZ.
- No Solana arena e2e test — the vote-battle one runs on chain 97.
- Untracked and expected: `database/staging_rls_grants_fix.sql` and the handoff file itself. `frontend/.mwz-feed-isolation-*/` are now gitignored — `feedChainIsolation.test.mjs` mkdtemps them there and never cleans up.

## 7. Memory files to trust

`solana-expansion-state.md`, `quote-catalog-verification.md`, `testnet-quote-token-facts.md`, `test-environment-workflow.md`, `solana-upgrade-runbook.md`.
