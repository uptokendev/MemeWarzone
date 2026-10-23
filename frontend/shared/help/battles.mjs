// Help Center articles: battles. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-is-a-battle",
    "q": "What is a battle?",
    "a": [
      "A battle is a timed fight between two coins on the same chain. One coin wins, one loses, and the result counts in the leagues.",
      "There are two kinds. A metrics battle is scored on market data. A vote battle is scored on votes. Both can have a prize pool made of buy-ins and Boosts."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      }
    ],
    "keywords": [
      "battle",
      "fight",
      "versus",
      "vs",
      "war",
      "arena",
      "coin battle"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/arena/live-battles.md:6-25",
      "frontend/api/lib/arenaBattleMode.js:21-22"
    ]
  },
  {
    "slug": "which-coins-can-battle",
    "q": "Which coins can battle?",
    "a": [
      "Graduated coins and imported coins can battle. A coin still on its bonding curve cannot.",
      "Both coins must be on the same chain. The coin owner has to be able to answer the challenge, so the opponent needs a verified owner."
    ],
    "bullets": [
      "Graduated coins: yes",
      "Imported coins: yes",
      "Coins still on the curve: no",
      "Coins on different chains: no"
    ],
    "keywords": [
      "eligible",
      "who can battle",
      "imported battle",
      "graduated battle",
      "requirements"
    ],
    "sources": [
      "founder 2026-10-22",
      "frontend/api/lib/arenaEligibility.js:16-23",
      "docs-site/src/content/arena/live-battles.md:36"
    ]
  },
  {
    "slug": "metrics-vs-vote-battles",
    "q": "What is the difference between a metrics battle and a vote battle?",
    "a": [
      "A metrics battle lasts 24 hours, 3 days or 7 days. It is scored on the change in market cap, holders and trading volume during the fight, plus Boost points. It scores percent change, so a bigger coin does not win just for being bigger.",
      "A vote battle lasts 1, 6, 12, 24 or 48 hours. Each wallet has one free vote worth 1 point. A Boost costs $1 and adds 1 point. The coin with more points wins."
    ],
    "bullets": [
      "Metrics battle: 24 h, 3 days or 7 days",
      "Vote battle: 1, 6, 12, 24 or 48 hours",
      "Both coins need live market data in a metrics battle"
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      }
    ],
    "keywords": [
      "battle types",
      "vote battle",
      "metrics battle",
      "normal battle",
      "battle length",
      "duration"
    ],
    "popular": true,
    "sources": [
      "frontend/api/lib/arenaBattleMode.js:21-27",
      "docs-site/src/content/arena/live-battles.md:18-29"
    ]
  },
  {
    "slug": "how-battle-scoring-works",
    "q": "How is a battle scored?",
    "a": [
      "In a vote battle the score is free vote points plus Boost points. One free vote is 1 point and one Boost is 1 point.",
      "In a metrics battle the score comes from how much each coin changed in percent during the fight: market cap, holders and trading volume, plus Boost points. The Rules tab on the battle page shows the scoring for that battle."
    ],
    "keywords": [
      "scoring",
      "points",
      "who wins",
      "score",
      "winner",
      "how battles are decided"
    ],
    "sources": [
      "docs-site/src/content/arena/live-battles.md:20-29,50",
      "frontend/api/lib/arenaBattleSettleV3.js:78-86"
    ]
  },
  {
    "slug": "free-votes-in-battles",
    "q": "Is voting in a battle free?",
    "a": [
      "Yes. In a vote battle each wallet gets one free vote worth 1 point. Connect a wallet on the battle's chain and press Vote on the side you want.",
      "A free vote is one per wallet per battle. You cannot change it or vote for the other side. If you vote and then write a comment, the comment shows which side you voted for."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      }
    ],
    "keywords": [
      "free vote",
      "vote",
      "how to vote",
      "vote for both",
      "change vote",
      "both sides"
    ],
    "sources": [
      "frontend/api/lib/arenaBattleVoteRuntime.js:135-160",
      "frontend/api/lib/arenaBattleMode.js:26",
      "docs-site/src/content/arena/live-battles.md:58"
    ]
  },
  {
    "slug": "battle-boosts",
    "q": "What is a Boost and how many can I buy?",
    "a": [
      "A Boost costs $1 and adds 1 point to the side you pick. Each Boost also adds to the battle's prize pool.",
      "Each wallet can buy 2 Boosts per battle, on either side or split between both. In a tournament the limit of 2 applies per matchup.",
      "Boosts close when 80% of the battle time has passed. In a 24 hour battle the last Boost can be bought 19 hours and 12 minutes after the start. In a 1 hour battle it is 48 minutes."
    ],
    "bullets": [
      "Price: $1 per Boost",
      "Value: 1 point in a vote battle",
      "Limit: 2 per wallet per battle",
      "Closed in the last 20% of the battle"
    ],
    "keywords": [
      "boost",
      "boosts",
      "buy boost",
      "boost limit",
      "boost closed",
      "boosting",
      "$1"
    ],
    "popular": true,
    "sources": [
      "frontend/api/lib/arenaBoostRules.js:1-18",
      "frontend/api/lib/arenaBattleMode.js:27",
      "docs-site/src/content/arena/live-battles.md:25-27"
    ]
  },
  {
    "slug": "challenge-another-coin",
    "q": "How do I challenge another coin to a battle?",
    "a": [
      "Only the owner of a coin can send a challenge. Connect the wallet that owns your coin first."
    ],
    "steps": [
      "Press Challenge a coin on the Battles page, or Challenge on a coin page.",
      "Pick your coin and an opponent on the same chain.",
      "Choose the battle type, the buy-in and the length.",
      "Review and send the challenge."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      }
    ],
    "keywords": [
      "challenge",
      "start a battle",
      "create battle",
      "fight another coin",
      "send challenge"
    ],
    "sources": [
      "docs-site/src/content/arena/live-battles.md:31-40"
    ]
  },
  {
    "slug": "accept-decline-counter-challenge",
    "q": "Someone challenged my coin. Can I accept, decline or counter?",
    "a": [
      "Yes. The owner of the challenged coin sees the challenge as a popup and in the Command Center. You can accept, decline or send a counter offer with a different buy-in or length.",
      "The battle goes live only after both owners agree. Each side pays its buy-in once both have agreed. A decline can carry a short message of up to 280 characters."
    ],
    "keywords": [
      "challenge popup",
      "counter offer",
      "decline challenge",
      "accept challenge",
      "inbox",
      "incoming challenge"
    ],
    "sources": [
      "docs-site/src/content/arena/live-battles.md:40",
      "frontend/api/lib/arenaChallengeOffer.js:7-14"
    ]
  },
  {
    "slug": "war-pool-prize-split",
    "q": "How is a battle prize pool split?",
    "a": [
      "The war pool holds both buy-ins and every Boost bought during the fight. When the battle is settled it is split as follows."
    ],
    "bullets": [
      "75% of both buy-ins: the winning coin's owner",
      "90% of the Boosts: the winning coin's owner",
      "20% of the buy-ins: the Major War League prize pool",
      "5% of the buy-ins: MemeWarzone",
      "10% of the Boosts: MemeWarzone"
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "keywords": [
      "war pool",
      "prize pool",
      "prize split",
      "75%",
      "90%",
      "winnings",
      "payout split"
    ],
    "sources": [
      "docs-site/src/content/arena/war-pools.md:186-193",
      "docs-site/src/content/arena/live-battles.md:64",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "claim-battle-prize",
    "q": "How do I claim a battle prize?",
    "a": [
      "Nothing is sent automatically. The owner of the winning coin claims the prize with the wallet that owns that coin.",
      "Until the result is final, the row says Waiting for on-chain result. After you claim it shows Claimed."
    ],
    "steps": [
      "Open Command Center and go to Rewards and claims.",
      "Connect the wallet that owns the winning coin and check the chain at the top.",
      "Find the battle row and press Claim.",
      "Confirm in your wallet and wait for Claimed."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      }
    ],
    "alsoIn": [
      "rewards"
    ],
    "keywords": [
      "battle prize",
      "claim win",
      "battle win",
      "collect prize",
      "winner claim",
      "waiting for on-chain result"
    ],
    "sources": [
      "docs-site/src/content/arena/war-pools.md:195-199",
      "docs-site/src/content/command-center/claims.md:144",
      "frontend/src/lib/helpCenter.ts:656-661"
    ]
  },
  {
    "slug": "battle-tie-final-salvo",
    "q": "What happens if a battle ends in a tie?",
    "a": [
      "A tied vote battle goes to a Final Salvo. A Final Salvo is a set of short voting windows called shots, up to 5 shots of 60 seconds each. Only free votes count in a shot, one per wallet per shot.",
      "In a metrics battle an exact tie on points is settled by comparing market cap points, then holder points, then volume points, then Boost points. If those are level too, the battle is decided by a fixed rule on the token address, so there is always a winner for the prize. League points for a true draw are 0 for both coins."
    ],
    "keywords": [
      "tie",
      "draw",
      "final salvo",
      "tiebreaker",
      "overtime",
      "equal score"
    ],
    "sources": [
      "frontend/api/lib/arenaFinalSalvoRuntime.mjs:3-4,36-42",
      "frontend/api/lib/arenaBattleSettleV3.js:78-108",
      "frontend/api/lib/arenaLeagueScoreMath.js:3,355-356",
      "docs-site/src/content/arena/events.md:108"
    ]
  },
  {
    "slug": "battle-points-for-leagues",
    "q": "How many league points does a battle give?",
    "a": [
      "Ranked battles give the winner 3 points and the loser 1. Vote battles are always ranked.",
      "An unranked metrics battle is called Open War. Its points count half: 1.5 for a win and 0.5 for a loss. Points count toward the Major War League table."
    ],
    "bullets": [
      "Ranked win: 3, ranked loss: 1",
      "Open War win: 1.5, Open War loss: 0.5",
      "Draw: 0 for both"
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "alsoIn": [
      "leagues"
    ],
    "keywords": [
      "league points",
      "mwl points",
      "open war",
      "ranked battle",
      "points for win"
    ],
    "sources": [
      "docs-site/src/content/arena/live-battles.md:68-74",
      "frontend/api/lib/arenaLeagueScoreMath.js:1-3,355"
    ]
  },
  {
    "slug": "tournaments-explained",
    "q": "How do tournaments work?",
    "a": [
      "A tournament is a bracket of graduated coins. They fight round by round until one champion is left. Each matchup is a battle. A slot without an opponent advances on its own.",
      "In a vote tournament each wallet has one free vote per matchup and round, and can buy 2 Tournament Boosts per matchup. A Tournament Boost costs $1 and adds 1 point. Boosts close when 80% of the round time has passed. Some matchups go to a Final Salvo.",
      "To enter, connect the wallet that owns an eligible graduated coin, open the tournament and press Enter tournament."
    ],
    "links": [
      {
        "href": "/warzone/tournaments",
        "text": "Tournaments"
      }
    ],
    "keywords": [
      "tournament",
      "bracket",
      "tournament boost",
      "enter tournament",
      "champion",
      "rounds"
    ],
    "popular": false,
    "sources": [
      "docs-site/src/content/arena/events.md:84-116",
      "frontend/api/lib/arenaBoostRules.js:2-3"
    ]
  },
  {
    "slug": "tournament-sponsorship",
    "q": "Can a project sponsor a tournament?",
    "a": [
      "Yes. Sponsors can apply for event and tournament sponsorships. The team reviews each application. Submitting an application does not book anything and no payment is due at that point.",
      "The event sponsorship fee is 30% of the sponsorship: 20% goes to marketing and 10% to the protocol. A sponsored spot is paid visibility and not an endorsement by MemeWarzone."
    ],
    "links": [
      {
        "href": "/warzone/tournaments",
        "text": "Tournaments"
      }
    ],
    "alsoIn": [
      "promotion"
    ],
    "keywords": [
      "sponsor",
      "sponsorship",
      "event sponsor",
      "tournament prize pool",
      "advertise"
    ],
    "needsReview": "The 30% (20% marketing, 10% protocol) is from the platform fact sheet for event sponsorship; confirm it applies to tournament sponsors and not only to ad spots.",
    "sources": [
      "docs-site/src/content/arena/sponsorships.md:203-246",
      "docs-site/src/content/fees/index.md:19"
    ]
  },
  {
    "slug": "why-challenge-disappeared",
    "q": "Why did my challenge or battle disappear or not start?",
    "a": [
      "A battle goes live only after the other owner accepts and both sides have paid the buy-in. A challenge that is declined or not answered in time moves to the expired state and never goes live. If you were declined, the inbox shows the decline message when the other owner wrote one.",
      "If a challenge expires or is cancelled after one side has already paid the buy-in, that buy-in is refunded.",
      "If a battle you expected is not on the Live tab, check Upcoming, My battles and Finished, and check that the chain filter matches the battle's chain."
    ],
    "keywords": [
      "battle cancelled",
      "challenge expired",
      "battle not starting",
      "declined",
      "missing battle",
      "cancelled"
    ],
    "sources": [
      "frontend/api/arenaBattles.js:70-75",
      "frontend/api/lib/arenaChallengeInbox.js:13,45",
      "founder 2026-10-23"
    ]
  },
  {
    "slug": "watch-battles-live",
    "q": "How do I watch battles live?",
    "a": [
      "Open Warzone, then Battles. The tabs are Live, Upcoming, My battles and Finished. You can filter by chain and by battle type. The first live battle is shown large at the top.",
      "Press Open fight on a card to open the battle page. It shows both coins, the countdown, the score, and the Vote and Boost buttons. Scores update live. Below are tabs for live comments, all comments, supporters ranked by Boosts, the rules and the prize pool."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      },
      {
        "href": "/warzone/tournaments",
        "text": "Tournaments"
      }
    ],
    "keywords": [
      "watch battle",
      "live battles",
      "battle page",
      "supporters",
      "comments",
      "share battle"
    ],
    "sources": [
      "docs-site/src/content/arena/live-battles.md:12-60,76-78"
    ]
  }
];
