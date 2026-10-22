// Help Center articles: rewards, claims and airdrops. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "ways-to-earn-on-memewarzone",
    "q": "What are all the ways to earn on MemeWarzone?",
    "a": [
      "There are several reward lanes. None of them is guaranteed, and they depend on activity, timing and eligibility."
    ],
    "bullets": [
      "Battle prizes: the owner of the winning coin claims the war pool share.",
      "Leagues: top places in the weekly and monthly leagues and the Major War League.",
      "Creator fees: a share of the trade fee on coins you launched, and pool fees after graduation.",
      "Recruiter earnings: a share of the trade fee from wallets linked to your code.",
      "Squad pool: a weekly pool shared by eligible squad members by contribution.",
      "Weekly airdrops: a pot split over eligible traders and creators."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      },
      {
        "href": "/airdrops",
        "text": "Airdrops"
      }
    ],
    "keywords": [
      "earn",
      "rewards",
      "make money",
      "income",
      "ways to earn",
      "payouts",
      "how to get paid"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/command-center/claims.md:135-146",
      "docs-site/src/content/fees/fee-routing.md:22-53",
      "docs-site/src/content/security/risk-disclosure.md"
    ]
  },
  {
    "slug": "rewards-are-not-guaranteed",
    "q": "Are rewards guaranteed? Does every holder get paid?",
    "a": [
      "No. Rewards depend on activity, rankings, timing and fair-play checks. A prize pool shown on screen does not mean your wallet will win.",
      "MemeWarzone does not pay out automatically to every holder of a coin. Holding a coin is not a claim on any pot. Trading carries the risk of losing money, so do not use money you cannot afford to lose."
    ],
    "keywords": [
      "guaranteed",
      "promise",
      "free money",
      "holder rewards",
      "passive income",
      "risk"
    ],
    "sources": [
      "docs-site/src/content/security/risk-disclosure.md",
      "docs-site/src/content/command-center/airdrops.md:36",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "claim-rewards-command-center",
    "q": "How do I claim my rewards?",
    "a": [
      "Rewards are claimed in the Command Center under Rewards and claims. The tab shows what the connected wallet has earned on the selected chain. Claims work on BNB Chain, Solana and Robinhood Chain, and each claim is a wallet transaction that you confirm yourself."
    ],
    "steps": [
      "Connect the wallet that earned the reward.",
      "Check that the chain at the top of the tab is the right one.",
      "Claim only rows marked Ready or Failed.",
      "Confirm in your wallet, wait for the confirmation, then check the row again."
    ],
    "bullets": [
      "League Rewards: weekly, monthly, Major War League and quarterly prizes",
      "Airdrop Rewards: weekly airdrop wins",
      "Squad Rewards: your share of the squad pool",
      "Recruiter Rewards: recruiter earnings, after one signature with the recruiter wallet",
      "Creator fees: one line per coin you launched",
      "Battle and tournament wins: one row per battle"
    ],
    "keywords": [
      "claim",
      "claim rewards",
      "rewards and claims",
      "claim center",
      "collect",
      "how to claim"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/command-center/claims.md:127-171"
    ]
  },
  {
    "slug": "claim-statuses",
    "q": "What do Ready, Pending, Failed and Expired mean on a claim?",
    "a": [
      "Ready means you can claim now. Pending means a claim is already in progress. Failed means the last attempt did not finish, and the button changes to Retry Claim. Expired means the claim window has closed. No rewards yet means there is nothing to claim on that row.",
      "A failed or cancelled claim never removes the reward. It stays on the row until you claim it."
    ],
    "keywords": [
      "pending claim",
      "failed claim",
      "retry claim",
      "expired reward",
      "ready",
      "claim status"
    ],
    "sources": [
      "docs-site/src/content/command-center/claims.md:148-158"
    ]
  },
  {
    "slug": "claim-all-ready",
    "q": "What does Claim all ready do?",
    "a": [
      "When more than one row is Ready, a Claim all ready button appears at the top with the number of ready rows. It runs the claims one after another.",
      "Your wallet asks you to confirm each claim, so expect one signature per reward. The button shows progress, for example Claiming 2 of 3."
    ],
    "keywords": [
      "claim all",
      "batch claim",
      "claim everything",
      "multiple claims"
    ],
    "sources": [
      "docs-site/src/content/command-center/claims.md:160-162"
    ]
  },
  {
    "slug": "do-rewards-expire",
    "q": "Do rewards expire? How long do I have to claim?",
    "a": [
      "Weekly airdrop wins can be claimed for 60 days. After that, unclaimed drops go back into the airdrop pot for a later week. Major War League prizes do not expire.",
      "A row that can no longer be claimed is marked Expired in Rewards and claims. Do not leave a reward unclaimed on purpose, because the window for other reward types is not listed here."
    ],
    "keywords": [
      "expire",
      "expiry",
      "deadline",
      "60 days",
      "unclaimed",
      "claim window",
      "lost reward"
    ],
    "needsReview": "Claim windows for weekly and monthly league prizes, squad, recruiter and battle prizes are not documented. Only airdrops (60 days) and MWL (no expiry) are confirmed.",
    "sources": [
      "docs-site/src/content/rewards/epochs-and-claims.md:108-114",
      "docs-site/src/content/command-center/claims.md:173-175"
    ]
  },
  {
    "slug": "which-coin-are-rewards-paid-in",
    "q": "Which coin are rewards paid in?",
    "a": [
      "Rewards are paid in the coin of the chain they were earned on. BNB stays BNB and SOL stays SOL. Earnings are not converted between chains, and Rewards and claims shows one chain at a time.",
      "Weekly airdrops are paid in the chain's own coin. League prizes are claimed on the chain you earned them on."
    ],
    "keywords": [
      "payout currency",
      "paid in bnb",
      "paid in sol",
      "native coin",
      "which token",
      "usdt"
    ],
    "sources": [
      "docs-site/src/content/command-center/airdrops.md:11",
      "frontend/src/lib/helpCenter.ts:599-604",
      "docs-site/src/content/command-center/claims.md:127"
    ]
  },
  {
    "slug": "claim-gas-and-solana-minimum",
    "q": "Do claims cost gas? Why is there a Solana minimum?",
    "a": [
      "Yes. Each claim is a wallet transaction, so you pay the normal network fee for the chain. Keep a small balance of the chain's coin in your wallet.",
      "On Solana every claim also creates a receipt that needs a deposit of about 0.0013 SOL. That is why Solana prizes have a minimum of 0.005 SOL. A smaller amount is not paid on its own: it rolls over or adds up until it is worth claiming."
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "keywords": [
      "claim fee",
      "gas",
      "network fee",
      "rent",
      "0.005 sol",
      "minimum payout",
      "solana claim"
    ],
    "needsReview": "Gas cost on BNB Chain and Robinhood Chain claims is the normal network fee; confirm no relayer pays it for the user.",
    "sources": [
      "docs-site/src/content/command-center/claims.md:131,171",
      "frontend/src/lib/helpCenter.ts:663-668"
    ]
  },
  {
    "slug": "weekly-airdrops-explained",
    "q": "How do the weekly airdrops work?",
    "a": [
      "Warzone Airdrops are a weekly reward for active traders and creators who are not the biggest wallets. Each chain runs its own airdrop with its own pot, in that chain's coin.",
      "The weekly window closes on Monday at 00:00 UTC. Winners are picked from the closed week and published shortly after. The pot is split over the winners, so a bigger pot means more winners.",
      "The Airdrops tab shows the running week, the current pool, a preview of who is eligible and past winners. The preview is an estimate, and the final list is made at the drop."
    ],
    "links": [
      {
        "href": "/airdrops",
        "text": "Airdrops"
      },
      {
        "href": "/airdrops/winners",
        "text": "Airdrop winners"
      }
    ],
    "keywords": [
      "airdrop",
      "weekly airdrop",
      "warzone airdrop",
      "monday drop",
      "airdrop pool",
      "bnb airdrop",
      "sol airdrop"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/rewards/warzone-airdrops.md:6-48",
      "docs-site/src/content/command-center/airdrops.md:6-22"
    ]
  },
  {
    "slug": "airdrop-eligibility",
    "q": "Am I eligible for the weekly airdrop?",
    "a": [
      "Two groups can qualify in a weekly window: traders with real buying and selling, and creators whose coins attract real buyers."
    ],
    "bullets": [
      "Traders need a minimum volume, a minimum number of trades and activity on more than one day in the week.",
      "A creator's own buys do not count toward their coin.",
      "Wallets flagged by security checks are left out.",
      "Very large activity is capped, so the pot spreads over more people.",
      "The limits are the same in US dollars on every chain. The exact numbers are not published."
    ],
    "links": [
      {
        "href": "/airdrops",
        "text": "Airdrops"
      }
    ],
    "keywords": [
      "airdrop requirements",
      "qualify",
      "eligible",
      "minimum volume",
      "airdrop preview",
      "self buy",
      "not eligible"
    ],
    "sources": [
      "docs-site/src/content/rewards/warzone-airdrops.md:12-27",
      "docs-site/src/content/command-center/airdrops.md:12-16"
    ]
  },
  {
    "slug": "airdrop-cooldown-and-return",
    "q": "Can I win the airdrop every week? What happens to unclaimed airdrops?",
    "a": [
      "A wallet that won sits out for 14 days before it can win again.",
      "Airdrop wins can be claimed for 60 days. After that, unclaimed drops go back into the pot and help a later week."
    ],
    "links": [
      {
        "href": "/airdrops/winners",
        "text": "Airdrop winners"
      }
    ],
    "keywords": [
      "cooldown",
      "14 days",
      "win again",
      "60 days",
      "unclaimed airdrop",
      "return to pot"
    ],
    "sources": [
      "docs-site/src/content/rewards/warzone-airdrops.md:24-25,37-39",
      "docs-site/src/content/command-center/airdrops.md:36"
    ]
  },
  {
    "slug": "where-airdrop-money-comes-from",
    "q": "Where does the airdrop pot come from?",
    "a": [
      "Airdrops are funded from the trade fee. When a trader has no recruiter, the recruiter and squad slices of that trade's fee go to the airdrop pot instead. That is 15% of the 2% fee on those trades.",
      "The pot therefore depends on how many traders have no recruiter, so it changes from week to week."
    ],
    "alsoIn": [
      "fees"
    ],
    "keywords": [
      "airdrop funding",
      "pot size",
      "15%",
      "unlinked traders",
      "fee split"
    ],
    "sources": [
      "docs-site/src/content/fees/fee-routing.md:22-53",
      "founder 2026-10-22"
    ]
  },
  {
    "slug": "creator-fee-claims",
    "q": "How do I claim creator fees from my coin?",
    "a": [
      "Open the Command Center, then Rewards and claims. If you launched coins, a Creator fees card lists each coin with the amount you can claim.",
      "After graduation, pool fees from the locked liquidity are collected from My coins. Open the coin and use the claim button on its row. If the pool is not ready or nothing is waiting, the row says so. Your share depends on the launch and the chain, so check the fee page for the current split."
    ],
    "alsoIn": [
      "fees"
    ],
    "keywords": [
      "creator fees",
      "lp fees",
      "harvest",
      "my coins",
      "creator earnings",
      "claim lp"
    ],
    "sources": [
      "docs-site/src/content/command-center/claims.md:146",
      "docs-site/src/content/creators/creator-earnings.md:11-27",
      "frontend/src/lib/helpCenter.ts:557-562"
    ]
  },
  {
    "slug": "squad-and-recruiter-rewards-claims",
    "q": "Where do I claim squad and recruiter rewards?",
    "a": [
      "Squad rewards are on the Squad Rewards row of Rewards and claims. The row shows when you are in a squad or have a squad reward.",
      "Recruiter earnings are in a separate Recruiter Rewards card. Sign once with your recruiter wallet to view and claim."
    ],
    "alsoIn": [
      "recruiters"
    ],
    "links": [
      {
        "href": "/squads",
        "text": "Squads"
      },
      {
        "href": "/recruiters",
        "text": "Recruiters"
      }
    ],
    "keywords": [
      "recruiter rewards",
      "squad rewards",
      "claim recruiter",
      "squad claim"
    ],
    "sources": [
      "docs-site/src/content/command-center/claims.md:139-146",
      "docs-site/src/content/command-center/recruiter.md:50-52"
    ]
  },
  {
    "slug": "reward-missing-or-wrong-wallet",
    "q": "I cannot see my reward. What should I check?",
    "a": [
      "Rewards and claims shows one chain and one wallet at a time. Most missing rewards are on another chain or another wallet.",
      "If the amount is still missing, the round may not have closed or the result may not be published yet. Weekly rewards close on Monday 00:00 UTC. Anti-abuse checks can also exclude activity from a reward. Product questions go to Discord support, and impersonation or phishing goes to Report Abuse."
    ],
    "steps": [
      "Connect the wallet that earned the reward.",
      "Switch the chain at the top of the tab.",
      "Check the round has closed and results are published.",
      "Ask in Discord support with your wallet address and the round."
    ],
    "links": [
      {
        "href": "https://discord.gg/aXTkn3Asu",
        "text": "MemeWarzone Discord"
      }
    ],
    "alsoIn": [
      "troubleshooting"
    ],
    "keywords": [
      "missing reward",
      "no rewards yet",
      "wrong chain",
      "cannot claim",
      "reward not showing"
    ],
    "sources": [
      "docs-site/src/content/command-center/claims.md:127,164-169",
      "docs-site/src/content/rewards/epochs-and-claims.md:88-101",
      "docs-site/src/content/security/anti-abuse.md"
    ]
  },
  {
    "slug": "reward-timing-weekly-close",
    "q": "When are weekly rewards calculated and published?",
    "a": [
      "The standard weekly close is Monday at 00:00 UTC. After that, results for the completed window are checked and published. Eligible reward rows then appear in Rewards and claims, and you claim them with your wallet.",
      "Monthly leagues close on the 1st of the month at 00:00 UTC."
    ],
    "keywords": [
      "monday",
      "weekly close",
      "when are rewards paid",
      "epoch",
      "publish results"
    ],
    "sources": [
      "docs-site/src/content/rewards/epochs-and-claims.md:88-101",
      "docs-site/src/content/leagues/epochs-and-prizes.md:37-44"
    ]
  }
];
