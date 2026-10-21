// Comparison pages ("MemeWarzone vs X"), shared by the app page (src/pages/ComparePage.tsx) and the API renderer
// (api/seoRender.js). Pure module: no DOM, no I/O. Add a competitor by adding an object to COMPARE_PAGES; the
// route rule, sitemap entry and server-rendered text follow from it. nginx renders /memewarzone-vs-<slug>.
//
// MemeWarzone facts: the same sources as shared/aboutContent.mjs (fees: shared/evmGen8.mjs GEN8_RATES incl. creatorPostBps 50,
// creator fee choice keep/holders/split/buyback: src/components/create/CreatorFeeChoicePicker.tsx (live launch types: DBC on Solana, gen-8 on BNB/RH; founder 2026-10-22);
// docs-site fees/fee-routing.md, creators/creator-earnings.md; battles: api/lib/arenaBattleMode.js).
// Competitor facts: public sources listed in `sources`, checked on `checkedOn`. Re-check before changing a number.
// Copy rule: plain sentences, concrete facts, no slogans, no dashes used as punctuation. Be fair to the competitor.

const ORIGIN = "https://app.memewar.zone";

/**
 * @typedef {{ feature: string, mwz: string, other: string }} CompareRow
 * @typedef {{ id: string, nav: string, heading: string, lead?: string, items?: string[], rows?: CompareRow[],
 *   qa?: { q: string, a: string }[], note?: string, links?: { href: string, text: string }[] }} CompareSection
 * @typedef {{ path: string, competitor: string, title: string, description: string, checkedOn: string,
 *   intro: string[], disclaimer: string, verdicts: { who: "mwz"|"other", title: string, items: string[] }[],
 *   sections: CompareSection[], sources: { text: string, href: string, date: string }[] }} ComparePage
 * @type {ComparePage[]}
 */
