MEMEWARZONE — BATTLE WALL & COMBAT CARD UX CHANGE ORDER
1. Product objective

Turn:

/warzone/battles

into the main public battlefield of MemeWarzone.

Instead of:

small row
↓
open separate battle
↓
back
↓
open another battle

the experience becomes:

BATTLE WALL

Battle A
────────────────

Battle B
────────────────

Battle C
────────────────

Battle D
────────────────

continuous vertical discovery

Each battle is visually substantial enough that the visitor can understand and follow the fight without leaving the page.

The Battles page should feel like:

A live war broadcast containing every active MemeWarzone fight.

This better fits MemeWarzone's core post-graduation positioning: competition is the retention layer rather than a static record system. The investor material likewise frames battles as recurring engagement and activity after graduation.

2. Route architecture
Canonical Battle Wall

Keep:

/warzone/battles

as the normal entry point.

Focused battle URL

Add/support:

/warzone/battles/:battleId

This is not another Battle Details design.

It loads the exact same Battle Wall and:

resolves the requested battle;
ensures that battle is present even if it would normally be outside the first loaded page;
scrolls directly to it;
briefly highlights/focuses it;
optionally expands it;
leaves all other battles below/above available to browse.

Example:

X post
↓
memewar.zone/warzone/battles/abc123
↓
Battle Wall opens
↓
$DOGE VS $PEPE centered
↓
user continues scrolling through other fights
Existing legacy route

Do not immediately delete:

/battle/:id

During migration:

/battle/:id
→ redirect to
/warzone/battles/:id

Only remove BattleDetails.tsx after everything users/operators currently need from it has safely moved into the Battle Wall.

The current router explicitly maintains separate /warzone/battles and /battle/:id routes, so this is a controlled UX consolidation rather than inventing an entirely new route system.

3. Main Battle Wall structure

At the top:

WARZONE
BATTLES

The wars happening across MemeWarzone right now.

Then the filtering/navigation layer.

Recommended primary state tabs:

[LIVE] [UPCOMING] [FINISHED]

Do not put unresolved creator challenges into the ordinary public battle feed.

Challenges are proposals until accepted.

LIVE

Battle is actively running.

Primary/default tab.

UPCOMING

Includes things like:

matched / funding
scheduled battle awaiting start
AUTO DEPLOY match awaiting deposits
accepted challenge awaiting deposits

Potentially waiting queue entries can have their own secondary toggle later, but I would not clutter the main public battlefield with hundreds of unmatched coins.

FINISHED

Historical fights/results.

4. Filtering

Above the battle modules:

CHAIN
[ALL] [BNB] [SOLANA] [ROBINHOOD]

BATTLE TYPE
[ALL] [MANUAL] [AUTO DEPLOY] [TOURNAMENT]

SORT
[DEFAULT]
[ENDING SOON]
[CLOSEST FIGHT]
[NEWEST]

And:

SEARCH TOKEN
[$TICKER / token name]

If wallet connected:

[MY BATTLES]

is useful.

Initial sorting

Do not create a speculative "Hot Battle" algorithm yet.

Use deterministic sort methods first:

ending soon;
smallest Battle Point gap;
newest;
possibly highest battle-period volume if authoritative.

Later we can define a real "Hot" ranking.

5. The Battle Wall battle module

This replaces the current lightweight ArenaMatchRow as the primary Live presentation.

It should adopt the visual strength of the mockup.

Desktop:

┌───────────────────────────────────────────────────────┐
│ LIVE                 RANKED                 18:42:13 │
│                                                       │
│ ┌──────────────────┐       VS      ┌────────────────┐│
│ │                  │               │                ││
│ │   TOKEN IMAGE    │               │  TOKEN IMAGE   ││
│ │                  │               │                ││
│ │     $ALPHA       │               │     $BRAVO     ││
│ │                  │               │                ││
│ │     58.4 BP      │               │     51.2 BP    ││
│ │                  │               │                ││
│ │ MCAP     $842K   │               │ MCAP     $790K ││
│ │ HOLDERS  2,811   │               │ HOLDERS  2,422 ││
│ │ BTL VOL   $98K   │               │ BTL VOL   $71K ││
│ └──────────────────┘               └────────────────┘│
│                                                       │
│               $ALPHA LEADS                            │
│                  +7.2 BP                              │
│                                                       │
│ [SUPPORT] [SHARE] [MORE ↓]                           │
└───────────────────────────────────────────────────────┘

