// Help Center articles: leagues. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-are-leagues",
    "q": "What are the leagues?",
    "a": [
      "Leagues are recurring competitions that rank coins, traders and recruiters. There is a weekly and a monthly round in most categories, and the top places share a prize pool.",
      "There are six categories, so more than one kind of performance can win. Standings move live while a round runs, and the result is fixed when it ends."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "keywords": [
      "league",
      "leagues",
      "competition",
      "leaderboard",
      "rankings",
      "prize pool"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/leagues/categories.md:6-17",
      "docs-site/src/content/leagues/epochs-and-prizes.md:35-44",
      "frontend/src/lib/leagues.ts:42-125"
    ]
  },
  {
    "slug": "league-periods",
    "q": "When do weekly and monthly leagues start and end?",
    "a": [
      "A weekly league runs from Monday 00:00 UTC to the next Monday 00:00 UTC. A monthly league runs from the 1st of the month 00:00 UTC to the 1st of the next month.",
      "The League page shows the exact window in the header and counts down under Ends in."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "keywords": [
      "epoch",
      "weekly league",
      "monthly league",
      "league end",
      "utc",
      "reset",
      "when does the league end"
    ],
    "sources": [
      "docs-site/src/content/leagues/epochs-and-prizes.md:37-44"
    ]
  },
  {
    "slug": "league-categories",
    "q": "What do the six league categories rank?",
    "a": [
      "Each category ranks a different thing."
    ],
    "bullets": [
      "Perfect Run: coins that graduated with no sells on the curve. Monthly only.",
      "Fastest Finish: the shortest time from launch to graduation. Creator buys are not counted.",
      "Biggest Hit: the largest single buy on a bonding curve in the round.",
      "Top Earner: trader profit and loss on the bonding curve, measured as net sells minus buys.",
      "Crowd Favorite: the most UpVotes from unique voters.",
      "Recruiter League: referral score across all chains."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "keywords": [
      "perfect run",
      "fastest finish",
      "biggest hit",
      "top earner",
      "crowd favorite",
      "recruiter league",
      "categories"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/leagues/categories.md:10-17",
      "frontend/src/lib/leagues.ts:48-125"
    ]
  },
  {
    "slug": "how-league-prizes-are-funded",
    "q": "Where does the league prize money come from?",
    "a": [
      "League prizes come from trading fees. Every buy and sell on the bonding curve pays a 2% fee, and 37.5% of that fee goes to the league pool. Nobody pays an entry fee to join a league.",
      "The pool for a round is split over the categories and then over the ranks in each category. The prize pool therefore depends on trading volume and is not fixed in advance."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "alsoIn": [
      "fees"
    ],
    "keywords": [
      "prize pool",
      "league fee",
      "37.5%",
      "funded",
      "where does prize come from"
    ],
    "sources": [
      "docs-site/src/content/fees/fee-routing.md:22-53",
      "frontend/api/league.js:554-600"
    ]
  },
  {
    "slug": "how-many-ranks-are-paid",
    "q": "How many places get paid in a league?",
    "a": [
      "When enough entrants qualify, at least the top 3 are paid in a weekly league and at least the top 5 in a monthly league. With more entrants, more ranks are paid. The standings then say that further ranks are paid too.",
      "The higher the rank, the larger the share. Payout now next to each rank shows what that place would get if the round ended now. Monthly prizes can have a cap per player, and the page warns you when it applies."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "keywords": [
      "paid ranks",
      "top 3",
      "top 5",
      "payout curve",
      "prize breakdown",
      "player cap",
      "how many winners"
    ],
    "sources": [
      "docs-site/src/content/leagues/epochs-and-prizes.md:50-57",
      "frontend/src/lib/leagues.ts:36-39,99-110,148-155"
    ]
  },
  {
    "slug": "league-prizes-paid-and-claimed",
    "q": "How are league prizes paid and claimed?",
    "a": [
      "Nothing is paid out automatically. When a round closes, results are checked and published, winners show on the page and in the Hall of fame, and the prize moves into the claim flow in your Command Center.",
      "Prizes are paid in the coin of the chain you earned them on. Claim with the wallet that earned the place.",
      "Claim within 90 days. After that, an unclaimed league prize goes back into the league prize pool."
    ],
    "steps": [
      "Open Command Center and go to Rewards and claims.",
      "Connect the wallet that earned the place and check the chain at the top.",
      "Press Claim on the League Rewards row when it is Ready.",
      "Confirm in your wallet."
    ],
    "alsoIn": [
      "rewards"
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "keywords": [
      "claim league prize",
      "league reward",
      "hall of fame",
      "league payout",
      "claim"
    ],
    "sources": [
      "docs-site/src/content/leagues/epochs-and-prizes.md:59-64",
      "docs-site/src/content/leagues/claims.md:76",
      "docs-site/src/content/command-center/claims.md:139",
      "founder 2026-10-23"
    ]
  },
  {
    "slug": "where-to-see-league-standings",
    "q": "Where do I see league standings?",
    "a": [
      "Open the League page. Pick a category and a period, weekly or monthly. If you pick Perfect Run while Weekly is selected, the page switches to Monthly because Perfect Run is monthly only.",
      "The page shows the prize pool, the time left, the live standings and earlier rounds. Major War League standings are on their own page under Warzone."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      },
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "keywords": [
      "standings",
      "leaderboard",
      "where is the league",
      "my rank",
      "league page"
    ],
    "sources": [
      "docs-site/src/content/leagues/categories.md:19",
      "docs-site/src/content/arena/major-war-league.md:126-138"
    ]
  },
  {
    "slug": "why-am-i-not-on-the-league-leaderboard",
    "q": "Why am I not on the league leaderboard?",
    "a": [
      "Usually the activity did not count in that category or that round. Some rules that apply:"
    ],
    "bullets": [
      "Fastest Finish ignores creator buys.",
      "Top Earner leaves out a creator's trades on their own coin.",
      "Perfect Run only counts coins that graduated with no sells on the curve, and only in the monthly round.",
      "Crowd Favorite counts confirmed UpVotes from unique voters.",
      "Recruiter League needs referred trading in the current round for a paid place.",
      "Hidden coins and activity flagged as self trading, wash trading or linked wallet farming are excluded.",
      "Check that the chain and the period at the top match where you were active."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "keywords": [
      "not on leaderboard",
      "missing from league",
      "not ranked",
      "league qualification",
      "why not ranked"
    ],
    "needsReview": "Exact qualification thresholds per category (for example minimum volume) were not found in the client code. The anti-abuse docs deliberately do not publish trigger rules.",
    "sources": [
      "frontend/src/lib/leagues.ts:48-125",
      "frontend/api/league.js:1228,1287,1584",
      "docs-site/src/content/security/anti-abuse.md"
    ]
  },
  {
    "slug": "crowd-favorite-league",
    "q": "How does the Crowd Favorite league work?",
    "a": [
      "Crowd Favorite ranks coins by confirmed UpVotes from unique voters in the selected week or month. Many votes from one wallet do not stack the way votes from many wallets do.",
      "An UpVote is a paid on-platform signal. It is not a recommendation to buy and it is not a safety check."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "alsoIn": [
      "promotion"
    ],
    "keywords": [
      "crowd favorite",
      "upvotes league",
      "unique voters",
      "votes ranking"
    ],
    "sources": [
      "frontend/src/lib/leagues.ts:89-100",
      "docs-site/src/content/leagues/categories.md:16",
      "docs-site/src/content/security/overview.md"
    ]
  },
  {
    "slug": "recruiter-league",
    "q": "What is the Recruiter League?",
    "a": [
      "The Recruiter League ranks recruiters across all chains. The score combines your network and the volume it traded in the current round. It is paid from the league fee like the other leagues.",
      "A paid place needs referred trading in the current round. Prizes go to your recruiter wallet on each chain."
    ],
    "links": [
      {
        "href": "/recruiters",
        "text": "Recruiter leaderboard"
      },
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "alsoIn": [
      "recruiters"
    ],
    "keywords": [
      "recruiter league",
      "referral score",
      "recruiter prize",
      "recruiter ranking"
    ],
    "sources": [
      "frontend/src/lib/leagues.ts:102-120",
      "docs-site/src/content/leagues/categories.md:17"
    ]
  },
  {
    "slug": "major-war-league-explained",
    "q": "What is the Major War League?",
    "a": [
      "The Major War League is the monthly table for graduated coins. Coins earn points in ranked battles. Points reset every season. The top 8 coins play the quarterly finals.",
      "It is a separate competition from the six weekly and monthly leagues. Its prize pool comes from 20% of every battle buy-in."
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "keywords": [
      "mwl",
      "major war league",
      "war league",
      "monthly table",
      "quarterly finals",
      "quarter finals"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/arena/major-war-league.md:6-12,140-149,161-166"
    ]
  },
  {
    "slug": "major-war-league-points",
    "q": "How do coins earn Major War League points?",
    "a": [
      "Mainly through battles: a ranked win is 3 points and a ranked loss is 1. An Open War win is 1.5 and a loss is 0.5. A tournament win adds a bonus of 2 points. A draw gives 0.",
      "The owner of a coin can also check in. A daily check-in gives 0.1 point, and every 7th day in a row adds 0.5 more. A coin must have fought at least once in the current month before check-in points land."
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "alsoIn": [
      "battles"
    ],
    "keywords": [
      "mwl points",
      "check in",
      "check-in points",
      "streak",
      "league points",
      "tournament bonus"
    ],
    "sources": [
      "frontend/api/lib/arenaLeagueScoreMath.js:1-8,289-292",
      "frontend/api/lib/arenaLeagueScore.js:261-330",
      "docs-site/src/content/arena/major-war-league.md:140-149"
    ]
  },
  {
    "slug": "what-is-a-check-in",
    "q": "What is a daily check-in?",
    "a": [
      "A check-in is one signed action per UTC day by the owner of a coin, either the creator or a verified owner of an imported coin. It builds a streak that shows as a badge on the coin and the profile.",
      "Every 7th day in a row earns one free UpVote credit. For coins in the Major War League the check-in also adds league points, as described in the points article. Missing a day resets the streak."
    ],
    "steps": [
      "Connect the wallet that owns the coin.",
      "Open the check-in on the Major War League page or the coin.",
      "Sign the message. It names the chain, the coin and the day."
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "keywords": [
      "check in",
      "checkin",
      "daily",
      "streak",
      "free upvote",
      "streak badge"
    ],
    "needsReview": "Confirm the exact button location of the check-in in the UI.",
    "sources": [
      "frontend/api/creatorStreaks.js:1-8",
      "frontend/api/lib/creatorStreak.js:3-9,45-48",
      "frontend/api/lib/arenaLeagueScoreMath.js:281-287",
      "frontend/api/arenaLeague.js:505-545"
    ]
  },
  {
    "slug": "major-war-league-prize-pool",
    "q": "How is the Major War League prize pool split?",
    "a": [
      "20% of every battle buy-in goes to the league. On BNB Chain and Robinhood Chain each deposit is split: 60% to the current month and 40% to the quarterly finals. The page shows the monthly prize pool and the quarterly finals pot.",
      "On Solana one pot pays both the monthly round and the quarterly finals.",
      "League prizes are claimed in the Command Center under Rewards and claims. Major War League prizes do not expire."
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "alsoIn": [
      "battles"
    ],
    "keywords": [
      "mwl prize",
      "60/40",
      "quarterly pot",
      "monthly pool",
      "solana pot"
    ],
    "sources": [
      "docs-site/src/content/arena/major-war-league.md:161-168",
      "docs-site/src/content/rewards/epochs-and-claims.md:108-114"
    ]
  },
  {
    "slug": "major-war-league-quarter-finals",
    "q": "How do the quarterly finals work?",
    "a": [
      "The top 8 coins of the quarter play the finals. The projected matchups are 1 against 8, 4 against 5, 3 against 6 and 2 against 7.",
      "A coin needs at least 3 finished fights in the quarter to appear in the projected field. The Quarter Finals tab shows the projected field, the last coin inside the cut and the first coin outside it."
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      }
    ],
    "keywords": [
      "quarter finals",
      "top 8",
      "finals",
      "qualify",
      "cut line",
      "seeding"
    ],
    "sources": [
      "docs-site/src/content/arena/major-war-league.md:155-159",
      "frontend/api/lib/arenaLeagueScoreMath.js:9-10"
    ]
  },
  {
    "slug": "who-can-join-major-war-league",
    "q": "Which coins can join the Major War League?",
    "a": [
      "Graduated coins can. A coin enters the table by fighting a ranked battle. There is no separate sign-up.",
      "The Your tokens list on the Major War League page shows the coins your connected wallet created. The page follows the chain you have selected."
    ],
    "links": [
      {
        "href": "/warzone/major-war-league",
        "text": "Major War League"
      },
      {
        "href": "/warzone/battles",
        "text": "Battles"
      }
    ],
    "keywords": [
      "join mwl",
      "enter league",
      "eligible coins",
      "graduated only",
      "your tokens"
    ],
    "needsReview": "Confirm imported coins also enter the Major War League table; the founder says they can battle, and arenaEligibility.js is the gate.",
    "sources": [
      "docs-site/src/content/arena/major-war-league.md:122-138",
      "frontend/api/lib/arenaEligibility.js:16-23",
      "frontend/api/lib/arenaLeagueScore.js:261-290"
    ]
  }
];
