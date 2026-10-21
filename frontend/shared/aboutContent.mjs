// About page copy, shared by the app page (src/pages/About.tsx) and the API renderer (api/seoRender.js),
// so crawlers that do not run JavaScript read the same text people see. Pure module: no DOM, no I/O.
//
// Every fact is read from code or docs on 2026-10-21. Update this file when one of these changes:
// - chains, graduation: docs-site/src/content/platform/graduation.md. DEX per chain (founder, 2026-10-21): Uniswap V4 on
//   BNB Chain and Robinhood Chain, Meteora on Solana. Graduated and imported coins can battle (founder, 2026-10-21).
// - battle modes, clocks, points: api/lib/arenaBattleMode.js; Boost rules: api/lib/arenaBoostRules.js
// - Boost split 90/10: api/lib/arenaBoostRuntime.mjs (BOOST_POOL_BPS, BOOST_PROTOCOL_BPS)
// - leagues, MWL, airdrops: docs-site/src/content/leagues/*, arena/major-war-league.md, rewards/warzone-airdrops.md
// - UpVote price $3: src/components/token/UpvoteDialog.tsx, api/arenaVotes.js; launchpad Featured: api/featured.js;
//   Warzone Featured rail: src/pages/Arena.tsx (useArenaFeaturedVotes)
// - imports and claims: docs-site/src/content/creators/imported-coins.md
// - legal: docs-site/src/content/legal/terms-of-service.md; socials: src/constants/navigation.ts
// Copy rule: plain sentences, concrete facts, no dashes used as punctuation.

export const ABOUT_PATH = "/about";

export const ABOUT_TITLE = "About MemeWarzone";

export const ABOUT_DESCRIPTION =
  "MemeWarzone is a memecoin launchpad on BNB Chain, Solana and Robinhood Chain. Coins launch on a bonding curve, graduate to a DEX and battle.";

export const ABOUT_INTRO = [
  "MemeWarzone is a memecoin launchpad with a social feed and a battle arena. It runs on BNB Chain, Solana and Robinhood Chain, and each coin lives on one chain.",
  "Coins launch on a bonding curve and graduate to a DEX pool with locked liquidity. Graduated coins, and coins imported from other launchpads, can then fight other coins in battles, tournaments and leagues.",
  "MemeWarzone is a crypto platform. It has no connection to Call of Duty: Warzone or any other game.",
];

/**
 * @typedef {{ href: string, text: string }} AboutLink
 * Render order: paragraphs, items, note, links.
 * @typedef {{ id: string, heading: string, paragraphs?: string[], items?: string[], note?: string, links?: AboutLink[] }} AboutSection
 * @type {AboutSection[]}
 */
