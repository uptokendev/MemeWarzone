# One import, one token page — build brief (for Grok)

Owner: founder. Date: 2026-09-24. Branch: `build/robinhood-full-expansion`.

## Decision (founder, 2026-09-24)

There is **one** way to bring an existing memecoin onto MemeWarzone: the Project Import the
sidebar already calls "Import your memecoin". Every imported token, old or new, gets the
**official Token Details page** with a chart and in-app trading through the DEX it already lives
on, and ownership is claimed **on that page**. The separate "Arena import" card and its
separate token page go away. Battle eligibility stays a fact the admission scan decides; it is
no longer a second form the user fills in.

## What exists (reuse; do not rebuild)

| Piece | Where | Notes |
|---|---|---|
| The only table | `public.arena_token_imports` | Both flows already write it. Ownership columns from `db/migrations/20260908_000001_project_import_onboarding.sql` (`ownership_status`, `project_owner_wallet`, `manual_claim_wallet`); admission columns from the arena side (`status` passed / needs_review / declined / scanning, `scan_json`, `scan_version`, `scanned_at`); profile columns (`image_url`, `description`, `website`, `x_url`, `telegram_url`). |
| Project Import entry | `frontend/src/pages/ProjectImport.tsx` (`ProjectImportPanel`, embedded in `pages/command-center/CommandCenterCoins.tsx`); API `frontend/api/projectImports.js` (`handleCreate`: `resolveProjectToken` → `scanProjectImportSecurity` → `assessProjectImport` → `createProjectImport` in `lib/projectImportCore.js`), wallet action `project_import_create` | Keep as the single entry. It already navigates to `/token/<address>?chainId=&claim=prompt`. |
| Ownership claim | `frontend/src/components/imports/ProjectXClaimDialog.tsx`, `frontend/api/projectImportXClaim.js`, manual review in `frontend/api/lib/projectOwnershipReview.js`; dashboard `ProjectOwnershipClaimsPage` | Unchanged. It moves onto the token page as a banner + the same dialog. |
| Admission scan | `frontend/api/arenaImports.js` (`scanToken` → `lib/arenaImportScan.js` `scanEvm` / `scanSolana`; `scan.status`, trusted metadata), manual review request `POST /api/arena/imports/:id/request-review` (wallet action `arena_import_request_review`); dashboard `ArenaImportsReviewPage` | Keep the scan and the review; drop the user-facing submit form. |
| Trading for imported tokens | `frontend/src/components/arena/ImportedTradePanel.tsx`: BNB via Topaz (`lib/arenaImportedTopaz.ts`: route resolution, quote, buy/sell, allowance), Solana via Meteora (`lib/solanaMeteoraTrade.ts`) | Robinhood imports have **no** swap path today: `lib/robinhoodV3Trade.ts` resolves routes by campaign address only. See D. |
| Token page today | `pages/TokenDetailsEntry.tsx` intercepts project imports → `pages/ImportedProjectDetails.tsx` (ownership page, no trading by design); otherwise `pages/TokenDetailsLiveEntry.tsx` → `pages/ImportedTokenDetails.tsx` (trade panel + admission status) for arena imports, else the launched `TokenDetails` | Two pages for one address. This is what the founder wants gone. |
| Chart | `components/token/UnifiedMarketChart.tsx` (`marketCandles`, `marketState`, `livePriceNative`, `liveMcapNative`, `nativeUsdPrice`, …) | Built for launched tokens; needs a candle source for imports (see C). |
| Market facts for an import | `GET /api/arena/imports/profile?tokenAddress=&chainId=` (`fetchArenaTokenProfile`), `lookupArenaImport`, `lookupProjectImport` (`ProjectImportItem` already carries `arenaStatus`) | The unified page reads one item: the project import item plus the admission fields. |
| Live data | 16 imports on production, all Solana, all `status = scanning`, 12 `ownership_verified`, 4 `ownership_pending` | The admission scan never ran for rows created by Project Import. They must not lose anything. |

## What to build

### A. One entry

- `CommandCenterCoins.tsx`: remove the **"Imported coins"** card (lines around `title="Imported coins"` up to "My Coins"); keep `ProjectImportPanel` embedded and "My Coins".
- `projectImports.js` `handleCreate`: after `assessProjectImport`, run the admission scan
  (`scanToken` from `arenaImports.js`, moved into a shared lib so both files import it) and store
  `status = scan.status`, `scan_json`, `scan_version`, `scanned_at`, plus the trusted metadata the
  arena path stores when the row has none. One transaction with the ownership write
  (`withImportTransaction`). A failed scan is `needs_review`, never a failed import.
