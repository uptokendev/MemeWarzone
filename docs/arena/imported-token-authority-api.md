# Imported Token Authority API — Agent 4 frozen contract

Status: frozen for Agent 4 PR #11.

This contract covers imported tokens only. MemeWarzone-native campaigns keep their existing graduation/creator-economics authority. Imported-token eligibility is an admission gate for **new** competition participation and never rewrites an already-running battle, tournament, or league record.

## Canonical classifications

The API exposes a computed `eligibility.authorityOutcome` with exactly these values:

- `passed` — current scan is approved and fresh.
- `needs_review` — reviewable uncertainty remains.
- `hard_failure` — a NON_OVERRIDABLE security/structural finding exists.
- `stale` — the last approved scan is no longer current by scan version or age.
- `rejected` — an administrator rejected/declined the import.
- `not_approved` — all other non-approved states.

Persisted `status` remains backward compatible (`passed`, `needs_review`, `declined`, etc.). Agent 4 must render `authorityOutcome` for effective authority and must not infer hard/stale authority from `status` alone.

## Authentication

Every `/api/admin/arena/imports` endpoint requires a valid Supabase dashboard administrator Bearer session.

- ops-key authentication is not accepted (`allowOps: false`).
- legacy-open compatibility is not accepted, even when global legacy auth enforcement is disabled.
- reviewer identity is derived by the server from the authenticated administrator; the client never supplies `reviewer`.

## Import item

All queue/detail/action responses use this item shape:

```json
{
  "id": "uuid",
  "chainId": 56,
  "tokenAddress": "0x...",
  "ownerWallet": "0x...",
  "name": "Token",
  "symbol": "TOK",
  "status": "needs_review",
  "scan": {},
  "scanVersion": "arena-import-scan-v2",
  "scannedAt": "2026-09-05T00:00:00.000Z",
  "evidenceVersion": "sha256-or-db-evidence-id",
  "stateVersion": 3,
  "reviewRequestedAt": null,
  "reviewReason": null,
  "reviewer": null,
  "reviewedAt": null,
  "createdAt": "...",
  "updatedAt": "...",
  "eligibility": {},
  "actionPolicy": {}
}
```

## Eligibility shape

```json
{
  "eligible": false,
  "code": "IMPORT_REVIEW_REQUIRED",
  "status": "needs_review",
  "authorityOutcome": "needs_review",
  "stateVersion": 3,
  "freshness": {
    "fresh": true,
    "stale": false,
    "scanVersion": "arena-import-scan-v2",
    "expectedScanVersion": "arena-import-scan-v2",
    "scannedAt": "2026-09-05T00:00:00.000Z",
    "ageMs": 1234,
    "maxAgeMs": 604800000
  }
}
```

Eligibility codes currently consumed by clients:

- `IMPORT_ELIGIBLE`
- `IMPORT_NOT_FOUND`
- `IMPORT_NON_OVERRIDABLE_FINDING`
- `IMPORT_REJECTED`
- `IMPORT_REVIEW_REQUIRED`
- `IMPORT_SCAN_STALE`
- `IMPORT_NOT_APPROVED`

## Action policy

```json
{
  "canRescan": true,
  "canApprove": false,
  "canReject": true,
  "hardBlocked": true,
  "selfReview": false,
  "requiresReason": true,
  "requiresExpectedVersion": true
}
```

Agent 4 must use `actionPolicy` to enable/disable controls. Server enforcement remains authoritative regardless of UI state.

## Queue

`GET /api/admin/arena/imports`

Persisted-status query filters are `status=review_requested|passed|needs_review|declined|scanning`. `stale` is a derived eligibility outcome rather than a persisted review status; Agent 4 must read `item.eligibility.authorityOutcome === "stale"` instead of relying on a persisted-status filter.

Success `200`:

```json
{
  "ok": true,
  "items": ["<ImportItem>"],
  "updatedAt": "2026-09-05T00:00:00.000Z"
}
```

`status=review_requested` means `review_requested_at IS NOT NULL` and persisted status is `declined` or `needs_review`.

## Detail + evidence + history

`GET /api/admin/arena/imports?id=<uuid>`

Success `200`:

```json
{
  "ok": true,
  "item": "<ImportItem>",
  "history": ["<HistoryItem>"]
}
```