export const COMPARE_PAGES = [
  {
    path: "/memewarzone-vs-pumpfun",
    competitor: "Pump.fun",
    title: "MemeWarzone vs Pump.fun",
    description:
      "MemeWarzone vs Pump.fun: chains, trading fees, creator earnings, graduation, battles and leagues side by side, with sources checked in October 2026.",
    checkedOn: "21 October 2026",
    intro: [
      "Pump.fun and MemeWarzone both launch memecoins on a bonding curve. Pump.fun launches coins on Solana. MemeWarzone launches coins on BNB Chain, Solana and Robinhood Chain, and adds battles, tournaments and leagues after launch.",
      "This page compares the two on chains, fees, creator earnings, graduation and what happens after launch.",
    ],
    disclaimer:
      "Pump.fun facts come from its public fee docs and news coverage, checked on 21 October 2026. Its terms can change, so check pump.fun/docs/fees for the current numbers.",
    verdicts: [
      {
        who: "mwz",
        title: "Pick MemeWarzone if",
        items: [
          "You want to launch on BNB Chain, Solana or Robinhood Chain from one platform.",
          "You want your coin to keep competing after launch, in battles, tournaments and leagues.",
          "You want your community to earn from the trading fee through league prizes, recruiters, squads and airdrops.",
          "Your coin already finished bonding on Pump.fun and you want to bring it into battles.",
        ],
      },
      {
        who: "other",
        title: "Pick Pump.fun if",
        items: [
          "Your community is on Solana and you want the largest audience of active traders.",
          "You want a lower trading fee and a higher creator share on the bonding curve.",
          "You want perps trading in the same app, which MemeWarzone does not offer.",
        ],
      },
    ],
    sections: [
      {
        id: "chains",
        nav: "Chains",
        heading: "Chains",
        rows: [
          { feature: "Where coins launch", mwz: "BNB Chain, Solana and Robinhood Chain. DogeOS is next.", other: "Solana." },
          { feature: "Other chains in the app", mwz: "Coins imported from other launchpads trade on MemeWarzone on all three chains.", other: "Since May 2026 its app also trades coins on Ethereum, Base and BNB Chain, settled through Solana." },
        ],
      },
      {
        id: "launch",
        nav: "Launch",
        heading: "Launch and graduation",
        rows: [
          { feature: "Launch model", mwz: "Bonding curve.", other: "Bonding curve." },
          { feature: "Cost to create a coin", mwz: "No platform fee, network costs only.", other: "Not on its fee page. Third-party guides put it at about 0.02 SOL." },
          { feature: "Sniper protection", mwz: "A launch fee that starts at 90% and falls to 2% over the first 60 seconds.", other: "Not listed in its fee docs." },
          { feature: "Graduation", mwz: "At a $30K or $50K market cap, chosen by the creator at launch.", other: "At about 85 SOL raised, according to third-party analyses. Its fee page lists a 0.015 SOL graduation fee." },
          { feature: "Where graduated coins trade", mwz: "Uniswap V4 on BNB Chain and Robinhood Chain, Meteora on Solana. The liquidity is locked for good.", other: "PumpSwap, Pump.fun's own DEX, since March 2025." },
        ],
      },
      {
        id: "fees",
        nav: "Fees",
        heading: "Fees and who earns them",
        lead: "Pump.fun charges less per trade and pays creators more on the bonding curve. After graduation MemeWarzone pays creators more. MemeWarzone sends most of its trading fee back to the community through league prize pools, recruiters, squads and airdrops. On both platforms a creator can pass their fees on to holders.",
        rows: [
          { feature: "Bonding curve fee", mwz: "2% on every buy and sell.", other: "1.25% on every buy and sell." },
          { feature: "Creator share on the curve", mwz: "0.112% of each trade, which is 5.6% of the fee.", other: "0.30% of each trade." },
          { feature: "What the creator does with their share", mwz: "Chosen at launch: keep it, give it to holders, split it, or use it for buyback and burn.", other: "Creators can pass part of their fees to holders through Holder Rewards, since September 2026." },
          { feature: "Community share of the fee", mwz: "37.5% to league prize pools, 12.5% to recruiters and 2.5% to the squad pool. When a trader has no recruiter, those last two go to weekly airdrops.", other: "A referral program since October 2026 that matches a new user's deposit, up to $50 each." },
          { feature: "Creator share after graduation", mwz: "BNB Chain and Robinhood Chain: 0.5% of every swap. Solana: 80% of the 0.25% pool fee, which is 0.20%.", other: "On PumpSwap 0.30% of each swap, falling to 0.05% as the market cap grows." },
          { feature: "Imported coins", mwz: "A 1% swap fee: 0.5% to the coin's creator and 0.5% to MemeWarzone.", other: "Not applicable." },
        ],
      },
      {
        id: "compete",
        nav: "After launch",
        heading: "After launch",
        lead: "This is the main difference. On Pump.fun a coin's visibility comes from trading activity. On MemeWarzone a coin can enter one competition after another.",
        rows: [
          { feature: "Battles", mwz: "Metrics battles of 24 hours to 7 days and vote battles of 1 to 48 hours, with buy-ins and a war pool for the winner.", other: "None in its public docs." },
          { feature: "Tournaments", mwz: "Brackets with free votes, Boosts and Final Salvo tie-breakers.", other: "None in its public docs." },
          { feature: "Leagues", mwz: "Weekly and monthly leagues in six categories, plus the Major War League for graduated coins.", other: "None in its public docs." },
          { feature: "Social", mwz: "One profile per wallet across chains, posts and follows, coin Stories and live streams.", other: "Coin comments and livestreams." },
        ],
      },
      {
        id: "trust",
        nav: "Scale and trust",
        heading: "Scale and trust",
        rows: [
          { feature: "Size", mwz: "Live since 2026 and still early.", other: "The largest Solana launchpad. About $491M of PUMP token buybacks by October 2026." },
          { feature: "External audit", mwz: "Pending on every chain.", other: "No audit report in its public docs." },
        ],
      },
      {
        id: "pumpfun-ahead",
        nav: "Where Pump.fun leads",
        heading: "Where Pump.fun is ahead",
        items: [
          "A much larger audience and more trading volume on Solana.",
          "A lower trading fee and a higher creator share per trade on the curve.",
          "Perps trading in the same app.",
        ],
      },
      {
        id: "faq",
        nav: "FAQ",
        heading: "Questions",
        qa: [
          {
            q: "What is the main difference between MemeWarzone and Pump.fun?",
            a: "Pump.fun launches coins on Solana and they graduate to PumpSwap. MemeWarzone launches coins on BNB Chain, Solana and Robinhood Chain, and after graduation a coin can enter battles, tournaments and leagues.",
          },
          {
            q: "Which one has lower fees?",
            a: "Pump.fun. Its bonding curve fee is 1.25% per trade, MemeWarzone's is 2%. On MemeWarzone most of the fee goes back to the community through league prize pools, recruiters, squads and airdrops.",
          },
          {
            q: "Can I launch a coin on BNB Chain with Pump.fun?",
            a: "No. Pump.fun launches coins on Solana. Its app has traded some coins on other chains since May 2026. MemeWarzone launches coins on BNB Chain, Solana and Robinhood Chain.",
          },
          {
            q: "Does Pump.fun have battles or leagues?",
            a: "Its public docs list no battles, tournaments or leagues as of 21 October 2026.",
          },
          {
            q: "Can I bring my Pump.fun coin to MemeWarzone?",
            a: "Yes. Once a coin has finished bonding and has a funded DEX pool, it can be imported. Imported coins can battle, and after claiming the coin the creator gets 0.5% of every swap on MemeWarzone.",
          },
        ],
        links: [
          { href: "/about", text: "About MemeWarzone" },
          { href: "/create", text: "Launch a coin" },
          { href: "/import", text: "Import a coin" },
        ],
      },
    ],
    sources: [
      { text: "Pump.fun fees", href: "https://pump.fun/docs/fees", date: "page updated 17 October 2026" },
      { text: "Pump.fun referral rewards", href: "https://pump.fun/docs/referral-rewards", date: "7 October 2026" },
      { text: "PUMP token page", href: "https://pump.fun/pump-token", date: "checked 21 October 2026" },
      { text: "The Block: Pump.fun launches PumpSwap", href: "https://www.theblock.co/post/347360", date: "20 March 2025" },
      { text: "The Crypto Times: Pump.fun adds Ethereum, Base and BNB Chain trading", href: "https://www.cryptotimes.io/2026/05/26/pump-fun-adds-ethereum-base-and-bnb-chain-trading-to-app/", date: "26 May 2026" },
      { text: "MemeWarzone fee routing", href: "https://docs.memewar.zone/fees/fee-routing", date: "checked 21 October 2026" },
    ],
  },
];

