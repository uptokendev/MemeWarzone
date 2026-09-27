# Warzone cards + imported token page — build brief (for Grok)

Owner: founder. Date: 2026-09-27. Branch: `build/robinhood-full-expansion` (push the same commits to
`build/cross-chain-stabilization-rh-base`, which auto-deploys the live app).

Three parts, **A → B → C, one commit each, in that order.** Pull first: the chart work for Part C (`4d4397cf`) is already on the branch. Do exactly what is written. If something
here is impossible or wrong, **stop and report it — do not work around it, do not improve anything
else.**

---

## Rules for this brief (read first — these are not suggestions)

1. **Scope is the file list of each part.** Each part names the files you may edit. Touching any
   other file is out of scope, even "while you are there". If you believe another file must change,
   stop and say which and why.
2. **Never touch these files, in any part:**
   - `frontend/src/components/arena/BattleWallCombatant.tsx`, `BattleWallModule.tsx`,
     `BattleWallCombatControls.tsx` (the battle cards; pinned by `battleWallPresentation.test.mjs`).
   - `frontend/src/components/home/FeaturedCampaignCard.tsx` and
     `frontend/src/components/home/SafeFeaturedCampaigns.tsx` (the front page).
   - `frontend/src/pages/TokenDetails.tsx` (our own token page is the **reference**, not the patient).
   - Anything under `frontend/api/`, `realtime-indexer/`, `contracts/`, `programs/`, `scripts/`,
     `db/`, and every trade/transaction path (`ImportedTradePanel.tsx`, `lib/arenaImportedTopaz.ts`,
     `lib/solanaMeteoraTrade.ts`, any `*V0*`, `*Trade*`, `*Swap*` module). **No API, database,
     contract or transaction change is part of this brief.**
3. **No refactors, no renames, no "cleanup", no new dependencies, no new colours or fonts.** Use the
   class strings quoted below verbatim. Do not reformat files you edit (no Prettier over whole files).
4. **Do not change a test to make it pass.** If an existing assertion fails, your change is wrong
   unless this brief explicitly says that assertion changes (it says so where it does).
5. **No data is invented.** A value we do not have shows `—`. Never show a placeholder number, a
   mock, or one field under another field's label.
6. **Checks before every commit** (all must pass; paste the output in your report):
   ```
   cd frontend
   node --test src/lib/arena/*.test.mjs src/imported-token-details-page.test.mjs
   npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -v "src/pages/Arena.tsx(1[0-9][0-9],15): error TS2322"   # that one error predates this brief
   npx vite build
   ```
