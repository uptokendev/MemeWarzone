# Staging rollback execution pack

Operations only. No contract/program/economics changes. No production deployment. No merge.

This pack is for PR #362 and is deliberately copy/paste-oriented. It does not claim that the drill passed. The operator must execute it in staging or an isolated equivalent and return the evidence template at the end.

## Fixed source and safety boundary

- PR: `#362`
- Source accepted before this operator-pack update: `d905c6d41d77715363dfadd10ae654904e87ae18`
- Execute the drill from the **current PR #362 head shown by GitHub/Coolify at execution time**. Record that SHA as `CANDIDATE_SHA` below; do not silently use an older deployment.
- Destructive staging identities are BSC Testnet `97`, Solana devnet with application chain identity `101`, and Robinhood Testnet `46630`.
- Never paste RPC URLs, `DATABASE_URL`, private keys, service-role credentials, bearer tokens or deployment environment values into evidence.
- Do not run this pack against production BNB 56, Solana mainnet-beta or Robinhood 4663.
- Do not down-migrate the database.

## Operator worksheet

Fill these from the Coolify staging UI before changing anything:

```bash
export CANDIDATE_SHA='<current PR #362 head>'
export FRONTEND_SERVICE='<Coolify staging frontend service name>'
export API_SERVICE='<Coolify staging API service name>'
export INDEXER_SERVICE='<Coolify staging realtime-indexer service name>'
export FRONTEND_URL='<staging frontend public URL>'
export API_URL='<staging API public URL>'
export INDEXER_URL='<staging realtime-indexer public URL>'

# IDs only; never paste environment values/secrets.
export FRONTEND_CANDIDATE_DEPLOYMENT_ID='<Coolify deployment ID>'
export API_CANDIDATE_DEPLOYMENT_ID='<Coolify deployment ID>'
export INDEXER_CANDIDATE_DEPLOYMENT_ID='<Coolify deployment ID>'
```

In Coolify, use the deployment-history entry whose commit/SHA exactly matches `CANDIDATE_SHA`. For a rollback, choose the newest prior deployment that was explicitly known-good for that same staging service. Do not choose a revision merely because it is older or green.

## Launch-health command for real staging

Run this inside a shell for the staging service/container that already has the staging `DATABASE_URL` and RPC environment. Do not echo those environment values.

```bash
cd /path/to/MemeWarzone
LAUNCH_HEALTH_BNB_CHAIN_ID=97 \
LAUNCH_HEALTH_SOLANA_CHAIN_ID=101 \
LAUNCH_HEALTH_ROBINHOOD_CHAIN_ID=46630 \
SOURCE_COMMIT="$CANDIDATE_SHA" \
node frontend/scripts/launch-health.mjs | tee /tmp/mwz-launch-health.txt
```

The command accepts the existing server-side BSC97 and RH46630 RPC environment names and prints only labels/statuses, never URLs. If Robinhood staging is intentionally not enabled/configured yet, record its output as unavailable/not_configured and mark only the RH46630 portions BLOCKED; do not substitute 4663 production RPC.

Expected output fields only:

```text
service_sha=...
db_readiness=READY|NOT_READY
bnb_chain_head=...
bnb_rpc=selected:OK|FAIL ...
solana_slot=...
solana_rpc=selected:OK|FAIL ...
robinhood_chain_head=...
robinhood_rpc=selected:OK|FAIL ...
indexer_bnb_cursor=... lag=...
indexer_solana_cursor=... lag=...
indexer_robinhood_cursor=... lag=...
reconciliation_error_count=...
```

## A. BASELINE

### A1. Record exact deployments

In Coolify staging, open each service and record the active deployment ID + source commit. Do not redeploy yet.

```text
candidate_sha=
frontend_deployment_id=
frontend_sha=
api_deployment_id=
api_sha=
indexer_deployment_id=
indexer_sha=
```

PASS requires the service revisions intended to be the candidate to match `CANDIDATE_SHA`. If a service is deliberately pinned to a different accepted SHA, record the reason instead of pretending they match.