export const ABOUT_SECTIONS = [
  {
    id: "coin-life",
    heading: "How a coin's life works",
    items: [
      "Launch: a creator picks a chain, sets the name, ticker, image and story, and deploys the coin on a bonding curve. No code is needed.",
      "Trade: anyone can buy and sell on the curve from the coin page. The price rises as the curve fills.",
      "Graduate: when the curve sells out, the liquidity moves into a DEX pool and is locked for good. On BNB Chain and Robinhood Chain that pool is on Uniswap V4, on Solana it is on Meteora.",
      "Compete: a graduated or imported coin can battle other coins in the Warzone and earn points in the leagues.",
    ],
    note: "On Solana, new coins launch on a Meteora Dynamic Bonding Curve, so they can be traded through Jupiter before they graduate.",
    links: [
      { href: "/create", text: "Launch a coin" },
      { href: "/coins", text: "Browse coins" },
      { href: "/playbook", text: "Read the Playbook" },
    ],
  },
  {
    id: "battles",
    heading: "Battles",
    paragraphs: [
      "A battle puts two coins against each other for a set time. The Warzone runs two kinds.",
    ],
    items: [
      "Metrics battles last 24 hours, 3 days or 7 days. They are scored on market cap, holders, volume and Boost points.",
      "Vote battles last 1, 6, 12, 24 or 48 hours. Every free vote counts 1 point and every Boost counts 1 point. A tie goes to Final Salvo, a short tie-breaker.",
      "A wallet can Boost twice per battle. Boosts close when the last 20% of the battle clock starts.",
      "90% of the money spent on Boosts goes into the war pool, which the winning coin takes. The other 10% goes to MemeWarzone.",
      "Prizes are not paid automatically. The owner of the winning coin claims them from the Command Center.",
    ],
    links: [
      { href: "/warzone/battles", text: "See live battles" },
      { href: "/warzone/tournaments", text: "Tournaments" },
    ],
  },
  {
    id: "leagues",
    heading: "Leagues and rewards",
    items: [
      "Weekly and monthly leagues rank coins and players in six categories: Perfect Run, Fastest Finish, Biggest Hit, Top Earner, Crowd Favorite and Recruiter League. A league week starts on Monday at 00:00 UTC.",
      "The Major War League ranks graduated coins by battle points. It is funded by 20% of battle buy-ins, and the top 8 coins play the quarterly finals.",
      "Part of every trading fee goes to the league prize pools.",
      "Weekly airdrops on each chain reward active traders and creators whose coins draw real buyers.",
      "Prizes are paid in the chain's own coin and claimed from the Command Center.",
    ],
    links: [
      { href: "/league", text: "League standings" },
      { href: "/warzone/major-war-league", text: "Major War League" },
      { href: "/airdrops", text: "Airdrops" },
    ],
  },
  {
    id: "creators",
    heading: "For creators",
    items: [
      "Creators earn a share of the trading fees on their coin, before and after graduation.",
      "Each coin has a Story: a full-screen page with the creator's own chapters and an automatic chronicle of the coin.",
      "UpVotes cost $3 each and move a coin up a Featured list. Coins still on their curve are featured on the launchpad. Graduated and imported coins have their own UpVotes and are featured in the Warzone overview.",
      "Coins that finished bonding on another launchpad, such as Pump.fun or Four.meme, can be imported. The owner claims an imported coin by wallet verification, by logging in with X, or through a manual review.",
    ],
    links: [
      { href: "https://docs.memewar.zone/fees", text: "Fees and fee split" },
    ],
  },
  {
    id: "recruiters",
    heading: "Recruiters and squads",
    paragraphs: [
      "Recruiters bring traders to MemeWarzone with a referral link and earn a share of the trading fees of the wallets they bring in. A squad is a group of traders around a recruiter. Squad members share a squad pool after each league period. Fair-play checks apply to both.",
    ],
    links: [
      { href: "/recruiters", text: "Recruiter leaderboard" },
      { href: "/squads", text: "Squad leaderboard" },
    ],
  },
  {
    id: "social",
    heading: "Profiles and the feed",
    paragraphs: [
      "Every wallet has one profile, and it is the same on every chain. You can post, repost, quote, react and follow any coin or wallet on any chain. Only buying and selling depend on the chain you have selected.",
    ],
  },
  {
    id: "safety",
    heading: "How your money is handled",
    items: [
      "Buys and sells go from your wallet to the coin's contract. MemeWarzone does not hold your coins.",
      "Trading fees are split inside the same transaction as the trade.",
      "The BNB Chain and Robinhood Chain contracts are owned by a Safe multisig and cannot be changed after deployment. The Solana programs can only be upgraded through a Squads multisig.",
      "Protocol earnings above a fixed cap move to a multisig wallet.",
    ],
  },
  {
    id: "company",
    heading: "Who runs MemeWarzone",
    paragraphs: [
      "MemeWarzone is operated under Dutch law. You must be 18 or older to use it. Legal questions go to legal@memewar.zone.",
    ],
    links: [
      { href: "https://x.com/memewarzone", text: "X" },
      { href: "https://t.me/memewarzonehq", text: "Telegram" },
      { href: "https://discord.gg/aXTkn3Asu", text: "Discord" },
      { href: "https://docs.memewar.zone", text: "Docs" },
      { href: "https://docs.memewar.zone/legal/terms-of-service", text: "Terms of Service" },
      { href: "https://docs.memewar.zone/legal/privacy-policy", text: "Privacy Policy" },
    ],
  },
];

/** JSON-LD for /about. The Organization itself lives in frontend/index.html (@id below). */
export function aboutJsonLd(origin = "https://app.memewar.zone") {
  const url = `${origin}${ABOUT_PATH}`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      name: ABOUT_TITLE,
      url,
      description: ABOUT_DESCRIPTION,
      about: { "@id": "https://memewar.zone/#organization" },
      isPartOf: { "@id": `${origin}/#website` },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "MemeWarzone", item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: "About", item: url },
      ],
    },
  ];
}
