# Story Mode (2026-09-28)

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

### Story Mode (built 2026-09-28)

Full-screen, Instagram-style story per coin: creator chapters + a data-driven Chronicle (never editable),
max 10 chapters launched / 8 imported. Contract: `frontend/shared/storyContract.mjs` (+ fixtures K88,
Derpy Dave). API (mine): `GET /api/story`, `GET /api/story/card/:chain/:token.png` (resvg + bundled OFL
fonts, sharp decodes logos incl. webp), share link `GET /s/:chain/:token` on the API domain (OG tags,
then redirect to `app…/story/:chain/:token`), `POST /api/story/profile` (strict wallet-signed, verified
owner: short story for imports + fixed full-story boxes). Rules in `api/lib/storyBuilder.mjs`, facts in
`api/lib/storyFacts.js` (league/featured/campaign card via their own handlers in-process). "Firsts" only
count from `MWZ_PUBLIC_LAUNCH_AT` (default 2026-09-25): 33 test campaigns predate K88.
Migration `db/migrations/20260928_000001_token_story_profiles.sql` (founder applies on production).
Player = Grok, `docs/story-mode-player-brief.md`. **Coolify serves the app without crawler handling**:
`/prepare/…` and battle links show the generic homepage preview on X (Netlify edge functions no longer
run) -- fix the same way as `/s/` when prioritised.


