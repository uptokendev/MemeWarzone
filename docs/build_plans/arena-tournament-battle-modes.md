# MemeWarzone Arena Tournament Battle Modes

Status: founder-directed backend boundary, 2026-09-03.

This addendum is narrower and newer than the earlier Arena/tournament notes. Where they conflict, this document controls tournament battle mode and round duration only. Existing Battle V2 scoring, Match Quality seeding, bracket reconciliation, buy-in, War Pool, chain isolation, and settlement controls remain unchanged unless stated here.

## 1. NORMAL tournament battles — LOCKED

A NORMAL tournament match is the standard MemeWarzone Battle V2 engine inside a tournament bracket.

- Every round lasts exactly **24 hours**.
- Round 1 may use the existing Match Quality seeding engine.
- Later rounds are winner-advances elimination matches.
- The battle uses the canonical Battle V2 baseline capture, eligible battle-window metrics, Battle Points calculator, final-score freeze, settlement, and advancement path.
- Tournament presentation must consume canonical Battle V2 metrics; it must not create a second scoring implementation.
- Scores reset because each round is a new Arena battle with a new battle window and new baselines.
- No previous-round Battle Points carry into the next round.
- A tournament organizer cannot shorten a NORMAL round below 24 hours or extend it; the database enforces the exact duration.

The existing API previously inserted tournament battles with a 12-hour `ends_at`. Migration `20260903_000103_arena_tournament_battle_modes.sql` overrides that legacy value at the database boundary and forces `ends_at = started_at + 24 hours` for every NORMAL tournament battle.

## 2. BOOST tournament battles — MODE LOCKED, SCORING NOT YET LOCKED

BOOST is a distinct tournament battle mode. It is not allowed to silently use normal Battle V2 scoring.

The product intent is a community-mobilization battle driven by the Arena's Boost action. The current repository already has an independent Arena paid-vote ingestion path with dedicated Arena treasury verification and a roughly-$3 target; that is the natural backend primitive for Boost Battles, but the exact Boost scoring/winner rules have not yet been founder-locked.

Until those rules are explicitly locked:

- `battle_mode = 'boost'` is valid tournament configuration data.
- Creating a live tournament battle for that mode fails closed with `BOOST_RULES_NOT_CONFIGURED`.
- A Boost tournament must never fall back to Battle V2 scoring just because Boost settlement is unavailable.
- UI may show Boost as an available/upcoming tournament format only if it clearly indicates that the format is not live in the current environment.

## 3. Boost rules still requiring a founder lock

Before BOOST may be activated, one canonical ruleset must define all of the following together:

- what counts as one Boost;
- whether the existing paid Arena Boost/UpVote transaction is the only scoring event;
- whether a wallet may Boost a side more than once per round;
- whether Boost value is count-based or value-based;
- exact round duration (recommended to remain 24 hours for bracket predictability, but not yet locked here);
- whether Boosts reset every round;
- tie-break order;
- anti-replay / transaction uniqueness rules;
- whether free tournament votes exist alongside paid Boosts and, if so, whether they affect winner scoring;
- settlement evidence stored with the battle;
- cross-chain normalization requirements so BNB, Solana, and Robinhood battles cannot gain an advantage from native-asset price differences.

Do not deploy a partial Boost scoring implementation before these rules are locked.

## 4. Data model

Migration `20260903_000103_arena_tournament_battle_modes.sql` adds:

- `arena_tournaments.battle_mode` — `normal | boost`, default `normal`;
- `arena_tournaments.round_duration_hours` — `24` for NORMAL;
- `arena_battles.battle_mode` — inherited from the parent tournament for tournament-sourced battles.

A database trigger is the final enforcement boundary for tournament battle mode and duration.

## 5. Local visual QA

The frontend already has a browser-local post-grad mock registry and mock battle runtime. For battle-page UI review, enable:

```env
VITE_ENABLE_POSTGRAD=true
VITE_ENABLE_POSTGRAD_ARENA=true
VITE_ENABLE_POSTGRAD_BATTLE=true
VITE_ENABLE_POSTGRAD_MOCKS=true
```

The visual QA preset is committed as `frontend/.env.arena-visual.example`. This uses deterministic mock campaigns/battles and does not seed production Supabase or write chain state.

Once the battle UI rebuild is finished, use one controlled two-campaign live battle for the visual pass, with close scores and realistic market-cap / holder / volume values so the lead state and combat damage are obvious without producing a runaway mismatch.
