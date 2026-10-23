// Help Center articles: trading. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "how-to-buy-and-sell",
    "q": "How do I buy or sell a coin?",
    "a": [
      "Open the coin page and use the Buy/Sell panel. The panel is the same for coins launched on MemeWarzone and for imported coins. A coin on its bonding curve trades on MemeWarzone itself. A graduated or imported coin trades in a DEX pool, still from the same page.",
      "You need a connected wallet on the coin's chain. On a phone, Buy and Sell sit at the bottom of the coin page and open the panel as a sheet."
    ],
    "steps": [
      "Open the coin page and pick Buy (green) or Sell (red).",
      "Type an amount. Quick buttons such as 25%, 50% or 100% fill in a share of your balance.",
      "Read the quote: what you pay and about what you get.",
      "Check the slippage where the panel shows it.",
      "Press the big button and read the wallet request before you confirm."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "buy",
      "sell",
      "trade",
      "how to buy",
      "swap",
      "purchase",
      "trade panel"
    ],
    "popular": true,
    "alsoIn": [
      "getting-started"
    ],
    "sources": [
      "docs-site/src/content/traders/trading-basics.md:10-25"
    ]
  },
  {
    "slug": "which-coin-do-i-pay-with",
    "q": "Which coin do I pay with when I buy?",
    "a": [
      "You pay with the native coin of the chain the token lives on: BNB on BNB Chain, SOL on Solana and ETH on Robinhood Chain. Each coin lives on one chain, so a Solana coin cannot be bought from a BNB wallet.",
      "On Solana the creator can choose another token to pair with, such as USDC from an approved list. For those coins the panel shows which token it asks for. Always read the panel and the wallet request before you confirm.",
      "Keep a little of the chain's native coin in the wallet for the network fee, whatever you buy with."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "pay with",
      "quote token",
      "usdc",
      "bnb",
      "sol",
      "eth",
      "which currency",
      "native coin"
    ],
    "alsoIn": [
      "wallets"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:22-34",
      "docs-site/src/content/platform/bonding-curve.md (What the coin is priced in)",
      "docs-site/src/content/platform/solana-operations.md:18"
    ],
    "needsReview": "Which quote tokens are active on mainnet Solana right now (docs only say 'such as USDC' from an approved list)."
  },
  {
    "slug": "what-is-slippage",
    "q": "What is slippage?",
    "a": [
      "Slippage is how far the price may move between the quote you see and the moment your trade lands. If the price moves past your limit, the trade fails instead of filling at a worse price. You then lose only the network fee.",
      "Use the lowest slippage that works. A very high setting lets the trade fill at a much worse price, and on public networks it gives bots more room to trade around you."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "slippage",
      "price moved",
      "tolerance",
      "minimum received",
      "at least"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/traders/bonding-curve.md:25-27",
      "frontend/src/components/evm/Gen8TradePanel.tsx:564 (At least line)"
    ]
  },
  {
    "slug": "slippage-settings-by-chain",
    "q": "Can I change the slippage in the trade panel?",
    "a": [
      "It depends on the chain and the coin. On BNB Chain the panel has a Slippage menu with Auto, 0.5%, 1% and 3%. Auto starts at 0.3% and adds a little for larger trades, up to 1%.",
      "On Robinhood Chain the panel uses a fixed 1%. Imported coins also use a fixed 1%. On Solana the curve trade uses a fixed 5% limit, and the panel has no menu for it.",
      "If a trade keeps failing on slippage, try a smaller amount first. Raise the setting only when you accept a worse price."
    ],
    "keywords": [
      "slippage setting",
      "auto slippage",
      "0.5%",
      "3%",
      "change slippage",
      "tolerance"
    ],
    "sources": [
      "frontend/src/components/evm/Gen8TradePanel.tsx:74-75,512-530",
      "frontend/shared/evmGen8Swap.mjs:425-458",
      "frontend/src/pages/TokenDetails.tsx:142 (SLIPPAGE_PCT = 5)",
      "frontend/src/components/arena/ImportedTradePanel.tsx:509"
    ],
    "needsReview": "Older BNB and Robinhood coins that trade through Topaz or Uniswap V3 use 1% in code (TokenDetails.tsx:1137); confirm whether any such coin still shows a menu."
  },
  {
    "slug": "what-is-price-impact",
    "q": "What is price impact?",
    "a": [
      "Price impact is how much your own trade moves the price. On a bonding curve every buy pushes the price up and every sell pushes it down, so a bigger order has a bigger impact. Early on, when there are few trades, one order can move the price a lot.",
      "Several smaller orders often fill better than one large one. Read the quote before you confirm. It shows what you pay and about what you get."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "price impact",
      "big order",
      "move the price",
      "whale",
      "large buy"
    ],
    "sources": [
      "docs-site/src/content/traders/bonding-curve.md:13-20",
      "docs-site/src/content/platform/bonding-curve.md",
      "frontend/src/components/evm/Gen8TradePanel.tsx (gen8FormatPriceImpact import, line 31)"
    ]
  },
  {
    "slug": "why-does-the-price-move",
    "q": "Why does a coin's price move?",
    "a": [
      "While a coin is on its bonding curve, a formula sets the price. Buys push it up and sells push it down. There is no order book and no market maker. After graduation the price comes from the DEX pool, where buys and sells move it in the same way.",
      "Momentum can snowball in both directions. Buying after a big rise or selling in a panic are common mistakes. This is not advice: coins can lose all their value, and you can lose everything you put in."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      }
    ],
    "keywords": [
      "price",
      "pump",
      "dump",
      "volatility",
      "why price up",
      "why price down"
    ],
    "sources": [
      "docs-site/src/content/traders/bonding-curve.md:8-23",
      "docs-site/src/content/platform/bonding-curve.md"
    ]
  },
  {
    "slug": "market-cap-and-progress-bar",
    "q": "What do market cap and the progress bar mean?",
    "a": [
      "Market cap is the coin's price multiplied by its supply. Every coin has 1 billion tokens. The curve progress shows how close the coin is to graduation. It is the Curve percentage on the coin card and the bar on the coin page.",
      "The creator picks the graduation target at launch: $30K or $50K market cap. When the bonding curve sells out at that market cap, the coin graduates and its liquidity moves into a DEX pool. A full bar alone does not mean the move is finished. Wait for the coin card to show DEX."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "market cap",
      "mcap",
      "progress",
      "bonding progress",
      "curve percentage",
      "how close to graduation"
    ],
    "alsoIn": [
      "graduation"
    ],
    "sources": [
      "docs-site/src/content/platform/graduation.md:8-24",
      "docs-site/src/content/creators/launch-rules.md:8-25",
      "founder 2026-10-22 (full bar is not graduation, from old help copy solana-after-grad)"
    ]
  },
  {
    "slug": "trading-after-graduation",
    "q": "Where do I trade a coin after it graduates?",
    "a": [
      "You keep trading on the same coin page. The Buy/Sell button now names the market it uses. Graduated coins trade in a locked DEX pool: Uniswap V4 on BNB Chain and Robinhood Chain, and Meteora on Solana.",
      "The curve fee of 2% stops. The pool charges its own fee instead: 1% on BNB Chain and Robinhood Chain, and 0.25% on Solana. You can also trade a graduated coin on the DEX directly, and those trades show in the market history."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "graduated",
      "after graduation",
      "uniswap",
      "meteora",
      "dex",
      "where to trade"
    ],
    "alsoIn": [
      "graduation"
    ],
    "sources": [
      "docs-site/src/content/platform/graduation.md:10-32",
      "docs-site/src/content/fees/after-graduation.md:8-18",
      "frontend/src/lib/helpCenter.ts:366-370 (external DEX trades appear in history)"
    ],
    "needsReview": "Whether external DEX trades appear on MemeWarzone for gen-8 pools (old copy says yes for earlier pools)."
  },
  {
    "slug": "trade-solana-coins-on-jupiter",
    "q": "Can I trade a Solana coin in Jupiter or another app?",
    "a": [
      "New Solana coins launch on a Meteora bonding curve, so Jupiter and other apps can trade them as well, before and after graduation. The trade is the same curve or pool trade, whichever app you use.",
      "The fee split is the same. One difference: when you trade on memewar.zone, Meteora pays a small referral back to MemeWarzone. In other apps that referral does not come to MemeWarzone."
    ],
    "keywords": [
      "jupiter",
      "dexscreener",
      "other app",
      "phantom swap",
      "meteora",
      "outside trading"
    ],
    "sources": [
      "docs-site/src/content/fees/fee-routing.md (Trade fee: new coins on Solana)",
      "founder 2026-10-22 (facts file: Solana DBC coins tradable through Jupiter before graduation)"
    ]
  },
  {
    "slug": "war-trade-room-explained",
    "q": "What is the War Trade Room?",
    "a": [
      "The War Trade Room is a trading table. Each row is a coin. Open a row to see its chart, its details and a Buy/Sell panel without leaving the table. It shows one chain at a time.",
      "The mode tabs filter the table: Trending, New, Graduated, Imported and Drafts. Click a column header to sort by market cap, liquidity, volume, holders or all-time high. Use the filter box to search by ticker, name, creator or address."
    ],
    "links": [
      {
        "href": "/war-room",
        "text": "Open the War Trade Room"
      }
    ],
    "keywords": [
      "war room",
      "war trade room",
      "trade table",
      "trending",
      "sort coins"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/traders/war-trade-room.md"
    ]
  },
  {
    "slug": "war-room-chat",
    "q": "What is the War Room chat on a coin page?",
    "a": [
      "Every coin page has a War Room, a live chat for that one coin. Anyone can read it without a wallet. To post, connect your wallet and sign once. The same signature covers your other social actions for 30 days.",
      "Chat is not advice, not a safety label and not proof that a coin is good. Check the official links, the holders and the wallet request yourself. Support never sends urgent claim links in a direct message."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "war room chat",
      "coin chat",
      "live chat",
      "comments",
      "token chat"
    ],
    "alsoIn": [
      "social"
    ],
    "sources": [
      "docs-site/src/content/platform/war-room.md"
    ]
  },
  {
    "slug": "charts-and-holders",
    "q": "How do I read the chart and the holders?",
    "a": [
      "The coin page and each open row in the War Trade Room show a price chart. After graduation the chart carries on from the curve into DEX trading, so history stays in one place.",
      "Holders is the number of wallets that hold the coin. A few wallets holding most of the supply is a risk signal, because one sale can move the price a lot. Check the holders before you buy, and do not read a busy chart as a sign of safety."
    ],
    "keywords": [
      "chart",
      "candles",
      "holders",
      "top holders",
      "distribution",
      "all-time high"
    ],
    "sources": [
      "docs-site/src/content/traders/war-trade-room.md (open row: chart, holders, all-time high)",
      "docs-site/src/content/platform/war-room.md:44-50 (check holders before you act)",
      "frontend/src/lib/helpCenter.ts:359-363 (chart continues after graduation)"
    ],
    "needsReview": "Exact layout of the holders tab on the coin page (list of top holders vs a count only)."
  },
  {
    "slug": "sell-all-my-tokens",
    "q": "How do I sell all of a coin?",
    "a": [
      "Pick Sell in the trade panel and press the 100% button, or use Max where the panel shows it. Then confirm in your wallet. You can also sell in steps with 25% or 50%.",
      "A sell pays the same 2% fee as a buy while the coin is on its curve. A big sell on a thin curve can move the price down a lot, so read the quote first. If the sell fails, try a smaller part."
    ],
    "keywords": [
      "sell all",
      "sell 100%",
      "exit",
      "cash out",
      "max sell"
    ],
    "sources": [
      "docs-site/src/content/traders/trading-basics.md:15-17",
      "frontend/src/components/evm/Gen8TradePanel.tsx:483 (showMax for sell)"
    ]
  },
  {
    "slug": "how-much-to-keep-for-fees",
    "q": "How much do I need in my wallet to trade? Is there a minimum?",
    "a": [
      "The panel does not tell you a fixed minimum trade size, but you must keep some of the chain's native coin for the network fee. The panel's Max button already leaves a reserve: about 0.005 SOL on Solana, 0.0005 BNB on BNB Chain and 0.0002 ETH on Robinhood Chain.",
      "If you try to spend more, the panel says you do not have enough and shows how much you can use. Very small trades can also be eaten by network fees, so check the quote."
    ],
    "keywords": [
      "minimum buy",
      "minimum amount",
      "smallest trade",
      "gas reserve",
      "not enough sol",
      "not enough bnb"
    ],
    "sources": [
      "frontend/src/lib/tradeBalanceReserve.ts:10-22,36-40",
      "frontend/src/components/evm/Gen8TradePanel.tsx:405,619"
    ],
    "needsReview": "No hard minimum trade size was found in the panels. Check whether the contracts or Meteora enforce one."
  },
  {
    "slug": "launch-fee-first-60-seconds",
    "q": "Why is the fee so high in the first minute after a launch?",
    "a": [
      "New coins have an anti-sniper fee. When trading opens, the fee starts at 90% and falls to the normal 2% over 60 seconds. It stops bots from buying everything in the first block for almost nothing. The fee is split the same way as the normal trade fee.",
      "If you buy in the first minute, you pay the fee shown in the quote. Waiting until the minute is over means you pay 2%. The creator's own first buy in the launch transaction pays 2%."
    ],
    "keywords": [
      "anti sniper",
      "sniper fee",
      "90% fee",
      "first minute",
      "launch fee",
      "bots"
    ],
    "alsoIn": [
      "fees",
      "create"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs GEN8_RATES sniperStartBps 9000, sniperWindowSeconds 60",
      "frontend/shared/dbcAntiSniper.mjs",
      "docs-site/src/content/fees/index.md:11"
    ]
  }
];
