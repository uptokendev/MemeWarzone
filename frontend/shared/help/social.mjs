// Help Center articles: social. Shape and copy rules: shared/helpContent.mjs.

export default [
  {
    "slug": "set-up-your-profile",
    "q": "How do I set up my profile?",
    "a": [
      "Every wallet has one public profile. Open Command Center, then Edit profile, or press Edit on your own profile. You can set a picture, a banner, a display name, an @username, a bio of up to 280 characters, and links to your website, X and Telegram.",
      "Press Save profile. Your wallet signs a message to prove it is you. This is not a transaction and costs no fee. Without a picture, your profile shows the default green operative."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "edit profile",
      "profile picture",
      "avatar",
      "bio",
      "banner",
      "display name"
    ],
    "popular": true,
    "alsoIn": [
      "getting-started"
    ],
    "sources": [
      "docs-site/src/content/social/profiles.md:30-55"
    ]
  },
  {
    "slug": "username-rules",
    "q": "How do usernames work?",
    "a": [
      "Your @username is how people tag you in posts. It has 3 to 20 characters: letters, numbers and underscore. It is unique and case does not matter, so Trader and trader are the same name. Some names, such as admin, support and memewarzone, are reserved.",
      "You can change it once every 30 days. Setting or changing it asks for a wallet signature, with no fee. Without a username nobody can tag you. Your profile also opens at /profile/yourname."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "username",
      "handle",
      "@name",
      "change username",
      "reserved names",
      "tag me"
    ],
    "sources": [
      "docs-site/src/content/social/profiles.md:14-26"
    ]
  },
  {
    "slug": "one-profile-on-every-chain",
    "q": "Do I need a separate profile for each chain?",
    "a": [
      "No. A profile belongs to a wallet, and its picture, name, @username and bio show on every chain. An EVM wallet address is the same on BNB Chain and Robinhood Chain, so one profile covers both. A Solana wallet has its own address and its own profile.",
      "Social features work across chains. You can follow any coin or wallet on any chain. Only buying and selling depends on the chain you picked."
    ],
    "keywords": [
      "multichain profile",
      "same profile",
      "bnb solana profile",
      "two wallets"
    ],
    "alsoIn": [
      "wallets",
      "getting-started"
    ],
    "sources": [
      "docs-site/src/content/platform/chain-readiness.md:50-52",
      "docs-site/src/content/social/profiles.md:6"
    ]
  },
  {
    "slug": "write-a-post",
    "q": "How do I write a post and add images?",
    "a": [
      "Use the composer at the top of Home or on your own profile. A post can be up to 1,000 characters. The feed shows the first 280 characters with a Read more link. You can add up to 4 images, each PNG, JPG or WebP up to 5 MB.",
      "Paste a coin's contract address and it turns into a coin card with the price and a Buy button. Type @ and the first letters of a name to tag someone who has a username."
    ],
    "steps": [
      "Connect your wallet.",
      "Type your post in the composer. Use the image button to add up to 4 images.",
      "Press Post. The first time, your wallet asks for one free signature."
    ],
    "links": [
      {
        "href": "/",
        "text": "Go to Home"
      }
    ],
    "keywords": [
      "post",
      "create post",
      "images in post",
      "tweet",
      "composer",
      "1000 characters"
    ],
    "popular": true,
    "sources": [
      "docs-site/src/content/social/posting.md:8-40"
    ]
  },
  {
    "slug": "replies-reposts-quotes-rockets",
    "q": "What are reposts, quote posts and rockets?",
    "a": [
      "A rocket is your like. Tap it again to take it back. Repost puts a post in your followers' feeds and on your profile. Quote post lets you add your own text and up to 4 images on top of someone else's post. Reply opens the post page where you write an answer.",
      "Share has Copy link and Share on X. Views count a unique viewer once per post."
    ],
    "keywords": [
      "repost",
      "quote",
      "rocket",
      "like",
      "reply",
      "retweet"
    ],
    "sources": [
      "docs-site/src/content/social/posting.md:42-70"
    ]
  },
  {
    "slug": "follow-coins-and-wallets",
    "q": "What can I follow, and on which chains?",
    "a": [
      "You can follow any wallet and any coin, on any chain. Press Follow on a profile or a coin page. Their posts, reposts and coin updates then show in the Following tab on Home. You need a connected wallet to follow, but no extra signature.",
      "You can also follow a draft before the coin exists. Followers and following lists are on your profile, and tapping a count opens the list."
    ],
    "links": [
      {
        "href": "/",
        "text": "Go to Home"
      }
    ],
    "keywords": [
      "follow",
      "unfollow",
      "following tab",
      "followers",
      "follow coin"
    ],
    "sources": [
      "docs-site/src/content/social/profiles.md:68-72",
      "docs-site/src/content/social/home-feed.md:54-62",
      "docs-site/src/content/social/signing.md:57-59",
      "founder 2026-10-14 (social is chainless, PR #589)",
      "frontend/src/lib/helpCenter.ts:161 (follow a draft before it exists)"
    ]
  },
  {
    "slug": "notifications-and-email",
    "q": "What notifications do I get, and can I turn them off?",
    "a": [
      "The bell in the top bar shows the latest ones, and View all opens Command Center, then Notifications. You are notified about replies, quotes, reposts, rockets, mentions and follows, about battle challenges, about rewards ready to claim and about events on coins you created.",
      "Open Command Center, then Settings, then Notification settings. Each of the four categories has a Bell switch and an Email switch. Email works only after you add an address and open the link we send. Saving asks for a free wallet signature."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "notifications",
      "bell",
      "email alerts",
      "mark as read",
      "turn off notifications"
    ],
    "sources": [
      "docs-site/src/content/social/notifications.md",
      "docs-site/src/content/command-center/notifications.md"
    ]
  },
  {
    "slug": "sign-once-for-30-days",
    "q": "Do I have to sign every post, rocket or chat message?",
    "a": [
      "No. The first time you post, reply or react, your wallet asks for one signature. It covers posts, replies, reposts, rockets, deleting your own posts, comments, War Room chat, reports, hide and block, and creator updates for 30 days.",
      "A signature is a message, not a transaction. It costs no gas, moves no funds and gives nobody access to your money. The message starts with MemeWarzone API Action. If a prompt asks you to approve a transaction or spend tokens when you only wanted to post, reject it.",
      "The signature is kept in this browser. On another browser or device, or with another wallet, you sign once more. Payments, claims, votes and challenges ask each time."
    ],
    "links": [
      {
        "href": "/about",
        "text": "About MemeWarzone"
      }
    ],
    "keywords": [
      "signature",
      "sign message",
      "30 days",
      "free signature",
      "sign in once"
    ],
    "popular": true,
    "alsoIn": [
      "wallets",
      "safety"
    ],
    "sources": [
      "docs-site/src/content/social/signing.md",
      "founder 2026-10 (signatures only for money, PR #526)"
    ]
  },
  {
    "slug": "delete-a-post",
    "q": "Can I delete my own post?",
    "a": [
      "Yes. Open the three dots menu on your own post or reply and choose Delete post or Delete reply. You are asked to confirm. A deleted post disappears from the feed, your profile and search. This cannot be undone.",
      "Copies others made elsewhere, such as a screenshot or a share on X, are not removed."
    ],
    "keywords": [
      "delete post",
      "remove post",
      "undo post",
      "delete reply"
    ],
    "sources": [
      "docs-site/src/content/social/posting.md:100-102"
    ]
  },
  {
    "slug": "report-hide-and-block",
    "q": "How do I report, hide or block someone?",
    "a": [
      "Every post, reply, comment and profile has a three dots menu. It offers Report, Hide for single posts and comments, and Block for accounts. Hide and Block only change what you see. Report goes to the team, who review every report.",
      "To report, describe what is wrong in 20 to 1,000 characters and press Send report. Follow your reports in Command Center, then Support and safety, then My Abuse Reports. To unblock someone, open Settings and use the Blocked accounts card.",
      "For impersonation or stolen identity, use File Abuse Report on the Support and safety page."
    ],
    "links": [
      {
        "href": "/profile",
        "text": "Open your profile"
      }
    ],
    "keywords": [
      "block",
      "report user",
      "hide post",
      "mute",
      "abuse",
      "harassment"
    ],
    "alsoIn": [
      "safety"
    ],
    "sources": [
      "docs-site/src/content/social/safety.md",
      "docs-site/src/content/command-center/support.md"
    ]
  },
  {
    "slug": "what-is-public-about-my-wallet",
    "q": "What can other people see about my wallet?",
    "a": [
      "Blockchains are public. Anyone can look up a wallet address in an explorer and see its balances and transactions. MemeWarzone cannot hide that. Your profile page shows the address, your coin holdings and your activity, such as launches and trades.",
      "You can shape the holdings lists in Command Center, then Settings, then Portfolio display. You can hide native coins and stablecoins and holdings under 1 dollar. These settings only change the lists, not your real balances or your total value.",
      "No account or email is needed to use MemeWarzone. Your wallet is your identity. MemeWarzone never asks for your seed phrase or private key."
    ],
    "keywords": [
      "privacy",
      "public wallet",
      "who can see",
      "anonymous",
      "hide holdings",
      "portfolio display"
    ],
    "alsoIn": [
      "safety",
      "wallets"
    ],
    "sources": [
      "docs-site/src/content/social/profiles.md:57-100",
      "docs-site/src/content/command-center/settings.md:26"
    ],
    "needsReview": "Which profile tabs (Portfolio, Activity) are public to all visitors, and the privacy policy wording."
  },
  {
    "slug": "profile-live-tab",
    "q": "What is the LIVE tab on a profile?",
    "a": [
      "A profile can show a LIVE tab after Posts while its owner is streaming on Kick. The tab flashes red. It plays Kick's own player and chat. Right now this is only set up for one partner profile.",
      "Kick sets cookies when the player loads, so MemeWarzone asks for cookie consent before it plays. Declining keeps the player off and you can open the stream on kick.com."
    ],
    "keywords": [
      "live tab",
      "kick stream",
      "streamer",
      "watch live",
      "cookie banner"
    ],
    "alsoIn": [
      "promotion"
    ],
    "sources": [
      "frontend/src/pages/PublicProfile.tsx:774",
      "frontend/src/components/profile/ProfileLiveStream.tsx",
      "frontend/shared/profileStreams.mjs:6-9"
    ]
  },
  {
    "slug": "coin-comments-and-chat",
    "q": "What is the difference between comments and the War Room chat?",
    "a": [
      "Every coin page has a Posts tab with the owner's updates, automatic updates and comments. The War Room is a live chat for that coin. Anyone can read both without a wallet. To post, connect and sign once.",
      "Prepare pages for drafts have comments instead of a live chat. Moderation removes obvious spam, phishing links and impersonation, but it cannot make every message safe."
    ],
    "keywords": [
      "comments",
      "chat",
      "war room",
      "coin comments",
      "token chat"
    ],
    "alsoIn": [
      "trading"
    ],
    "sources": [
      "docs-site/src/content/platform/war-room.md",
      "docs-site/src/content/social/creator-updates.md:6-8"
    ]
  },
  {
    "slug": "post-views-counted",
    "q": "How are views on a post counted?",
    "a": [
      "A view counts when a post is at least half on screen for about one second, or when you open its page. Each viewer counts once per post. A wallet that signed in for social actions counts once, and everyone else counts once per IP address.",
      "Opening the same post again does not add views."
    ],
    "keywords": [
      "views",
      "view count",
      "impressions",
      "unique views"
    ],
    "sources": [
      "docs-site/src/content/social/posting.md:88-96"
    ]
  },
  {
    "slug": "home-feed-tabs",
    "q": "What do the tabs on Home show?",
    "a": [
      "For you shows posts, reposts, creator updates, launches, graduations and battles, newest first. Following shows only wallets you follow, with chips for People, Coins and Auto updates. Launches, Battles and Graduations filter by type for the chain you picked.",
      "Posts with a Taking off label collected reactions fast in the last 48 hours. On phones the extra cards, such as Trending and League, move into tabs."
    ],
    "links": [
      {
        "href": "/",
        "text": "Go to Home"
      }
    ],
    "keywords": [
      "home feed",
      "for you",
      "following",
      "taking off",
      "feed tabs"
    ],
    "sources": [
      "docs-site/src/content/social/home-feed.md"
    ]
  }
];
