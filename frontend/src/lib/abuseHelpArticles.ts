export type AbuseHelpArticle = {
  id: string;
  title: string;
  summary: string;
  body: string;
  keywords: string[];
};

export const ABUSE_HELP_ARTICLES: AbuseHelpArticle[] = [
  {
    id: "creating-a-token",
    title: "Creating a token",
    summary: "How to deploy a campaign from Create or a Prepare Mode draft.",
    body: "Connect the owner wallet, enter name, ticker, image and socials, then pick a graduation tier. Direct Create deploys immediately. Drafts can be published first as a promotion page, then armed when you are ready to pay gas.",
    keywords: ["create", "token", "deploy", "ticker", "factory"],
  },
  {
    id: "prepare-mode",
    title: "Prepare Mode",
    summary: "Promotion pages, drafts, and scheduled trading open.",
    body: "Prepare Mode lets you publish a campaign page before the contract is live. Save promotion copy, reserve a ticker, then deploy now or set a future trading-open time. The countdown is not a reserved global slot.",
    keywords: ["prepare", "draft", "promotion", "countdown", "scheduled"],
  },
  {
    id: "wallet-connections",
    title: "Wallet connections",
    summary: "BNB and Solana wallets inside Command Center.",
    body: "Command Center follows the wallet in the URL. Use a supported BNB or Solana wallet, switch to the correct chain, and sign when the API asks. Profile, claims and abuse reports all stay bound to that connected wallet.",
    keywords: ["wallet", "metamask", "phantom", "connect", "chain"],
  },
  {
    id: "trading",
    title: "Trading",
    summary: "Bonding-curve buys and sells on Token Details and War Trade Room.",
    body: "Pre-graduation trades run on the MemeWarzone bonding curve. After graduation, trading continues through the campaign's verified pool. Quotes, slippage and wallet signatures all stay inside MemeWarzone, not in Discord.",
    keywords: ["trade", "buy", "sell", "chart", "war room"],
  },
  {
    id: "graduation",
    title: "Graduation",
    summary: "When a campaign leaves the curve and keeps trading.",
    body: "Graduation is a market-stage change, not the end of the project. The token page and War Trade Room stay up. Bonding history and post-grad trades share the same chart once the pool is verified.",
    keywords: ["graduate", "graduation", "dex", "topaz", "pool"],
  },
  {
    id: "upvotes",
    title: "UpVotes",
    summary: "How UpVote support works on live campaigns.",
    body: "UpVotes are on-platform support, not Discord tickets. Use the token page controls while the campaign is live. Failed or pending votes are product support (Discord), not the Abuse desk.",
    keywords: ["upvote", "vote", "support", "boost"],
  },
  {
    id: "recruiters",
    title: "Recruiters",
    summary: "Codes, links, and recruiter rewards.",
    body: "Open Command Center → Recruiter for your code, invite link and payout status. Recruiter signup and attribution are wallet-signed. Reward questions go to Discord support, not Abuse.",
    keywords: ["recruiter", "referral", "code", "invite"],
  },
  {
    id: "squads",
    title: "Squads",
    summary: "Squad membership and standings.",
    body: "If you joined through a recruiter, Command Center → Squad shows membership and contribution. Squad image and roster changes require the connected owner wallet.",
    keywords: ["squad", "team", "roster", "member"],
  },
  {
    id: "rewards",
    title: "Rewards",
    summary: "Airdrops, claims, and reward status.",
    body: "Command Center → Airdrops and Rewards and claims show pool status, winners and claimable amounts. Always claim from the wallet that earned the reward. Claim failures are product support.",
    keywords: ["reward", "claim", "airdrop", "payout"],
  },
  {
    id: "lp-fees",
    title: "LP Fees",
    summary: "Creator harvest after graduation.",
    body: "Creators collect LP fees from Command Center → My coins when unclaimed fees are available. Fee questions are product support, not Abuse.",
    keywords: ["lp", "fees", "harvest", "creator"],
  },
];

export function searchAbuseHelp(query: string): AbuseHelpArticle[] {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return ABUSE_HELP_ARTICLES;
  return ABUSE_HELP_ARTICLES.filter((article) => {
    const haystack = [article.title, article.summary, article.body, ...article.keywords].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

export { DISCORD_SUPPORT_URL } from "@/lib/helpCenter";