7. **Report per part:** files changed (must be a subset of the part's list), the check output, and
   a screenshot of the result at desktop width (≥1280px) and phone width (390px).

---

## Part A — Featured memecoins on the Warzone overview show their metrics

**Founder:** "the featured doesn't have the metrics."

**Today:** `frontend/src/pages/Arena.tsx`, section `data-warzone-featured`. Each card is rendered by
`FeaturedArenaCoinCard` (defined at the top of `Arena.tsx`), which wraps the front page's
`FeaturedCampaignCard` and already resolves the image through `useArenaTokenProfile(chainId,
tokenAddress)`. It passes `mcapUsdLabel={null}` and `athUsdLabel="—"`, so both boxes read `—`.

**Data that exists** (no API change): `useArenaTokenProfile` returns `ArenaTokenProfile`
(`frontend/src/lib/arenaImports.ts`) with `marketCapUsd: number | null`. Live example: Derpy Dave
(chain 101, `2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS`) → `marketCapUsd 61496`. There is **no
ATH field** for any token in this profile.

**Build (only `frontend/src/pages/Arena.tsx`):**
1. Move the `useArenaTokenProfile` call in `FeaturedArenaCoinCard` so it runs **always** (not only
   when `imageUrl` is missing) — the card needs market cap even when the feed has an image. Keep the
   image rule: `imageUrl || profile?.imageUrl`.
2. `mcapUsdLabel`: `profile?.marketCapUsd` formatted with `formatCompactUsd` from
   `@/lib/arena/battlePresentation` (the same formatter the battle cards use); `null` when the
   profile or the field is missing (the card then shows `—` itself).
3. `athUsdLabel`: the front page's rule, `max(current market cap, indexed ATH)`. The profile has no
   indexed ATH, so this is the current market cap when there is one, else `"—"`. Write it as a small
   local function `athLabel(marketCapUsd)` in `Arena.tsx` with a one-line comment saying the profile
   carries no ATH yet.
4. Remove the two props from the call site that hard-code them (`mcapUsdLabel={null}`,
   `athUsdLabel="—"`); `FeaturedArenaCoinCard` computes them.

**Done when:** on `/warzone` with Solana selected, Derpy Dave's card shows MCAP `$61.5K`-style and ATH
the same value; a coin whose profile has no market cap shows `—` in both. Nothing else on the page
changes.

---

## Part B — League cards look like the battle cards

**Founder:** "the cards for the leagues are different from the look of the cards in the battles. We
need it to be consistent."

**Reference (do not edit):** `frontend/src/components/arena/BattleWallCombatant.tsx`. Its look:
- Outer: `mwz-flat-card relative flex h-auto max-h-[22rem] min-w-0 overflow-hidden`; leader accent
  `border-orange-400/45`.
- Blurred art bleed behind everything: `WarzoneDecorativeLayer` with an `<img>` class
  `absolute inset-0 z-0 h-full w-full scale-110 object-cover object-left opacity-[0.16] blur-[12px]`
  plus the readability gradient `absolute inset-0 z-0 bg-[linear-gradient(90deg,rgba(5,5,5,0.28)_0%,rgba(5,5,5,0.72)_48%,rgba(5,5,5,0.92)_100%)]`.
- Split body: `relative z-10 grid min-h-0 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-stretch`.
- Art pane left, full card height, square: `relative aspect-square h-0 min-h-full w-auto shrink-0 self-stretch overflow-hidden`,
  image `h-full w-full object-cover object-center`, initials fallback as in `CombatantArtwork`, and
  the small corner badge `absolute left-1 top-1 bg-black/65 px-1 py-0.5 font-retro text-[8px] uppercase tracking-[0.14em] text-white/80 md:left-1.5 md:top-1.5 md:px-1.5 md:text-[9px] md:tracking-[0.16em]`.
- Right pane: ticker (`truncate font-retro text-base leading-none text-foreground sm:text-xl md:text-2xl lg:text-[1.65rem]`),
  name (`mt-0.5 block truncate text-[10px] uppercase tracking-[0.14em] text-white/58 md:mt-1 md:text-[11px] md:tracking-[0.16em]`),
  then a 2×2 grid `grid w-full grid-cols-2 gap-1 sm:gap-1.5` of `MetricBox`es (label 7–8px uppercase,
  value `font-retro` tabular).

**Today:** `frontend/src/components/warzone/WarzoneRankCard.tsx` — a plain card with a small
`WarzoneTokenMark`, ticker, name, `N PTS`, `W / L`. Used in exactly two places: the Major War League
card on `frontend/src/pages/Arena.tsx` (podium, top 3) and the "Top command" podium on
`frontend/src/pages/PostGradLeague.tsx` (`first`, `second`, `third`). Both already pass `chainId`
and `tokenAddress`.

**Build (only these files):**
- `frontend/src/components/warzone/WarzoneRankCard.tsx` — rewrite the component's markup in the
  battle card's language above. **Keep its props exactly** (`rank, imageUrl, symbol, name, points,
  wins, losses, chainId, tokenAddress`) so neither caller changes.
  - Corner badge on the art: `#1`, `#2`, `#3`. Rank 1 keeps the crown (`Crown` from `lucide-react`,
    `h-3.5 w-3.5 text-orange-300`) next to the ticker, and the leader accent `border-orange-400/45`
    on the outer card.
  - Art: `imageUrl`, else `useArenaTokenProfile(chainId, tokenAddress)?.imageUrl`, else the
    initials fallback. Bleed layer only when there is a usable image (same rule as the battle card).
  - Four metric boxes, in this order: `PTS` (points), `W / L` (`${wins} / ${losses}`), `MCAP`
    (profile `marketCapUsd` via `formatCompactUsd`), `HOLDERS` (profile `holders`, `toLocaleString()`).
    Missing value → `—` with the dimmed style the battle card uses for not-ready values.
  - **No links inside the card.** Both callers already wrap the whole card in a link; a link inside a
    link is invalid HTML. (This is the one deliberate difference from the battle card, whose ticker is
    a link.)
  - No `actions` row (the battle card's bottom bar holds battle buttons; leagues have none).
  - Copy the `MetricBox` and initials-fallback markup into this file as local functions. **Do not
    import from or export out of `BattleWallCombatant.tsx`** (rule 2).
  - Keep the attribute `data-warzone-rank-card={rank}` on the outer element and add
    `data-warzone-rank-card-layout="split"`.
- `frontend/src/lib/arena/warzoneLeagueChainAndArt.test.mjs` — this test pins
  `chainId={chainId} tokenAddress={tokenAddress}` on `WarzoneTokenMark` inside `WarzoneRankCard`.
  Your rewrite no longer uses `WarzoneTokenMark` there, so replace **only that one assertion** with
  one that pins `useArenaTokenProfile(chainId, tokenAddress)` and `data-warzone-rank-card-layout="split"`
  in `WarzoneRankCard.tsx`. Leave every other assertion in that file as it is.

**Layout check:** the overview's MWL column is one third of the page at `lg`; the card must not
overflow it (the right pane truncates, the metric grid stays 2×2). On `PostGradLeague` the podium is
`grid gap-3 md:grid-cols-3`; unchanged.

**Done when:** on `/warzone` (Solana) and `/warzone/major-war-league` the ASK and DERPYDAVE cards
look like the fighters on the Battle Wall (square art left, blurred bleed, ticker/name, 2×2 metric
boxes) with rank badges, the crown on #1, points and W/L correct (ASK 3 PTS 1/0, DERPYDAVE 1 PTS 0/1),
MCAP and HOLDERS from the profile. The Battle Wall itself is byte-for-byte unchanged
(`git diff --stat` shows no file under `components/arena/BattleWall*`).

---

## Part C — The imported token page uses the same layout as our own token page

**Founder:** "the tokendetails page is inconsistent with the page for our own tokens. I want the same
layout."

**Reference (do not edit):** `frontend/src/pages/TokenDetails.tsx`, the render starting at line 4414.
**The page you change:** `frontend/src/pages/ImportedTokenPage.tsx` (≈650 lines). The route decides
between them in `pages/TokenDetailsEntry.tsx`; **do not touch the entry file.**

**Already done, keep exactly as it is:** the chart data. Since `4d4397cf` the imported page loads the
import's own DEX history from `fetchArenaImportCandles` (state `chartResolution`, `usdCandles`,
`candleState`, the `useEffect` that loads/refreshes them, `importUsdCandlesToChart`, and the
`resolution` / `onResolutionChange` props on `UnifiedMarketChart`). Move the chart's JSX where Part C
says; do not change those names, the effect, or the props.

