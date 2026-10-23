// Help Center articles: safety and security. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "never-share-seed-phrase",
    "q": "Will MemeWarzone ever ask for my seed phrase or private key?",
    "a": [
      "No. MemeWarzone never asks for your seed phrase, recovery phrase or private key, in the app, in Discord, on X, in Telegram or by email. Anyone who asks is a scammer, even if they look like staff.",
      "A wallet only needs you to approve or sign a message or transaction. Signing does not require your seed phrase."
    ],
    "keywords": [
      "seed phrase",
      "private key",
      "recovery phrase",
      "mnemonic",
      "12 words",
      "secret phrase",
      "scam"
    ],
    "popular": true,
    "sources": [
      "founder 2026-10-22",
      "docs-site/src/content/security/avoid-scams.md"
    ]
  },
  {
    "slug": "official-links-and-channels",
    "q": "What are the official MemeWarzone links and channels?",
    "a": [
      "Use only these official places. Type the address yourself or use a bookmark."
    ],
    "bullets": [
      "App: app.memewar.zone",
      "Website: memewar.zone",
      "Docs: docs.memewar.zone",
      "X: x.com/memewarzone",
      "Telegram: t.me/memewarzonehq",
      "Discord: discord.gg/aXTkn3Asu",
      "Email: support@memewar.zone"
    ],
    "links": [
      {
        "href": "https://docs.memewar.zone",
        "text": "Docs"
      },
      {
        "href": "https://x.com/memewarzone",
        "text": "MemeWarzone on X"
      },
      {
        "href": "https://t.me/memewarzonehq",
        "text": "MemeWarzone on Telegram"
      },
      {
        "href": "https://discord.gg/aXTkn3Asu",
        "text": "MemeWarzone Discord"
      }
    ],
    "keywords": [
      "official website",
      "official links",
      "official twitter",
      "official telegram",
      "fake site",
      "real domain"
    ],
    "popular": true,
    "needsReview": "app.memewar.zone is the live app host per the founder's records; confirm no other official domain should be listed.",
    "sources": [
      "founder 2026-10-22",
      "docs-site/src/content/security/avoid-scams.md:11-19"
    ],
    "alsoIn": [
      "getting-started"
    ]
  },
  {
    "slug": "spot-fake-coins-and-impersonation",
    "q": "How do I spot a fake coin or an impersonator?",
    "a": [
      "Anyone can launch a coin with any name, image and ticker. A matching name or logo does not prove the coin belongs to a project, a person or a company.",
      "Check the contract address against the one the project posts on its own official channels, and check which chain the coin is on. Look at who created the coin and how old it is. An UpVote, a Featured spot, a rising chart or a crowded page does not make a coin safe."
    ],
    "bullets": [
      "Compare the full contract address, not only the name or ticker.",
      "Be careful with coins launched seconds after a famous name starts trending.",
      "Ignore DMs that point you to a coin or a claim page.",
      "If someone uses your name or images, file a Report Abuse case."
    ],
    "keywords": [
      "fake coin",
      "copycat",
      "impersonation",
      "clone token",
      "fake project",
      "same ticker",
      "stolen logo"
    ],
    "sources": [
      "docs-site/src/content/security/overview.md:30-40",
      "docs-site/src/content/command-center/support.md:24-31"
    ]
  },
  {
    "slug": "report-abuse",
    "q": "How do I report impersonation, stolen images or phishing?",
    "a": [
      "Use File Abuse Report in the Command Center under Support and safety. Abuse reports are for identity problems: someone impersonating you, using your images or content, a fake project pretending to be you, or phishing that pretends to be you or MemeWarzone. You can also report a post, comment or profile from its menu.",
      "A failed trade or a missing reward is not abuse. Take those to Discord support."
    ],
    "steps": [
      "Open Command Center, then Support and safety, and press File Abuse Report.",
      "Pick a category and, if you know it, what you are reporting: a profile, coin, token, wallet, post or website. Add the link or address.",
      "Describe what happened and how it targets you.",
      "Enter your email and add evidence if you have it: JPG, PNG, WEBP or PDF, up to 5 files of 10 MB each."
    ],
    "links": [
      {
        "href": "https://discord.gg/aXTkn3Asu",
        "text": "MemeWarzone Discord"
      }
    ],
    "keywords": [
      "report abuse",
      "report",
      "scam report",
      "abuse report",
      "stolen identity",
      "phishing report",
      "file abuse"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/command-center/support.md:6-50",
      "frontend/src/lib/abuseHelpArticles.ts",
      "frontend/src/lib/helpCenter.ts:677-721"
    ]
  },
  {
    "slug": "abuse-report-replies",
    "q": "How will I hear back about my abuse report?",
    "a": [
      "After you submit you get a case number and a link to the case. My Abuse Reports lists your cases with type, date, status and last update. Staff replies appear only there.",
      "You get an email when there is a reply, but do not answer the email. Reply inside the case, where you can also add more evidence. Only you and the abuse team can see your reports. Regular Discord support cannot."
    ],
    "keywords": [
      "abuse reply",
      "case number",
      "my abuse reports",
      "who sees my report",
      "abuse email"
    ],
    "sources": [
      "docs-site/src/content/command-center/support.md:42-54"
    ]
  },
  {
    "slug": "what-memewarzone-controls",
    "q": "What does MemeWarzone control and what does it not?",
    "a": [
      "MemeWarzone is non-custodial. It does not hold your coins, and fees are split inside the same transaction as the trade. You sign every transaction from your own wallet.",
      "The team does not control the market price of a coin, other people's trades or what a coin's creator does with their own tokens. The platform can improve structure and visibility, but it cannot remove market risk."
    ],
    "alsoIn": [
      "getting-started"
    ],
    "keywords": [
      "custody",
      "non custodial",
      "who holds my funds",
      "does mwz hold my coins",
      "control",
      "trust"
    ],
    "sources": [
      "docs-site/src/content/fees/index.md:27",
      "docs-site/src/content/security/overview.md:6-12",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "contracts-owners-and-audit",
    "q": "Who owns the contracts, and are they audited?",
    "a": [
      "On BNB Chain and Robinhood Chain the contracts are owned by a Safe multisig and cannot be changed after deployment. On Solana the programs can only be upgraded through a Squads multisig.",
      "An external audit is pending on every chain. Until it is done, treat the contracts as unaudited by an outside firm. Protocol earnings above a fixed cap move to a multisig wallet. The contract addresses are listed on the About page."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone and contracts"
      }
    ],
    "keywords": [
      "audit",
      "multisig",
      "safe",
      "squads",
      "immutable",
      "contract owner",
      "upgradeable",
      "is it safe"
    ],
    "popular": false,
    "sources": [
      "frontend/shared/aboutContent.mjs:213-250",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "rug-risk-and-locked-liquidity",
    "q": "Can a creator rug a coin? What is locked after graduation?",
    "a": [
      "When a coin graduates, its liquidity moves into a DEX pool and is locked for good. The creator cannot withdraw that liquidity. On BNB Chain and Robinhood Chain the pool is on Uniswap V4. On Solana it is on Meteora.",
      "That does not remove all risk. A creator can still sell the tokens they hold, and a coin can lose most of its value. The creator reserve is 2% of supply (20M tokens). On Solana it is released at graduation. On BNB Chain and Robinhood Chain it is released no earlier than 1 hour after graduation, and only while the price is at or above the graduation price."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      }
    ],
    "alsoIn": [
      "graduation"
    ],
    "keywords": [
      "rug",
      "rugpull",
      "rug pull",
      "locked liquidity",
      "liquidity lock",
      "creator dump",
      "exit scam"
    ],
    "popular": false,
    "sources": [
      "founder 2026-10-22",
      "frontend/shared/evmGen8.mjs GEN8_RESERVE_RELEASE_DELAY_SECONDS",
      "frontend/shared/dbcEconomics.mjs",
      "docs-site/src/content/security/risk-disclosure.md"
    ]
  },
  {
    "slug": "import-safety-checks",
    "q": "What safety checks run on imported coins?",
    "a": [
      "When you import a coin, MemeWarzone checks that the address is a real token on the chosen chain, that the coin has left its bonding stage and has a funded DEX pool, and that the token can be sold and moved freely.",
      "An import is refused when the address is not a token, selling fails (a honeypot), transfers are blocked or paused, or the transfer tax is above 10%. Some findings send the coin to review instead, and it is not listed until the review is done. Trading is switched off on a coin when a later scan reports a honeypot or a blocked transfer.",
      "A passed check lowers some risks. It is not a promise that a coin is safe."
    ],
    "alsoIn": [
      "imports"
    ],
    "keywords": [
      "honeypot",
      "import check",
      "safety scan",
      "transfer tax",
      "blocked transfer",
      "scan",
      "can i sell"
    ],
    "sources": [
      "docs-site/src/content/creators/imported-coins.md:27-44,67"
    ]
  },
  {
    "slug": "phishing-signatures-to-watch",
    "q": "What wallet prompts should make me stop and not sign?",
    "a": [
      "Read every prompt before you approve. Stop if anything does not match what you meant to do."
    ],
    "bullets": [
      "The website domain in the prompt is not an official one.",
      "The chain is not the one you chose.",
      "It asks for an approval of unlimited spending, or to give another address control of your tokens.",
      "It asks you to sign a message you cannot read, or a transaction you did not start.",
      "A message, DM or email says you must claim something urgently or your wallet will be locked.",
      "Someone offers support or recovery help that you did not ask for."
    ],
    "keywords": [
      "phishing",
      "wallet drainer",
      "approval",
      "unlimited approval",
      "malicious signature",
      "scam link",
      "sign message",
      "drainer"
    ],
    "popular": false,
    "sources": [
      "docs-site/src/content/security/avoid-scams.md:21-35",
      "docs-site/src/content/security/overview.md"
    ]
  },
  {
    "slug": "what-memewarzone-asks-you-to-sign",
    "q": "What does MemeWarzone ask me to sign?",
    "a": [
      "You sign once when you connect, and that sign-in covers social actions such as posts, follows and comments for 30 days. You also sign for actions that move money or change something on chain: buying, selling, creating a coin, buying Boosts or UpVotes, signing up as a recruiter and claiming rewards.",
      "A sign-in message is not a transaction and cannot move your coins. Still, read each prompt. If a prompt appears that you did not trigger, close it."
    ],
    "alsoIn": [
      "wallets"
    ],
    "keywords": [
      "signature",
      "sign message",
      "sign in",
      "why sign",
      "30 days",
      "sign every time"
    ],
    "sources": [
      "founder 2026-10-22 (signatures only for money, PR #526)",
      "docs-site/src/content/social/signing.md",
      "docs-site/src/content/arena/live-battles.md:60"
    ]
  },
  {
    "slug": "what-data-is-public",
    "q": "What information about me is public?",
    "a": [
      "Blockchain data is public. Anyone can see your wallet address, your trades and your balances on a block explorer. Your MemeWarzone profile is tied to your wallet and is the same on every chain: picture, name, @username and bio. Posts, follows, comments and league and battle results are public.",
      "No account or email is needed to use the app. The email you give in an abuse report is used only to tell you when the report is updated, and only you and the abuse team see the report."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      }
    ],
    "keywords": [
      "privacy",
      "public data",
      "wallet address public",
      "personal data",
      "gdpr",
      "anonymous",
      "profile visible"
    ],
    "needsReview": "For the full list of personal data and retention, point to the privacy policy; the privacy policy text was not read for this article.",
    "sources": [
      "docs-site/src/content/command-center/support.md:36,54",
      "docs-site/src/content/social/profiles.md",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "account-security-tips",
    "q": "How do I keep my wallet and account secure?",
    "a": [
      "Your wallet is your account, so its security is your security. MemeWarzone cannot reset a wallet, reverse a transaction or recover lost keys."
    ],
    "bullets": [
      "Keep your seed phrase offline and never type it into a website or chat.",
      "Use a separate wallet for trading, with only the funds you are ready to risk.",
      "Consider a hardware wallet for larger balances.",
      "Bookmark the official app and do not follow links from DMs or replies.",
      "Check the domain, chain and action in each prompt before you sign.",
      "Review and revoke token approvals you no longer need.",
      "Do not use money you cannot afford to lose."
    ],
    "keywords": [
      "wallet security",
      "hardware wallet",
      "revoke approvals",
      "2fa",
      "account security",
      "hacked",
      "compromised wallet"
    ],
    "sources": [
      "docs-site/src/content/security/avoid-scams.md",
      "docs-site/src/content/security/risk-disclosure.md"
    ]
  },
  {
    "slug": "contact-support",
    "q": "How do I contact MemeWarzone support?",
    "a": [
      "For product questions about wallets, trading, launches and rewards, use the MemeWarzone Discord. You can also write to support@memewar.zone. Legal questions go to legal@memewar.zone.",
      "Use Report Abuse in the Command Center for impersonation, stolen images or phishing. Support never asks for your seed phrase or private key and never asks you to send funds to get a reward."
    ],
    "links": [
      {
        "href": "https://discord.gg/aXTkn3Asu",
        "text": "MemeWarzone Discord"
      },
      {
        "href": "https://t.me/memewarzonehq",
        "text": "Telegram"
      }
    ],
    "alsoIn": [
      "troubleshooting",
      "getting-started"
    ],
    "keywords": [
      "support",
      "contact",
      "help",
      "email",
      "discord support",
      "customer service",
      "talk to a human"
    ],
    "sources": [
      "founder 2026-10-22",
      "docs-site/src/content/command-center/support.md:15-20"
    ]
  },
  {
    "slug": "memewarzone-risk-disclosure",
    "q": "What are the risks of trading memecoins on MemeWarzone?",
    "a": [
      "You can lose all the money you put into a memecoin. Prices are volatile and can change fast. Weak coins, bad timing, bad links, infrastructure delays and bad judgment can all cost money.",
      "MemeWarzone gives information and tools, not financial advice. Rewards are never guaranteed income. Use only money you can afford to lose. The service is operated under Dutch law and is for users aged 18 or older."
    ],
    "keywords": [
      "risk",
      "risks",
      "lose money",
      "financial advice",
      "disclaimer",
      "18+",
      "volatility"
    ],
    "sources": [
      "docs-site/src/content/security/risk-disclosure.md",
      "docs-site/src/content/legal/terms-of-service.md"
    ]
  }
];
