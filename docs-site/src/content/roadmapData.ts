export type RoadmapStatus = 'completed' | 'incoming' | 'scheduled' | 'planned' | 'future'

export type RoadmapMilestone = {
  id: string
  month: string
  title: string
  shortText: string
  status: RoadmapStatus
}

export const roadmapMilestones: RoadmapMilestone[] = [
  {
    id: 'idea-war-plan',
    month: 'November',
    title: 'Idea & War Plan',
    shortText: 'MemeWarzone concept formed and the first battle plan was written.',
    status: 'completed'
  },
  {
    id: 'first-test-version',
    month: 'February',
    title: 'First Test Version',
    shortText: 'Early version went online with core structure and initial security logic.',
    status: 'completed'
  },
  {
    id: 'first-docs-online',
    month: 'February',
    title: 'First Docs Online',
    shortText: 'The first public documentation went live.',
    status: 'completed'
  },
  {
    id: 'leagues-recruiters-build',
    month: 'March',
    title: 'Leagues & Recruiters',
    shortText: 'Battle Leagues and Recruiter Program systems entered build phase.',
    status: 'completed'
  },
  {
    id: 'recruiter-online',
    month: 'April',
    title: 'Recruiter Program Online',
    shortText: 'Recruiter signup and onboarding went live through the landing page.',
    status: 'completed'
  },
  {
    id: 'reward-pools-built',
    month: 'April',
    title: 'Reward Pools Built',
    shortText: 'Squad Pool and Warzone Airdrop Pool were designed and built.',
    status: 'completed'
  },
  {
    id: 'fortress-security',
    month: 'April',
    title: 'Fortress Security',
    shortText: 'The full security system was built, hardened, and tested.',
    status: 'completed'
  },
  {
    id: 'prepare-mode-systems',
    month: 'April',
    title: 'Prepare Mode Systems',
    shortText: 'Drafts, Promotion Pages, scheduled status, and Prepare Mode launch flows were prepared.',
    status: 'completed'
  },
  {
    id: 'prepare-mode-live',
    month: 'May 2026',
    title: 'Prepare Mode Live',
    shortText: 'Creators, recruiters, squads, traders, and communities can prepare drafts and promotion pages before launch.',
    status: 'completed'
  },
  {
    id: 'bnb-live-launch',
    month: 'June 2026',
    title: 'BNB Live Launch',
    shortText: 'The BNB battlefield opened with live coin launches, bonding curve trading, UpVotes, Leagues, rewards, and claims.',
    status: 'completed'
  },
  {
    id: 'solana-expansion',
    month: '2026',
    title: 'Solana Live',
    shortText: 'MemeWarzone runs on Solana with launches, trading, Leagues, rewards, and claims, and the multi chain battlefield began.',
    status: 'completed'
  },
  {
    id: 'robinhood-chain',
    month: 'September 2026',
    title: 'Robinhood Chain Live',
    shortText: 'Robinhood Chain joined BNB Chain and Solana: launches, trading, imports, battles, and claims, paid in ETH, with stock token pairing.',
    status: 'completed'
  },
  {
    id: 'warzone-battles',
    month: 'September 2026',
    title: 'Warzone & Battles',
    shortText: 'Post graduation battles, vote battles, tournaments, the Major War League, and battle prize pools went live on every chain.',
    status: 'completed'
  },
  {
    id: 'imports',
    month: 'September 2026',
    title: 'Imported Coins',
    shortText: 'Coins launched elsewhere can be imported, traded on their own DEX from the same coin page, and claimed by their owners.',
    status: 'completed'
  },
  {
    id: 'meteora-launch',
    month: 'September 2026',
    title: 'Meteora Launch Type',
    shortText: 'A second Solana launch type on a Meteora curve, with your own fee choice.',
    status: 'completed'
  },
  {
    id: 'social-layer',
    month: 'October 2026',
    title: 'Social Layer & Redesign',
    shortText: 'Home feed, posts with up to 4 images, rockets, reposts, quotes, replies, usernames, profiles, creator updates, notifications, and a simpler design everywhere.',
    status: 'completed'
  },
  {
    id: 'marketing-growth-engine',
    month: '2026',
    title: 'Marketing Growth Engine',
    shortText: 'Automated Telegram, Discord, and X pushes, Shill & Chill spaces, a weekly podcast, and campaign recaps scale activity.',
    status: 'completed'
  },
  {
    id: 'war-missions',
    month: 'To be scheduled',
    title: 'War Missions / Quest System',
    shortText: 'A quest system to guide onboarding, social growth, and recruiter applications.',
    status: 'planned'
  },
  {
    id: 'tron-base-eth-expansion',
    month: 'To be scheduled',
    title: 'Tron, Base & Ethereum',
    shortText: 'More chains after BNB Chain, Solana, and Robinhood Chain: Tron, Base, and Ethereum.',
    status: 'planned'
  },
  {
    id: 'internal-bridge',
    month: 'After new chains',
    title: 'Internal Bridge',
    shortText: 'The internal bridge moves MemeWarzone from multi chain presence toward one connected interchain battlefield.',
    status: 'future'
  },
  {
    id: 'interchain-battlefield',
    month: 'After bridge',
    title: 'Full Interchain Battlefield',
    shortText: 'Cross chain discovery, profiles, rankings, reputation, chain choice, and unified reward dashboards expand the ecosystem.',
    status: 'future'
  },
  {
    id: 'market-share-push',
    month: 'Year one',
    title: '20% Per-Chain Target',
    shortText: 'The strategic target is 20% market share on each chain MemeWarzone launches on, not only 20% across all chains combined.',
    status: 'future'
  }
]
