# Battle challenge flow — build brief (for Grok)

Owner: founder. Date: 2026-09-24. Branch: `build/robinhood-full-expansion`. Everything below the
"What exists" section is new work; everything in it is already in the repo and must be reused, not
rebuilt. Money and signing paths are frozen (see "Rules"), so this is UI, one DB column, two API
changes and one realtime channel.

## Goal, in the founder's words

1. Keep the **Challenge a coin** button on the Battle Wall header (`frontend/src/pages/ArenaBattles.tsx`,
   `data-challenge-coin-cta`). Clicking it opens a **popup wizard** (not a redirect): step 1 pick or
   search the memecoin to battle, step 2 set the terms, step 3 review and confirm.
2. A **"You have been challenged" popup that shows up anywhere on the platform** (mockup:
   `SCHEDULED BATTLE` / `$ALPHA CHALLENGES $BRAVO` / `COMMUNITY VS COMMUNITY` / `BATTLE STARTS IN
   hh:mm:ss` / ACCEPT · COUNTER · DECLINE). It must also show the **buy-in the challenger proposed**.
3. **ACCEPT** opens the same style of popup to **pay the buy-in** (the proposed stake).
4. **COUNTER** lets the defender enter a **buy-in higher than the current offer** and submit.
5. **DECLINE** asks "Are you sure?" with an optional **message to the challenger**.
6. The **challenger gets the same popup** when the other side counters (accept / counter / decline
   again), accepts (then the challenger pays their buy-in) or declines (shows the message).
7. Replace the half-done challenge form in the Command Center profile with the same popup.

## What exists (reuse)

| Piece | Where | Notes |
|---|---|---|
| Challenge / accept / decline / counter API | `frontend/api/arenaBattles.js` — `POST /api/arena/battles/challenge`, `POST /api/arena/battles/:id/accept`, `/decline`, `/counter` | Wallet-signed actions `arena_challenge_battle`, `arena_accept_battle`, `arena_decline_battle`, `arena_counter_battle` (`requireWalletActionAuth`, extra lines `Battle: <id>`, `Stake: <n>`, `Duration: <h>`). `MAX_COUNTERS = 12`. Accept returns `escrowRequired: state === "matched"`; a matched battle needs both stakes on chain within `DEPOSIT_WINDOW_HOURS = 24`, then goes live. Decline sets state `expired`. |
| Client calls | `frontend/src/features/postgrad/apiClient.ts` — `challengePostGradBattle`, `acceptPostGradBattle`, `counterPostGradBattle`, `declinePostGradBattle`, `fetchPostGradCreatorBattleStatuses`, `fetchArenaStakeStatus`, `postArenaStakeReceipt` | Payloads already carry `stakeNative`, `durationHours`, `battleMode`, `auth`. |
| Wallet-action signing | `signAuth(action, extraLines)` in `frontend/src/pages/command-center/CommandCenterBattles.tsx` (EVM + Solana) | Lift it into a hook (`useArenaWalletAction`) so popups outside that page can sign. Do not change the message lines: the API verifies them. |
| Buy-in payment | `frontend/src/components/arena/ArenaStakeButton.tsx` | Already does the on-chain stake for EVM (war pool V2 via `getArenaWarPoolTreasuryAddress`) and Solana (`runSolanaArenaUserAction`), reads `fetchArenaStakeStatus`, posts `postArenaStakeReceipt`. The buy-in popup wraps this; it does not reimplement it. |
| Coin search | `frontend/src/components/search/SearchPopup.tsx` (`open`, `onOpenChange`) and `presentManualOpponentPreview` in `CommandCenterBattles.tsx` | Step 1 of the wizard. |
| Wizard shell | `frontend/src/components/create/CreateWizardShell.tsx` (`step`, `totalSteps`, `canBack`, `canNext`, …) | Render it inside a Dialog for the 3 steps. |
| Incoming-challenge presentation | `frontend/src/lib/arena/creatorChallengePresentation.mjs` — `collectIncomingCreatorChallenges`, `presentCreatorChallenge`, `initialChallengeDraft`, `patchChallengeDraft`, `challengeDurationLabel`; `frontend/src/components/arena/CreatorChallengeCarousel.tsx` (`onAccept`, `onDecline`, `onCounter`) | Pure helpers with tests in `creatorChallengePresentation.test.mjs`. Keep them; the popup is a new consumer. |
| Realtime pattern | `frontend/src/components/rank/RankPromotionListener.tsx` + `frontend/src/hooks/useAblyLeagueChannel.ts` (channel `league:{chainId}`, token from `/api/ably/token?chainId=&scope=league`) | A listener mounted once in `App.tsx` that subscribes and shows a popup. Copy this shape. Server side publishes with `rest.channels.get(name).publish(event, payload)` (`frontend/api/lib/leagueAblyPublish.js`, `arenaBattleRealtime.js` uses `arena:battle:{id}`). |
| Email notices | `frontend/api/lib/arenaNotify.js` — `notifyChallenge`, `notifyCounterOffer` | Keep; add the decline notice with the message. |
| Battle mode / duration parsing | `parseBattleMode`, `parseBattleDurationHoursForMode` in `arenaBattles.js`; `frontend/src/lib/arena/battleDuration.ts` client side | Terms step uses the same allowed durations per mode. |

