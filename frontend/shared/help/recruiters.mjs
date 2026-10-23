// Help Center articles: recruiters and squads. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-is-a-recruiter",
    "q": "What is a MemeWarzone recruiter?",
    "a": [
      "A recruiter brings creators and traders to MemeWarzone with a personal code and link. The wallets that join through that link form the recruiter's squad.",
      "Recruiters earn a share of the trade fee from the wallets they brought in. They do not own those users and they do not change the rules for rewards, claims or eligibility."
    ],
    "links": [
      {
        "href": "/recruiters",
        "text": "Recruiter leaderboard"
      },
      {
        "href": "/recruiter/signup",
        "text": "Become a recruiter"
      }
    ],
    "keywords": [
      "recruiter",
      "referral",
      "affiliate",
      "invite",
      "ambassador",
      "refer a friend"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/programs/recruiter-program.md:6-40",
      "docs-site/src/content/fees/where-fees-go.md:40"
    ]
  },
  {
    "slug": "become-a-recruiter",
    "q": "How do I become a recruiter?",
    "a": [
      "Anyone with a BNB Chain, Solana or Robinhood Chain wallet can sign up. The recruiter account is created as active when you submit the signed form. You can also start from the Recruiter tab in the Command Center.",
      "A wallet can be a recruiter only once, and a code can be used only once."
    ],
    "steps": [
      "Open the recruiter signup page and connect your wallet.",
      "Choose a recruiter code: lowercase letters, numbers, dashes or underscores. The page tells you if it is taken.",
      "Enter a display name, an email and a short pitch about your audience. Telegram, Discord and X handles are optional.",
      "Accept the recruiter terms and sign the signup message in your wallet."
    ],
    "links": [
      {
        "href": "/recruiter/signup",
        "text": "Become a recruiter"
      }
    ],
    "keywords": [
      "recruiter signup",
      "apply recruiter",
      "register recruiter",
      "become recruiter",
      "recruiter code",
      "join as recruiter"
    ],
    "popular": true,
    "sources": [
      "frontend/api/dev-fix/attribution.js:829-895",
      "frontend/src/pages/RecruiterSignup.tsx:262-296",
      "docs-site/src/content/command-center/recruiter.md:10-14"
    ]
  },
  {
    "slug": "recruiter-referral-link",
    "q": "What is my referral link and how do I change my code?",
    "a": [
      "Your referral link ends in /r/ followed by your code, for example /r/yourcode. The Recruiter tab in the Command Center shows your referral link and a home link, each with a copy button, plus Share on X.",
      "To change your code, open the Recruiter tab, press Sign in to manage with the recruiter wallet, type the new code and press Save code. A code that another recruiter already has cannot be used."
    ],
    "links": [
      {
        "href": "/recruiter/signup",
        "text": "Recruiter signup"
      }
    ],
    "keywords": [
      "referral link",
      "/r/",
      "recruiter code",
      "change code",
      "share link",
      "invite link"
    ],
    "needsReview": "The full public domain of the referral link was not checked (the route is /r/:code in the app). Check the exact URL shown in the Recruiter tab.",
    "sources": [
      "frontend/src/pages/RecruiterReferral.tsx:42",
      "docs-site/src/content/command-center/recruiter.md:20-37"
    ]
  },
  {
    "slug": "how-recruiter-attribution-works",
    "q": "How does a wallet get linked to a recruiter?",
    "a": [
      "When someone opens a referral link, the app remembers the recruiter's code for a limited time. The person can connect a wallet afterwards. On connect, and after the wallet signs in, the wallet is linked to that recruiter and joins the squad. A new member chooses whether they join as a creator, a trader or both.",
      "A wallet is linked to one recruiter at a time. A wallet that already has a recruiter keeps it, and an opened link for another recruiter does not replace it."
    ],
    "links": [
      {
        "href": "/squads",
        "text": "Squads"
      }
    ],
    "keywords": [
      "attribution",
      "linked",
      "link wallet",
      "referral cookie",
      "join recruiter",
      "who referred me",
      "recruiter link"
    ],
    "sources": [
      "docs-site/src/content/programs/attribution-and-links.md:6-30",
      "frontend/api/dev-fix/attribution.js:536-600"
    ]
  },
  {
    "slug": "recruiter-link-lock",
    "q": "Can I change my recruiter after I joined? What is the lock?",
    "a": [
      "The link is meant to stay in place so reward routing is auditable and nobody can hop between codes. Once a wallet has activity on MemeWarzone, its link is locked.",
      "If you opened the wrong link, fix it before you trade, create or take part in anything. After the lock there is currently no way to change your recruiter."
    ],
    "keywords": [
      "change recruiter",
      "switch recruiter",
      "locked",
      "wrong referral",
      "wrong code",
      "attribution lock"
    ],
    "sources": [
      "docs-site/src/content/programs/attribution-and-links.md:28-30",
      "frontend/api/dev-fix/attribution.js:536-566",
      "founder 2026-10-23"
    ]
  },
  {
    "slug": "recruiter-earnings",
    "q": "How much does a recruiter earn?",
    "a": [
      "A recruiter earns 12.5% of the trade fee paid by wallets they brought in. The trade fee is 2%, so that is 0.25% of each trade. A recruiter also earns 15% of the graduation fee of coins those wallets create, which is 0.30% of the raise.",
      "Earnings are paid in the chain's own coin and claimed in the Command Center under Rewards and claims. They depend on the real trading of your linked wallets, so they can be zero."
    ],
    "links": [
      {
        "href": "/recruiters",
        "text": "Recruiter leaderboard"
      }
    ],
    "alsoIn": [
      "fees",
      "rewards"
    ],
    "keywords": [
      "recruiter fee",
      "12.5%",
      "recruiter commission",
      "referral earnings",
      "how much do recruiters make",
      "15%"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/fees/where-fees-go.md:40",
      "founder 2026-10-22 (fee split facts)"
    ]
  },
  {
    "slug": "og-recruiters",
    "q": "What are OG recruiters?",
    "a": [
      "OG recruiters are an early recruiter class. They earn 15% of the trade fee (0.30% of each trade) and 17.5% of the graduation fee (0.35%). The extra comes out of MemeWarzone's share, not from the traders.",
      "OG status is shown on the recruiter's public page."
    ],
    "alsoIn": [
      "fees"
    ],
    "keywords": [
      "og",
      "og recruiter",
      "early recruiter",
      "17.5%",
      "15% trade fee"
    ],
    "sources": [
      "docs-site/src/content/programs/og-recruiters.md",
      "docs-site/src/content/fees/where-fees-go.md:40",
      "frontend/api/dev-fix/attribution.js:877"
    ]
  },
  {
    "slug": "what-is-a-squad",
    "q": "What is a squad?",
    "a": [
      "A squad is the group of wallets linked to one recruiter. If you joined through a recruiter's link, you are in that recruiter's squad. The Squad tab in the Command Center appears only when your wallet is in a squad.",
      "The tab shows the squad status, the members, how many members are eligible and the pending pool. Public squad standings are on the Squads page."
    ],
    "links": [
      {
        "href": "/squads",
        "text": "Squads"
      }
    ],
    "keywords": [
      "squad",
      "team",
      "crew",
      "members",
      "squad tab",
      "squad page"
    ],
    "sources": [
      "docs-site/src/content/command-center/squad.md:6-22",
      "frontend/src/pages/SquadLeaderboard.tsx:108"
    ]
  },
  {
    "slug": "squad-pool-explained",
    "q": "How does the squad pool work?",
    "a": [
      "The squad pool is 2.5% of the 2% trade fee. It is shared every week by eligible members, based on their contribution. It is not an equal split, and it is not a reward for showing up once.",
      "Squad rewards are claimed in Rewards and claims, on the Squad Rewards row. The pool does not guarantee the same result for every member."
    ],
    "links": [
      {
        "href": "/squads",
        "text": "Squads"
      }
    ],
    "alsoIn": [
      "rewards",
      "fees"
    ],
    "keywords": [
      "squad pool",
      "squad reward",
      "2.5%",
      "contribution",
      "weekly squad",
      "squad share"
    ],
    "sources": [
      "docs-site/src/content/rewards/squad-pool.md:6-30",
      "docs-site/src/content/fees/fee-routing.md:22-53"
    ]
  },
  {
    "slug": "why-not-eligible-squad-rewards",
    "q": "Why am I not eligible for squad rewards?",
    "a": [
      "Being a member is not enough. Your own activity has to qualify under the weekly rules, and fair-play checks apply before rewards are shown. The Eligible tile on the Squad tab shows how many members qualify.",
      "A wallet that is detached from the squad or flagged under the fair-play rules can lose eligibility for that week."
    ],
    "alsoIn": [
      "rewards"
    ],
    "keywords": [
      "squad not eligible",
      "no squad reward",
      "squad eligibility",
      "zero squad reward"
    ],
    "sources": [
      "docs-site/src/content/command-center/squad.md:24-28",
      "docs-site/src/content/rewards/squad-pool.md:24-28"
    ]
  },
  {
    "slug": "leave-or-switch-squad",
    "q": "Can I leave a squad?",
    "a": [
      "Not at the moment. There is no way to leave a squad or move to another squad in the app. A squad link is tied to the recruiter that brought the wallet in, and it locks once the wallet has activity.",
      "If something went wrong with your link, ask in Discord support."
    ],
    "links": [
      {
        "href": "https://discord.gg/aXTkn3Asu",
        "text": "MemeWarzone Discord"
      }
    ],
    "keywords": [
      "leave squad",
      "quit squad",
      "remove me",
      "unlink",
      "detach"
    ],
    "sources": [
      "frontend/api/leagueRecruiter.js:139-143",
      "frontend/api/dev-fix/attribution.js:536-566",
      "founder 2026-10-23"
    ]
  },
  {
    "slug": "squad-join-limits-fair-play",
    "q": "Are there fair-play checks on recruiters and squads?",
    "a": [
      "Yes. Fair-play checks apply to recruiters and squads, and anti-abuse checks can affect eligibility, ranking, winner selection and claim status. Activity that looks like self trading, wash trading, circular activity or linked wallet farming can be excluded.",
      "Joins from one network are limited, only the wallet's owner can join, and a recruiter's own wallets cannot be linked to their own code. A recruiter can be suspended for scripted or fake squads. The exact triggers are not published."
    ],
    "alsoIn": [
      "safety"
    ],
    "keywords": [
      "suspended recruiter",
      "fake referrals",
      "sybil",
      "fair play",
      "recruiter ban",
      "self referral"
    ],
    "sources": [
      "docs-site/src/content/security/anti-abuse.md",
      "frontend/api/dev-fix/attribution.js:450-460,532,576-590",
      "founder 2026-10-09 (recruiter suspension)"
    ]
  },
  {
    "slug": "recruiter-dashboard",
    "q": "What does the recruiter dashboard show?",
    "a": [
      "The Recruiter tab in the Command Center shows tiles for linked wallets, creators, traders, your code and your status. After you press Sign in to manage and sign with the recruiter wallet, it also lists recent referrals with their role and join date.",
      "You can copy your links, share on X, upload a squad image (PNG, JPG or WebP) for your public squad page and open your public recruiter page. Recruiter rewards are claimed in Rewards and claims."
    ],
    "links": [
      {
        "href": "/recruiters",
        "text": "Recruiter leaderboard"
      }
    ],
    "keywords": [
      "recruiter dashboard",
      "recruiter tab",
      "linked wallets",
      "recent referrals",
      "squad image",
      "manage recruiter"
    ],
    "sources": [
      "docs-site/src/content/command-center/recruiter.md:6-55"
    ]
  },
  {
    "slug": "recruiter-and-squad-leaderboards",
    "q": "Where are the recruiter and squad leaderboards?",
    "a": [
      "The recruiter leaderboard is at /recruiters. It compares recruiters by network growth, activity, earnings and performance score, sorted by total earned and then by linked wallets.",
      "The squad leaderboard is at /squads. It shows how squads rank this week, the estimated share of the squad pool for each squad and how members rank by contribution. Estimates are not payouts."
    ],
    "links": [
      {
        "href": "/recruiters",
        "text": "Recruiter leaderboard"
      },
      {
        "href": "/squads",
        "text": "Squad leaderboard"
      }
    ],
    "keywords": [
      "recruiter leaderboard",
      "squad leaderboard",
      "ranking",
      "top recruiters",
      "top squads"
    ],
    "sources": [
      "frontend/src/pages/RecruiterLeaderboard.tsx:84-126",
      "frontend/src/pages/SquadLeaderboard.tsx:108"
    ]
  },
  {
    "slug": "recruiter-league-prizes",
    "q": "Is there a prize for the best recruiters?",
    "a": [
      "Yes. The Recruiter League is a weekly and monthly prize league on every chain, paid from the league fee. It is one all-chains ranking, and a paid place needs referred trading in the current round. Prizes go to your recruiter wallet on each chain.",
      "Prizes are not guaranteed and are claimed in Rewards and claims."
    ],
    "links": [
      {
        "href": "/league",
        "text": "League standings"
      }
    ],
    "alsoIn": [
      "leagues"
    ],
    "keywords": [
      "recruiter league",
      "recruiter prize",
      "weekly recruiter",
      "recruiter ranking prize"
    ],
    "sources": [
      "frontend/src/lib/leagues.ts:102-120"
    ]
  }
];
