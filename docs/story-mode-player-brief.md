# Story Mode: the player — build brief (for Grok)

Owner: founder. Date: 2026-09-28. Branch: `build/robinhood-full-expansion`; push every commit to both
`build/robinhood-full-expansion` **and** `build/cross-chain-stabilization-rh-base` (live, auto-deploys).

**Start after `docs/warzone-cards-token-page-brief.md` Parts B and C are merged.** Pull first.

Do exactly what is written. If something here does not fit the code, **stop and report it — do not
work around it and do not improve anything else.**

---

## The founder's bar

"Something with animations, a flow, a feeling, an experience. A website inside a website." Every coin
gets a full-screen story that plays like **Instagram / X stories**: tap right for the next chapter, tap
left to go back, hold to pause, swipe. Two voices, always visibly different:

- **Creator** chapters: the creator's own words (stamp in the coin's accent colour).
- **Chronicle** chapters: facts MemeWarzone records on chain (orange ember stamp).

Launched coins have at most **10** chapters, imported coins at most **8**.

## What already exists (reuse, do not rebuild)

| Piece | Where | Notes |
|---|---|---|
| **The contract** | `frontend/shared/storyContract.mjs` | The only shape a story has. `STORY_CHAPTER_KINDS` (12 kinds), `validateStory(story)`, `emphasisParts(text)`, `STORY_MAX_CHAPTERS`. Import it; do not copy it. |
| **Two real stories** | `frontend/shared/fixtures/story-k88.json` (launched, 10 chapters), `story-derpydave.json` (imported, 8) | Build and test the player on these. Every one of the 12 kinds except `text` style `plain`/`words` appears in them. |
| **The look and motion** | `docs/story-mode/prototype-player.html` (generic, data-driven) and `docs/story-mode/prototype-k88.html` (the K88 original) | Open them in a browser. They are the reference for layout, colours, type, and every animation. Port them; do not redesign them. |
| Fonts | Bungee (display), Barlow Condensed (body), JetBrains Mono (labels) | Load them the way the app loads its other Google fonts. |
| Animation | `framer-motion` is already a dependency | Use it or plain CSS keyframes as in the prototype. **No new dependencies.** |
| Token pages | `pages/TokenDetails.tsx` (our coins), `pages/ImportedTokenPage.tsx` (imports) | You add one button to each (section D). |

**The API is not yours.** Claude builds `GET /api/story?chainId=&token=` in parallel. It returns
exactly the fixture shape. Until it is live, the player runs on the fixtures (section C).

---

## Rules (not suggestions)

1. **Files you may create:** everything under `frontend/src/components/story/` and
   `frontend/src/lib/story/`, plus `frontend/src/pages/StoryPage.tsx` and
   `frontend/src/components/story/story-player.test.mjs`.
   **Files you may edit, only as section D says:** `frontend/src/App.tsx` (one route),
   `frontend/src/pages/TokenDetails.tsx` (one button), `frontend/src/pages/ImportedTokenPage.tsx`
   (one button). Nothing else. Never `frontend/shared/storyContract.mjs` or the fixtures: if the
   contract is wrong, stop and say so.
2. **Never render HTML from a story.** No `dangerouslySetInnerHTML` anywhere under
   `components/story/`. Text with `*emphasis*` goes through `emphasisParts()` and renders as React
   text nodes. Links come only from `call.ctas[].href` and `trades.items[].txUrl`: internal paths
   (`/…`) use `<Link>`, `https://` open in a new tab with `rel="noreferrer"`.
3. **Nothing leaves the frame.** This is the founder's own finding on the prototype ("Derpy Dav / e").
   - A word never breaks inside itself. Title letters animate per letter but are grouped per word
     (`white-space: nowrap` on the word).
   - After a chapter mounts (and on resize), every large text (title, big number, clock, war-cry line)
     shrinks until it fits its box's width, then the whole chapter shrinks until it fits the frame's
     height. Copy the `fitSlide` logic from `prototype-player.html`.
   - Count-up numbers are measured at their final value, not at 0.
   - Check every chapter of both fixtures at **360×640, 390×844, 430×932** and the desktop frame.
4. **No AI-sounding copy.** The only fixed strings you add are `TAP TO BEGIN →`, `TAP LEFT TO REPLAY`,
   `Enter the story`, `Close`, and the paused marker. No em dashes (—) anywhere in UI text you write.
   All story text comes from the API / fixtures; never write or "improve" it.
5. **No refactors, no renames, no new dependencies, no reformatting files you edit.**
6. **Do not change a test to make it pass** unless this brief names that test.
7. **Checks before every commit** (paste the output in your report):
   ```
   cd frontend
   node --test shared/storyContract.test.mjs src/components/story/story-player.test.mjs src/lib/arena/*.test.mjs src/imported-token-details-page.test.mjs
   npx tsc --noEmit -p tsconfig.app.json
   npx vite build
   ```