### A2. Prove frontend/API/indexer reachability

```bash
curl -fsS -o /dev/null -w 'frontend_root_http=%{http_code}\n' "$FRONTEND_URL/"
curl -fsS "$API_URL/healthz"; printf '\n'
curl -fsS "$API_URL/health"; printf '\n'
curl -fsS "$INDEXER_URL/healthz"; printf '\n'
curl -fsS "$INDEXER_URL/health"; printf '\n'
```

API `/healthz` must be 200/`ok`; `/health` must report its DB-backed health as ready. The indexer lightweight `/healthz` must be green; its `/health` must be healthy for the configured staging DB/runtime.

### A3. Capture launch-health baseline

Run the staging launch-health command above and save the complete **sanitized** output. Record:

```text
db_readiness=
bnb_head_0=
solana_slot_0=
robinhood_head_0=
bnb_cursor_0=
bnb_lag_0=
solana_cursor_0=
solana_lag_0=
robinhood_cursor_0=
robinhood_lag_0=
reconciliation_errors_0=
```

Do not continue if DB readiness is not READY or the staging RPC identities point at the wrong chains.

## B. FRONTEND ROLLBACK

### B1. Select previous known-good

Coolify staging -> `FRONTEND_SERVICE` -> deployment history.

Record:

```text
frontend_previous_deployment_id=
frontend_previous_sha=
why_known_good=
```

The previous revision must have existing staging evidence or be the last explicitly accepted staging frontend. Do not guess.

### B2. Roll back only frontend

In Coolify, redeploy/rollback `FRONTEND_SERVICE` to `frontend_previous_deployment_id`. Do not change API, indexer, DB or environment variables.

After Coolify reports healthy:

```bash
curl -fsS -o /dev/null -w 'root=%{http_code}\n' "$FRONTEND_URL/"
curl -fsS -o /dev/null -w 'create=%{http_code}\n' "$FRONTEND_URL/create"
curl -fsS "$API_URL/healthz"; printf '\n'
curl -fsS "$API_URL/health"; printf '\n'
```

In a browser hard-reload:

1. `/`
2. `/create`
3. one existing staging project/token page
4. Command Center login route

For API connectivity, the page must load its normal public data rather than only rendering a static shell. Do not perform a financial action.

Record the API and indexer deployment IDs again and prove they did not change.

### B3. Restore candidate frontend

In Coolify redeploy the exact `FRONTEND_CANDIDATE_DEPLOYMENT_ID` / `CANDIDATE_SHA`. Repeat B2 checks.

PASS: previous frontend works, API/indexer stay unchanged, and candidate frontend restores healthy.

## C. API ROLLBACK

### C1. Select previous API deployment

Coolify staging -> `API_SERVICE` -> deployment history.

Record:

```text
api_previous_deployment_id=
api_previous_sha=
why_known_good=
```

Only continue if that API is known to be forward-compatible with the current staging schema. If unknown, mark API rollback BLOCKED. Never down-migrate to force it.

### C2. Roll back only API

Rollback `API_SERVICE` to `api_previous_deployment_id`. Leave frontend, indexer and DB unchanged.

```bash
curl -fsS "$API_URL/healthz"; printf '\n'
curl -fsS "$API_URL/health"; printf '\n'
```

Then exercise read-only public/import surfaces. Use a real staging BNB or Solana token/project already present in the staging dataset; do not create/claim/edit it.

```bash
# Replace only these public identifiers. They are not secrets.
export READ_CHAIN_ID='<56 or 101 if this staging API exposes production-identity import reads; otherwise the staging-supported import chain>'
export READ_TOKEN='<existing public token/mint>'

curl -fsS "$API_URL/api/project-imports?chainId=$READ_CHAIN_ID&tokenAddress=$READ_TOKEN" | head -c 2000; printf '\n'
```

Also load the corresponding public imported-project page in the browser and prove it remains readable. Do not use an authenticated mutation as a rollback smoke test.

### C3. Restore candidate API

