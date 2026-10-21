// About page copy, shared by the app page (src/pages/About.tsx) and the API renderer (api/seoRender.js),
// so crawlers that do not run JavaScript read the same text people see. Pure module: no DOM, no I/O.
//
// Every fact is read from code, docs or chain, or given by the founder, on 2026-10-21. Update this file when one changes:
// - chains, graduation: docs-site/src/content/platform/graduation.md. DEX per chain (founder): Uniswap V4 on BNB Chain and
//   Robinhood Chain, Meteora on Solana. Graduated and imported coins can battle (founder). DogeOS line: founder, verified
//   by DogeOS and MyDoge Wallet. Roadmap (Interchained DEX in two steps) and team: founder, 2026-10-21.
// - battle modes, clocks, points: api/lib/arenaBattleMode.js; Boost rules: api/lib/arenaBoostRules.js; Boost $1:
//   docs-site arena/live-battles.md; buy-in flow and 75/20/5: arena/live-battles.md, arena/war-pools.md
// - Boost split 90/10: api/lib/arenaBoostRuntime.mjs (BOOST_POOL_BPS, BOOST_PROTOCOL_BPS)
// - leagues: src/lib/leagues.ts, docs-site leagues/categories.md, leagues/epochs-and-prizes.md; MWL: arena/major-war-league.md
// - airdrops: docs-site rewards/warzone-airdrops.md; squad pool: rewards/squad-pool.md
// - fees: 2% curve fee (shared/evmGen8.mjs GEN8_RATES.bondingBps), creator 5.6% (creatorBondingBps 560), older coins 5%:
//   docs-site creators/creator-earnings.md; recruiter 12.5%/15%, OG 15%/17.5%: fees/fee-routing.md, fees/where-fees-go.md;
//   imports 1% = 0.5% creator + 0.5% MemeWarzone on every chain (founder)
// - UpVote price $3: src/components/token/UpvoteDialog.tsx, api/arenaVotes.js; launchpad Featured: api/featured.js;
//   Warzone Featured rail: src/pages/Arena.tsx (useArenaFeaturedVotes)
// - contracts: Solana program ids and gen-8 addresses as baked into the live app (VITE_SOLANA_*_PROGRAM_ID,
//   VITE_EVM_GEN8_*); owners read on chain 2026-10-21 (gen-8 launcher owner is a Safe on 56 and 4663). Audit: pending (founder).
// - imports and claims: docs-site creators/imported-coins.md; legal: legal/terms-of-service.md; socials: src/constants/navigation.ts
// Copy rule: plain sentences, concrete facts, no slogans, no dashes used as punctuation.
// Images under /assets/about/ are small WebP copies of the app's own art in public/assets.

export const ABOUT_PATH = "/about";

export const ABOUT_TITLE = "About MemeWarzone";

export const ABOUT_DESCRIPTION =
  "MemeWarzone is a memecoin launchpad on BNB Chain, Solana and Robinhood Chain. Coins launch on a bonding curve, graduate to a DEX and battle.";

export const ABOUT_INTRO = [
  "MemeWarzone is a memecoin launchpad with a social feed and a battle arena. It runs on BNB Chain, Solana and Robinhood Chain, and each coin lives on one chain.",
  "Coins launch on a bonding curve and graduate to a DEX pool with locked liquidity. Graduated coins, and coins imported from other launchpads, can then fight other coins in battles, tournaments and leagues.",
];

export const ABOUT_DISAMBIGUATION = "MemeWarzone is a crypto platform. It has no connection to Call of Duty: Warzone or any other game.";

export const ABOUT_CHAINS = ["BNB Chain", "Solana", "Robinhood Chain"];

/** The next chain, shown next to the live chains. */
export const ABOUT_NEXT_CHAIN = {
  name: "DogeOS",
  label: "Coming soon",
  text: "MemeWarzone is among the first launchpads invited onto DogeOS, which targets about 500,000 existing wallets.",
};

