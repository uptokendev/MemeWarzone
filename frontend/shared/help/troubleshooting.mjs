// Help Center articles: troubleshooting. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "my-transaction-failed",
    "q": "Why did my buy or sell fail?",
    "a": [
      "The usual reasons are: the price moved more than your slippage allows, you do not have enough of the chain's coin left for the network fee, the order is large and moves the price too much, or your wallet is on a different network than the coin. A new coin can also be not open for trading yet.",
      "A failed transaction can still cost the network fee. The trade panel and your wallet show the actual error. Do not report a failed trade as abuse. Abuse reports are for identity problems."
    ],
    "steps": [
      "Try a smaller amount.",
      "Keep some BNB, SOL or ETH in the wallet for the network fee.",
      "Check that your wallet is on the coin's chain.",
      "If the panel offers it, try again with slightly higher slippage."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "transaction failed",
      "trade failed",
      "error",
      "reverted",
      "cannot buy",
      "cannot sell",
      "simulation failed"
    ],
    "popular": true,
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "docs-site/src/content/traders/troubleshooting.md:10-26",
      "frontend/src/lib/solanaTradeV1.ts:308-309"
    ]
  },
  {
    "slug": "slippage-exceeded-error",
    "q": "What does 'slippage exceeded' mean?",
    "a": [
      "The price moved past your limit between the quote and the moment the trade ran, so the trade was stopped to protect you. It happens on fast coins, on large orders and in the first minute after a launch.",
      "Retry with a smaller amount. Where the panel has a slippage menu, as on BNB Chain, pick a higher value only if you accept a worse price. On Solana the limit is fixed at 5%."
    ],
    "keywords": [
      "slippage exceeded",
      "price changed",
      "slippage error",
      "min out",
      "too little received"
    ],
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "frontend/src/lib/solanaTradeV1.ts:306-310",
      "frontend/src/components/evm/Gen8TradePanel.tsx:74-75",
      "frontend/src/pages/TokenDetails.tsx:142"
    ]
  },
  {
    "slug": "wallet-shows-a-warning",
    "q": "My wallet shows a warning on a trade. Is it a scam?",
    "a": [
      "Not always. Wallets scan every transaction and show a warning for things they cannot recognize. New sites, new tokens and thin liquidity often trigger one. A warning is a reason to read, not proof of a scam and not proof of safety.",
      "Read what the wallet says it will do. A MemeWarzone trade sends your coin or token to the curve or pool and gives you the other side. It should never ask you to approve unlimited spending for unknown addresses or to share your seed phrase. If the request does not match what you pressed, reject it.",
      "If the site is brand new on a partner website that uses the swap box, Phantom can show a message that the domain is new or not reviewed. That comes from Phantom checking the website and usually goes away within days."
    ],
    "links": [
      {
        "href": "/about",
        "text": "Official contracts"
      }
    ],
    "keywords": [
      "phantom warning",
      "blowfish",
      "wallet warning",
      "malicious",
      "request blocked",
      "domain not reviewed",
      "suspicious transaction"
    ],
    "popular": true,
    "alsoIn": [
      "safety",
      "wallets"
    ],
    "sources": [
      "docs-site/src/content/creators/swap-widget.md (A new website)",
      "docs-site/src/content/traders/troubleshooting.md",
      "docs-site/src/content/platform/war-room.md:44-50"
    ]
  },
  {
    "slug": "extra-instructions-in-phantom",
    "q": "Why does Phantom show more instructions than I expected on Solana?",
    "a": [
      "Phantom rewrites the transaction before you sign. It adds compute budget instructions and a Lighthouse safety check for each account the transaction writes. Lighthouse is Phantom's own guard. It checks that the accounts end up in the expected state and fails the transaction if not.",
      "So an app buy can show more instructions and a larger size in the wallet than the app built. That is normal. If the wallet shows an action you did not ask for, such as an unrelated transfer, reject it."
    ],
    "keywords": [
      "lighthouse",
      "phantom",
      "compute budget",
      "extra instructions",
      "transaction size",
      "solana instructions"
    ],
    "alsoIn": [
      "wallets"
    ],
    "sources": [
      "frontend/src/lib/solanaUserV0Transaction.ts:10,35",
      "frontend/src/lib/solanaV0Transaction.test.mjs:233",
      "memory swap-widget.md (measured mainnet buy: Phantom appends Lighthouse)"
    ]
  },
  {
    "slug": "transaction-stuck-pending",
    "q": "My transaction is stuck on pending. What now?",
    "a": [
      "Wait a few minutes. The network can be busy. Many wallets offer Speed up or Cancel on EVM chains. On Solana, a transaction that does not land within about a minute usually expires and no funds move.",
      "Before you try again, check your wallet history and the chain explorer. If the first one succeeded, a second one buys twice."
    ],
    "keywords": [
      "pending",
      "stuck transaction",
      "not confirmed",
      "speed up",
      "cancel transaction",
      "nonce"
    ],
    "sources": [
      "docs-site/src/content/traders/troubleshooting.md:6-9"
    ],
    "needsReview": "The Solana expiry remark is general network behavior, not from MemeWarzone docs. Confirm before publishing."
  },
  {
    "slug": "balance-not-updating",
    "q": "My balance or position does not update after a trade.",
    "a": [
      "Refresh the page. Then check that the right wallet is connected. Check your wallet history to see whether the transaction succeeded.",
      "If you added Robinhood Chain to your wallet through MemeWarzone before October 14, it may use an old RPC address that now fails often. MemeWarzone offers to switch your wallet to the public RPC. Accept it, or update the network in your wallet."
    ],
    "keywords": [
      "balance not updating",
      "position missing",
      "holdings wrong",
      "rpc",
      "robinhood rpc",
      "refresh"
    ],
    "alsoIn": [
      "wallets"
    ],
    "sources": [
      "docs-site/src/content/traders/troubleshooting.md:28-32",
      "frontend/src/components/wallet/RobinhoodWalletRpcNotice.tsx:46"
    ]
  },
  {
    "slug": "cannot-find-a-coin",
    "q": "I cannot find a coin.",
    "a": [
      "Coins and search show one chain at a time. Check the chain buttons first. Then search by ticker, name or the full address. Search finds coins launched or imported on MemeWarzone, people by display name or @username, and any wallet by its address.",
      "A draft or scheduled coin may not be open for trading yet. A coin that was launched elsewhere is not listed until someone imports it."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      },
      {
        "href": "/import",
        "text": "Import a coin"
      }
    ],
    "keywords": [
      "coin missing",
      "search not working",
      "token not found",
      "cannot find token",
      "wrong chain search"
    ],
    "sources": [
      "docs-site/src/content/traders/troubleshooting.md:34-38",
      "frontend/src/lib/helpCenter.ts:309-313"
    ]
  },
  {
    "slug": "page-shows-the-wrong-chain",
    "q": "The page shows the wrong chain or asks me to switch networks.",
    "a": [
      "Coins, Leagues, the War Trade Room and search show one chain at a time. Use the chain buttons to pick BNB, Solana or Robinhood. Your choice is remembered. A coin page always opens on the coin's own chain.",
      "For a trade, your wallet must be on the coin's network. BNB Chain and Robinhood Chain use the same EVM address, so the wallet only needs to switch network. Solana needs a Solana wallet."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "wrong network",
      "switch network",
      "wrong chain",
      "chain selector",
      "network mismatch"
    ],
    "alsoIn": [
      "wallets"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:12-20,45-48"
    ]
  },
  {
    "slug": "signature-request-keeps-appearing",
    "q": "My wallet keeps asking me to sign.",
    "a": [
      "One signature covers social actions for 30 days. It is kept in this browser. You sign again on another browser or device, with another wallet, or after the 30 days. Actions such as saving your profile, voting, payments and claims ask every time by design.",
      "If the same request returns again and again, check that you are using the same wallet account and that the browser keeps site data. Private windows and blocked site data cannot keep the signature. Reject any prompt that asks you to approve a transaction or spend tokens when you only wanted to post."
    ],
    "keywords": [
      "signature loop",
      "sign again",
      "keeps asking to sign",
      "sign message",
      "re-sign"
    ],
    "alsoIn": [
      "wallets",
      "social"
    ],
    "sources": [
      "docs-site/src/content/social/signing.md:20-45"
    ],
    "needsReview": "The private window and blocked site data remark is inferred from 'the signature is kept in this browser'. Confirm in the session code."
  },
  {
    "slug": "boosts-are-closed",
    "q": "Why does it say 'Boosts are closed'?",
    "a": [
      "Boosts close when the last 20% of a battle's clock starts. A 24 hour battle closes Boosts at 19 hours 12 minutes. A 1 hour battle closes them at 48 minutes. After that you can no longer add a Boost to either side.",
      "Each wallet can also Boost only twice per battle, both sides together. Free votes are separate from Boosts."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "See battles"
      }
    ],
    "keywords": [
      "boost closed",
      "cannot boost",
      "boosts are closed for the last 20%",
      "boost limit",
      "battle vote"
    ],
    "alsoIn": [
      "battles"
    ],
    "sources": [
      "frontend/api/lib/arenaBoostRules.js:60",
      "frontend/src/lib/arena/battleBoostPresentation.mjs:65",
      "docs/claude/battles.md"
    ]
  },
  {
    "slug": "upvote-not-counted",
    "q": "My UpVote does not show up.",
    "a": [
      "Wait a minute and refresh the page. Then check your wallet history to see whether the payment went through. An UpVote counts after its transaction is confirmed. If the transaction failed, no vote was cast.",
      "A cooldown and daily limits apply to UpVotes. If the popup says you reached a limit, try later. Do not use links from strangers that claim to UpVote for you."
    ],
    "keywords": [
      "upvote missing",
      "upvote not counted",
      "vote not showing",
      "upvote failed",
      "crowd favorite count"
    ],
    "alsoIn": [
      "promotion"
    ],
    "sources": [
      "frontend/src/components/token/UpvoteDialog.tsx:694",
      "docs-site/src/content/fees/upvotes.md:36-42"
    ],
    "needsReview": "How long the indexer takes to show a confirmed UpVote, and which limit message the popup shows."
  },
  {
    "slug": "claim-button-missing",
    "q": "I cannot find my claim button.",
    "a": [
      "Claims live in Command Center, under Rewards and claims, for the wallet that earned them. Check that you have connected the right wallet and picked the right chain. League, airdrop, recruiter, battle and creator payouts are listed there once they are ready.",
      "A reward that is still Pending is not claimable yet. Prizes are not paid automatically to every holder and are not guaranteed. For an imported coin, creator earnings can only be claimed after you prove you own the coin."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "claim",
      "no claim button",
      "cannot claim",
      "rewards missing",
      "pending reward",
      "payout"
    ],
    "alsoIn": [
      "rewards"
    ],
    "sources": [
      "docs-site/src/content/creators/creator-earnings.md:13",
      "docs-site/src/content/creators/swap-widget.md:44-52",
      "frontend/src/lib/helpCenter.ts:635-660"
    ],
    "needsReview": "Exact status names and where each reward type appears in the current Command Center."
  },
  {
    "slug": "mobile-wallet-browser",
    "q": "Wallet will not connect on my phone.",
    "a": [
      "A phone browser has no wallet inside the page. Tap your wallet in the connect window and MemeWarzone opens inside that wallet's own browser, ready to connect. You can also open the site from the browser inside the wallet app yourself.",
      "If the wallet does not open on a site you visit, try the wallet browser. Unlock the wallet first, then refresh."
    ],
    "links": [
      {
        "href": "/",
        "text": "Go to Home"
      }
    ],
    "keywords": [
      "mobile",
      "phone",
      "wallet browser",
      "walletconnect",
      "metamask mobile",
      "phantom mobile",
      "cannot connect"
    ],
    "alsoIn": [
      "wallets"
    ],
    "sources": [
      "frontend/src/components/wallet/ConnectWalletModal.tsx:214-226,571"
    ]
  },
  {
    "slug": "clear-cache-and-refresh",
    "q": "The app looks wrong or old. Should I clear my cache?",
    "a": [
      "Start with a hard refresh. Then try another browser or a private window to see whether the problem is local. If a page works there, clear the site data for memewar.zone and connect again.",
      "Clearing site data removes the stored social signature and your cookie choice, so your wallet asks you to sign again. Your coins and profile live on the chain and on our servers. Clearing the cache does not touch them. Never share a seed phrase while troubleshooting."
    ],
    "keywords": [
      "clear cache",
      "hard refresh",
      "blank page",
      "stale page",
      "old version",
      "site data"
    ],
    "sources": [
      "docs-site/src/content/social/signing.md:34-36",
      "frontend/src/lib/cookieConsent.ts"
    ]
  },
  {
    "slug": "coin-not-open-for-trading",
    "q": "A coin page says trading has not opened.",
    "a": [
      "Drafts have a public Prepare page, but they do not trade. A scheduled launch can open trading up to 30 days after it is created. The page shows the countdown. Buying is not possible before then.",
      "In the first 60 seconds after trading opens, the fee starts at 90% and falls to 2%. Check the fee in the quote before you buy."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "not open",
      "scheduled",
      "countdown",
      "draft",
      "cannot buy yet",
      "launch time"
    ],
    "alsoIn": [
      "create",
      "trading"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:338-339",
      "docs-site/src/content/traders/war-trade-room.md:36"
    ]
  }
];