The integrated plan already requires reusable combatant cards containing token identity and authoritative Battle Points metrics.

The new change is where those rich cards are used.

6. Center VS design

I agree strongly with the mockup here.

The current center HUD is too much like a third information card.

Change the visual hierarchy from:

CARD | LARGE HUD CARD | CARD

toward:

CARD       VS       CARD

The center should communicate the fight, not compete with the participants.

Recommended:

        VS

58.4        51.2

$ALPHA LEADS

+7.2 BP

18:42:13
REMAINING

Secondary technical telemetry should not dominate the confrontation.

Things such as:

REST synced
realtime connected
settlement version
data source

can live under MORE, in tooltips, or only appear when abnormal.

Exception:

DATA DELAY

must remain prominent.

The dedicated audit rules require stale/unhealthy telemetry to stop pretending the score is current, and distinguish actual 0 Battle Points from unavailable points.

7. Battle Combatant Cards

Reuse the existing BattleCard V2 architecture rather than rebuilding it.

Each side should show immediately:

image

ticker
name if room

BATTLE POINTS

MCAP
holders
eligible Battle Volume

Secondary/expanded detail:

liquidity

MCAP change
holder change
turnover

MCAP component / 50
holder component / 30
volume component / 20

MWZ NATIVE / IMPORTED
chain
creator/owner

The server remains the scoring authority.

Never calculate Battle Points in these cards. The integrated plan requires one canonical server-side engine.

8. Responsive design
Desktop

Primary:

LEFT CARD     VS/HUD     RIGHT CARD

The combatants visually face each other.

Tablet

Can remain:

LEFT CARD    VS    RIGHT CARD

with reduced metric density.

Mobile

Do not squeeze tiny side-by-side cards.

Prefer:

┌─────────────────┐
│     $ALPHA      │
│     58.4 BP     │
└─────────────────┘

        VS
   ALPHA +7.2
    18:42:13

┌─────────────────┐
│     $BRAVO      │
│     51.2 BP     │
└─────────────────┘

Share/More/Support remain easy to tap.

9. Warfare effects on the Battle Wall

This changes one older implementation rule.

The previous integrated plan explicitly reserved heavy effects for Battle Details.

Because Battle Details is no longer the principal combat surface, effects now belong on the visible Battle Wall modules.

But they must be performance-controlled.

Rule

Only battles near/in the viewport receive active effects.

Example:

Battle 1 visible
→ realtime active
→ combat effects active

Battle 2 visible
→ realtime active
→ combat effects active

Battle 3 approaching viewport
→ preload

Battle 20 offscreen
→ REST/static state only
→ no tracers
→ no recoil
→ no active effect DOM

Use IntersectionObserver or equivalent.

Do not subscribe 50 fights to heavy realtime animation simultaneously.

10. Existing Phase 8 effect behavior remains

Reuse:

tracers
bullet impacts
persistent bullet holes
bursts
lead-change barrage
card recoil
damage persistence/fade

Do not rewrite that system.

The existing integrated plan already defines these warfare effects and the required performance/mobile/reduced-motion QA.

Effects remain:

cosmetic only.

They never affect:

Battle Points
settlement
WarPool
MWL
tournaments
database metrics
11. Damage stays scoped to the battle

Bullet effects should visually strike:

opponent combatant card

They should never damage/obscure:

navigation
filter bar
creator challenge notification
Support controls
share menu
expanded funding controls
other battle modules

Each battle needs an isolated effects container.

No projectile can visually leak into the battle above/below it.

12. Expanded Battle mode

Every battle module gets:

MORE ↓

The battle expands inline.

No page change.

Expanded content inherits today's useful BattleDetails functionality.

Recommended order:

BATTLE SCORE BREAKDOWN

MCAP component
Holder component
Eligible volume component