State machine today: `waiting` (open for battle) → `challenged` (offer on the table, either side may
counter, `offered_stake_native` / `offered_duration_hours` / `offer_count` track the live offer) →
accept → `matched` (stakes due) → `live` → `finished`; decline or timeout → `expired`.

## What to build

### A. `ChallengeCoinModal` (3 steps, opened from the Battle Wall button and from the Command Center)

- Step 1 **Pick the opponent**: your coin (from `fetchPostGradCreatorBattleStatuses`, only eligible
  ones, exactly as the Command Center filters today) and the target coin via `SearchPopup` or a pasted
  address, with `presentManualOpponentPreview` for the preview card. Same chain only.
- Step 2 **Terms**: buy-in (native amount, > 0, label the chain's native symbol), fight length (the
  mode's allowed durations), battle mode (`normal` / `vote` as today). Defaults from the current
  Command Center form.
- Step 3 **Review & confirm**: both coins, buy-in, duration, mode, the sentence "They must accept
  before the fight goes live", then Confirm → `signAuth("arena_challenge_battle", …)` →
  `challengePostGradBattle`. Success toast + close; the Command Center "Your match status" list and
  the Battle Wall refresh (`useArenaBattleFeed`).
- Replace the inline form in `CommandCenterBattles.tsx` ("Challenge a coin" card) with a button that
  opens this modal. Keep `id="command-center-challenge"` on the wrapper so the existing deep link and
  `creatorChallengePresentation.test.mjs` keep passing; change the Battle Wall button from a `Link` to
  a button that opens the modal, and update that same test's expectations.

### B. `IncomingChallengeListener` (mounted once in `App.tsx`, next to `RankPromotionListener`)

- Subscribes to a **per-creator channel** `arena:creator:{chainId}:{walletLowercase}` for the
  connected wallet(s) (EVM and Solana). Extend `frontend/api/ably/token.js` with `scope=arena-creator`
  that grants subscribe on exactly that channel for the requesting wallet (wallet-signed like the
  other scopes; never a wildcard).
- Server publishes on that channel from `arenaBattles.js`: `challenge_received` (to the defender),
  `counter_received` (to the other side), `challenge_accepted` (to the challenger), `challenge_declined`
  (to the challenger, with the message). Payload = the hydrated battle plus `offeredStakeNative`,
  `offeredDurationHours`, `nativeSymbol`, `message`. Publishing is best-effort inside a try/catch, like
  `leagueAblyPublish.js`: the HTTP action never fails because Ably did.
- Fallback: on mount and on window focus, call `fetchPostGradCreatorBattleStatuses` and show anything
  in `challenged` that the user has not dismissed this session (`sessionStorage` key per battle id).
- Renders `ChallengeResponsePopup` (C). One popup at a time; queue the rest.

### C. `ChallengeResponsePopup` (the mockup)

- Header `SCHEDULED BATTLE`, title `$CHALLENGER CHALLENGES $DEFENDER` (use `presentCreatorChallenge`),
  line `COMMUNITY VS COMMUNITY · BATTLE STARTS IN hh:mm:ss` (countdown to the accept deadline the
  battle row carries; if none, show the fight length), and a **Buy-in** line: `<offeredStakeNative>
  <nativeSymbol>` plus the duration.
- **ACCEPT** → `signAuth("arena_accept_battle", [\`Battle: ${id}\`])` → `acceptPostGradBattle`; if the
  response says `escrowRequired`, open `BuyInPopup` (D) immediately.
- **COUNTER** → inline field prefilled with the current offer; the client refuses a value that is not
  strictly higher than the current offer; submit → `signAuth("arena_counter_battle", [Battle, Stake,
  Duration])` → `counterPostGradBattle`. Show "Waiting for $X to respond" afterwards.
- **DECLINE** → "Are you sure?" confirm with an optional message field (max 280 chars) →
  `signAuth("arena_decline_battle", [\`Battle: ${id}\`])` → `declinePostGradBattle(battleId, auth,
  message)`.
- The **same component serves the challenger**: on `counter_received` the buttons are ACCEPT (their
  counter) / COUNTER / DECLINE; on `challenge_accepted` it shows "Accepted — pay your buy-in" and
  opens (D); on `challenge_declined` it shows the decline and the message, with Close.

### D. `BuyInPopup`

- Same visual frame as (C). Shows the agreed buy-in and the deposit deadline (`depositEndsAt` from the
  battle row, 24 h window). Body is `ArenaStakeButton` (unchanged) plus its status text; when
  `fetchArenaStakeStatus` reports the stake deposited, show "Waiting for the other side" or "Battle is
  live" and close. Handles the wallet-network switch the way `ArenaStakeButton` already does.

### E. API and DB (small)

1. Migration in `db/migrations/` (next to `20260921_000011_beat_the_market_solana.sql`): add
   `decline_message text null` to `public.arena_battles`. Additive only.
2. `handleDecline`: read `body.message` (trim, max 280, strip control chars), store it, include it in
   the Ably payload and in a new `notifyDeclined` email (`arenaNotify.js`) to the other side.
3. `handleCounter`: enforce **stake strictly higher than the current offer** (`stakeNative >
   currentOffer`), 400 otherwise, keep the existing "must change stake or duration" check for the
   duration-only case if the founder wants duration counters; default: stake must go up.
4. Publish the four events above after the DB write in `handleChallenge`, `handleCounter`,
   `handleAccept`, `handleDecline`.
5. `frontend/api/ably/token.js`: add the `arena-creator` scope.

## Rules (from CLAUDE.md, still in force)

- **Do not touch** the contracts, `arenaWarPoolEscrow.js`, `ArenaStakeButton`'s on-chain steps, the
  wallet-action message lines, or the create/buy/sell transaction flows. The buy-in popup wraps the
  existing button; it does not send transactions itself.
- No new money logic: stakes, splits, deadlines and resolution stay where they are.
- Every new pure helper gets a `node --test` file next to it (`.test.mjs`), like
  `creatorChallengePresentation.test.mjs`. Keep these green: `creatorChallengePresentation.test.mjs`,
  `battleWall*.test.mjs`, `arenaMatchRowPresentation.test.mjs`, `walletConnectTarget.test.mjs`.
- `eslint` clean on every touched file. `vite build` must pass (tsc is not part of the build, but do
  not add type errors to the touched files).
- The app is chain-aware: a challenge is same-chain; `chainId` comes from the coin, never from a
  default.

## Acceptance (what the founder will test on the live app)

1. Battle Wall → Challenge a coin → 3 steps → confirm → the defender's browser (anywhere on the
   platform, other page, other tab) shows the popup within a few seconds with the proposed buy-in.
2. Defender presses COUNTER with a higher buy-in → challenger's browser shows the counter popup; lower
   or equal is refused client- and server-side.
3. Challenger presses ACCEPT → challenger's buy-in popup opens; defender's browser shows "accepted",
   opens their buy-in popup; both pay → battle goes live on the Battle Wall.
4. DECLINE with a message → the other side sees the message; battle reads expired.
5. Refreshing the page with a pending challenge shows the popup again (fallback poll), and
   dismissing it keeps it dismissed for the session.
6. Command Center → Battles → the old inline form is gone; the button opens the same modal.