/** Quick facts under the hero. */
export const ABOUT_HIGHLIGHTS = [
  { value: "3 chains", label: "BNB Chain, Solana and Robinhood Chain, with DogeOS next" },
  { value: "1 to 48 hours", label: "Vote battle clocks" },
  { value: "90%", label: "of Boost money goes to the winning coin" },
  { value: "$3", label: "per UpVote to get featured" },
];

export const ABOUT_HERO_LINKS = [
  { href: "/create", text: "Launch a coin" },
  { href: "/coins", text: "Browse coins" },
  { href: "/warzone", text: "Enter the Warzone" },
];

const solscan = (a) => `https://solscan.io/account/${a}`;
const bscscan = (a) => `https://bscscan.com/address/${a}`;
const rhscan = (a) => `https://robinhoodchain.blockscout.com/address/${a}`;

/**
 * @typedef {{ href: string, text: string }} AboutLink
 * @typedef {{ title: string, text: string }} AboutPoint
 * @typedef {{ title: string, segments: { pct: number, label: string }[] }} AboutSplit
 * @typedef {{ chain: string, audit: string, entries: { label: string, address: string, href: string }[] }} AboutContracts
 * Render order in both the page and the renderer:
 *   lead, steps, chips, modes, splits, items, categories, members, contracts, qa, note, links.
 * @typedef {{
 *   id: string, nav: string, heading: string, lead?: string, image?: string,
 *   steps?: AboutPoint[], chipsLabel?: string, chips?: string[],
 *   modes?: { name: string, durations: string[], text: string }[], splits?: AboutSplit[],
 *   items?: string[], categories?: { name: string, text: string, image: string }[],
 *   members?: { name: string, role: string }[], contracts?: AboutContracts[], qa?: { q: string, a: string }[],
 *   note?: string, links?: AboutLink[]
 * }} AboutSection
 * @type {AboutSection[]}
 */