────────────────

BATTLE TERMS

stake
duration
started
ends
match type
Match Quality / Ranked / Open War

────────────────

WARPOOL / SUPPORT

existing WarPool component

────────────────

OWNER ACTIONS

stake funding if matched
claim if applicable

────────────────

RESULT / HISTORY

winner
draw
tie-break disclosure
settlement version
historical scoring version

Collapse:

LESS ↑

and continue browsing.

13. WarPool remains unchanged

Move/reuse its UI.

Do not touch its accounting.

The current integrated plan explicitly says Battle Points changes must not modify WarPool deposits, claims, escrow or payout math.

So this is:

same WarPool
new presentation location

not a WarPool rewrite.

14. Owner funding controls

When a battle is:

matched

and requires funding, the proper owner can see the existing stake/deposit action inside the expanded battle.

Normal public visitors should see something like:

AWAITING FUNDING
1 / 2 DEPLOYED

not an unusable owner button.

Funding must stay in the existing chain-specific escrow architecture.

15. Finished battle design

Finished fights remain visually interesting.

Example:

FINAL

$ALPHA
64.8

VS

$BRAVO
59.1

$ALPHA WINS
+5.7 BP

Then:

[SHARE RESULT] [MORE]

Battle scars can remain as a deterministic/static visual treatment if desired, but do not replay a fake live combat sequence every time somebody scrolls over a finished battle.

Historical V1 fights must still say:

SCORE

or otherwise accurately represent their historic scoring model.

Never reinterpret MCAP-era fights as Battle Points V2. This backward-compatibility requirement is explicitly locked.

16. Upcoming battle design

For an accepted/automatched but not-live battle:

DEPLOYMENT PENDING

$ALPHA
       VS
$BRAVO

2.0 BNB
24 HOURS

FUNDING
ALPHA ✓
BRAVO WAITING

No live Battle Points.

No fake battle effects.

No misleading timer.

Battle timer only starts at the actual live transition, consistent with the current Arena baseline/funding architecture.

17. Unresolved challenges are not public fights

Keep:

challenged

out of the normal Battle Wall.

A manual challenge that hasn't been accepted is still negotiation.

This also preserves the current challenge architecture defined in the integrated plan:

challenge
→ ACCEPT / COUNTER / DECLINE

without turning every proposal into public noise.

18. Creator-only Challenge Alert

This sits above the Battle Wall only when relevant to the connected creator.

Normal users do not see it.

Example:

┌────────────────────────────────────────┐
│ ⚠ YOU'VE BEEN CHALLENGED              │
│                                        │
│              1 / 3                     │
│        ‹                ›              │
│                                        │
│ $ALPHA        VS        $MYCOIN        │
│                                        │
│ 2.0 BNB       •         24H            │
│                                        │
│ [ACCEPT] [COUNTER] [DECLINE]           │
└────────────────────────────────────────┘

Condition:

connected wallet
owns challenged defender
battle.state === challenged

Once it becomes:

matched
live
finished
expired
declined

it disappears from the challenge alert.

19. Multiple challenge carousel

One incoming challenge:

no arrows/counter necessary

Multiple:

‹    2 / 5    ›

Desktop:

arrows;
keyboard navigation if convenient.

Mobile:

swipe;
arrows still accessible.

Critical state rule:

Each challenge must retain its own:

counter stake
counter duration
busy/action state

Do not have one global counter input accidentally apply to another challenge when sliding.

20. Sharing is first-class

Every battle module gets:

SHARE

Not buried inside More.

Opening it should provide initially:

SHARE ON X
COPY BATTLE LINK
DOWNLOAD / OPEN PNG

Telegram can follow later.

Share URL:

/warzone/battles/:battleId
21. Battle social PNG

Reuse the existing MemeWarzone server-rendered promotional share-card architecture rather than inventing a client screenshot system.

The repository already has a backend share-card renderer designed for social platform image fetching.

Create equivalent:

battle-share-card

Conceptually:

GET /api/battle-share-card?id=<battleId>

The battle ID is the input.

The server resolves authoritative battle state/metrics.