**Files you may edit:** `frontend/src/pages/ImportedTokenPage.tsx` and
`frontend/src/imported-token-details-page.test.mjs` (only the assertions this part names). Nothing else.

### Target layout, top to bottom (mirror the reference; class strings are quoted verbatim from it)

1. **Page wrapper.** Replace `<ContentContainer className="space-y-5 px-1 pb-12 pt-2">` with the
   reference wrapper `<div className="w-full flex flex-col px-3 md:px-6 gap-3 md:gap-4 pb-24 xl:pb-0">`
   (TokenDetails 4415). Remove the `ContentContainer` import if it becomes unused.

2. **Hero card** (TokenDetails 4445–4755). Replace the `mwz-hud-frame p-5` hero with:
   - `Card className="overflow-hidden bg-card/30 backdrop-blur-md rounded-2xl border border-border p-0 xl:min-h-[220px] shrink-0"`
     → `div className="grid grid-cols-1 xl:grid-cols-[220px_minmax(0,1fr)] items-stretch xl:min-h-[220px]"`.
   - **Art cell**: `div className="relative min-h-[180px] bg-muted/20 xl:min-h-[220px] overflow-hidden shrink-0"`
     with the image `className="h-full w-full object-contain object-center"`. Keep `data-project-image="true"`
     on the `<img>` and keep the owner's image-edit button (`data-owner-image-edit="true"`) overlaid
     in the art cell's corner.
   - **Right side**: `div className="min-w-0 flex flex-col justify-start gap-2 p-3 md:p-4 xl:p-5"`, then
     the **identity strip** `div className="rounded-2xl border border-border/60 bg-muted/15 px-4 py-2.5 md:px-4 md:py-2.5 min-h-0"`
     → `div className="flex flex-wrap items-center gap-2 md:gap-2.5 xl:flex-nowrap xl:justify-start xl:gap-2 xl:overflow-x-auto"`
     holding, left to right, in the reference's order:
     `h1` name (`text-lg md:text-2xl font-retro text-foreground whitespace-nowrap`, keep `data-project-name`),
     ticker (keep `data-project-ticker`),
     the **IMPORTED** badge (keep `data-imported-badge`) where the reference shows its stage pill,
     the VERIFIED/UNVERIFIED ownership pill and the arena admission `TacticalTag` (unchanged markup),
     the owner avatar link (in the reference's creator slot),
     social **icon** buttons for website / X / Telegram in the reference's `h-7 w-7` icon style
     (copy the markup of the reference's Globe / X / TG buttons; keep `data-project-socials` on
     their wrapper; hide a button when its link is empty),
     the copy-address pill in the reference's `rounded-full border border-border/50 bg-muted/20 px-2 py-1` style,
     Favourite star, `ArenaUpvoteDialog tokenAddress chainId` (moved here from the right column;
     keep the `postGradFlags.arena` condition), Share (keep `data-project-share` and today's
     behaviour — **not** `TokenShareCardModal`), Report, then CLAIM MEMECOIN
     (keep `data-project-claim-action="true">CLAIM MEMECOIN`, same `canClaim` condition) and EDIT
     (same `canEdit` condition), and the CrypticPump badge / list button with its existing conditions.
   - Keep the text `Imported token — no bonding curve` and the Chain / Mint|Contract lines
     (`data-project-chain`, `data-project-address`) as one line under the strip, small muted text.
   - **Five stat tiles** under the strip, exactly the reference grid
     `div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:w-full xl:max-w-[920px] xl:grid-cols-5"`,
     each tile `rounded-xl border border-border bg-muted/20 px-3 py-2`, label
     `text-[10px] text-muted-foreground uppercase tracking-wide`, value
     `mt-0.5 text-sm md:text-[15px] font-retro text-foreground break-words`:
     **Market cap** (`profile.marketCapUsd`), **Price** (`profile.priceUsd`, sub-label `Spot`),
     **Volume** (`profile.volume24hUsd`, sub-label `24h`), **Liquidity** (`profile.liquidityUsd`),
     **Holders** (`profile.holders`, `toLocaleString()`, tile `col-span-2 md:col-span-1`).
     Use the page's existing `formatUsd`. Missing → `—`.

3. **Claim banner** (`data-import-claim-banner`, "Is this your project? Claim it") and the no-image
   hint ("Add a project image from the owner tools") stay, directly under the hero, unchanged.

4. **Main grid** stays `grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-3 md:gap-4 items-start`.
   **Left column** `div className="min-w-0 flex flex-col gap-3 md:gap-4"`:
   - **Chart card, standalone** (TokenDetails 4759): `Card` with
     `bg-card/30 backdrop-blur-md rounded-2xl border border-border p-0 overflow-hidden flex flex-col min-h-[360px] h-[360px] md:min-h-[420px] md:h-[420px] xl:min-h-[520px] xl:h-[520px]`.
     The `UnifiedMarketChart` fills it (`flex-1 min-h-0` wrapper). Keep its current props. Put
     `chart.emptyNote` (when not null) as a small line at the top of this card. No expand button, no
     AthBar, no USD/native toggle (the import chart is USD only).
   - **Activity card** (TokenDetails 4875): `Card className="bg-card/30 backdrop-blur-md rounded-2xl border border-border p-4"`,
     `TabsList className="grid w-full grid-cols-3 mb-3 bg-transparent p-0 h-auto gap-2"`, triggers
     `ctaTabsTriggerClass`, tabs **Overview / Trades / Community** (the reference's labels):
     - **Overview**: the description box in the reference's style
       `rounded-2xl border border-border bg-muted/10 px-4 py-4` (keep `data-project-description`).
       No Campaign Intel / Flywheel / Holder accordion (launchpad data an import does not have).
     - **Trades**: today's trades content minus the four stat tiles (they moved to the hero). Keep the
       empty text `Trades appear here once this pool is indexed` and its DEX / explorer links.
     - **Community**: `TokenComments chainId campaignAddress={item.tokenAddress} tokenAddress={item.tokenAddress} mode="comments"`,
       exactly as today.
   **Right column** `div className="xl:sticky xl:top-[80px] xl:-mt-px self-start"` (was not sticky):
   - **Trade card**: `Card className="bg-card/30 backdrop-blur-md rounded-2xl border border-border p-4"`
     with a `text-sm font-semibold` "Trade" title and `ImportedTradePanel` **unchanged** (or the
     honeypot note, unchanged condition). **Do not edit `ImportedTradePanel.tsx`.**
   - **War Room card**: `Card className="mt-3 bg-card/30 backdrop-blur-md rounded-2xl border border-border p-4"`,
     header `h3 "War Room"` + `p "Live campaign chat"` exactly as TokenDetails 5548–5554, then
     `TokenWarRoom` with today's props and today's show condition.
   - **Project card** (owner tools): same `Card … mt-3 … p-4` class, holding the owner profile editor
     (`data-owner-profile-editor`, `data-owner-edit-controls`) — only the editor; the description moved
     to Overview.
   - **Arena card**: same `Card … mt-3 … p-4` class, holding today's arena strip content unchanged
     (`data-import-arena-strip`, "Challenge this coin", the competition note, REQUEST MANUAL CHECK).

5. Footer disclaimer and `ChallengeCoinModal` stay at the end, unchanged.

**Not in scope** (leave out, do not stub): mobile sticky header, `MobileTradeDock` / `MobileTradeSheet`,
`GraduationExplosion`, graduation progress, "Your Position", Creator Updates, the share-card modal,
AthBar, per-timeframe % changes. Trades-tab data for imports is a separate backend task.

### Tests (`frontend/src/imported-token-details-page.test.mjs`)

Every assertion in that file must still pass, **except** these, which change on purpose:
- `>Chart<` → the chart is no longer a tab. Replace with an assertion that `UnifiedMarketChart` sits
  in a `Card` whose class contains `xl:h-[520px]`.
- `>Comments<` → replace with `>Community<`.
Add assertions for: the hero grid string `xl:grid-cols-[220px_minmax(0,1fr)]`, the five-tile grid
string `xl:grid-cols-5`, the sticky right column `xl:sticky xl:top-[80px]`, and `>Overview<`.
**All other assertions stay byte-for-byte** (the data attributes, ownership pill strings, `canClaim`,
`canEdit`, CrypticPump conditions, claim banner, arena strip, trade panel, `Imported token — no bonding curve`,
`Trades appear here once this pool is indexed`, and everything about `TokenDetailsEntry`).

**Done when:** `/token/2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS?chainId=101` (Derpy Dave) and any
own launchpad token page, side by side at 1440px, have the same hero shape (art left 220px, identity
strip, five tiles), the same chart card height, the same Overview / Trades / Community card, and the
same sticky right column with Trade then War Room; the chart still shows Derpy Dave's history and its
timeframe buttons still work; the checks in rule 6 pass.
