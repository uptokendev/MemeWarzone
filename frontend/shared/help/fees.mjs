// Help Center articles: fees. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-is-the-trade-fee",
    "q": "How much is the fee when I trade?",
    "a": [
      "Every buy and every sell on a bonding curve pays a 2% fee. It is part of the trade and is already in the quote. It is not added afterwards.",
      "You also pay a network fee (gas) to the chain. That is separate and does not go to MemeWarzone. After a coin graduates, the 2% curve fee stops and the pool's own fee applies."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      }
    ],
    "keywords": [
      "fee",
      "trading fee",
      "2%",
      "how much fee",
      "cost to trade"
    ],
    "popular": true,
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "docs-site/src/content/fees/index.md:11",
      "frontend/shared/evmGen8.mjs GEN8_RATES bondingBps 200"
    ]
  },
  {
    "slug": "where-the-trade-fee-goes",
    "q": "Where does the 2% trade fee go?",
    "a": [
      "The 2% is split in the same transaction as the trade. Shares below are of the 2% fee. League prizes get 37.5%. The coin's creator gets 5.6%, which is 0.112% of the trade. The recruiter gets 12.5% (OG recruiters 15%). The squad pool gets 2.5%. MemeWarzone keeps the rest, 41.9% for a linked trader.",
      "If the trader has no recruiter, nobody earns the recruiter and squad slices. They go to the weekly Warzone Airdrops, 15% of the fee. Rewards come out of the 2%. None of them adds a fee of its own."
    ],
    "bullets": [
      "League prizes: 37.5%",
      "Creator: 5.6% (0.112% of the trade)",
      "Recruiter: 12.5%, or 15% for OG recruiters",
      "Squad pool: 2.5%",
      "Airdrops: 15%, only when the trader has no recruiter",
      "MemeWarzone: the remainder, 41.9% for a linked trader"
    ],
    "links": [
      {
        "href": "/league",
        "text": "See the league"
      }
    ],
    "keywords": [
      "fee split",
      "fee routing",
      "where does the fee go",
      "league share",
      "recruiter share",
      "treasury"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/fees/fee-routing.md:21-53",
      "docs-site/src/content/fees/where-fees-go.md"
    ]
  },
  {
    "slug": "solana-meteora-fee-share",
    "q": "Is the fee different for new Solana coins?",
    "a": [
      "The trade fee is still 2%. New Solana coins trade on a Meteora bonding curve, and Meteora keeps 20% of every fee, which is 0.40% of the trade. The remaining 80% is split into the same reward slices by the same rules.",
      "The creator share is the same 0.112% of the trade. MemeWarzone's own share is smaller, 21.9% of the fee for a linked trader. When you trade on memewar.zone, Meteora pays part of its cut back to MemeWarzone as a referral."
    ],
    "keywords": [
      "meteora",
      "dbc",
      "solana fee",
      "20% meteora",
      "dynamic bonding curve"
    ],
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "docs-site/src/content/fees/fee-routing.md:55-71",
      "docs/claude/meteora-dbc.md"
    ]
  },
  {
    "slug": "creator-earnings-per-trade",
    "q": "How much does a creator earn from trades?",
    "a": [
      "On new coins the creator gets 5.6% of the 2% trade fee, which is 0.112% of every buy and sell. A coin that trades 100,000 dollars in volume on the curve earns its creator about 112 dollars.",
      "After graduation the creator side gets half of the 1% pool fee on BNB Chain and Robinhood Chain, and 80% of the 0.25% pool fee on Solana. Creators claim in the Command Center under Rewards and claims. Earnings are not guaranteed and depend on real trading."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "creator earnings",
      "creator fee",
      "0.112%",
      "how creators earn",
      "creator share"
    ],
    "alsoIn": [
      "create",
      "rewards"
    ],
    "sources": [
      "docs-site/src/content/creators/creator-earnings.md:14-24",
      "docs-site/src/content/fees/index.md:30-40"
    ]
  },
  {
    "slug": "older-coins-creator-share",
    "q": "Why do older coins pay creators 0.10% and not 0.112%?",
    "a": [
      "A coin keeps the rules it launched with, and its fee never changes. Coins launched before October 2026, and coins on the earlier Solana launchpad curve, give the creator 5% of the 2% fee, which is 0.10% of every trade.",
      "New coins give 5.6% (0.112%). The difference comes out of MemeWarzone's own share, not out of the other slices."
    ],
    "keywords": [
      "0.10%",
      "old coins",
      "creator share old",
      "launched before october"
    ],
    "sources": [
      "docs-site/src/content/fees/index.md:34-40",
      "docs-site/src/content/fees/fee-routing.md:73-85"
    ]
  },
  {
    "slug": "graduation-fee",
    "q": "What is the graduation fee?",
    "a": [
      "When a coin graduates, MemeWarzone takes 2% of the coin's raise, once. The creator gets no share of it. It goes to the recruiter, squad and airdrop slices and to MemeWarzone.",
      "The creator does get the 2% reserve (20 million tokens). Solana releases it at graduation. BNB Chain and Robinhood Chain release it no earlier than 1 hour after graduation, and only while the price is at or above the graduation price."
    ],
    "keywords": [
      "graduation fee",
      "2% graduation",
      "raise fee",
      "creator reserve"
    ],
    "alsoIn": [
      "graduation"
    ],
    "sources": [
      "docs-site/src/content/fees/fee-routing.md:93-108",
      "frontend/shared/evmGen8.mjs GEN8_RATES graduationFeeBps 200",
      "docs-site/src/content/creators/creator-earnings.md:8"
    ]
  },
  {
    "slug": "fees-after-graduation",
    "q": "What fees apply after a coin graduates?",
    "a": [
      "The 2% curve fee stops and the DEX pool charges its own fee. On BNB Chain and Robinhood Chain every swap pays 1%: 0.5% to the creator side and 0.5% to MemeWarzone. On Solana the Meteora pool charges 0.25%: 80% to the creator side and 20% to MemeWarzone.",
      "Older BNB Chain and Robinhood coins that graduated into earlier pools split 80% creator side and 20% MemeWarzone. Pool liquidity is locked for good, so nobody can withdraw it."
    ],
    "keywords": [
      "after graduation fee",
      "pool fee",
      "uniswap fee",
      "0.25%",
      "dex fee",
      "1% fee"
    ],
    "alsoIn": [
      "graduation",
      "trading"
    ],
    "sources": [
      "docs-site/src/content/fees/after-graduation.md:8-24",
      "frontend/shared/evmGen8.mjs GEN8_RATES postBps 100, creatorPostBps 50"
    ]
  },
  {
    "slug": "imported-coin-swap-fee",
    "q": "What is the fee on imported coins?",
    "a": [
      "Swaps of imported coins pay a 1% fee on every chain. Half, 0.5%, goes to the coin's creator and half to MemeWarzone. The fee is shown in the quote before you confirm.",
      "While a coin is unclaimed, the creator's half is held for 90 days per trade. If the creator claims the coin in that time, it is paid out. What is still unclaimed after 90 days goes to MemeWarzone."
    ],
    "links": [
      {
        "href": "/import",
        "text": "Import a coin"
      }
    ],
    "keywords": [
      "import fee",
      "swap fee",
      "imported swap 1%",
      "unclaimed fees",
      "90 days"
    ],
    "alsoIn": [
      "imports",
      "trading"
    ],
    "sources": [
      "docs-site/src/content/fees/after-graduation.md:26-38",
      "founder 2026-10-22 (facts file, imports 1% on every chain)"
    ],
    "needsReview": "docs-site/src/content/fees/index.md:18 still says imports pay 0.5% on BNB Chain and Robinhood Chain. after-graduation.md and the founder say 1%."
  },
  {
    "slug": "upvote-and-boost-prices",
    "q": "How much do UpVotes and Boosts cost?",
    "a": [
      "An UpVote costs 3 dollars, paid in the chain's own coin, so the amount of BNB, SOL or ETH changes with the price. One transaction is one vote. The fee goes to MemeWarzone.",
      "A battle Boost costs 1 dollar and adds 1 point. 90% of a Boost goes to the prize and 10% to MemeWarzone. A wallet can Boost twice per battle, and Boosts close in the last 20% of a battle."
    ],
    "keywords": [
      "upvote price",
      "$3",
      "boost price",
      "$1",
      "how much is an upvote"
    ],
    "alsoIn": [
      "promotion",
      "battles"
    ],
    "sources": [
      "frontend/src/components/token/UpvoteDialog.tsx:38-39",
      "docs-site/src/content/fees/index.md:20-22",
      "frontend/api/lib/arenaBoostRules.js"
    ]
  },
  {
    "slug": "network-fees-are-separate",
    "q": "Are network fees (gas) part of the MemeWarzone fee?",
    "a": [
      "No. Network fees are paid to the chain, not to MemeWarzone. They come on top of the 2% trade fee. The amount depends on the chain and how busy it is. Your wallet shows it before you confirm.",
      "Keep some BNB, SOL or ETH in the wallet for them. On Solana a trade can also pay a small one-time rent for a new token account."
    ],
    "keywords": [
      "gas",
      "network fee",
      "gas fee",
      "rent",
      "transaction cost"
    ],
    "alsoIn": [
      "trading",
      "troubleshooting"
    ],
    "sources": [
      "docs-site/src/content/fees/index.md:25",
      "frontend/src/lib/tradeBalanceReserve.ts:4-10"
    ]
  },
  {
    "slug": "no-fee-to-launch",
    "q": "Does it cost anything to launch a coin?",
    "a": [
      "MemeWarzone charges no platform fee to create a coin. You pay network costs only. On Solana, setting up the launch costs about 0.006 SOL in rent, and a first buy of your own coin pays the normal 2% fee.",
      "A launch can be refused if the wallet cannot cover the first buy plus gas and launch costs."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Create a coin"
      }
    ],
    "keywords": [
      "launch cost",
      "create fee",
      "free to launch",
      "deploy cost"
    ],
    "alsoIn": [
      "create"
    ],
    "sources": [
      "docs/claude/meteora-dbc.md",
      "docs-site/src/content/creators/launch-rules.md:41-52"
    ],
    "needsReview": "The 0.006 SOL rent figure comes from docs/claude/meteora-dbc.md; the measured total reserve is 0.03 SOL (tradeBalanceReserve.ts:54). Confirm which figure to show."
  },
  {
    "slug": "why-memewarzone-charges-fees",
    "q": "Why does MemeWarzone take a fee, and who holds the money?",
    "a": [
      "MemeWarzone's share pays for development, servers, audits and the team. Rewards come out of the 2% fee before the protocol share is counted, so the protocol gets what is left.",
      "MemeWarzone never holds your coins. Fees are split by the contract or program in the same transaction as the trade. Protocol earnings above a fixed cap move to a multisig wallet that needs several signers to move funds."
    ],
    "links": [
      {
        "href": "/about",
        "text": "Contracts and wallets"
      }
    ],
    "keywords": [
      "revenue",
      "treasury",
      "multisig",
      "non custodial",
      "who gets the money"
    ],
    "alsoIn": [
      "safety"
    ],
    "sources": [
      "docs-site/src/content/fees/where-fees-go.md:44-54",
      "docs-site/src/content/fees/index.md:27"
    ]
  },
  {
    "slug": "battle-and-sponsorship-fees",
    "q": "What fees apply to battles and sponsorships?",
    "a": [
      "A battle buy-in carries a 25% fee: 20% goes to the Major War League pool and 5% to MemeWarzone. The other 75% is the prize. A Boost carries a 10% fee to MemeWarzone, and 90% goes to the prize.",
      "Event sponsorships carry a 30% fee: 20% marketing and 10% MemeWarzone. The other 70% is the event prize."
    ],
    "keywords": [
      "buy in fee",
      "battle fee",
      "boost fee",
      "sponsor fee",
      "major war league"
    ],
    "alsoIn": [
      "battles"
    ],
    "sources": [
      "docs-site/src/content/fees/index.md:19-21",
      "frontend/api/lib/arenaBoostRuntime.mjs"
    ]
  },
  {
    "slug": "all-fees-at-a-glance",
    "q": "What are all the fees on MemeWarzone?",
    "a": [
      "Curve trades pay 2%. The first 60 seconds after a launch start at 90% and fall to 2%. Graduation takes 2% of the raise once. After graduation the pool fee applies. Imported swaps pay 1%.",
      "An UpVote is 3 dollars and a Boost is 1 dollar. Battle buy-ins carry 25%. Network fees are separate and go to the chain."
    ],
    "bullets": [
      "Curve trade: 2% of every buy and sell",
      "Launch fee: 90% falling to 2% in 60 seconds",
      "Graduation: 2% of the raise, once",
      "After graduation: 1% (BNB Chain, Robinhood Chain) or 0.25% (Solana)",
      "Imported swap: 1%",
      "UpVote: 3 dollars. Boost: 1 dollar"
    ],
    "keywords": [
      "all fees",
      "fee table",
      "fee list",
      "pricing",
      "costs"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/fees/index.md:9-24"
    ]
  }
];
