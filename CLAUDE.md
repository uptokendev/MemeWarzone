# MemeWarzone — working agreement

Carried over from `docs/build_plans/handoff-2026-09-22-solana-devnet-step1.md` (2026-09-22).
Everything below is verified fact unless marked **open**. Read the rules before touching anything.

**Read only what the task needs.** This file holds the rules, the environments and an index. The
history and verified facts live in `docs/claude/`, one file per topic. Open the file that matches the
task before touching that area; do not read them all. New findings go into the matching topic file
(or a new one, added to the index below), not into this file.

## 1. Non-negotiable rules (from the founder, still in force)

- **Do not change unrelated logic.** "Constantly check yourself you don't change any other logic."
- **Facts over theories.** Diff against the last known-good commit/tx before theorizing about a cause.
- **Every Solana transaction is proven on a local validator before any program upgrade.** No exceptions.
- **Never change the CREATE / BUY / SELL transaction setup or flow.** Every transaction path runs the same way as those three. **Graduation is the only exception** — it is a different path by design and is measured on its own. The create/buy/sell shape was built to stop Phantom flagging us (fee router, account layout, writable count, one ALT, one signer), so a change there is not a refactor, it is a relapse. It is pinned in `tests/solana/v0-launchpad-onchain.cjs`: CREATE 844 bytes / 2 ix / 1 table / 17 accounts, 9 writable; BUY 764 bytes / 2 ix / 1 table / 14 accounts, 7 writable. If a change makes those assertions fail, the change is wrong — do not repin them to make the gate pass.
- **Deployer `9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H` must never hold user money.** Protocol wallet stays capped; the rest goes to multisig `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv`.
- **No Solana mainnet upgrade until BNB and Robinhood are ready.** One combined release: new launchpad contracts on BNB and Robinhood, both Solana programs upgraded, tested together, then live. Both Solana candidates are finished and staged; nothing goes up on its own. The treasury additionally needs `MWZ_TREASURY_RELEASE=1` to lift its own hold. See `docs/claude/solana-programs.md` (One combined release).
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


## 3. Topic index (`docs/claude/`)

| File | Read when the task touches |
|---|---|
| `solana-devnet-step1.md` | devnet RPC/PDAs, arena init on devnet, postgrad/arena feature flags, `resolve-due` operator, quote catalog + Solana quote binding basics |
| `solana-programs.md` | launchpad/treasury program changes, Token-2022 quotes, SBF gate, bound graduation, Squads upgrades, the 2026-09-24 incident, proposal decode/propose tooling, mainnet arena init, treasury `1840a9e7`, the combined-release decision |
| `evm-contracts-audit.md` | EVM contract bugs found in audit, V3 fee model, why the EVM suite broke, BNB deploy script order |
| `evm-deployments.md` | testnet + mainnet addresses (BNB 56/97, Robinhood 4663/46630), deployment bugs, mainnet inputs, Safe batches, go-live to-dos |
| `binding-and-create-path.md` | draft save / create authorization bugs, explorer verification, boost + sponsorship pricing, EVM binding tokens, Robinhood stocks + registry, wallet connect chain choice |
| `battles.md` | matchmaking, league points, challenge popups/inbox, battle e2e script, Solana battle resolver |
| `solana-ops.md` | graduation keeper, treasury_operator role, indexer pg pool starvation |
| `payouts-and-rewards.md` | protocol fee flush, league vaults, poker payouts, airdrop runner + recovery, recruiter/creator payouts, payout operator, monthly vault cap bug |
| `story-mode.md` | Story Mode API, share cards, `/s/` links |
| `meteora-dbc.md` | Meteora DBC launch type, fees, tx shape, mainnet canary |

Also: `docs/solana-mainnet-squads-upgrade-runbook.md`, `docs/runbooks/`, and the gitignored
`docs/build_plans/` (go-live and mainnet-deploy runbooks, on disk only).

## 4. Known loose ends

- Chart panel / WarRoom / Imported trade panels still assume WSOL.
- `market_trades_v` labels Solana `dex_trades` as TOPAZ.
- No Solana arena e2e test — the vote-battle one runs on chain 97.
- Untracked and expected: `database/staging_rls_grants_fix.sql` and the handoff file itself. `frontend/.mwz-feed-isolation-*/` are now gitignored — `feedChainIsolation.test.mjs` mkdtemps them there and never cleans up.

## 5. Memory files to trust

`solana-expansion-state.md`, `quote-catalog-verification.md`, `testnet-quote-token-facts.md`, `test-environment-workflow.md`, `solana-upgrade-runbook.md`.