Do not allow clients to submit arbitrary:

leftPoints=99
rightPoints=2
winner=...

through query parameters and manufacture fake battle graphics.

22. PNG design

Target social ratio:

1200 × 630

or the existing share-card pipeline's standardized equivalent.

Live:

MEMEWARZONE

LIVE BATTLE

$ALPHA                 $BRAVO
[IMAGE]        VS      [IMAGE]

58.4                     51.2
BATTLE POINTS       BATTLE POINTS

MCAP $842K             MCAP $790K
HOLDERS 2,811       HOLDERS 2,422
BATTLE VOL $98K      BATTLE VOL $71K

$ALPHA LEADS +7.2

18H 42M REMAINING

MEMEWAR.ZONE

Finished:

FINAL RESULT

$ALPHA WINS

64.8 — 59.1

MemeWarzone

Upcoming:

BATTLE DEPLOYING

$ALPHA VS $BRAVO

2 BNB
24 HOURS
23. PNG data-health rules

Live PNG must obey the same data rules as the UI.

If telemetry unhealthy:

DATA DELAY

Do not embed stale values as though they are current Battle Points.

If points not ready:

BATTLE POINTS PENDING

not:

0.0 — 0.0
24. PNG historical rules

Historical V1:

FINAL SCORE

using correct V1 semantics.

V2:

FINAL BATTLE POINTS

Never convert a V1 result into the current scoring model merely to make the social card prettier.

25. Social metadata / crawlers

A deep battle URL should produce battle-specific social metadata where the current deployment architecture permits it:

og:title
$ALPHA vs $BRAVO — MemeWarzone

og:description
$ALPHA leads $BRAVO by 7.2 Battle Points. 18h remaining.

og:image
battle-share-card?id=...

For finished:

$ALPHA defeated $BRAVO — MemeWarzone

Do not expose private challenge information through OG metadata.

Only public eligible battle states get social previews.

26. Pagination / continued scrolling

Do not fetch every historical battle ever created at once.

Initial model:

first page / batch
↓
scroll
↓
load more
↓
load more

For Live, number may initially remain small, but architecture should not assume that forever.

The current backend/list currently caps battle results, so future wall work should move toward proper page/cursor semantics rather than merely increasing the cap indefinitely.

27. Realtime resource strategy

This is critical.

For each battle module:

Offscreen
REST snapshot
no active combat effects
no active high-frequency realtime processing
Near viewport
prepare/hydrate
Visible live battle
REST reconciliation
subscribe to battle realtime
display updates
effects active
Leaves viewport
unsubscribe / suspend heavy visual work
retain last authoritative snapshot

This allows dozens of fights without destroying browser performance.

The canonical realtime architecture still remains REST → realtime patches → reconnect → REST reconciliation.

28. Data fetching should be shared

Avoid:

BattleCombatantCard
→ profile request

other BattleCombatantCard
→ another profile request

wall
→ metrics request

expanded details
→ duplicate battle request

share menu
→ another battle request

Normalize/cache battle/token data so one battle module can reuse the same hydrated information.

This matters much more on the wall than it did with one standalone detail page.

29. Tournament battles

Tournament fights should appear on the Battle Wall.

Badge:

TOURNAMENT
ROUND 2

Filter:

TYPE → TOURNAMENT

Clicking/focusing remains inside the wall.

Optional link:

VIEW TOURNAMENT

can still navigate to Tournament Details.

Do not create a tournament-specific battle display engine. The integrated plan explicitly requires tournaments to reuse the same battle engine.

30. Ranked vs Open War

Public module should clearly show:

RANKED

or:

OPEN WAR
UNRANKED

Do not expose Match Quality calculation internals.

A safe public:

MATCH QUALITY 84%

is fine when authoritative.

Internal manipulation/cluster details remain private.

31. Native / imported parity

The wall must not visually downgrade imported assets.

All combinations:

MWZ vs MWZ
MWZ vs imported
imported vs MWZ
imported vs imported

use the same Battle module.

Only badge differs:

MWZ NATIVE
IMPORTED

This parity is already a locked requirement of the integrated plan.

32. Chain-neutral presentation