The immutable scanner evidence is `item.scan`. Historical evidence is returned per history row.

History item:

```json
{
  "id": 123,
  "eventType": "scan|rescan|decision",
  "previousStatus": "needs_review",
  "nextStatus": "passed",
  "evidence": {},
  "scanVersion": "arena-import-scan-v2",
  "evidenceVersion": "...",
  "decision": "approve|reject|rescan|null",
  "reviewer": "server-derived-admin-id",
  "reason": "operator reason",
  "stateVersion": 4,
  "timestamp": "2026-09-05T00:00:00.000Z"
}
```

History is append-only at database level. UPDATE and DELETE are rejected by triggers.

## Rescan

`POST /api/admin/arena/imports/:id/rescan`

Body:

```json
{ "expectedVersion": 3, "reason": "requested current evidence" }
```

Success `200`:

```json
{ "ok": true, "item": "<ImportItem>" }
```

The scanner runs first; the final write is protected by the supplied `expectedVersion`. If authority changed while scanning, the new evidence is not committed and the request returns the conflict contract below.

## Approve

`POST /api/admin/arena/imports/:id/approve`

Body:

```json
{ "expectedVersion": 3, "reason": "reviewed evidence" }
```

Success `200`:

```json
{ "ok": true, "idempotent": false, "item": "<ImportItem>" }
```

Approval is impossible when current evidence contains a NON_OVERRIDABLE finding. The server returns `422 IMPORT_NON_OVERRIDABLE_FINDING` even for an administrator.

An identical retry after the same decision may return `200` with `idempotent: true`.

## Reject

`POST /api/admin/arena/imports/:id/reject`

Body and success shape are the same as approve. Persisted status remains `declined` for compatibility; effective `authorityOutcome` is `rejected`.

## Deprecated compatibility decision route

`POST /api/admin/arena/imports/:id/decide`

This is retained only for the existing dashboard compatibility layer. It is still protected by the exact same strict admin/CAS/non-overridable rules. Agent 4 PR #11 should use the explicit `/approve` and `/reject` routes for new code.

## Public current eligibility

`GET /api/arena/imports/eligibility?chainId=<chainId>&token=<tokenAddress>`

Success `200`:

```json
{
  "ok": true,
  "importId": "uuid",
  "eligibility": "<Eligibility>",
  "stateVersion": 3,
  "updatedAt": "2026-09-05T00:00:00.000Z"
}
```

Not found: `404 IMPORT_NOT_FOUND`.

This is a read surface. Authoritative backend competition handlers use the shared `arenaImportEligibility` / `arenaEligibility` predicate directly before **new** participation.

## Conflict response

Conflicting stale writes fail closed with HTTP `409`:

```json
{
  "ok": false,
  "error": "Import state changed before this decision.",
  "code": "IMPORT_STATE_CONFLICT",
  "expectedVersion": 3,
  "currentVersion": 4,
  "currentStatus": "passed"
}
```

A rescan conflict may omit `currentStatus`; clients must key behavior on `code` and reload detail before retrying.

## Hard-failure contract

Scanner findings carry server-side `authority`:

- `REVIEWABLE`
- `NON_OVERRIDABLE`

At minimum these are NON_OVERRIDABLE where emitted by the scanner: not a contract, not a mint, non-transferable token behavior, honeypot sell failure, an objectively paused token, and unsafe excessive transfer-tax structure. Manual review cannot erase those findings.

Incomplete EVM trading/pool probes are REVIEWABLE uncertainty, not a pass. A safe external Solana token is not required to have a MemeWarzone/Meteora graduation pool.

## Freshness and future participation

Current scan authority requires the expected scan version and a scan age inside `ARENA_IMPORT_SCAN_MAX_AGE_HOURS` (default 168 hours / 7 days). A previously approved token therefore becomes `stale` when evidence ages out or the scanner version changes.

A later unsafe rescan immediately blocks **future admission**. Existing running competitions are not updated or rewritten by rescan/eligibility code. When a running competition advances into a genuinely new participation boundary, that boundary must use the canonical eligibility predicate.

## Creator economics

Imported tokens never acquire MemeWarzone-native launch creator economics merely because they pass import review. Competition eligibility and native-launch economics are separate authorities.