Redeploy `API_CANDIDATE_DEPLOYMENT_ID` / `CANDIDATE_SHA`, then repeat:

```bash
curl -fsS "$API_URL/healthz"; printf '\n'
curl -fsS "$API_URL/health"; printf '\n'
curl -fsS "$API_URL/api/project-imports?chainId=$READ_CHAIN_ID&tokenAddress=$READ_TOKEN" | head -c 2000; printf '\n'
```

PASS: old API can read the forward schema and public Import/project data, and candidate API restores without repair.

## D. INDEXER RESTART / RECOVERY

This is a restart of the **same candidate indexer SHA**, not an indexer downgrade.

### D1. Before stop

Run launch-health and record:

```text
indexer_sha_before=
bnb_cursor_before=
bnb_head_before=
bnb_lag_before=
solana_cursor_before=
solana_slot_before=
solana_lag_before=
robinhood_cursor_before=
robinhood_head_before=
robinhood_lag_before=
reconciliation_errors_before=
```

Also record a duplicate-effect baseline using the existing staging reconciliation/idempotency diagnostics for the dataset. At minimum record the count/result used and the query/job name; do not paste DB credentials.

### D2. Stop indexer only

Coolify staging -> `INDEXER_SERVICE` -> Stop.

Prove API remains healthy:

```bash
curl -fsS "$API_URL/healthz"; printf '\n'
curl -fsS "$API_URL/health"; printf '\n'
```

Wait until at least BSC97 or Solana devnet has advanced. Do not send a production transaction. Use staging chain traffic/natural advancement.

Run the launch-health command from the API/ops container while the indexer is stopped and record:

```text
bnb_head_while_stopped=
solana_slot_while_stopped=
robinhood_head_while_stopped=
```

PASS precondition: at least one available chain head/slot is greater than its pre-stop value while the stored cursor remains unchanged.

### D3. Restart exact same candidate

Coolify staging -> start/redeploy `INDEXER_CANDIDATE_DEPLOYMENT_ID` at exactly `CANDIDATE_SHA`. Do not choose latest/branch-tip unless it equals the recorded candidate.

Immediately run launch-health and record:

```text
bnb_cursor_after_restart=
bnb_lag_after_restart=
solana_cursor_after_restart=
solana_lag_after_restart=
robinhood_cursor_after_restart=
robinhood_lag_after_restart=
```

FAIL if an existing non-zero cursor becomes zero/null/genesis-like. PASS persisted-resume only when each enabled chain resumes at or beyond its saved pre-stop cursor, never below it.

### D4. Prove catch-up

Run launch-health periodically until each enabled cursor advances and lag trends down/bounded relative to the new chain head/slot. Record one final sample:

```text
bnb_cursor_caught_up=
bnb_head_caught_up=
bnb_lag_caught_up=
solana_cursor_caught_up=
solana_slot_caught_up=
solana_lag_caught_up=
robinhood_cursor_caught_up=
robinhood_head_caught_up=
robinhood_lag_caught_up=
```

### D5. Run existing reconciliation once

Inside the candidate repository/container with the staging environment loaded:

```bash
cd /path/to/MemeWarzone
npm --prefix realtime-indexer run job:reconcile-graduations-once
```

Then rerun launch-health and record:

```text
reconciliation_errors_after=
```

PASS requires `reconciliation_errors_after <= reconciliation_errors_before`.

### D6. Prove no duplicate financial/event effect

Use the same staging idempotency/reconciliation diagnostic captured in D1 and compare before/after. PASS only if the restart + reconciliation did not create a duplicate external trade/event, duplicate payout/claim effect, or increased reconciliation mismatch. Record the diagnostic/query/job name and before/after counts/results, not secrets.

If there is no dataset/event suitable for proving duplicate behavior, mark this subtest BLOCKED; do not invent a PASS.

## E. PAUSE ISOLATION

These checks are staging-only. Prefer existing staging configuration/capability flags and read-only state inspection. If a pause requires an on-chain admin transaction, do **not** perform it under PR #362; record that item BLOCKED and hand it to the separately authorized chain-certification lane. This operations PR must not mutate contracts/programs.