The same wall supports:

BNB
Solana
Robinhood
future chains

No separate BNB Battle Wall or Solana Battle Wall.

The chain is a filter/badge.

Scoring stays normalized/server-authoritative, consistent with the Master Build Plan's broader adapter principle rather than scattering chain-specific logic through UI.

33. Components — recommended architecture

Do not immediately dump today's complete BattleDetails.tsx into ArenaBattles.tsx.

Create/recompose reusable pieces.

Conceptually:

ArenaBattles
│
├── BattleWallHeader
├── BattleWallFilters
├── CreatorChallengeCarousel
│
└── BattleWall
    │
    └── BattleWallCard
        ├── BattleCombatantCard
        ├── BattleWallVsHud
        ├── BattleCombatEffects
        ├── BattleShareButton
        └── BattleExpandedDetails
            ├── BattleMetricBreakdown
            ├── WarPoolPanel
            ├── BattleTerms
            ├── ArenaStakeButton
            ├── ArenaWarPoolClaimButton
            └── BattleResultLog

Names can follow existing project conventions.

The architectural point matters more than exact filenames.

34. Existing components to reuse

Already-built pieces should be extended/recomposed:

BattleCombatantCard
BattleMetricBreakdown
BattleCombatEffects
BattleScoreHud
ArenaStakeButton
ArenaWarPoolClaimButton
WarPoolPanel

ArenaMatchRow
useArenaBattleFeed
useArenaFeedBattleMetrics
useArenaBattleRealtimeDetails

Do not create parallel score, effects, WarPool or funding systems.

35. ArenaMatchRow

It has just been upgraded with authoritative Battle Points.

Do not throw that work away.

Repurpose it for places where compact rows still make sense:

sidebars
homepage previews
related battles
Command Center history
League/tournament summaries
mobile condensed contexts

But it is no longer the principal /warzone/battles Live presentation.

36. BattleDetails.tsx

Treat it as a migration source.

Phase by phase move its useful capabilities into reusable modules.

Then:

/battle/:id
→ /warzone/battles/:id

Only after parity has been proven should standalone BattleDetails stop rendering independently.

Do not delete it first and discover afterward that:

stake funding
WarPool claim
result log
tournament support redirect
tie-break disclosure

was lost.

37. Challenge notification placement

Because creator challenges are personal, this component may appear:

at the top of /warzone/battles; and/or
Command Center Battles.

But it should use one shared presentation component, not two independently maintained challenge UIs.

Command Center can remain the full management location.

Battle Wall provides the prominent "you have been challenged" notification.

38. Accessibility

Required:

keyboard-expandable More;
challenge carousel controls with accessible labels;
swipe not being the only carousel method;
reduced-motion combat mode;
share buttons properly labelled;
scores readable without color;
leader indication not color-only;
DATA DELAY conveyed in text;
focus management when opening /warzone/battles/:id.
39. Performance QA

Test at least:

1 live battle
5 live battles
20 live battles
50 simulated battle modules

Measure:

active realtime subscriptions;
DOM effect count;
scroll smoothness;
memory growth;
profile/metrics request count;
unmount cleanup;
viewport effect cleanup.

Only visible/near-visible fights should be expensive.

40. Functional QA

Required:

Battle Wall
live fights render rich card-vs-card;
continuous scrolling;
no navigation needed to watch another fight;
chain filter;
type filter;
token search;
ending-soon sort;
closest-fight sort;
finished filter;
empty states.
Focus URL
/warzone/battles/:id loads correct fight;
battle not initially loaded can be resolved;
scroll/focus works;
browser refresh works;
legacy /battle/:id redirects;
invalid battle has useful fallback.
Live telemetry
Battle Points update;
lead flips;
timer updates;
DATA DELAY;
reconnect;
viewport subscribe/unsubscribe.
Effects
points gain creates opponent impact;
lead flip barrage;
battle effects cannot leak into neighboring card;
reduced motion;
mobile;
offscreen battle creates no visual effects.
Expanded details
WarPool;
stake;
funding;
claims;
result;
tie-break;
historical V1;
tournament battle.
Sharing
copy link;
X share;
PNG;
live PNG;
finished PNG;
V1 PNG;
DATA DELAY PNG;
token imagery fallback;
crawler-compatible image response.
Challenges
creator only;
one challenge;
multiple challenge carousel;
accept;
counter;
decline;
accepted challenge disappears;
matched/live challenge no longer appears;
different counter state per carousel item.
41. Explicit things NOT changed