8. **Report:** files changed (must be inside rule 1), check output, and a screen recording or
   screenshots of every chapter of both fixtures at 390×844 plus one desktop view.

---

## What to build

### A. The player: `components/story/StoryPlayer.tsx`

- Props: `story: StoryResponse`, `onClose: () => void`.
- Full-screen overlay rendered in a portal above the app (`z-index` above the app shell), body scroll
  locked while open. On desktop (≥ 860px) the story sits in a centred 9:16 frame
  (`height: min(94vh, 860px)`, rounded 22px) on a dark backdrop; on phones it is edge to edge, with
  safe-area insets respected (see the prototype's `env(safe-area-inset-*)`).
- Top: one progress bar per chapter; header with the coin logo, name, `$TICKER · chainLabel`, a
  `n / total` pill and a **Close** button (top right, 44×44 hit area).
- Navigation exactly as the prototype: left third = previous, right two thirds = next, hold ≥ 220 ms =
  pause, horizontal swipe > 60 px = next/previous (and must not also count as a tap), ← → keys, space =
  pause, **Esc = close**. Pause when the tab is hidden.
- Auto-advance after each chapter's `durationMs`; the last chapter stays (no loop).
- Colours: set `--accent` / `--accent-2` on the player root from `story.coin.accent` / `accent2`.
  Everything else uses the prototype's fixed palette.
- `prefers-reduced-motion`: no motion, all text visible immediately, auto-advance still works.

### B. The scenes: `components/story/scenes/`

One component per kind in `STORY_CHAPTER_KINDS`, registered in one map
(`components/story/sceneRegistry.ts`: `kind -> component`). Each ports the matching part of the
prototypes:

| kind | Prototype reference | Fields it reads |
|---|---|---|
| `cover` | `prototype-player` cover (halo, rising logo, per-letter slam) | `kicker`, `quote`; coin `name`, `ticker`, `logoUrl`, `logoAnimated` |
| `text` | `prototype-k88` chapters 2 and 3; `style`: `sonar` (rings + bubbles), `candle` (candles + one growing candle), `words` (word-by-word reveal), `plain` | `heading`, `body` |
| `warcry` | `prototype-k88` chapter 4 (stomp + shake) | `lines` |
| `moment` | `prototype-player` clock scene (+ seal when `seal` is set) | `date`, `time`, `title`, `sub`, `seal`, `lede` |
| `counts` | `prototype-player` stats scene | `date`, `title`, `sub`, `rows[]` (`value`, `decimals`, `prefix`, `suffix`, `label`, `tone`), `lede` |
| `trades` | `prototype-k88` chapter 7 | `items[]` (`offsetLabel`, `amount`, `decimals`, `unit`, `wallet`, `note`, `txUrl`, `tone`) |
| `clan` | `prototype-k88` chapter 8 (dots) | `title`, `sub`, `holding`, `exited`, `lede` |
| `progress` | `prototype-k88` chapter 9 | `title`, `percent`, `fromLabel`, `toLabel`, `rival`, `lede` |
| `chart` | `prototype-player` chart scene (line draws, area fades, low/high pins) | `title`, `sub`, `points`, `low`, `high`, `fromLabel`, `toLabel`, `lede` |
| `battle` | `prototype-player` battle scene | `date`, `title`, `sub`, `left`, `right`, `resultLabel`, `lede` |
| `standing` | `prototype-player` standing scene | `title`, `sub`, `rows[]` |
| `call` | `prototype-player` call scene | `title`, `ctas[]` (`primary` = the filled button) |

Every chapter shows its `stamp` with the voice styling (`creator` = accent, `chronicle` = ember with
the dot). An unknown `kind` is skipped, never crashes.

### C. Data: `lib/story/storyApi.ts`

- `fetchStory(chainId, token, signal?)` → `GET /api/story?chainId=<id>&token=<address>` through the
  app's existing `apiFetch`. Run the result through `validateStory`; if it returns problems, treat the
  story as absent (return `null`, log the problems once with `console.warn`).
- Fixtures while the API is not live: when `import.meta.env.DEV` or `VITE_STORY_FIXTURES === "true"`,
  a `storyFixture=k88|derpydave` query parameter loads the matching JSON from `frontend/shared/fixtures/`
  instead of calling the API.
- `useStory(chainId, token)` hook: `{ story, loading }`, cached per `chainId:token` for 5 minutes (same
  pattern as `hooks/useArenaTokenProfile.ts`).

### D. Entry points

- **Route** in `App.tsx`: `/story/:chainId/:token` → `pages/StoryPage.tsx`, which loads the story and
  opens the player; **Close** navigates to `story.coin.tokenPath`. This is the shareable link. While
  loading: a centred spinner. No story: a short "No story yet for this coin." with a link back.
- **Button "Enter the story"** on both token pages, shown only when `useStory` returns a story:
  - `TokenDetails.tsx`: in the identity strip, directly before the Share control. One element, no
    other change.
  - `ImportedTokenPage.tsx`: in the hero actions, directly before SHARE. One element, no other change.
  - Opens the player in place (no navigation); closing returns to the page.
  - Style: accent-outlined pill with a ▶ glyph, `h-7`, the same height as the strip's other controls.

### E. Sharing (founder: "shareable so people can share it on social media, use it as promo")

Every story carries `story.share`: `url` (the public share link, which the API serves with Open Graph
tags so X / Telegram / Discord show a big preview card, then forwards to the story), `text` (the post
text, plain, no URL) and `imageUrl` (the 1200x630 card). The API builds all three; you only use them.

- **Share button** in the player header, left of Close (44x44, share glyph). It opens a small sheet
  inside the player (pauses the story while open) with:
  - **Share on X**: `https://x.com/intent/post?text=<encodeURIComponent(share.text)>&url=<encodeURIComponent(share.url)>`
  - **Telegram**: `https://t.me/share/url?url=<encodeURIComponent(share.url)>&text=<encodeURIComponent(share.text)>`
  - **Copy link**: `navigator.clipboard.writeText(share.url)` inside the click handler; on rejection,
    show the URL in a selectable read-only field. Toast "Link copied".
  - **More…**: only when `navigator.share` exists: `navigator.share({ title: coin.name, text: share.text, url: share.url })`.
  - A small preview of `share.imageUrl` at the top of the sheet, so the sharer sees what the post will look like.
- **The `call` chapter** also gets a **Share this story** button under its CTAs, opening the same sheet.
- Links open in a new tab (`target="_blank" rel="noreferrer"`). Never build share URLs from anything
  but `story.share`.

### F. The full story (founder, 2026-09-28)

Chronicle chapters are generated and the same for every coin; creators never edit them. What a
creator writes lives in two places, both delivered by the API:
- a short `text` chapter with stamp "Written by the owner" (imported coins) - just another chapter;
- `story.fullStory`: `null`, or `{ updatedAt, sections: [{ key, heading, body }] }` built from **our**
  fixed boxes (`STORY_FULL_SECTIONS` in the contract: headings and order are ours, the body is theirs).

Build:
- On the `call` chapter, when `story.fullStory` is not null, a **Read the full story** button (full
  width, outlined, under the CTAs and above "Share this story").
- It opens, **inside the same frame**, a scrollable page (`components/story/FullStoryPage.tsx`):
  story paused, progress bars hidden, a **Back** button top left that returns to the `call` chapter.
  Content top to bottom: the coin logo (96px) and name, then each section as its `heading` (display
  font, accent colour) and `body` (body font, 19px, line-height 1.5, `white-space: pre-line`, rendered
  through `emphasisParts`), then the same CTAs as the `call` chapter at the bottom.
- Tap zones, swipe and arrow keys are off while this page is open; the page scrolls normally
  (touch and wheel). Esc goes back to the `call` chapter (a second Esc closes the player).
- The K88 fixture has a full story (3 sections); Derpy Dave's has none, so no button there.

### G. Tests: `components/story/story-player.test.mjs` (node:test, source-level like the repo's others)

- Every kind in `STORY_CHAPTER_KINDS` has an entry in `sceneRegistry.ts`.
- No file under `components/story/` contains `dangerouslySetInnerHTML` or `innerHTML`.
- `StoryPlayer.tsx` handles `Escape`, `ArrowLeft`, `ArrowRight`, and `visibilitychange`.
- The fit logic exists (a function that compares `scrollWidth`/`clientWidth` and
  `scrollHeight`/`clientHeight`).
- `App.tsx` registers `/story/:chainId/:token`.
- No em dash (U+2014) in any file under `components/story/`.
- `FullStoryPage.tsx` exists, renders `section.heading` / `section.body` through `emphasisParts`, and the
  call chapter only shows "Read the full story" when `story.fullStory` is not null.
- The share sheet builds its X and Telegram links from `share.url` / `share.text` only
  (`x.com/intent/post` and `t.me/share/url` appear, and no other share host).

---

## Not in scope (do not start, do not stub)

The story API and chronicle rules (Claude), the share link page and the preview card image
(Claude), the creator **editor** for the short story and the full-story boxes (a later brief; the API
`POST /api/story/profile` already exists), sound, video export, analytics, any change to how token pages
look beyond the one button.

## Done when

- `/story/101/4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77?storyFixture=k88` plays all 10 K88 chapters
  and `…/2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS?storyFixture=derpydave` all 8 Derpy Dave chapters,
  looking and moving like the prototypes, with **no text outside the frame** at the three phone sizes.
- Tap, hold, swipe, keys and Esc work; the last chapter's buttons work.
- Share on X / Telegram / Copy link produce exactly `share.url` and `share.text` from the fixture.
- K88: "Read the full story" opens the 3-section page in the frame, it scrolls, Back returns to the
  last chapter. Derpy Dave: no such button.
- The checks in rule 7 pass.