For every check, capture **before**, **paused**, and **restored** state. Do not infer a backend pause merely because a button disappeared; the Masterplan requires financial safety beyond UI disabling.

### E1. BNB creation OFF; other chains unaffected

1. Record current BNB creation capability/flag and Solana/RH capabilities from the staging service configuration or authoritative diagnostics.
2. If there is an existing off-chain staging BNB creation feature/capability switch, set only that switch OFF and redeploy/restart only the service required by that flag.
3. Verify BNB `/create` path is unavailable/fail-closed for creation.
4. Verify Solana creation configuration/read path is unchanged.
5. Verify RH46630 configuration/read path is unchanged where enabled.
6. Restore the exact prior BNB flag/value and prove baseline returns.
7. If the only authoritative BNB pause is `LaunchFactory.setCreatePaused(...)`, do not call it in this PR; record `BLOCKED: requires separately authorized BSC97 contract-admin pause drill`.

### E2. Solana creation/Arena OFF; other chains unaffected

1. Record the current Solana creation and Arena capability flags/state.
2. Use only existing off-chain staging switches if present; set Solana creation/Arena OFF without changing BNB/RH configuration.
3. Verify Solana create/Arena financial entry points fail closed.
4. Verify BNB and RH read/capability state is unchanged.
5. Restore prior values and verify again.
6. If the authoritative pause requires a Solana program instruction, do not send it; mark BLOCKED for the separately authorized Solana devnet lane.

### E3. Robinhood 46630 OFF; BNB/Solana unaffected

1. Confirm staging is chain `46630`, never `4663`.
2. Record RH46630 support/creation/Arena operational state.
3. Disable only the existing off-chain RH46630 activation/capability switch if available, or leave its already fail-closed state unchanged.
4. Verify RH financial creation/actions are unavailable.
5. Verify BNB97 and Solana devnet health/cursors remain healthy and unchanged in configuration.
6. Restore only if a value was changed.
7. Never substitute a 4663 production canary for this test.

### E4. Arena financial actions OFF; Import/project reads remain readable

1. Record Arena financial capability state.
2. Disable the existing staging Arena financial feature/capability flag(s) without disabling project Import.
3. Verify Battle/Tournament/Boost/other financial action endpoints or UI actions fail closed.
4. Verify these remain readable:
   - `/`
   - Import entry/page
   - an existing imported project page
   - read-only `GET /api/project-imports?...`
5. Restore candidate flag state and verify again.

PASS requires Import/project reads to survive while financial Arena actions are unavailable. Production's Import-first boundary remains the reference safety model; do not activate production Arena for this test.

### E5. Claims execution OFF; entitlement/history preserved

1. Record claim-execution capability/flags and a staging wallet/epoch read model with existing entitlement/history.
2. Set only existing off-chain claim execution/payout enable switches OFF. Do not delete/modify entitlement rows.
3. Verify execution/mutation is unavailable/fail-closed.
4. Re-read the same entitlement/history and prove the records/counts/amounts are unchanged.
5. Restore the exact previous switches and re-read again.
6. Do not call contract/program claim-pause admin functions under this PR.

PASS requires execution OFF while entitlement/history remains intact.

## F. PASS / FAIL EVIDENCE TEMPLATE

Paste only this sanitized record back to Launch Control/Agent 5. Do not paste URLs, environment values, RPC endpoints or credentials.