This change order does not authorize redesign of:

Battle Points formula
Match Quality formula
AUTO DEPLOY matching
manual challenge state machine
counter-offers
accept
decline
stake validation
duration validation
escrow
WarPool accounting
settlement logic
MWL point ledger
tournament advancement
normalized market snapshots
Robinhood chain execution
BNB protocol
Solana protocol

This is primarily a Battle UX, routing, sharing and performance-composition change.

42. Implementation sequence

I would build it in five isolated implementation phases.

Battle Wall Phase 1 — Wall foundation

Build:

new Battle Wall card composition
Live / Upcoming / Finished
filters
search
sort
continuous loading structure

Use REST authoritative values.

No route deletion.

No WarPool migration yet.

No social PNG yet.

Definition of done: Visitors can browse rich card-vs-card fights vertically without opening BattleDetails.

Battle Wall Phase 2 — Focused battle routing

Build:

/warzone/battles/:battleId
focus/scroll/highlight
deep-link state
legacy /battle/:id redirect strategy

Do not remove standalone page until Phase 4 parity exists.

Definition of done: Every battle can be linked directly while still opening inside the Battle Wall.

Battle Wall Phase 3 — Realtime + viewport warfare

Move heavy combat experience onto visible Wall battles:

viewport-aware realtime
viewport-aware BattleCombatEffects
compact center VS HUD
performance caps
reduced motion

Definition of done: Several simultaneous fights feel alive without all battles doing expensive work offscreen.

Battle Wall Phase 4 — Inline full battle functionality

Move/recompose:

WarPool
stake/funding
claims
terms
metric breakdown
result log
tie-break disclosure
historical version information

under MORE.

Then establish feature parity with BattleDetails.

Only now can /battle/:id safely become redirect-only.

Battle Wall Phase 5 — Social battle engine + creator challenge carousel

Build:

battle-share-card PNG
Share menu
X intent
copy deep link
battle social metadata
creator-only challenge alert
multi-challenge carousel

This is largely isolated presentation/share work once the battle module is stable.

43. Updated Definition of Done

The Battle UX change order is complete when:

/warzone/battles is the principal public Battle experience.
Live fights render as full two-sided combat modules.
Visitors continuously scroll from one active fight to another.
No separate page navigation is required to experience a battle.
Every fight retains a unique deep-linkable URL.
That URL focuses the battle inside the same Battle Wall.
Existing /battle/:id links remain backward compatible.
Live modules show authoritative Battle Points, leader and timer.
DATA DELAY never masquerades as live scoring.
Effects attack opposing cards and stay locally scoped.
Offscreen battles do not run heavy warfare/realtime unnecessarily.
MORE exposes full existing Battle Details functionality.
WarPool accounting is unchanged.
Funding/escrow behavior is unchanged.
Historical V1 battles remain historically accurate.
Tournament fights reuse the same module.
Native/imported tokens have identical battle presentation.
BNB/Solana/Robinhood share the same Battle Wall architecture.
Every public battle can generate an authoritative social PNG.
Every public battle has a Share action.
Creator challenge notification is creator-only.
Multiple challenges use a carousel.
Challenge notification disappears when the challenge leaves challenged.
Manual challenge ACCEPT/COUNTER/DECLINE remains intact.
AUTO DEPLOY remains intact.
Important supersession note

This should be inserted into the newest RHandbattlesupgrade-integrated.md as the new founder-approved Battle presentation architecture.

Specifically, it supersedes the older statements:

ArenaMatchRow can remain lightweight

and:

Battle Details becomes the principal combat screen

for the primary Battles page UX.

The underlying Battle engine, Battle Points, Match Quality, realtime authority, historical compatibility and warfare-effect rules remain authoritative.