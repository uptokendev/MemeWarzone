// Help Center articles: imports. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-are-imported-coins",
    "q": "What is an imported coin?",
    "a": [
      "An imported coin is a memecoin that launched somewhere else and was brought to MemeWarzone. It gets the same coin page as a coin launched here, with chart, Buy and Sell panel, posts and holders.",
      "The difference is underneath. An imported coin trades in its own DEX pool, not on a MemeWarzone bonding curve. Its name and ticker come from the token and cannot be changed."
    ],
    "links": [
      {
        "href": "/import",
        "text": "Import a coin"
      }
    ],
    "keywords": [
      "import",
      "imported",
      "bring my coin",
      "external coin",
      "other launchpad",
      "migrate to memewarzone"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:6-12,64-70",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "which-coins-can-be-imported",
    "q": "Which coins can I import?",
    "a": [
      "A coin can be imported when all of these are true:"
    ],
    "bullets": [
      "It is on BNB Chain, Solana or Robinhood Chain.",
      "It has finished its bonding phase on the platform where it launched. A coin still bonding on Pump.fun, Four.meme or a similar launchpad is refused. Come back after it graduates.",
      "It trades in a DEX pool with real liquidity.",
      "It passes the safety checks."
    ],
    "links": [
      {
        "href": "/import",
        "text": "Import a coin"
      }
    ],
    "keywords": [
      "eligible",
      "requirements",
      "pump.fun",
      "four.meme",
      "still bonding",
      "can i import",
      "graduated coin"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:14-24",
      "frontend/api/lib/arenaImportEligibility.js"
    ]
  },
  {
    "slug": "how-to-import-a-coin",
    "q": "How do I import a coin?",
    "a": [
      "Anyone can import a coin. Your wallet signs the import request, but it does not need to hold or own the token. The signature is not a transaction and costs nothing."
    ],
    "steps": [
      "Open Import memecoin in the menu. You can also start from Command Center, My coins, Import memecoin.",
      "Choose the chain: BNB, Solana or Robinhood.",
      "Connect a wallet on that chain.",
      "Paste the coin's contract address. On Solana this is the mint address.",
      "Press IMPORT MEMECOIN and sign the message in your wallet."
    ],
    "bullets": [
      "MemeWarzone looks up the token, checks its market and runs the safety scan. When that passes you land on the coin's new page."
    ],
    "links": [
      {
        "href": "/import",
        "text": "Import a coin"
      }
    ],
    "keywords": [
      "add coin",
      "import memecoin",
      "paste contract",
      "list my token",
      "import token",
      "contract address"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:26-38",
      "frontend/src/App.tsx:238"
    ]
  },
  {
    "slug": "import-a-pumpfun-coin",
    "q": "How do I import a Pump.fun coin?",
    "a": [
      "Wait until the coin has graduated on Pump.fun. A coin that is still bonding is refused. Then follow the normal import steps on the Solana chain and paste the coin's mint address.",
      "If you want to claim the coin as its owner, you will need the wallet Pump.fun recorded as the creator. Pump.fun may have created a separate wallet for you when you signed up, which can differ from the Phantom or Solflare wallet you normally use. The import page has a Got a Pump.fun token? guide with the official export and import steps."
    ],
    "links": [
      {
        "href": "/import",
        "text": "Import a coin"
      }
    ],
    "keywords": [
      "pump fun",
      "pumpfun",
      "pump.fun import",
      "solana import",
      "mint address",
      "privy wallet",
      "creator wallet"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:60-62",
      "frontend/src/components/imports/PumpImportHelp.tsx"
    ]
  },
  {
    "slug": "do-i-need-to-own-the-token-to-import",
    "q": "Do I need to own or hold a coin to import it, and does it cost anything?",
    "a": [
      "No on both. Any wallet can import a coin, and it does not need to hold the token. Importing costs nothing because it is a signature and not a transaction.",
      "Importing does not make you the owner. The real owner claims the coin separately, and trading does not wait for that claim."
    ],
    "keywords": [
      "free import",
      "import cost",
      "import fee",
      "not the owner",
      "someone else's coin"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:26-30,82-86"
    ]
  },
  {
    "slug": "why-was-my-import-refused",
    "q": "Why was my import refused?",
    "a": [
      "An import is refused when the scan finds a problem that nobody can override. The coin is also refused while it is still bonding."
    ],
    "bullets": [
      "The address is not a token on the chain you chose.",
      "Selling fails (a honeypot).",
      "The token cannot be transferred, or transfers are paused.",
      "The transfer tax is above 10%.",
      "The coin is still bonding on its original launchpad."
    ],
    "links": [
      {
        "href": "/import",
        "text": "Import a coin"
      }
    ],
    "keywords": [
      "import failed",
      "declined",
      "honeypot",
      "transfer tax",
      "rejected",
      "refused",
      "cannot import"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:46-60",
      "frontend/api/lib/arenaImportScan.js:60-70"
    ]
  },
  {
    "slug": "import-sent-to-review",
    "q": "My import is waiting for review. What does that mean?",
    "a": [
      "Some findings do not refuse an import but send it to review, for example when the safety scan could not finish or the market data is unclear. The page exists, but the coin is not listed until the review is done.",
      "If the lookup was only busy, nothing is rejected: press IMPORT again."
    ],
    "keywords": [
      "pending review",
      "not listed",
      "needs review",
      "import stuck",
      "manual review import"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:56-60",
      "frontend/api/lib/arenaImportScan.js:55-60"
    ]
  },
  {
    "slug": "claim-an-imported-coin",
    "q": "How do I prove I own an imported coin?",
    "a": [
      "An imported coin starts unclaimed, and trading does not wait for the claim. If you run the project, open the coin page and press CLAIM MEMECOIN. The popup lists the ways you can prove ownership. Which ones you see depends on the chain and the token.",
      "The options appear in this order: the owner wallet, the project's X account, and last, manual review. Use the first one that works for you."
    ],
    "steps": [
      "Owner wallet: on BNB Chain and Robinhood Chain connect the wallet that is the token contract's current owner. On Solana connect the recorded project authority wallet.",
      "Project X account: if the token lists an official X account, press VERIFY WITH X and sign in to that exact account.",
      "Manual review: press REQUEST MANUAL REVIEW and give an X account where the team can reach you. The team checks the claim and contacts you."
    ],
    "bullets": [
      "Until the claim is verified the coin shows Ownership pending."
    ],
    "keywords": [
      "claim memecoin",
      "verify owner",
      "ownership",
      "claim coin",
      "project owner",
      "verify with x",
      "manual review"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:88-120",
      "frontend/src/components/imports/ProjectXClaimDialog.tsx:130-142"
    ]
  },
  {
    "slug": "claim-popup-has-no-owner-wallet-option",
    "q": "The claim popup does not offer the owner wallet option. Why?",
    "a": [
      "On BNB Chain and Robinhood Chain the owner wallet option reads the token contract's current owner. If the contract exposes no active owner, for example because ownership was renounced, the option is not available.",
      "Use the project's official X account if the token lists one, or request manual review. If you connect a wallet that is not the owner, the owner option shows the recorded owner but cannot be used."
    ],
    "keywords": [
      "renounced",
      "no owner",
      "owner wallet missing",
      "verify owner wallet",
      "claim not available"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "frontend/src/components/imports/ProjectXClaimDialog.tsx:136-140",
      "docs-site/src/content/creators/imported-coins.md:98-104"
    ]
  },
  {
    "slug": "wrong-x-account-when-claiming",
    "q": "Verify with X says I used the wrong account. What now?",
    "a": [
      "The claim only works with the exact X account attached to the token. Signing in with a different account fails and the popup tells you that was not the correct account.",
      "Sign in with the project's X account, verify the owner wallet instead, or request manual review."
    ],
    "keywords": [
      "x login",
      "twitter",
      "wrong account",
      "verify with x failed",
      "claim failed"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:110-114",
      "frontend/src/components/imports/ProjectXClaimDialog.tsx:134"
    ]
  },
  {
    "slug": "unclaimed-creator-share-90-days",
    "q": "What happens to the creator's half of the fee if nobody has claimed the coin?",
    "a": [
      "The creator's 0.5% builds up while the coin is unclaimed. It is held for 90 days per trade. Claim the coin within that time to collect it.",
      "Whatever is still unclaimed after 90 days goes to MemeWarzone."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Your profile"
      }
    ],
    "keywords": [
      "unclaimed fees",
      "90 days",
      "creator earned",
      "claim fees",
      "held fees",
      "expire"
    ],
    "alsoIn": [
      "fees",
      "rewards"
    ],
    "sources": [
      "docs-site/src/content/fees/after-graduation.md:38",
      "frontend/api/lib/financeRevenueLanes.js:64,299"
    ]
  },
  {
    "slug": "creator-earned-claim-it-auto-import",
    "q": "Why does my coin already have a MemeWarzone page?",
    "a": [
      "If a coin earned creator fees through the swap box on a website but had no page here, MemeWarzone imports it itself, through the same checks as a user import. The creator then finds the coin with a Creator earned notice and a Claim button.",
      "A coin that is refused, for example because it is still bonding, is retried about every 6 hours."
    ],
    "keywords": [
      "auto import",
      "automatic import",
      "swap widget",
      "creator earned",
      "page already exists"
    ],
    "sources": [
      "frontend/api/lib/importAutoImport.js:1-10",
      "docs-site/src/content/creators/swap-widget.md"
    ]
  },
  {
    "slug": "where-do-imported-coins-trade",
    "q": "Where do imported coins trade?",
    "a": [
      "In the coin's own DEX pool, through the same Buy and Sell panel as other coins. The coin page shows a Trading on line, and the button names the DEX, for example Buy on Jupiter.",
      "Trading is switched off on a coin when the safety scan reports a honeypot or a blocked transfer."
    ],
    "bullets": [
      "Solana: Jupiter, which routes through the coin's pools.",
      "BNB Chain: PancakeSwap pools.",
      "Robinhood Chain: Uniswap."
    ],
    "keywords": [
      "jupiter",
      "pancakeswap",
      "uniswap",
      "imported trading",
      "dex",
      "where to buy imported"
    ],
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:64-80",
      "docs-site/src/content/platform/chain-readiness.md:30"
    ]
  },
  {
    "slug": "imported-coins-battles-and-upvotes",
    "q": "Can imported coins battle and get UpVotes?",
    "a": [
      "Yes. Imported coins can battle in the Warzone and have their own UpVotes. Imported and graduated coins are featured in the Warzone overview. Once the coin is claimed, the owner can challenge other coins.",
      "Imported coins also appear in Search, in the Imported coins panel on Coins, and in the War Room under the Imported tab."
    ],
    "links": [
      {
        "href": "/warzone",
        "text": "Warzone"
      },
      {
        "href": "/coins",
        "text": "Coins"
      }
    ],
    "keywords": [
      "battle imported",
      "upvote imported",
      "featured",
      "warzone",
      "imported tab",
      "war room"
    ],
    "alsoIn": [
      "battles",
      "promotion"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:72-80,132-140",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "what-can-the-owner-do-after-claiming",
    "q": "What can I do after I claim an imported coin?",
    "a": [
      "Connect the owner wallet and press EDIT on the coin page to change the description, website, X and Telegram links, and upload the project image. Open Edit page from Command Center, My coins, for tags, links, a pinned post, the Story text and Story images.",
      "You can also post updates as the coin, turn auto updates (launch, graduation and battle results) on or off, and challenge other coins to battles. The name and ticker cannot be changed, and every edit is signed by your wallet."
    ],
    "keywords": [
      "edit imported coin",
      "after claim",
      "owner tools",
      "update logo",
      "post as coin"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:124-140"
    ]
  },
  {
    "slug": "someone-else-claimed-my-coin",
    "q": "Someone else claimed my imported coin. What can I do?",
    "a": [
      "Claims have to be proven with the token's owner wallet, the project's X account, or manual review by the team, so a claim made without one of these does not go through.",
      "If you believe someone claimed your coin falsely, report it with Report Abuse in the Command Center under Support and safety, and include the coin address and what proves you are the owner."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Command Center"
      }
    ],
    "keywords": [
      "stolen claim",
      "false claim",
      "impersonation",
      "dispute",
      "wrong owner"
    ],
    "alsoIn": [
      "safety"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:88-120",
      "founder 2026-10-22"
    ],
    "needsReview": "Confirm the dispute process for a coin claimed by the wrong party is Report Abuse and manual review."
  }
];
