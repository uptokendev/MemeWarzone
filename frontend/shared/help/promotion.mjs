// Help Center articles: promotion. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "what-is-an-upvote",
    "q": "What is an UpVote?",
    "a": [
      "An UpVote is a paid push for a coin's visibility. It helps the coin rank higher on Coins, in Featured and Trending, and on the Warzone pages. It does not buy the coin and it gives you no tokens.",
      "It is not a safety label, a quality mark or an endorsement by MemeWarzone. It only shows that somebody paid to push the coin. Promotion is usually hidden. UpVotes make it visible."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "upvote",
      "vote",
      "up vote",
      "boost visibility",
      "paid vote"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/platform/upvotes.md",
      "frontend/src/lib/helpCenter.ts:373-391"
    ]
  },
  {
    "slug": "how-to-upvote-a-coin",
    "q": "How do I UpVote a coin?",
    "a": [
      "You need a connected wallet on the coin's chain. An UpVote is a payment, so your wallet asks you to confirm a transaction."
    ],
    "steps": [
      "Press UpVote on a coin card on Coins, on a Featured card or on the coin page.",
      "Read the popup. It shows the price, fixed at 3 dollars and paid in the chain's own coin.",
      "Confirm the payment in your wallet. One transaction is one vote."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "how to upvote",
      "vote for coin",
      "upvote button",
      "upvote popup"
    ],
    "sources": [
      "docs-site/src/content/platform/upvotes.md:12-14",
      "frontend/src/components/token/UpvoteDialog.tsx:38-39,654"
    ]
  },
  {
    "slug": "upvote-price-and-limits",
    "q": "How much is an UpVote and is there a limit?",
    "a": [
      "An UpVote costs 3 dollars on every chain, paid in BNB, SOL or ETH. The popup converts the 3 dollars at the current price. The fee goes to MemeWarzone.",
      "A cooldown and daily limits apply to keep UpVotes fair. The popup tells you when you hit one."
    ],
    "keywords": [
      "upvote cost",
      "$3",
      "cooldown",
      "daily limit",
      "upvote limit"
    ],
    "alsoIn": [
      "fees"
    ],
    "sources": [
      "frontend/src/components/token/UpvoteDialog.tsx:38-39,694",
      "frontend/src/pages/Playbook.tsx:478"
    ],
    "needsReview": "The exact cooldown length and daily cap are not in the frontend code. Check the contract or API and add the numbers."
  },
  {
    "slug": "upvotes-and-safety",
    "q": "Does an UpVote mean a coin is safe?",
    "a": [
      "No. An UpVote does not certify a coin, remove risk or make other traders follow. Money spent on visibility is only visibility.",
      "Check the coin yourself: the official links, the holders and the wallet request. Be careful with links that offer to UpVote for you."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      }
    ],
    "keywords": [
      "upvote safe",
      "upvote scam",
      "trust upvotes",
      "endorsement"
    ],
    "alsoIn": [
      "safety"
    ],
    "sources": [
      "docs-site/src/content/platform/upvotes.md:20-32",
      "docs-site/src/content/fees/upvotes.md:30-34"
    ]
  },
  {
    "slug": "featured-lists-explained",
    "q": "What is the Featured list, and what is the Warzone Featured rail?",
    "a": [
      "Coins that are still on their bonding curve are ranked in the launchpad Featured list by UpVotes over a window you can pick: the last 24 hours, 7 days or all time.",
      "Graduated and imported coins have their own UpVotes, and they are featured in the Warzone overview. Each chain has its own list, because the Coins pages show one chain at a time."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      },
      {
        "href": "/warzone",
        "text": "Warzone overview"
      }
    ],
    "keywords": [
      "featured",
      "featured rail",
      "trending",
      "warzone featured",
      "ranking",
      "discovery"
    ],
    "sources": [
      "frontend/api/featured.js:10-16 (SORT_MAP: 24h, 7d, all)",
      "founder 2026-10-22 (launchpad Featured vs Warzone overview)",
      "docs-site/src/content/platform/chain-readiness.md:13-17"
    ],
    "needsReview": "Exact wording of the Warzone rail on the page."
  },
  {
    "slug": "apply-for-a-sponsorship",
    "q": "How do I advertise my project on MemeWarzone?",
    "a": [
      "You can apply for a paid ad spot. There are two: a banner tile in the row at the top of Home (up to 6 sponsors at once) and a Sponsored card in the Featured row on Coins. Each spot has its own packages and prices.",
      "Use the Your ad here tile on Home, Advertise here in the Featured row, or the application page. A sponsored spot is paid visibility, not an endorsement."
    ],
    "steps": [
      "Open the application and fill in your project name, contact, website, short bio and a creative image.",
      "Pick a package and your preferred dates.",
      "Send it. The team reviews your project and creative.",
      "After approval you get payment details. The spot goes live after payment."
    ],
    "links": [
      {
        "href": "/sponsorships/apply",
        "text": "Apply for a spot"
      }
    ],
    "keywords": [
      "sponsorship",
      "advertise",
      "ad spot",
      "banner",
      "sponsored",
      "marketing"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/arena/sponsorships.md"
    ]
  },
  {
    "slug": "after-sponsorship-application",
    "q": "What happens after I apply for a sponsorship?",
    "a": [
      "Applying starts a review. It does not book the spot, and no payment is due yet. The team checks the project and the creative, confirms the dates and then sends payment details.",
      "Make sure the bio, image and dates are final before you send the form. Your draft is saved in your browser until you submit. Only pay what the team confirms. Nobody from MemeWarzone asks for payment in a direct message."
    ],
    "links": [
      {
        "href": "/sponsorships/apply",
        "text": "Apply for a spot"
      }
    ],
    "keywords": [
      "sponsorship review",
      "ad approved",
      "payment reference",
      "sponsor status"
    ],
    "sources": [
      "docs-site/src/content/arena/sponsorships.md:30-45"
    ]
  },
  {
    "slug": "story-pages",
    "q": "What is a Story page?",
    "a": [
      "A Story is a full-screen page for one coin, in the style of social stories. It has chapters written by the creator and an automatic chronicle built from real data. The creator cannot edit the chronicle. A launched coin can have up to 10 chapters and an imported coin up to 8.",
      "Every Story has a share link. When you post that link on X, it shows a preview card with the coin's picture."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "story",
      "story mode",
      "coin story",
      "chronicle",
      "chapters",
      "/s/ link"
    ],
    "popular": true,
    "sources": [
      "docs/claude/story-mode.md",
      "frontend/shared/storyContract.mjs"
    ]
  },
  {
    "slug": "share-a-coin-link",
    "q": "How do I share a coin so people land on the right page?",
    "a": [
      "Share the MemeWarzone coin page link. It carries the chain, so the person lands on the right coin. If you share a bare address, say which chain it is on.",
      "A Story share link gives X a preview card. In posts on MemeWarzone, paste the contract address and it turns into a coin card with a Buy button. Each post also has a Share menu with Copy link and Share on X."
    ],
    "links": [
      {
        "href": "/coins",
        "text": "Browse coins"
      }
    ],
    "keywords": [
      "share",
      "share link",
      "share card",
      "preview",
      "twitter card",
      "promote my coin"
    ],
    "alsoIn": [
      "social"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:52-56",
      "docs-site/src/content/social/posting.md:35-45,76-80",
      "docs/claude/story-mode.md"
    ]
  },
  {
    "slug": "prepare-page-and-push-live",
    "q": "How do drafts, the Prepare page and Push Live help promote a launch?",
    "a": [
      "A draft can have a public Prepare page. People can read it, follow it and comment before trading opens. Use that time to settle your links, logo, message and launch time.",
      "Push Live is the last step. It turns a prepared draft into a live launch. If the launch is scheduled, trading can open up to 30 days later. Do not push live while links or timing are still changing."
    ],
    "links": [
      {
        "href": "/create",
        "text": "Create a coin"
      }
    ],
    "keywords": [
      "prepare mode",
      "draft",
      "push live",
      "scheduled launch",
      "launch countdown"
    ],
    "alsoIn": [
      "create"
    ],
    "sources": [
      "docs-site/src/content/creators/promotion-and-push-live.md",
      "frontend/shared/evmGen8.mjs:338-339"
    ]
  },
  {
    "slug": "swap-box-for-your-website",
    "q": "Can I put a buy and sell box on my own website?",
    "a": [
      "Yes, for Solana coins. The swap box lets visitors buy and sell from your site with their own wallet. You paste a few lines of code into a Custom HTML block. It works for coins launched on MemeWarzone while they are on the curve and for imported coins.",
      "Imported coin swaps pay 1%, of which 0.5% goes to the coin's creator. A launched coin pays the normal fees. The box shows the fee before anyone confirms."
    ],
    "links": [
      {
        "href": "https://docs.memewar.zone/creators/swap-widget",
        "text": "Swap box guide"
      }
    ],
    "keywords": [
      "widget",
      "embed",
      "swap widget",
      "website",
      "mwz-swap",
      "iframe"
    ],
    "alsoIn": [
      "imports",
      "create"
    ],
    "sources": [
      "docs-site/src/content/creators/swap-widget.md"
    ],
    "needsReview": "The founder's memory notes say the same script also serves gen-8 BNB and Robinhood coins (checked 2026-10-22), but the public guide still says BNB Chain and Robinhood Chain come later."
  },
  {
    "slug": "kick-live-streams",
    "q": "Can I stream live on my MemeWarzone profile?",
    "a": [
      "Live streams from Kick can show on a profile, with a flashing red LIVE tab after Posts while the channel is live. At the moment only one partner profile has this. There is no setting yet for other users to add their own stream.",
      "The stream plays in Kick's own player, so Kick sets cookies when it loads. MemeWarzone asks for cookie consent first. If you decline, the stream stays off and you can watch on kick.com instead."
    ],
    "keywords": [
      "live stream",
      "kick",
      "stream on profile",
      "live tab",
      "streamer"
    ],
    "alsoIn": [
      "social"
    ],
    "sources": [
      "frontend/shared/profileStreams.mjs:6-9",
      "frontend/src/components/profile/ProfileLiveStream.tsx:20-60",
      "frontend/src/pages/PublicProfile.tsx:774"
    ],
    "needsReview": "Confirm the founder still wants this described as partner-only and whether coin pages get streams."
  },
  {
    "slug": "post-updates-as-your-coin",
    "q": "How can a creator keep holders informed?",
    "a": [
      "The owner of a coin can post updates as the coin from the Posts tab of its coin page. An update is up to 280 characters with up to 4 images. It shows the coin's logo and a Creator update label. Tick Also in the home feed to share it more widely.",
      "The coin page also posts automatic updates for the launch, graduation and battles. Owners can turn those off on the edit page. Battles, UpVotes and league pushes are the other ways to get attention."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "creator update",
      "post as coin",
      "announce",
      "update holders",
      "coin page"
    ],
    "alsoIn": [
      "social",
      "create"
    ],
    "sources": [
      "docs-site/src/content/social/creator-updates.md"
    ]
  },
  {
    "slug": "upvote-vs-boost",
    "q": "What is the difference between an UpVote and a Boost?",
    "a": [
      "An UpVote is a 3 dollar push for a coin's visibility in lists and the Crowd Favorite league. A Boost is a 1 dollar vote inside a battle. It adds 1 point for the coin you back in that battle.",
      "A wallet can Boost twice per battle, and Boosts close when the last 20% of the battle starts. UpVotes have a cooldown and daily limits."
    ],
    "links": [
      {
        "href": "/warzone/battles",
        "text": "See battles"
      }
    ],
    "keywords": [
      "upvote vs boost",
      "boost",
      "battle vote",
      "difference"
    ],
    "alsoIn": [
      "battles"
    ],
    "sources": [
      "frontend/api/lib/arenaBoostRules.js:60",
      "frontend/src/components/token/UpvoteDialog.tsx:39",
      "docs-site/src/content/arena/live-battles.md"
    ]
  }
];
