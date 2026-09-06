# Robinhood Stock Graduation Registry API — Frozen Release Contract

Release scope: persistent authority for NEW Robinhood Stock Token graduations. Robinhood bonding remains ETH. `existingMarketSupport` is independent: disabling new graduations does not disable existing MEME/Stock markets.

## Authentication

All `/api/admin/robinhood/...` routes require an authenticated dashboard-admin Bearer session. Operator identity is derived on the server from the authenticated admin. Browser-supplied reviewer/operator identity is ignored/not accepted.

## Registry item

```ts
type RegistryItem = {
  id: string;
  chainId: number;
  robinhoodAssetUid: string | null;
  contractAddress: string;
  symbol: string;
  displayName: string;
  underlyingSymbol: string;
  canonical: boolean;
  robinhoodStatus: string;
  tradingHalted: boolean | null;
  candidate: boolean;
  adminState: "default" | "force_enabled" | "force_disabled";
  automatedHealthStatus: "healthy" | "review" | "unhealthy" | "stale";
  automatedHealthReason: string | null;
  existingMarketSupport: boolean;
  stateVersion: number;
  oracleFeedAddress: string | null;
  acquisitionPoolAddress: string | null;
  routeEnabled: boolean | null;
  enabledForGraduation: boolean;
  enabledForDiscovery: boolean;
  enabledForTrading: boolean;
  marketStatus: "eligible" | "healthy" | "review" | "unhealthy" | "stale";
  lastCanonicalSyncAt: string | null;
  lastHealthCheckAt: string | null;
  lastVerifiedAt: string | null;
};
```

`enabledForGraduation` is server-derived. `force_enabled` cannot bypass a hard safety failure (noncanonical/inactive/halted/stale/unhealthy/no enabled onchain route/no oracle/no acquisition pool/no deployed code). `enabledForTrading` reflects `existingMarketSupport`, not new-graduation eligibility.

## actionPolicy

Detail and mutation responses include:

```ts
type ActionPolicy = {
  canEnable: boolean;
  canDisable: boolean;
  canClearOverride: boolean;
  canRescan: true;
  requiresExpectedVersion: true;
  requiresReasonForOverride: true;
  forceEnableBypassesHardSafety: false;
};
```

The dashboard must render/disable actions from `actionPolicy`; it must not reproduce safety policy in React.

## Admin routes

### GET `/api/admin/robinhood/stock-graduation-registry`

Response `200`:

```json
{ "ok": true, "items": ["RegistryItem"], "updatedAt": "ISO-8601" }
```

### GET `/api/admin/robinhood/stock-graduation-registry/:id`

Response `200`:

```json
{
  "ok": true,
  "item": "RegistryItem",
  "actionPolicy": "ActionPolicy",
  "history": [
    {
      "id": "uuid",
      "action": "enable|disable|clear_override|rescan|canonical_missing",
      "reason": "string|null",
      "operator_identity": "server-derived string",
      "previous_state": {},
      "next_state": {},
      "previous_version": 1,
      "next_version": 2,
      "created_at": "ISO-8601"
    }
  ]
}
```

### POST `/api/admin/robinhood/stock-graduation-registry/sync`

Body:

```json
{ "reason": "operator reason" }
```

Fetches official Robinhood `GET https://api.robinhood.com/rhj/assets`, imports exact `chainId=4663` deployments, marks disappeared historical deployments noncanonical instead of deleting them, then runs the minimal health refresh.

### POST `/api/admin/robinhood/stock-graduation-registry/rescan`

Body:

```json
{ "reason": "operator reason" }
```

Runs minimal health refresh for registry rows. Bulk sync/rescan are system-derived refresh operations; optimistic `expectedVersion` applies to row-targeting mutations below.

### POST `/api/admin/robinhood/stock-graduation-registry/:id/rescan`

Body:

```json
{ "expectedVersion": 12, "reason": "optional rescan note" }
```

Returns the same detail envelope as GET detail. If the row changed since it was displayed, returns `409 STATE_VERSION_CONFLICT`.

### POST `/api/admin/robinhood/stock-graduation-registry/:id/enable`

Body:

```json
{ "expectedVersion": 12, "reason": "required operator reason" }
```

Sets `adminState=force_enabled` only if hard safety is currently satisfied. This cannot override noncanonical/inactive/halted/stale/unhealthy/no-route/no-code conditions.

### POST `/api/admin/robinhood/stock-graduation-registry/:id/disable`

Body:

```json
{ "expectedVersion": 12, "reason": "required operator reason" }
```

Sets `adminState=force_disabled`. This disables only NEW graduation eligibility. It does not set `existingMarketSupport=false`.

### POST `/api/admin/robinhood/stock-graduation-registry/:id/clear-override`

Body:

```json
{ "expectedVersion": 12, "reason": "optional operator note" }
```

Returns the row to `adminState=default` and server-derived candidate/health policy.

## Public creator route

### GET `/api/robinhood/stock-tokens?chainId=4663`

Response `200`:

```json
{
  "ok": true,
  "chainId": 4663,
  "source": "robinhood_stock_token_registry",
  "items": ["RegistryItem"],
  "updatedAt": "ISO-8601"
}
```

The Create picker may use `enabledForDiscovery` for visibility and MUST use `enabledForGraduation` as the selectable graduation eligibility returned by the server. It must not add a source-code allowlist.

## stateVersion semantics

`stateVersion` is a monotonically increasing per-registry-row optimistic concurrency token. Agent 4 sends the currently displayed value as `expectedVersion` for row-targeting POST actions. Successful row changes return a higher version. A stale value returns HTTP `409`; Agent 4 should refetch the item and present the current server state rather than retrying blindly.

## Status/error codes

- `200` success.
- `400 EXPECTED_VERSION_REQUIRED` missing/invalid row mutation version.
- `400 REASON_REQUIRED` missing required manual reason.
- `401` invalid/missing admin Bearer session.
- `403` authenticated user is not a dashboard admin.
- `404 REGISTRY_ENTRY_NOT_FOUND` unknown id.
- `404 REGISTRY_ACTION_NOT_FOUND` unknown action.
- `409 STATE_VERSION_CONFLICT` stale optimistic version.
- `503 ROBINHOOD_STOCK_REGISTRY_ADMIN_FAILED` admin operation/canonical sync/live health unavailable.
- `503 ROBINHOOD_STOCK_REGISTRY_UNAVAILABLE` public DB registry unavailable.

Create authorization continues to surface stock eligibility failures through the existing `/api/routing/create-authorization` contract as `409 STOCK_CREATE_POLICY_BLOCKED`.

## Agent 4 mechanical alignment

Only align `src/hooks/useRobinhoodStockGraduationRegistry.ts` to the routes/envelopes above. No page redesign is required.

## Explicitly deferred

Sophisticated health scoring, multi-DEX aggregation, DEX 24h ranking, historical liquidity, automatic top-N ranking, full safe-graduation-capacity analytics, UI charts, and notifications are follow-up work and are not part of this release contract.
