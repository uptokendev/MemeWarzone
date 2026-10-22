// Help Center articles: create. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "how-to-launch-a-coin",
    "q": "How do I launch a coin, step by step?",
    "a": [
      "Open Launch a coin in the menu. On a phone it is the Create button in the bottom bar. Next stays locked until a step is complete. There is no MemeWarzone fee to launch, only network costs."
    ],
    "steps": [
      "Path: choose Direct to launch now, or Draft to get a public page first and launch later.",
      "Identity: upload the image, then enter the name and ticker. The card preview updates as you type and Create tells you if the ticker is available.",
      "Story: write a short description and add your socials. Socials are optional.",
      "Bond: pick the graduation market cap ($30K or $50K) and what happens to your share of the trade fee. On BNB Chain and Robinhood Chain your optional first buy is here.",
      "Market: pick the token your coin pairs with after graduation. On Solana your optional first buy is here.",
      "Review: check everything, then save the draft or deploy and confirm in your wallet."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "create token",
      "deploy",
      "make a coin",
      "new coin",
      "launch memecoin",
      "how to create"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/creators/create-a-campaign.md:8-20",
      "frontend/src/pages/Create.tsx"
    ]
  },
  {
    "slug": "launch-types-solana-dbc-and-evm",
    "q": "What is DBC, and how does a launch differ per chain?",
    "a": [
      "On Solana new coins launch on a Meteora Dynamic Bonding Curve, called DBC. Jupiter can route trades on it before graduation, and when the curve completes the coin moves to a Meteora pool.",
      "On BNB Chain and Robinhood Chain new coins launch on our own bonding curve built on a Uniswap V4 hook. When the curve completes the coin moves to a Uniswap V4 pool.",
      "The rules you see in Create are the same on all three chains: 1 billion supply, the same two graduation targets, the same anti-sniper fee and the same fee choices."
    ],
    "keywords": [
      "dbc",
      "meteora",
      "dynamic bonding curve",
      "gen-8",
      "gen 8",
      "uniswap v4",
      "hook",
      "launch type"
    ],
    "sources": [
      "docs/claude/meteora-dbc.md:5-12",
      "frontend/shared/evmGen8.mjs:21-26",
      "docs-site/src/content/creators/launch-rules.md:1-10",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "graduation-target-30k-or-50k",
    "q": "Should my coin graduate at $30K or $50K?",
    "a": [
      "In the Bond step you choose the market cap at which the bonding curve completes and the coin graduates: $30K (Fast grad) or $50K (Normal, the default).",
      "A lower target is reached sooner, so the coin graduates sooner. A higher target needs more buying before graduation. The choice is part of the launch and cannot be changed afterwards."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "fast grad",
      "normal",
      "graduation market cap",
      "target",
      "30k",
      "50k",
      "bond step"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:55-56",
      "docs-site/src/content/creators/launch-rules.md:8-18"
    ]
  },
  {
    "slug": "coin-supply-and-creator-reserve",
    "q": "How is the supply split between the curve, the pool and the creator?",
    "a": [
      "Every new coin has 1 billion tokens."
    ],
    "bullets": [
      "85% (850M) is sold on the bonding curve.",
      "13% (130M) goes into the DEX pool at graduation.",
      "2% (20M) is the creator reserve. On Solana it is released at graduation. On BNB Chain and Robinhood Chain it can be released no earlier than 1 hour after graduation, and only while the price is at or above the graduation price."
    ],
    "keywords": [
      "tokenomics",
      "supply",
      "1 billion",
      "creator reserve",
      "team tokens",
      "allocation",
      "vesting"
    ],
    "alsoIn": [
      "graduation"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:32-35,191",
      "frontend/shared/dbcEconomics.mjs:23-34",
      "docs-site/src/content/creators/launch-rules.md:20-30"
    ]
  },
  {
    "slug": "anti-sniper-launch-fee",
    "q": "What is the anti-sniper fee at launch?",
    "a": [
      "When trading opens, the trade fee starts at 90% and falls to the normal 2% within 60 seconds. Bots that buy in the first seconds pay for it.",
      "Your own first buy in the launch transaction does not pay the high fee. It is charged the normal 2%."
    ],
    "keywords": [
      "sniper",
      "bots",
      "launch fee",
      "90%",
      "front running",
      "bundle"
    ],
    "alsoIn": [
      "fees",
      "trading"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:44-54",
      "frontend/shared/dbcEconomics.mjs:50-60",
      "docs-site/src/content/creators/launch-rules.md:32-36"
    ]
  },
  {
    "slug": "creator-first-buy",
    "q": "Can I buy my own coin when I launch it, and how much?",
    "a": [
      "Yes. A first buy is optional. It happens inside the launch transaction before anyone else can buy, at the curve price plus the normal 2% fee. The tokens go straight to your wallet, unlocked.",
      "You can buy up to 70% of the supply, so at least 15% of the supply is still left on the curve for everyone else. The MAX button in Create fills in the most your wallet can pay after gas and launch fees.",
      "On BNB Chain and Robinhood Chain the first buy is in the Bond step. On Solana it is in the Market step, because you pay in the token you pick there. A large first buy costs a lot, because the price rises along the curve."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "initial buy",
      "dev buy",
      "first buy",
      "70%",
      "max buy",
      "creator buy",
      "snipe own coin"
    ],
    "popular": true,
    "sources": [
      "frontend/shared/evmGen8.mjs:36,329",
      "docs-site/src/content/creators/launch-rules.md:38-50",
      "docs/claude/meteora-dbc.md:118"
    ]
  },
  {
    "slug": "creator-later-buys-escrow",
    "q": "What happens to coins I buy later from the creator wallet?",
    "a": [
      "Coins you buy from the creator wallet on your own coin after launch go into escrow. 20% unlocks after 30 days, then another 20% every 7 days. Everything is free after 58 days.",
      "The Buy panel shows this schedule before you confirm. The first buy inside the launch transaction is not escrowed."
    ],
    "keywords": [
      "escrow",
      "locked",
      "creator wallet buy",
      "unlock schedule",
      "58 days",
      "vesting"
    ],
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "frontend/shared/gen8EscrowSchedule.mjs:8-13",
      "docs-site/src/content/creators/launch-rules.md:52-58"
    ],
    "needsReview": "The 30 day cliff and 7 day steps are verified for gen-8 (EVM). The same schedule on Solana comes from the launch rules docs and was not re-checked in code."
  },
  {
    "slug": "creator-fee-choice-at-launch",
    "q": "What are the creator fee choices at launch?",
    "a": [
      "In the Bond step you decide what happens to your share of the trade fee. The four choices are keep it, give it to holders, split it, or use it for buyback and burn.",
      "The choice is made at launch. Your share is a small slice of the 2% trade fee: 5.6% of the fee, which is 0.112% of each trade. The full fee split is on the fee pages."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "creator fees",
      "keep fees",
      "buyback",
      "burn",
      "split",
      "holders",
      "fee share"
    ],
    "alsoIn": [
      "fees"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:60",
      "frontend/src/components/create/CreatorFeeChoicePicker.tsx",
      "docs-site/src/content/fees/fee-routing.md:22-53",
      "docs-site/src/content/creators/creator-earnings.md:11"
    ],
    "needsReview": "Coins launched before October 2026 pay the creator 5% of the fee (0.10% of a trade); this answer states the current figure only."
  },
  {
    "slug": "what-is-a-draft-prepare-page",
    "q": "What is a draft, the Prepare page and Push Live?",
    "a": [
      "Choose Draft in the Path step to get a public page for your coin before trading opens. That page is the Prepare page. It shows on the Drafts tab on Coins and in search as PRE-LAUNCH.",
      "On a draft you set the message, links, launch time and founder note, share the page, and let people follow and comment. There is no chart and no Buy button. Trading starts when you press Push Live and confirm the launch in your wallet.",
      "A draft only needs a wallet signature. You pay network fees when you deploy."
    ],
    "steps": [
      "Create the coin and save it as a draft.",
      "Finish promotion setup: message, links, timing, founder note and logo.",
      "Share the Prepare page and gather followers.",
      "Press Push Live when links and timing are final."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Create a draft"
      },
      {
        "href": "/coins",
        "text": "Coins, Drafts tab"
      }
    ],
    "keywords": [
      "draft",
      "prepare mode",
      "prepare page",
      "push live",
      "pre-launch",
      "prelaunch",
      "staging"
    ],
    "alsoIn": [
      "getting-started"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/prepare-mode.md",
      "docs-site/src/content/creators/direct-and-draft.md",
      "docs-site/src/content/creators/promotion-and-push-live.md",
      "frontend/src/App.tsx:239-241"
    ]
  },
  {
    "slug": "edit-or-hide-a-draft",
    "q": "Can I edit a draft after saving it?",
    "a": [
      "Yes. Open Command Center, My coins, find the draft and press Edit Draft. You can change it until you deploy the coin.",
      "Check the chain, ticker, image, links and launch time before Push Live, because once the coin trades, people act on what the page says."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "edit draft",
      "change draft",
      "delete draft",
      "archive draft",
      "hide draft"
    ],
    "sources": [
      "frontend/src/components/postgrad/CommandCenterCoinRow.tsx:136",
      "docs-site/src/content/creators/direct-and-draft.md:38-44"
    ],
    "needsReview": "Old help said drafts can be hidden or archived. No archive control was found in the code that was checked."
  },
  {
    "slug": "schedule-a-launch",
    "q": "How do I schedule a launch for later?",
    "a": [
      "Scheduled launches are made from a draft. On the Push Live page choose the scheduled option and pick a time. The time must be at least five minutes ahead and no more than 30 days away. The page uses your local time zone.",
      "Trading stays closed until that time. On BNB Chain and Robinhood Chain the open time is part of the launch you sign, so the coin opens by itself and you do not need to come back. The anti-sniper fee runs from the open time, not from the moment you signed.",
      "On Solana the schedule is a timer on your draft. When the time arrives, MemeWarzone notifies you that your launch time has arrived, and you open the draft and deploy it with your wallet to go live."
    ],
    "steps": [
      "Save the coin as a Draft and finish promotion setup.",
      "Open Push Live and choose the scheduled option.",
      "Pick the trading-open time.",
      "Confirm in your wallet."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Create a draft"
      }
    ],
    "keywords": [
      "schedule",
      "timer",
      "countdown",
      "launch later",
      "launch time",
      "timezone",
      "30 days"
    ],
    "sources": [
      "frontend/src/pages/PushDraftLive.tsx:400-418",
      "frontend/shared/dbcSchedule.mjs:1-30",
      "frontend/shared/evmGen8.mjs:217-223,338-341",
      "founder 2026-10-12",
      "frontend/api/dbc/create.js:850-880 (due Solana drafts: 'Your launch time has arrived. Deploy now to go live.')",
      "founder 2026-10-23"
    ]
  },
  {
    "slug": "change-launch-time-after-signing",
    "q": "Can I change the launch time after I scheduled it?",
    "a": [
      "Not after the launch is signed on BNB Chain or Robinhood Chain. The open time is part of the signed launch request and cannot be changed afterwards.",
      "Before you sign, you can change the time on the draft's Push Live page."
    ],
    "keywords": [
      "reschedule",
      "change time",
      "cancel launch",
      "delay launch"
    ],
    "sources": [
      "frontend/shared/evmGen8.mjs:363-370"
    ],
    "needsReview": "Confirm what a Solana creator can do to a scheduled draft (reschedule or cancel) before its time."
  },
  {
    "slug": "edit-coin-after-launch",
    "q": "Can I edit my coin after launch?",
    "a": [
      "The name, ticker and image are written into the token itself and cannot be changed. Everything else on the coin page you can edit as the owner.",
      "Open Edit page from Command Center, My coins. You can change the banner, bio (up to 1,200 characters), founder note, website, X, Telegram and Discord links, up to 5 tags, the Story text and the pinned post. Every edit is signed by your wallet. A signature is not a transaction and costs nothing."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "edit token",
      "change name",
      "change logo",
      "change ticker",
      "update links",
      "edit page",
      "change description"
    ],
    "sources": [
      "frontend/src/pages/CoinEdit.tsx:177-330"
    ]
  },
  {
    "slug": "image-and-metadata-limits",
    "q": "What are the limits for the image, name, ticker and description?",
    "a": [
      "Create checks these as you type."
    ],
    "bullets": [
      "Image: PNG, JPG or WebP, up to 5 MB.",
      "Name: up to 32 characters.",
      "Ticker: up to 10 characters.",
      "Description: up to 1,000 characters and required.",
      "Socials (website, X, Telegram, Discord) are optional."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "logo size",
      "image too large",
      "ticker length",
      "name length",
      "file size",
      "png",
      "jpg"
    ],
    "sources": [
      "frontend/src/pages/Create.tsx:132,1456",
      "frontend/src/constants/validation.ts:20-24"
    ],
    "needsReview": "The chain stores the name and ticker in bytes, so a name with emoji can be too long even under 32 characters. Create measures this and shows an error."
  },
  {
    "slug": "pick-the-pairing-token-market-step",
    "q": "What is the Market step and which token should I pair with?",
    "a": [
      "The Market step sets the token your coin is paired with in its DEX pool after graduation. On BNB Chain the curve trades in BNB, and on Robinhood Chain in ETH. On Solana the curve trades in the token you pick, SOL by default.",
      "Only approved options appear. On Solana an example is USDC. On Robinhood Chain you can choose ETH or an approved stock token. If you pair with something other than the chain's coin, your coin's price and liquidity also follow that token."
    ],
    "keywords": [
      "quote token",
      "pairing",
      "usdc",
      "sol",
      "stock token",
      "market step",
      "pair"
    ],
    "sources": [
      "docs-site/src/content/creators/create-a-campaign.md:22-32"
    ]
  },
  {
    "slug": "launch-on-more-than-one-chain",
    "q": "Can I launch the same coin on two chains?",
    "a": [
      "Each coin lives on one chain, so there is no single coin across chains. You can launch a separate coin on each chain, one launch per chain. You pick the chain in Create.",
      "There is no limit on how many live coins one wallet can have and no wait between launches. Share the MemeWarzone coin page link and not only the address, because the link carries the chain."
    ],
    "keywords": [
      "multichain",
      "bnb and solana",
      "two chains",
      "same ticker",
      "cross chain launch",
      "duplicate"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:6-8",
      "docs-site/src/content/creators/launch-rules.md:80-90",
      "frontend/api/lib/dbc/dbcCreateLimits.js:36-40"
    ]
  },
  {
    "slug": "why-was-my-launch-refused",
    "q": "Why can't I launch my coin?",
    "a": [
      "There is no cooldown between launches and no limit on live coins. A launch can still be refused when:"
    ],
    "bullets": [
      "the wallet, or a group of wallets it belongs to, is restricted for abuse",
      "the creator is under manual review",
      "the wallet cannot pay for the first buy plus gas and launch fees",
      "the ticker is not available",
      "the image is over 5 MB or a field is too long"
    ],
    "links": [
      {
        "href": "/create",
        "text": "Launch a coin"
      }
    ],
    "keywords": [
      "cannot launch",
      "launch failed",
      "blocked",
      "cooldown",
      "limit",
      "error creating"
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "sources": [
      "docs-site/src/content/creators/launch-rules.md:80-95",
      "frontend/api/lib/dbc/dbcCreateLimits.js:36-40",
      "frontend/src/pages/Create.tsx:675"
    ],
    "needsReview": "CreatorArmEligibilityDialog.tsx still describes a 24 hour cooldown and live-coin tiers. Confirm whether that applies to any live launch path."
  }
];