export const COMPARE_PATHS = COMPARE_PAGES.map((page) => page.path);

export function comparePageFor(path) {
  return COMPARE_PAGES.find((page) => page.path === path) || null;
}

/** Every visible string of one page, for the copy-rule test. */
export function compareAllText(page) {
  return [
    page.title, page.description, page.disclaimer, ...page.intro,
    ...page.verdicts.flatMap((v) => [v.title, ...v.items]),
    ...page.sections.flatMap((s) => [
      s.nav, s.heading, s.lead, s.note, ...(s.items || []),
      ...(s.rows || []).flatMap((r) => [r.feature, r.mwz, r.other]),
      ...(s.qa || []).flatMap((x) => [x.q, x.a]),
      ...(s.links || []).map((l) => l.text),
    ]),
    ...page.sources.map((x) => x.text),
  ].filter(Boolean);
}

export function compareJsonLd(page, origin = ORIGIN) {
  const url = `${origin}${page.path}`;
  const qa = page.sections.flatMap((s) => s.qa || []);
  return [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: page.title,
      description: page.description,
      url,
      dateModified: "2026-10-21",
      author: { "@id": "https://memewar.zone/#organization" },
      publisher: { "@id": "https://memewar.zone/#organization" },
      about: [
        { "@type": "SoftwareApplication", name: "MemeWarzone", applicationCategory: "FinanceApplication", url: `${origin}/` },
        { "@type": "SoftwareApplication", name: page.competitor, applicationCategory: "FinanceApplication" },
      ],
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
        { "@type": "ListItem", position: 2, name: "About", item: `${origin}/about` },
        { "@type": "ListItem", position: 3, name: page.title, item: url },
      ],
    },
  ];
}
