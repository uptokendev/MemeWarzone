# Arena Imported-Token Authority API — Agent 4 Frozen Contract

Authority generation: `arena-import-scan-v2`

This contract is frozen for Agent 4 PR #11. Imported tokens are external Arena participants. They do not acquire MemeWarzone-native launch creator economics.

## Status and finding authority

Persisted import statuses:

- `passed` — scanner passed or a reviewable finding was manually approved; still subject to freshness.
- `needs_review` — reviewable scanner uncertainty/finding.
- `declined` — hard scanner failure or manual rejection.
- `scanning` — non-final scan state retained for compatibility.

`stale` is a derived competition-eligibility status. It does not rewrite the historical persisted scan result.

Finding authority values:

- `REVIEWABLE`
- `NON_OVERRIDABLE`

A `NON_OVERRIDABLE` finding can never be converted to competitive eligibility by admin approval.

## Common AdminImport shape

```json
{
  "id": "uuid",
  "chainId": 101,
  "tokenAddress": "address",
  "ownerWallet": "wallet",
  "name": "Token Name",
  "symbol": "TKN",
  "status": "needs_review",
  "scan": {},
  "scanVersion": "arena-import-scan-v2",
  "scannedAt": "2026-09-05T12:00:00.000Z",
  "evidenceVersion": "opaque-evidence-hash",
  "stateVersion": 3,
  "reviewRequestedAt": null,
  "reviewReason": null,
  "reviewer": null,
  "reviewedAt": null,
  "createdAt": "2026-09-05T12:00:00.000Z",
  "updatedAt": "2026-09-05T12:00:00.000Z",
  "eligibility": {},
  "actionPolicy": {
    "canRescan": true,
    "canApprove": true,
    "canReject": true,
    "hardBlocked": false,
    "selfReview": false,
    "requiresReason": true,
    "requiresExpectedVersion": true
  }
}
```

The `scan` object contains immutable evidence for that scan, including `warnings`, `reasons`, `findings`, `hardFindings`, `reviewableFindings`, `scanVersion`, and `scannedAt` where available.

## Queue

`GET /api/admin/arena/imports?status=<optional-status>`

Response `200`:

```json
{
  "ok": true,
  "items": ["AdminImport"],
  "updatedAt": "ISO-8601"
}
```

Supported filters include `scanning`, `passed`, `needs_review`, `declined`, `stale`, and `review_requested`. `stale` is primarily represented through each item's `eligibility`; clients must not infer eligibility from persisted `status` alone.

## Detail, evidence, history and action policy

`GET /api/admin/arena/imports?id=<uuid>`

Response `200`:

```json
{
  "ok": true,
  "item": "AdminImport",
  "history": [
    {
      "id": 1,
      "eventType": "scan|rescan|decision",
      "previousStatus": "needs_review",
      "nextStatus": "passed",
      "evidence": {},
      "scanVersion": "arena-import-scan-v2",
      "evidenceVersion": "opaque-evidence-hash",
      "decision": "approve|reject|rescan|null",
      "reviewer": "server-derived-admin-id-or-email|null",
      "reason": "operator reason",
      "stateVersion": 4,
      "timestamp": "ISO-8601"
    }
  ]
}
```

Evidence is carried in `item.scan` for the current state and in `history[].evidence` for append-only prior scan/decision states. `item.actionPolicy` is authoritative for the current authenticated reviewer.

## Rescan

`POST /api/admin/arena/imports/:id/rescan`

Request:

```json
{
  "expectedVersion": 3,
  "reason": "optional operator note; defaults to rescan"
}
```

Success `200`:

```json
{
  "ok": true,
  "item": "AdminImport"
}
```

A rescan records a new append-only history entry. A later unsafe result revokes eligibility for future competition admission. It does not rewrite already-created/running competition records.

## Approve

`POST /api/admin/arena/imports/:id/approve`

Request:

```json
{
  "expectedVersion": 3,
  "reason": "required reason"
}
```

Success `200`:

```json
{
  "ok": true,
  "idempotent": false,
  "item": "AdminImport"
}
```

A safe identical retry may return `idempotent: true`.

Hard-block response `422`:

```json
{
  "ok": false,
  "error": "Non-overridable scanner finding blocks approval.",
  "code": "IMPORT_NON_OVERRIDABLE_FINDING",
  "actionPolicy": {}
}
```

Self-review response `403` uses `code: IMPORT_SELF_REVIEW_FORBIDDEN`.

## Reject

`POST /api/admin/arena/imports/:id/reject`

Request:

```json
{
  "expectedVersion": 3,
  "reason": "required reason"
}
```

Success is the same mutation shape as approve with the resulting `item.status = "declined"`.

## Eligibility

`GET /api/arena/imports/eligibility?chainId=<chain-id>&token=<token-address>`

Success `200`:

```json
{
  "ok": true,
  "importId": "uuid",
  "eligibility": {
    "eligible": true,
    "code": "IMPORT_ELIGIBLE",
    "status": "passed",
    "freshness": {
      "fresh": true,
      "stale": false,
      "scanVersion": "arena-import-scan-v2",
      "expectedScanVersion": "arena-import-scan-v2",
      "scannedAt": "ISO-8601",
      "ageMs": 3600000,
      "maxAgeMs": 604800000
    },
    "stateVersion": 3
  },
  "stateVersion": 3,
  "updatedAt": "ISO-8601"
}
```

Eligibility codes are:

- `IMPORT_ELIGIBLE`
- `IMPORT_NOT_FOUND`
- `IMPORT_NON_OVERRIDABLE_FINDING`
- `IMPORT_REJECTED`
- `IMPORT_REVIEW_REQUIRED`
- `IMPORT_NOT_APPROVED`
- `IMPORT_SCAN_STALE`

Clients must consume `eligibility.eligible`; they must not implement their own `status === passed` rule.

## Concurrency and conflict contract

All admin mutations use `expectedVersion`. Conflicting stale actions return HTTP `409`:

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

A stale rescan returns the same `IMPORT_STATE_CONFLICT` code and the expected/current versions.

Missing `expectedVersion`: HTTP `400`, `IMPORT_EXPECTED_VERSION_REQUIRED`.
Missing decision reason: HTTP `400`, `IMPORT_REASON_REQUIRED`.
Strict admin session required: HTTP `401`, `IMPORT_ADMIN_AUTH_REQUIRED`.

## Competition admission semantics

The backend's single imported-token predicate is `evaluateImportedCompetitionEligibility` in `frontend/api/lib/arenaImportEligibility.js`.

It is consumed for new Arena participation through:

- Warzone/creator battle discovery;
- Find Match candidate discovery;
- Normal Battle open/challenge;
- queue auto-match/AUTO DEPLOY candidate admission;
- standard Tournament opt-in;
- Vote Tournament registration via the same tournament opt-in path;
- Arena vote-token resolution/featured discovery;
- Major War League check-in;
- Quarter Finals admission through the gated tournament entry path.

Already-created/live battles, frozen league results, active tournament brackets, and votes against an already-active matchup are not silently rewritten by a later rescan.