- A one-off, idempotent backfill script (`frontend/scripts/backfill-import-admission.mjs`, same
  env loading as `verify-quote-catalog.mjs`) that runs the admission scan for every row still at
  `scanning`. The founder runs it in the API container after deploy. Print per-row results.
- Delete the public `POST /api/arena/imports` create route and `submitArenaImport` /
  `uploadArenaImportImage` on the client if nothing else uses them; keep `lookup`, `profile`,
  `request-review` and the admin routes.

### B. One token page

- Replace `ImportedProjectDetails` and `ImportedTokenDetails` with one `ImportedTokenPage` rendered
  by `TokenDetailsEntry` for any `arena_token_imports` row, with the **launched token page's layout**:
  1. Header: identity (name, symbol, address copy, share), chain, ownership pill (VERIFIED / claim
     pending), admission pill (Arena: scanning / eligible / needs review / declined).
  2. Chart (C) and the trade panel (`ImportedTradePanel`, unchanged) side by side, exactly where a
     launched token shows them. Trading is available as soon as a pool resolves and the security
     scan found no honeypot / blocked transfer (`scanProjectImportSecurity` result), **independent of
     ownership and of admission**.
  3. Claim banner when `ownershipStatus` is `ownership_pending` or `ownership_manual_review`:
     "Is this your project? Claim it" → `ProjectXClaimDialog` (same dialog, same manual fallback).
     `?claim=prompt` opens it on arrival, as today.
  4. Owner profile section (description, website, X, Telegram, image) editable only by the verified
     owner wallet, lifted from `ImportedProjectDetails` (`project_import_metadata` action).
  5. Arena strip: eligible → the Battle Wall / War Room actions the launched page shows;
     needs_review / declined → the "request manual review" control from `ImportedTokenDetails`
     (`arena_import_request_review`); scanning → "Arena check running".
  6. Missing image no longer hides the page. It shows a placeholder and the owner prompt to add one.
- `TokenDetailsLiveEntry` stops looking up arena imports; `TokenDetailsEntry` is the single switch.

### C. Chart data for imports

Use the indexer's DEX candles when the token's pool is indexed (the same feed the launched
post-graduation chart reads), otherwise the market snapshot from `/api/arena/imports/profile`
(price, market cap, liquidity, 24 h volume) as `marketState` with an empty candle set and a
"Chart appears once trades are indexed" note. Do not invent candles client-side.

### D. Robinhood imports: trading

`ImportedTradePanel` has no Robinhood branch. Add one on top of `lib/robinhoodV3Trade.ts` by
resolving the WETH/token Uniswap V3 pool from the V3 factory
(`VITE_ROBINHOOD_V3_FACTORY_ADDRESS_4663`, fee tiers 500 / 3000 / 10000) and quoting through the
same adapter the launched page uses. If that cannot be done cleanly in this change, keep the
panel hidden on 4663 with the copy "Trading on Robinhood imports arrives next", and say so in the
PR. Robinhood imports remain behind `VITE_ENABLE_PROJECT_IMPORT_ROBINHOOD` (on in production).

## Rules

- No changes to contracts, to the Topaz / Meteora swap execution code, to wallet-action message
  lines, or to the ownership review logic. The claim dialog is reused, not rewritten.
- Additive DB changes only, as migrations in `db/migrations/`. Nothing here should need one.
- Existing tests to update, not delete: `frontend/src/project-imports-ui.test.mjs`,
  `imported-token-details-page.test.mjs`, `project-import-identity-ui.test.mjs`,
  `robinhood-import-gate.test.mjs`. The pin "imported page mounts no trading, Arena, paid
  discovery" flips by decision; replace it with pins for the new page: trading present, claim
  banner when pending, arena strip by admission status, single entry in Command Center.
- New pure helpers get `node --test` files next to them. `eslint` clean; `vite build` passes.

## Acceptance (founder, on the live app after deploy)

1. Command Center → Coins shows one import form. Importing a token lands on `/token/<address>`
   with the chart, the trade panel and, if unclaimed, the claim banner.
2. The 16 existing imports open that same page; the 12 verified ones show VERIFIED and the
   owner can edit the profile; the 4 pending show the claim banner.
3. A buy and a sell of an imported BNB token through the page succeed; same on Solana.
4. Admission: a clean token shows "eligible" after the scan; a flagged one shows "needs review"
   with the request button; the dashboard's Arena Imports Review page still lists it.
5. No "Arena import" wording remains anywhere in the app.
