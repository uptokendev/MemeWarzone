# Launch-day rollback / pause drill

Operations only. No contract/program/economics mutation. No production deployment.

## Goal

Prove that an operator can recover the application stack without changing chain state:

1. frontend rollback;
2. API rollback;
3. realtime-indexer restart from persisted cursor / chain truth;
4. reconciliation after restart;
5. chain-scoped pause remains independent.

Use staging or an isolated preview environment only. Do not point destructive test configuration at production.

## Evidence header

Record before starting:

- current candidate SHA;
- previous known-good frontend SHA;
- previous known-good API SHA;
- previous known-good indexer SHA;
- staging database identifier;
- API `/healthz` and `/health` result;
- indexer `/healthz` and `/health` result;
- `node frontend/scripts/launch-health.mjs` output;
- indexer cursor rows for chain IDs 56, 101 and 4663.

Never paste RPC URLs, `DATABASE_URL`, private keys, service-role credentials or bearer tokens into evidence.

## A. Baseline

1. Deploy/start the candidate revision in staging using the normal staging process.
2. Confirm API `/healthz` = 200 and `/health` reports DB ready.
3. Confirm indexer `/healthz` = 200 and `/health` is healthy.
4. Run the read-only launch-health command.
5. Save the three chain cursor values and reconciliation error count.
6. Create no production transactions. If staging already has accepted test fixtures, note their latest chain positions only.

Pass: all expected staging services identify the candidate SHA, DB is ready and cursor/reconciliation output is readable.

## B. Frontend rollback

1. In staging only, select the previous known-good frontend deployment/SHA.
2. Redeploy only the frontend static service.
3. Do not change API/indexer/database/chain configuration.
4. Hard-reload `/`, `/create`, one project/token page and Command Center login.
5. Confirm the API health endpoints remain green and the indexer revision did not change.
6. Re-promote the candidate frontend SHA and repeat the hard reload.

Pass: frontend can move backward and forward without DB migration, API restart, indexer restart or financial mutation.

## C. API rollback

1. Record candidate API SHA and current DB schema high-water mark.
2. In staging only, redeploy the previous known-good API SHA against the existing forward-compatible staging schema.
3. Confirm `/healthz` and `/health` are green.
4. Exercise read-only project/campaign endpoints and one authenticated non-financial read where available.
5. Confirm indexer remains running and cursor values continue to advance or remain stable as expected.
6. Restore candidate API SHA and repeat health checks.

Fail immediately if the old API cannot safely read the forward schema. Do not down-migrate automatically.

Pass: previous API revision can serve against the forward schema and candidate can be restored without data repair.

## D. Indexer restart from persisted cursor / chain truth

1. Record indexer SHA and cursor rows for chain IDs 56, 101 and 4663.
2. Stop only the staging realtime-indexer process.
3. Leave PostgreSQL and API running.
4. Wait long enough for at least one staging chain head/slot to advance if the selected RPC permits it.
5. Start the exact same indexer SHA.
6. Verify startup identifies the expected SHA and does not reset cursor state.
7. Run `node frontend/scripts/launch-health.mjs`.
8. Confirm each available cursor resumes from the stored position and lag decreases or remains bounded.
9. Run the existing one-shot graduation reconciliation command when applicable:
   `npm --prefix realtime-indexer run job:reconcile-graduations-once`
10. Run launch-health again.
11. Check for duplicate indexed rows/events using the existing idempotency/reconciliation diagnostics appropriate to the staging dataset.

Pass: no cursor resets, no duplicate financial/event effect, and reconciliation completes without increasing the reconciliation error count.

## E. Previous-indexer rollback

Only if the staging database schema is forward-compatible with the previous known-good indexer revision:

1. Stop candidate indexer.
2. Start previous known-good indexer SHA using the same staging DB and chain configuration.
3. Verify it reads the existing cursor and does not backfill from genesis/zero.
4. Run launch-health and reconciliation once.
5. Restore candidate indexer SHA.
6. Repeat health/reconciliation.

If compatibility is uncertain, mark this subtest BLOCKED rather than attempting a destructive downgrade.

## F. Pause isolation checks

Without sending financial transactions:

- verify BNB creation can be disabled independently from Solana/Robinhood configuration;
- verify Solana creation/Arena capability can be disabled independently;
- verify Robinhood 4663 creation can remain disabled while BNB/Solana stay unchanged;
- verify Arena financial capability can be disabled without disabling project/import reads;
- verify claim execution can be paused without deleting entitlement/history state.

This may be performed as configuration/state inspection when changing the staging flag would otherwise create risk.

## Required result record

Record:

- baseline candidate SHA;
- frontend rollback SHA -> candidate SHA;
- API rollback SHA -> candidate SHA;
- indexer cursor before stop;
- chain head/slot while stopped;
- cursor immediately after restart;
- cursor after reconciliation;
- reconciliation error count before and after;
- duplicate-effect check result;
- any blocked subtest and exact reason.

`ROLLBACK/PAUSE PATH: PROVEN` requires all required A-D steps to have been executed successfully in staging or an isolated equivalent. A written procedure or static CI alone is `UNPROVEN`.
