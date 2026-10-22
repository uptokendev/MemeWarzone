// Help Center articles: getting-started. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-is-memewarzone",
    "q": "What is MemeWarzone?",
    "a": [
      "MemeWarzone is a memecoin launchpad with a social feed and a battle arena. You can launch a coin, trade coins, follow people and coins, and enter coins into battles and leagues.",
      "It runs on BNB Chain, Solana and Robinhood Chain. Each coin lives on one chain. You trade from your own wallet, and MemeWarzone does not hold your coins."
    ],
    "bullets": [
      "Launch: create a coin with a bonding curve, or save it as a draft first.",
      "Trade: buy and sell on the curve, and in the DEX pool after graduation.",
      "Battle: coins fight in metrics and vote battles for prizes and league points.",
      "Earn: fees, league prizes and weekly airdrops are paid out when you qualify. Nothing is guaranteed."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      },
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "what is",
      "about",
      "launchpad",
      "memecoin",
      "meme war zone",
      "memewar"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/what-is-memewarzone.md",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "how-to-start-trading-memecoins",
    "q": "How do I start trading on MemeWarzone?",
    "a": [
      "You need a wallet with a little of the chain's coin for the trade and for network fees: BNB on BNB Chain, SOL on Solana, ETH on Robinhood Chain."
    ],
    "steps": [
      "Press Connect Wallet in the top right and pick your wallet.",
      "Sign in once when asked. It is a signature, not a transaction, and it costs nothing.",
      "Pick your chain with the chain buttons (BNB, Solana, Robinhood) on Coins.",
      "Open a coin from the Coins page.",
      "Enter an amount in the Buy panel, read the quote, and confirm in your wallet."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "buy",
      "first trade",
      "how to buy",
      "begin",
      "new user",
      "beginner"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/getting-started.md",
      "frontend/src/components/wallet/WalletSignInGate.tsx:31-50"
    ]
  },
  {
    "slug": "how-to-start-as-a-creator",
    "q": "How do I launch my first coin?",
    "a": [
      "Open Launch a coin in the menu. On a phone it is the Create button in the bottom bar. Create has six steps: Path, Identity, Story, Bond, Market and Review.",
      "There is no MemeWarzone fee to launch. You pay network costs, plus the cost of your own first buy if you make one. Have your image, name, ticker, a short description and your official links ready first."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "create coin",
      "launch token",
      "deploy",
      "make a memecoin",
      "creator"
    ],
    "alsoIn": [
      "create"
    ],
    "sources": [
      "docs-site/src/content/creators/create-a-campaign.md",
      "docs-site/src/content/creators/launch-rules.md",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "browse-without-wallet",
    "q": "Can I browse MemeWarzone without connecting a wallet?",
    "a": [
      "Yes. Public pages open without a wallet: the coin list, coin pages, charts, battles, leagues, profiles and search.",
      "You need a connected wallet to trade, launch, follow, post, vote or claim anything."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Coins"
      },
      {
        "href": "/league",
        "text": "Leagues"
      }
    ],
    "keywords": [
      "no wallet",
      "read only",
      "look around",
      "without connecting"
    ],
    "sources": [
      "frontend/src/lib/helpCenter.ts:54-58",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "do-i-need-an-account",
    "q": "Do I need to create an account or sign up with an email?",
    "a": [
      "No. Your wallet is your account. One wallet has one profile with a picture, name, @username and bio, and it looks the same on every chain.",
      "The first time you connect, you may be asked to pick a @username. You can press Later and set it in Settings."
    ],
    "keywords": [
      "sign up",
      "register",
      "login",
      "email",
      "username"
    ],
    "sources": [
      "docs-site/src/content/getting-started.md",
      "docs-site/src/content/social/index.md"
    ]
  },
  {
    "slug": "supported-chains",
    "q": "Which chains does MemeWarzone support?",
    "a": [
      "BNB Chain, Solana and Robinhood Chain. Launching, trading, battles, leagues, imports and reward claims work on all three.",
      "Each coin lives on one chain. Social features work across chains: you can follow any coin or wallet on any chain. Only buying and selling depends on the chain you have selected."
    ],
    "bullets": [
      "BNB Chain: you pay in BNB. Use an EVM wallet such as MetaMask.",
      "Solana: you pay in SOL. Use a Solana wallet such as Phantom or Solflare.",
      "Robinhood Chain: you pay in ETH. Use an EVM wallet such as MetaMask."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "bnb",
      "bsc",
      "solana",
      "robinhood chain",
      "ethereum",
      "networks",
      "multichain"
    ],
    "alsoIn": [
      "wallets"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "dogeos-coming-to-memewarzone",
    "q": "Is DogeOS coming to MemeWarzone?",
    "a": [
      "Yes. MemeWarzone is among the first launchpads invited onto DogeOS, which is aiming at about 500,000 existing wallets. DogeOS has not launched on MemeWarzone yet.",
      "After DogeOS the plan is more chains and a full Interchained DEX, first for the chains MemeWarzone already runs on. These are plans, not dates."
    ],
    "keywords": [
      "doge",
      "dogeos",
      "mydoge",
      "roadmap",
      "new chain",
      "next chain"
    ],
    "sources": [
      "founder 2026-10-22"
    ],
    "needsReview": "Confirm the DogeOS wording and the 500,000 wallets figure are still approved for public copy."
  },
  {
    "slug": "cost-to-get-started",
    "q": "How much does it cost to use MemeWarzone?",
    "a": [
      "Connecting a wallet, browsing, drafting a coin and signing in are free. There is no MemeWarzone fee to launch a coin.",
      "You pay network fees for each transaction. Trades on the bonding curve carry a 2% fee, shown in the quote before you confirm. Making your own first buy at launch is optional and costs the coin price plus that 2% fee.",
      "On Solana, setting up a new launch costs about 0.006 SOL in rent for its curve configuration, on top of network fees."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "price",
      "free",
      "fees to launch",
      "gas",
      "how much money",
      "minimum"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:44-54",
      "docs/claude/meteora-dbc.md:33",
      "founder 2026-10-22"
    ],
    "needsReview": "The Solana 0.006 SOL rent figure comes from an engineering note; confirm the amount the Create review step shows today."
  },
  {
    "slug": "where-things-are",
    "q": "Where do I find things: Coins, Warzone, Leagues, Command Center and the War Room?",
    "a": [
      "The main menu has the pages you will use most."
    ],
    "bullets": [
      "Home: the social feed with posts from people and coins you follow.",
      "Coins: every coin on your selected chain, with a Drafts tab for coins not yet live.",
      "Warzone: the battle arena, with battles, tournaments and the Major War League.",
      "Leagues: weekly and monthly rankings.",
      "War Room: a trading room with charts and a fast trade panel, including imported coins.",
      "Command Center: your private dashboard, opened from your profile.",
      "Airdrops and Recruiters: weekly airdrops and referral links."
    ],
    "links": [
      {
        "href": "/warzone",
        "text": "Warzone"
      },
      {
        "href": "/league",
        "text": "Leagues"
      },
      {
        "href": "/war-room",
        "text": "War Room"
      },
      {
        "href": "/profile",
        "text": "Your profile"
      }
    ],
    "keywords": [
      "menu",
      "navigation",
      "war trade room",
      "tabs",
      "lost",
      "sidebar"
    ],
    "popular": true,
    "sources": [
      "frontend/src/App.tsx:215-286",
      "docs-site/src/content/getting-started.md"
    ]
  },
  {
    "slug": "what-is-the-command-center",
    "q": "What is the Command Center?",
    "a": [
      "It is your private dashboard. Open it from your profile. It has tabs for Overview, My coins, Battles, Recruiter, Squad, Airdrops, Rewards and claims, Support and safety, Notifications, Edit profile and Settings.",
      "Some tabs only appear when they apply to you, for example Battles when you own a coin that can battle, and Squad when you are in one. On a phone, swipe the tab row."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "dashboard",
      "my coins",
      "claims",
      "settings",
      "command centre"
    ],
    "sources": [
      "frontend/src/lib/helpCenter.ts:525-531",
      "frontend/src/App.tsx:264-282"
    ],
    "needsReview": "Tab list copied from the old help text; check it against the current Command Center sidebar."
  },
  {
    "slug": "what-is-the-warzone",
    "q": "What is the Warzone and how do battles work?",
    "a": [
      "The Warzone is the battle arena. Coin owners challenge other coins, the two sides agree on the type, buy-in and length, and the community backs a side. Graduated and imported coins can battle.",
      "There are metrics battles (24 hours, 3 days or 7 days) and vote battles (1, 6, 12, 24 or 48 hours). Winners earn league points and prizes that the winning coin's owner claims from the Command Center."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "Battles"
      },
      {
        "href": "/warzone",
        "text": "Warzone"
      }
    ],
    "keywords": [
      "arena",
      "battle",
      "pvp",
      "tournament",
      "vote battle"
    ],
    "alsoIn": [
      "battles"
    ],
    "sources": [
      "docs-site/src/content/arena/live-battles.md",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "memewarzone-and-call-of-duty",
    "q": "Is MemeWarzone related to Call of Duty: Warzone?",
    "a": [
      "No. MemeWarzone has nothing to do with the Call of Duty game or its publisher. It is a memecoin launchpad. The war theme is only our branding."
    ],
    "keywords": [
      "cod",
      "call of duty",
      "activision",
      "game",
      "fps"
    ],
    "sources": [
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "who-runs-memewarzone-contact",
    "q": "Who runs MemeWarzone and how do I contact the team?",
    "a": [
      "MemeWarzone is operated under Dutch law, and you must be 18 or older to use it.",
      "For product questions, join the Discord. For account or security problems, email support@memewar.zone. Legal matters go to legal@memewar.zone.",
      "To report impersonation or abuse, use Report Abuse in the Command Center under Support and safety."
    ],
    "links": [
      {
        "href": "https://discord.gg/aXTkn3Asu",
        "text": "Discord"
      },
      {
        "href": "https://t.me/memewarzonehq",
        "text": "Telegram"
      },
      {
        "href": "https://x.com/memewarzone",
        "text": "X"
      },
      {
        "href": "https://docs.memewar.zone",
        "text": "Documentation"
      }
    ],
    "keywords": [
      "support",
      "email",
      "discord",
      "telegram",
      "contact",
      "team",
      "help"
    ],
    "sources": [
      "docs-site/src/content/legal/terms-of-service.md",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "can-i-lose-money-on-memecoins",
    "q": "Can I lose money trading memecoins here?",
    "a": [
      "Yes. Memecoin prices can fall to near zero, and you can lose everything you put in. Rewards, prizes and airdrops are not guaranteed, and nothing on MemeWarzone is financial advice.",
      "Only trade what you can afford to lose. Check the coin page, the creator and the links, and be careful with anything that promises returns."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      }
    ],
    "keywords": [
      "risk",
      "rug",
      "scam",
      "safe",
      "invest",
      "profit",
      "guaranteed"
    ],
    "sources": [
      "docs-site/src/content/legal/terms-of-service.md",
      "founder 2026-10-22"
    ]
  }
];
