// Help Center articles: graduation. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-is-graduation",
    "q": "What is graduation?",
    "a": [
      "Graduation is the step from the bonding curve to a DEX pool. It happens when the coin's curve sells out at the graduation market cap the creator chose at launch, $30K or $50K.",
      "After that the curve is closed and the coin trades in a normal liquidity pool. The coin keeps its coin page, posts, holders and history. Progress toward graduation shows on the coin page and as the Curve percentage on the coin card."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "graduate",
      "graduated",
      "migration",
      "migrate",
      "bonding complete",
      "grad"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/platform/graduation.md:1-12",
      "frontend/shared/evmGen8.mjs:55-56"
    ]
  },
  {
    "slug": "what-is-a-bonding-curve",
    "q": "What is a bonding curve?",
    "a": [
      "A bonding curve is a price formula built into the coin's contract. It lets a new coin trade from the first second, before any pool exists. Buys push the price up and sells push it down along the curve.",
      "Every new coin puts 85% of its supply on the curve. When those tokens are sold, the coin graduates. Early on, one trade can move the price a lot. Read the quote before you confirm."
    ],
    "keywords": [
      "curve",
      "bonding",
      "how pricing works",
      "pump fun curve",
      "price formula",
      "curve progress"
    ],
    "alsoIn": [
      "trading"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/platform/bonding-curve.md",
      "frontend/shared/evmGen8.mjs:33"
    ]
  },
  {
    "slug": "what-happens-step-by-step-at-graduation",
    "q": "What exactly happens when a coin graduates?",
    "a": [
      "When the curve completes, these things happen in order. On BNB Chain and Robinhood Chain graduation is instant."
    ],
    "steps": [
      "The curve is complete and curve trading ends.",
      "A 2% graduation fee goes to MemeWarzone's fee routing.",
      "The liquidity moves into the coin's DEX pool and is locked for good.",
      "The creator's 2% reserve (20M tokens) becomes releasable under the chain's rule.",
      "The coin card switches from LIVE to DEX.",
      "The Buy and Sell panel now trades in the pool, and the button names the DEX."
    ],
    "keywords": [
      "graduation process",
      "what changes",
      "after graduating",
      "liquidity move",
      "migration steps"
    ],
    "sources": [
      "docs-site/src/content/platform/graduation.md:14-26",
      "founder 2026-10-12"
    ]
  },
  {
    "slug": "where-do-graduated-coins-trade",
    "q": "Where do coins trade after graduation?",
    "a": [
      "In a DEX pool, on the same MemeWarzone coin page. You do not have to leave the site."
    ],
    "bullets": [
      "BNB Chain: Uniswap V4",
      "Robinhood Chain: Uniswap V4",
      "Solana: Meteora (DAMM v2)"
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "uniswap",
      "meteora",
      "dex",
      "pancakeswap",
      "pool",
      "where to trade",
      "raydium"
    ],
    "sources": [
      "docs-site/src/content/platform/graduation.md:28-36",
      "docs-site/src/content/fees/after-graduation.md:10-18"
    ],
    "needsReview": "Older coins that graduated before gen-8 are in Topaz (BNB Chain) or Uniswap V3 (Robinhood Chain) pools. Confirm how to word this for users."
  },
  {
    "slug": "is-liquidity-locked-after-graduation",
    "q": "Is the liquidity locked after graduation?",
    "a": [
      "Yes. At graduation the coin's liquidity goes into the DEX pool and is locked for good. Nobody can withdraw it, including MemeWarzone and the creator.",
      "That removes the usual liquidity pull. It does not make a coin safe: the price can still fall as holders sell."
    ],
    "keywords": [
      "rug pull",
      "locked liquidity",
      "lp lock",
      "burn liquidity",
      "safe",
      "can creator remove liquidity"
    ],
    "alsoIn": [
      "safety"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/fees/after-graduation.md:8-10",
      "docs-site/src/content/creators/launch-rules.md:60-64"
    ]
  },
  {
    "slug": "creator-reserve-release-rules",
    "q": "When does the creator get the 2% reserve?",
    "a": [
      "Every coin sets aside 2% of the supply (20M tokens) as a creator reserve. When it is released depends on the chain."
    ],
    "bullets": [
      "Solana: released at graduation.",
      "BNB Chain and Robinhood Chain: released no earlier than 1 hour after graduation, and only while the price is at or above the graduation price."
    ],
    "keywords": [
      "reserve",
      "creator tokens",
      "dev tokens",
      "unlock",
      "team allocation",
      "1 hour"
    ],
    "alsoIn": [
      "create"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:191",
      "frontend/shared/dbcEconomics.mjs:23-34",
      "docs-site/src/content/creators/launch-rules.md:28"
    ]
  },
  {
    "slug": "coin-never-graduates",
    "q": "What happens if my coin never graduates?",
    "a": [
      "It stays on its bonding curve. The curve keeps working: anyone can still buy and sell, and the price still follows the curve. The coin is not removed, and no expiry date was found in the launch settings.",
      "It can still get posts, followers and UpVotes. Graduation depends on enough people buying, and it is never promised."
    ],
    "keywords": [
      "stuck",
      "stalled",
      "dead coin",
      "not graduating",
      "no buyers",
      "refund",
      "expire"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs",
      "frontend/shared/dbcEconomics.mjs",
      "docs-site/src/content/platform/bonding-curve.md"
    ],
    "needsReview": "No time limit or refund path was found in code. Confirm there is none."
  },
  {
    "slug": "how-far-is-my-coin-from-graduating",
    "q": "How can I see how close a coin is to graduating?",
    "a": [
      "Open the coin page. Curve progress shows there, and the coin card shows it as the Curve percentage. The target market cap ($30K or $50K) was set by the creator at launch and does not change.",
      "On Solana, a full bar alone is not graduation. The coin counts as graduated once the move to its Meteora pool is confirmed on-chain. The coin card then switches from LIVE to DEX."
    ],
    "keywords": [
      "curve percentage",
      "progress bar",
      "graduation progress",
      "how close",
      "bar full"
    ],
    "sources": [
      "docs-site/src/content/platform/graduation.md:4-8",
      "frontend/src/lib/helpCenter.ts:359-363"
    ],
    "needsReview": "The Solana pool-confirmation note comes from the old help text. Re-check against the current graduation keeper behaviour."
  },
  {
    "slug": "do-i-press-a-graduate-button",
    "q": "Do I need to press a Graduate button?",
    "a": [
      "No. Graduation happens on its own when the curve completes. On BNB Chain and Robinhood Chain it is instant. On Solana MemeWarzone's own keeper moves the coin into its Meteora pool after the curve completes, which can take a short while."
    ],
    "keywords": [
      "manual graduation",
      "migrate button",
      "graduate manually",
      "keeper"
    ],
    "sources": [
      "founder 2026-10-12",
      "docs/claude/meteora-dbc.md:25-26",
      "docs/claude/solana-ops.md"
    ],
    "needsReview": "Confirm the typical delay between a full curve and the Solana pool being live."
  },
  {
    "slug": "jupiter-before-graduation-solana",
    "q": "Can I trade a Solana coin on Jupiter before it graduates?",
    "a": [
      "Yes for coins launched on the Meteora Dynamic Bonding Curve, which is how new Solana coins launch. Jupiter can route trades on the curve, so a new coin is also reachable from Jupiter and from wallets that use Jupiter.",
      "After graduation the coin trades in a Meteora pool, and the coin page keeps working as before."
    ],
    "keywords": [
      "jupiter",
      "phantom swap",
      "dex aggregator",
      "solana trade outside",
      "external trade"
    ],
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "docs/claude/meteora-dbc.md:27-30",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "does-the-chart-reset-at-graduation",
    "q": "Does the chart reset when a coin graduates?",
    "a": [
      "No. The chart continues from the curve into DEX trading. After graduation the market history also includes trades made directly in the DEX pool, not only trades made on MemeWarzone."
    ],
    "keywords": [
      "chart",
      "price history",
      "dex trades",
      "candles",
      "external trades"
    ],
    "sources": [
      "frontend/src/lib/helpCenter.ts:359-371"
    ],
    "needsReview": "Copied from old help text. Confirm gen-8 and Meteora coins still stitch the chart and include outside DEX trades."
  },
  {
    "slug": "what-changes-for-a-coin-after-graduation",
    "q": "What can a coin do after it graduates?",
    "a": [
      "A graduated coin can challenge other coins to battles, enter tournaments and earn Major War League points. Its graduation shows up as an auto update on the coin page and on the home feed.",
      "The creator should announce it through official channels, remind people the coin page link stays the same, and watch for fake pool links and impersonators."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      }
    ],
    "keywords": [
      "after graduation",
      "next steps",
      "battle graduated",
      "major war league",
      "creator checklist"
    ],
    "alsoIn": [
      "battles"
    ],
    "sources": [
      "docs-site/src/content/platform/graduation.md:38-42",
      "docs-site/src/content/creators/graduation.md:8-14"
    ]
  },
  {
    "slug": "does-graduation-mean-price-goes-up",
    "q": "Does graduation make the price go up?",
    "a": [
      "No. Graduation moves the coin from the curve to a pool at the curve's last price. What happens next depends on buyers and sellers, as with any coin.",
      "Graduation is also not a safety check. It shows the curve was filled, nothing more."
    ],
    "keywords": [
      "pump after graduation",
      "price after migration",
      "dump",
      "moon",
      "good sign"
    ],
    "alsoIn": [
      "safety"
    ],
    "sources": [
      "docs/claude/meteora-dbc.md:121-124",
      "founder 2026-10-22"
    ],
    "needsReview": "The pool-opens-at-last-price statement is verified for Solana DBC only. Check the EVM gen-8 pool opening price."
  }
];