export const ABOUT_SECTIONS = [
  {
    id: "coin-life",
    nav: "A coin's life",
    heading: "How a coin's life works",
    steps: [
      { title: "Launch", text: "A creator picks a chain, sets the name, ticker, image and story, and deploys the coin on a bonding curve. No code is needed, and there is no platform fee to create a coin." },
      { title: "Trade", text: "Anyone can buy and sell on the curve from the coin page. The price rises as the curve fills. A launch fee starts at 90% and falls to 2% over the first 60 seconds, to stop snipers." },
      { title: "Graduate", text: "When the coin reaches its market cap target, $30K or $50K as the creator picked, the liquidity moves into a DEX pool and is locked for good. On BNB Chain and Robinhood Chain that pool is on Uniswap V4, on Solana it is on Meteora." },
      { title: "Compete", text: "A graduated or imported coin can battle other coins in the Warzone and earn points in the leagues." },
    ],
    chipsLabel: "Graduates to",
    chips: ["BNB Chain: Uniswap V4", "Robinhood Chain: Uniswap V4", "Solana: Meteora"],
    note: "On Solana, new coins launch on a Meteora Dynamic Bonding Curve, so they can be traded through Jupiter before they graduate.",
    links: [
      { href: "/create", text: "Launch a coin" },
      { href: "/playbook", text: "Read the Playbook" },
    ],
  },
  {
    id: "battles",
    nav: "Battles",
    heading: "Battles",
    lead: "A battle puts two coins against each other for a set time. One coin's owner challenges another, and both agree on the type, the buy-in and the length. Each side pays the buy-in once both have agreed. The Warzone runs two kinds of battle.",
    image: "/assets/about/battles-bg.webp",
    modes: [
      {
        name: "Metrics battle",
        durations: ["24 hours", "3 days", "7 days"],
        text: "Scored on changes in market cap, holders, volume and Boost points.",
      },
      {
        name: "Vote battle",
        durations: ["1 hour", "6 hours", "12 hours", "24 hours", "48 hours"],
        text: "Every wallet has one free vote worth 1 point. A Boost costs $1 and adds 1 point. A tie goes to Final Salvo, a short tie-breaker.",
      },
    ],
    splits: [
      {
        title: "Where the buy-ins go",
        segments: [
          { pct: 75, label: "Winning coin's owner" },
          { pct: 20, label: "Major War League" },
          { pct: 5, label: "MemeWarzone" },
        ],
      },
      {
        title: "Where Boost money goes",
        segments: [
          { pct: 90, label: "War pool, taken by the winning coin" },
          { pct: 10, label: "MemeWarzone" },
        ],
      },
    ],
    items: [
      "A wallet can Boost twice per battle. Boosts close when the last 20% of the battle clock starts.",
      "Prizes are not paid automatically. The owner of the winning coin claims them from the Command Center.",
      "Tournaments run brackets with free votes and Boosts in every matchup. Some matchups end in a Final Salvo, where only free votes count, one per wallet per shot.",
    ],
    links: [
      { href: "/warzone/battles", text: "See live battles" },
      { href: "/warzone/tournaments", text: "Tournaments" },
    ],
  },
  {
    id: "leagues",
    nav: "Leagues",
    heading: "Leagues and rewards",
    lead: "Weekly and monthly leagues rank coins and players in six categories. A weekly league runs from Monday 00:00 UTC to the next Monday. A monthly league runs from the first day of the month at 00:00 UTC to the first day of the next month.",
    categories: [
      { name: "Perfect Run", text: "Coins that graduated with no sells on the curve. Monthly only.", image: "/assets/about/perfectrun.webp" },
      { name: "Fastest Finish", text: "The shortest time from launch to graduation.", image: "/assets/about/fastestfinish.webp" },
      { name: "Biggest Hit", text: "The largest single buy on a bonding curve.", image: "/assets/about/biggesthit.webp" },
      { name: "Top Earner", text: "Trader profit and loss inside the bonding curve.", image: "/assets/about/topearner.webp" },
      { name: "Crowd Favorite", text: "UpVotes from unique voters.", image: "/assets/about/crowdfavorite.webp" },
      { name: "Recruiter League", text: "Referral score across all chains.", image: "/assets/about/logo.webp" },
    ],
    items: [
      "When enough entrants qualify, at least the top 3 of a weekly league and the top 5 of a monthly league are paid. With more entrants, more ranks are paid.",
      "The Major War League ranks graduated coins by battle points. It is funded by 20% of battle buy-ins, and the top 8 coins play the quarterly finals.",
      "Weekly airdrops on each chain reward active traders and creators whose coins draw real buyers. Eligibility looks at trading volume, the number of trades and activity on more than one day. The exact thresholds are not published.",
      "Creator self-buys do not count for airdrops and flagged wallets are excluded. A winner sits out for 14 days. The airdrop week closes on Monday at 00:00 UTC, and unclaimed airdrops return to the pot after 60 days.",
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
    nav: "Creators",
    heading: "For creators",
    image: "/assets/about/upvote_image.webp",
    items: [
      "Every buy and sell on the bonding curve pays a 2% fee. The creator gets 5.6% of it, which is 0.112% of every trade. Coins launched before October 2026 earn 5%, which is 0.10%.",
      "Imported coins pay a 1% swap fee on MemeWarzone: 0.5% to the coin's creator and 0.5% to MemeWarzone, on every chain.",
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
    nav: "Recruiters",
    heading: "Recruiters and squads",
    image: "/assets/about/recruiters.webp",
    lead: "Recruiters bring traders to MemeWarzone with a referral link. A recruiter earns 12.5% of the trading fee from the wallets they bring in, which is 0.25% of each trade, and 15% of the graduation fee of coins those wallets create, which is 0.30%. OG recruiters earn 15% and 17.5%, which is 0.30% and 0.35%. The extra comes out of MemeWarzone's share, not from a higher fee.",
    items: [
      "A squad is a group of traders around a recruiter. 2.5% of the trading fee goes to a weekly squad pool, shared by eligible members based on what they contribute. It is not an equal or guaranteed payout.",
      "Fair-play checks apply to recruiters and squads.",
    ],
    links: [
      { href: "/recruiters", text: "Recruiter leaderboard" },
      { href: "/squads", text: "Squad leaderboard" },
    ],
  },
  {
    id: "social",
    nav: "Social",
    heading: "Profiles and the feed",
    lead: "Every wallet has one profile, and it is the same on every chain. You can post, repost, quote, react and follow any coin or wallet on any chain. Only buying and selling depend on the chain you have selected.",
  },
  {
    id: "safety",
    nav: "Your money",
    heading: "How your money is handled",
    items: [
      "Buys and sells go from your wallet to the coin's contract. MemeWarzone does not hold your coins.",
      "Trading fees are split inside the same transaction as the trade.",
      "The BNB Chain and Robinhood Chain contracts are owned by a Safe multisig and cannot be changed after deployment. The Solana programs can only be upgraded through a Squads multisig.",
      "Protocol earnings above a fixed cap move to a multisig wallet.",
    ],
  },
  {
    id: "contracts",
    nav: "Contracts",
    heading: "Contracts and audits",
    lead: "These are the contracts that new coins on MemeWarzone use today. An external audit is pending on every chain.",
    contracts: [
      {
        chain: "BNB Chain",
        audit: "External audit: pending",
        entries: [
          { label: "Launcher", address: "0xCa64b78653d45232E679be19e2B8e24d72152C1f", href: bscscan("0xCa64b78653d45232E679be19e2B8e24d72152C1f") },
          { label: "Launch hook (Uniswap V4)", address: "0xCb5c3265328cAe92Ef609E4bF3DE27a6c73668EC", href: bscscan("0xCb5c3265328cAe92Ef609E4bF3DE27a6c73668EC") },
          { label: "Owner (Safe multisig)", address: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7", href: bscscan("0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7") },
        ],
      },
      {
        chain: "Robinhood Chain",
        audit: "External audit: pending",
        entries: [
          { label: "Launcher", address: "0xCa64b78653d45232E679be19e2B8e24d72152C1f", href: rhscan("0xCa64b78653d45232E679be19e2B8e24d72152C1f") },
          { label: "Launch hook (Uniswap V4)", address: "0x8c298A7Ab9640c377BEE1EFF67425956F96B28Ec", href: rhscan("0x8c298A7Ab9640c377BEE1EFF67425956F96B28Ec") },
          { label: "Owner (Safe multisig)", address: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7", href: rhscan("0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7") },
        ],
      },
      {
        chain: "Solana",
        audit: "External audit: pending",
        entries: [
          { label: "Launchpad program", address: "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt", href: solscan("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt") },
          { label: "Rewards treasury program", address: "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX", href: solscan("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX") },
          { label: "Upgrade authority (Squads multisig)", address: "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv", href: solscan("fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv") },
        ],
      },
    ],
    note: "New Solana coins trade on Meteora's Dynamic Bonding Curve program, which Meteora runs.",
  },
  {
    id: "roadmap",
    nav: "Roadmap",
    heading: "What comes next",
    steps: [
      { title: "DogeOS", text: "MemeWarzone is among the first launchpads invited onto DogeOS, which targets about 500,000 existing wallets." },
      { title: "More chains", text: "More chains will follow DogeOS, with the same launchpad, battles and leagues on each." },
      { title: "Interchained DEX", text: "A full interchained DEX. The first release covers the chains MemeWarzone runs on, then it opens up to more chains." },
    ],
  },
  {
    id: "team",
    nav: "Team",
    heading: "The team",
    members: [
      { name: "Patrick Klarenbeek", role: "CEO" },
      { name: "Sven Hoederdaal", role: "CTO and Head of Development" },
      { name: "Douglas Klepp", role: "CSO" },
    ],
    lead: "MemeWarzone is operated under Dutch law. You must be 18 or older to use it. Support and security questions go to support@memewar.zone. Legal questions go to legal@memewar.zone.",
    links: [
      { href: "https://x.com/memewarzone", text: "X" },
      { href: "https://t.me/memewarzonehq", text: "Telegram" },
      { href: "https://discord.gg/aXTkn3Asu", text: "Discord" },
      { href: "https://docs.memewar.zone", text: "Docs" },
      { href: "https://docs.memewar.zone/legal/terms-of-service", text: "Terms of Service" },
      { href: "https://docs.memewar.zone/legal/privacy-policy", text: "Privacy Policy" },
    ],
  },
  {
    id: "good-to-know",
    nav: "Good to know",
    heading: "Good to know",
    qa: [
      {
        q: "Does MemeWarzone pay every holder of a coin?",
        a: "No. Rewards go to battle winners, league places, creators, recruiters, squad members and airdrop winners. There is no automatic payout to every holder.",
      },
      {
        q: "Are rewards guaranteed?",
        a: "No. Rewards depend on taking part, eligibility, results and the size of each pool. Some details, such as the exact airdrop thresholds, are not published. Memecoins are volatile and you can lose what you put in.",
      },
      {
        q: "How is MemeWarzone different from Pump.fun?",
        a: "Pump.fun launches coins on Solana. MemeWarzone launches on BNB Chain, Solana and Robinhood Chain and adds battles, tournaments and leagues after launch. The full comparison is on its own page.",
      },
      {
        q: "Is MemeWarzone related to Call of Duty: Warzone?",
        a: "No. MemeWarzone is a crypto platform. It has no connection to Call of Duty: Warzone or any other game.",
      },
    ],
    links: [
      { href: "/memewarzone-vs-pumpfun", text: "MemeWarzone vs Pump.fun" },
    ],
  },
];

/** Every visible string, for the copy-rule test. */
export function aboutAllText() {
  return [
    ABOUT_TITLE, ABOUT_DESCRIPTION, ...ABOUT_INTRO, ABOUT_DISAMBIGUATION, ...ABOUT_CHAINS,
    ABOUT_NEXT_CHAIN.name, ABOUT_NEXT_CHAIN.label, ABOUT_NEXT_CHAIN.text,
    ...ABOUT_HIGHLIGHTS.flatMap((h) => [h.value, h.label]), ...ABOUT_HERO_LINKS.map((l) => l.text),
    ...ABOUT_SECTIONS.flatMap((s) => [
      s.nav, s.heading, s.lead, s.note, s.chipsLabel, ...(s.chips || []),
      ...(s.steps || []).flatMap((x) => [x.title, x.text]),
      ...(s.modes || []).flatMap((m) => [m.name, m.text, ...m.durations]),
      ...(s.splits || []).flatMap((x) => [x.title, ...x.segments.map((g) => g.label)]),
      ...(s.items || []),
      ...(s.categories || []).flatMap((c) => [c.name, c.text]),
      ...(s.members || []).flatMap((m) => [m.name, m.role]),
      ...(s.contracts || []).flatMap((c) => [c.chain, c.audit, ...c.entries.map((e) => e.label)]),
      ...(s.qa || []).flatMap((x) => [x.q, x.a]),
      ...(s.links || []).map((l) => l.text),
    ]),
  ].filter(Boolean);
}

/** JSON-LD for /about. The Organization itself lives in frontend/index.html (@id below). */
export function aboutJsonLd(origin = "https://app.memewar.zone") {
  const url = `${origin}${ABOUT_PATH}`;
  const team = ABOUT_SECTIONS.find((s) => s.id === "team")?.members || [];
  const qa = ABOUT_SECTIONS.find((s) => s.id === "good-to-know")?.qa || [];
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
      "@type": "Organization",
      "@id": "https://memewar.zone/#organization",
      name: "MemeWarzone",
      url: "https://memewar.zone",
      email: "support@memewar.zone",
      sameAs: ["https://x.com/memewarzone", "https://t.me/memewarzonehq", "https://discord.gg/aXTkn3Asu"],
      employee: team.map((m) => ({ "@type": "Person", name: m.name, jobTitle: m.role })),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: qa.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })),
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