```text
PR: #362
DRILL_ENVIRONMENT: STAGING / ISOLATED
START_UTC:
END_UTC:
CANDIDATE_SHA:

A_BASELINE: PASS / FAIL / BLOCKED
FRONTEND_SHA:
FRONTEND_DEPLOYMENT_ID:
API_SHA:
API_DEPLOYMENT_ID:
INDEXER_SHA:
INDEXER_DEPLOYMENT_ID:
DB_READINESS:
BNB_HEAD_0:
SOLANA_SLOT_0:
ROBINHOOD_HEAD_0:
BNB_CURSOR_0:
BNB_LAG_0:
SOLANA_CURSOR_0:
SOLANA_LAG_0:
ROBINHOOD_CURSOR_0:
ROBINHOOD_LAG_0:
RECON_ERRORS_0:

B_FRONTEND_ROLLBACK: PASS / FAIL / BLOCKED
PREVIOUS_FRONTEND_SHA:
PREVIOUS_FRONTEND_DEPLOYMENT_ID:
ROLLBACK_HEALTH:
CANDIDATE_RESTORE_HEALTH:
API_DEPLOYMENT_UNCHANGED: YES / NO
INDEXER_DEPLOYMENT_UNCHANGED: YES / NO

C_API_ROLLBACK: PASS / FAIL / BLOCKED
PREVIOUS_API_SHA:
PREVIOUS_API_DEPLOYMENT_ID:
ROLLBACK_HEALTHZ:
ROLLBACK_HEALTH:
ROLLBACK_IMPORT_PUBLIC_READ: PASS / FAIL
CANDIDATE_RESTORE_HEALTHZ:
CANDIDATE_RESTORE_HEALTH:
CANDIDATE_IMPORT_PUBLIC_READ: PASS / FAIL

D_INDEXER_RECOVERY: PASS / FAIL / BLOCKED
INDEXER_SHA_BEFORE:
BNB_CURSOR_BEFORE:
BNB_HEAD_BEFORE:
SOLANA_CURSOR_BEFORE:
SOLANA_SLOT_BEFORE:
ROBINHOOD_CURSOR_BEFORE:
ROBINHOOD_HEAD_BEFORE:
RECON_ERRORS_BEFORE:
BNB_HEAD_WHILE_STOPPED:
SOLANA_SLOT_WHILE_STOPPED:
ROBINHOOD_HEAD_WHILE_STOPPED:
BNB_CURSOR_AFTER_RESTART:
SOLANA_CURSOR_AFTER_RESTART:
ROBINHOOD_CURSOR_AFTER_RESTART:
RESTART_FROM_ZERO: YES / NO
BNB_CURSOR_FINAL:
BNB_HEAD_FINAL:
BNB_LAG_FINAL:
SOLANA_CURSOR_FINAL:
SOLANA_SLOT_FINAL:
SOLANA_LAG_FINAL:
ROBINHOOD_CURSOR_FINAL:
ROBINHOOD_HEAD_FINAL:
ROBINHOOD_LAG_FINAL:
RECONCILIATION_COMMAND: PASS / FAIL
RECON_ERRORS_AFTER:
DUPLICATE_EFFECT_DIAGNOSTIC:
DUPLICATE_EFFECT_BEFORE:
DUPLICATE_EFFECT_AFTER:
DUPLICATE_EFFECT_RESULT: PASS / FAIL / BLOCKED

E_PAUSE_ISOLATION: PASS / FAIL / BLOCKED
BNB_CREATION_OFF_OTHER_CHAINS_OK: PASS / FAIL / BLOCKED
SOLANA_CREATION_ARENA_OFF_OTHER_CHAINS_OK: PASS / FAIL / BLOCKED
RH46630_OFF_BNB_SOLANA_OK: PASS / FAIL / BLOCKED
ARENA_FINANCIAL_OFF_IMPORT_READABLE: PASS / FAIL / BLOCKED
CLAIMS_EXECUTION_OFF_HISTORY_PRESERVED: PASS / FAIL / BLOCKED

BLOCKERS_OR_NOTES:
SECRETS_OR_RPC_URLS_INCLUDED: NO
PRODUCTION_TOUCHED: NO
```

## Verdict rule

Do not mark the drill proven from this document or CI.

- `ROLLBACK/PAUSE PATH: PROVEN` requires the required rollback/restart/reconciliation and applicable pause-isolation steps to have real staging evidence.
- Any failed required step = FAIL/UNPROVEN.
- Any required step that cannot be exercised without unauthorized contract/program mutation = BLOCKED/UNPROVEN, with the exact separately authorized lane named.
- Source/static checks alone never establish runtime recovery.
