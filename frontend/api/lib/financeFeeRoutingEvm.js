// EVM fee routing registry (BNB 56, Robinhood 4663; testnets 97 / 46630) for
// the finance view.
//
// Splits are quoted from the contracts (repo HEAD 127c09da); addresses from
// deployments/<chain>/mainnet.*.json and the Safe batches beside them. Every
// router/vault pointer the registry relies on is also read live (wiring checks)
// so a Safe batch that re-pointed something shows up as a mismatch instead of
// a silently wrong map. Testnets have no pinned record here: their destinations
// are resolved from the live router getters and labelled as such.

import { id as keccakId } from "ethers";

export const EVM_FEE_ROUTING_CHAINS = Object.freeze({
  56: { chain: "bnb", environment: "mainnet", nativeSymbol: "BNB", nativeDecimals: 18, tokens: { WBNB: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 } } },
  4663: { chain: "robinhood", environment: "mainnet", nativeSymbol: "ETH", nativeDecimals: 18, tokens: { WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18 } } },
  97: { chain: "bnb", environment: "testnet", nativeSymbol: "tBNB", nativeDecimals: 18, tokens: { WBNB: { address: "0xcd2c34926894616F6768F15F15614b1F7816bC2E", decimals: 18 } } },
  46630: { chain: "robinhood", environment: "testnet", nativeSymbol: "ETH", nativeDecimals: 18, tokens: { WETH: { address: "0x52A47A33930B8a90a2000b1bA3CB96e879569670", decimals: 18 } } },
});

export const EVM_SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
export const EVM_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
export const EVM_PROTOCOL_OPERATOR = "0x4CB68C7e131Ef7855b2ceEe1B99Cc163DFD47810";

export function evmGetterSelector(getter) {
  return keccakId(`${getter}()`).slice(0, 10);
}

const MAINNET = {
  56: {
    record: "deployments/bnb",
    wrapped: "WBNB",
    routerV4: "0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa",
    routerV3: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
    weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
    monthly: "0x42D254A7451808Bb01df879d71BcAfDC5D605A38",
    monthlyOld: "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8",
    recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
    community: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    creatorV2: "0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66",
    creatorV1: "0x72A963682B261195EB43F8f75e0515ab279EbD14",
    protocol: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c",
    postGrad: "0xD9E381408A4e361C66D8b1e657583bdE6c52402d",
    mwlMonthly: "0xC46D33FCce7030627254278716d4AEb536Cf46FF",
    mwlQuarterly: "0xa83d8194C367f2d3eA7B3963f50d579efD8a2218",
    warPool: "0xe69a6a41363a48179beaB9b1E6122885bbFe8C65",
    airdropDistributor: "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75",
    holderDistributor: "0xD106198Ca83c26f4B43c9DF7368F134f0Cd46cc1",
    charity: "0xd6602E3aA3F8FBe202ac84776d47ee0FfAd188df",
    eventPrize: "0xDc77CAACDEB6affA0a5791f62BBB958D99Edc58B",
    upvote: "0xF6AA6eD33030F1179B57658f45dd48E31a60E70f",
    sponsorship: "0xe10e9c26D7CA80390831884CA17919E22fF44938",
    locker: "0xEEEfa12B14ea922B21bAf05Ad4aa79B2643c8eA6",
    lockerName: "PermanentLpLocker (gen-6)",
  },
  4663: {
    record: "deployments/robinhood",
    wrapped: "WETH",
    routerV4: "0x49Ae38B19664d90b410AE860B9604e1Bc5f7Ab5d",
    routerV3: "0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb",
    weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    monthly: "0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A",
    monthlyOld: "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238",
    recruiter: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
    community: "0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a",
    creatorV2: "0xEDCC2667365F116b9971Cc02f198470BE23a5651",
    creatorV1: "0xD9E381408A4e361C66D8b1e657583bdE6c52402d",
    protocol: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
    postGrad: "0x5D5CC19B5BE86BA28b8164f85883F17843B69810",
    mwlMonthly: "0xa20388579323e22076b07e89Ac916aE6Ff91A0E0",
    mwlQuarterly: "0xA2f8e9C7aaeeECaa78D070FEe64CB54427d5291e",
    warPool: "0xD3E00E476b72e49Ec4587df58b23Ea5BAd1F151C",
    airdropDistributor: "0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D",
    holderDistributor: "0x0Bf17e4bF2Ef1f4737d1e8cF95170D814e36A023",
    charity: "0x72A963682B261195EB43F8f75e0515ab279EbD14",
    eventPrize: "0x2DFF1259Eb7fD905D15E30234b5F6fF2Eb77A898",
    upvote: "0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa",
    sponsorship: "0xcF7a0603B2C27B79D858A183330FF3bcfE34C381",
    locker: "0x615b1AbE348edA2e5a44eCe32fb50fbC45d2AF07",
    lockerName: "PermanentV3PositionLocker (gen-6)",
  },
};

const TESTNET_ROUTERS = {
  97: { router: "0x00b7A353baC4D5e03986FcEAD5084930Df4404Dd", record: "deployments/bscTestnet/testnet.gen6.json" },
  46630: { router: "0x138F4F259619de83b6bDA5380d4a03F1e5204711", record: "deployments/robinhood/testnet.gen6b.json" },
};

const ROUTER_GETTERS = [
  ["weekly_league", "weeklyLeagueVault"],
  ["monthly_league", "monthlyLeagueTreasury"],
  ["recruiter_vault", "recruiterRewardsVault"],
  ["community_vault", "communityRewardsVault"],
  ["protocol_vault", "protocolRevenueVault"],
  ["creator_vault_v2", "creatorRewardsVault"],
];

function tradeFlowV4(routerAddress, wrapped) {
  return {
    id: "evm_trade_v4",
    label: "Bonding-curve buy / sell (gen-6, live)",
    trigger: "Every buy and sell on a gen-6 campaign",
    router: `TreasuryRouterV4 ${routerAddress}`,
    totalFee: "2% (protocolFeeBps 200); 50% falling to 2% over the first 60 s (anti-sniper)",
    status: "live",
    splits: [
      { destinationId: "weekly_league", share: "11.25%", note: "37.5% league x weeklyLeagueBps 3000" },
      { destinationId: "monthly_league", share: "26.25%", note: "37.5% league x monthlyLeagueBps 7000" },
      { destinationId: "creator_vault_v2", share: "5.6% (CREATOR_TRADE_BPS 560)", note: "Then by creator choice: keep / split / holders / buyback" },
      { destinationId: "recruiter_vault", share: "12.5% linked / 15% OG / 0% unlinked" },
      { destinationId: "community_vault", share: "2.5% squad (linked + OG); 15% airdrop (unlinked)" },
      { destinationId: "protocol_vault", share: "41.9% (OG 39.4%), remainder" },
    ],
    citation: "contracts/TreasuryRouterV4.sol:16-22,186-210,408-480; contracts/LaunchCampaign.sol:126-127,432-440,1036-1044; contracts/LaunchFactory.sol:374",
    notes: [
      "Routing is strict: a reverting receiver reverts the trade, so no fee is parked.",
      `The router's own receive() forwards stray value to the weekly vault.`,
      `LP-token protocol share arrives as ${wrapped} (ERC20); see the LP flow.`,
    ],
  };
}

function finalizeFlow(router) {
  return {
    id: "evm_finalize",
    label: "Graduation (finalize)",
    trigger: "graduate() on a sold-out campaign",
    router,
    totalFee: "2.2% of the raise (GRAD_PROTOCOL_BPS 220) to the router; 19.8% to the creator (GRAD_CREATOR_BPS 1980); about 78% to the pool",
    status: "live",
    splits: [
      { destinationId: "recruiter_vault", share: "15% linked / 17.5% OG" },
      { destinationId: "community_vault", share: "2.5% squad (linked + OG); 17.5% airdrop (unlinked)" },
      { destinationId: "protocol_vault", share: "82.5% (OG 80%), remainder" },
    ],
    citation: "contracts/LaunchCampaign.sol:136-137,763-790,1009-1015; contracts/TreasuryRouterV4.sol:212-232",
    notes: ["No league or creator slice. If the router refuses, the protocol share waits in pendingProtocolGraduationFee (permissionless flush)."],
  };
}

function mainnetRegistry(chainId) {
  const a = MAINNET[chainId];
  const network = EVM_FEE_ROUTING_CHAINS[chainId];
  const rec = a.record;
  const native = ["native"];
  const withWrapped = ["native", a.wrapped];

  const destinations = [
    { id: "protocol_vault", label: "ProtocolRevenueVault", kind: "vault", address: a.protocol, custody: "Forwards on receive(): operator up to $10k lifetime, rest to overflow (Safe). No ERC20 withdraw.", role: "Protocol share of trades, finalizes, LP fees, UP votes, sponsorships", citation: `contracts/ProtocolRevenueVault.sol:23-81; ${rec}/mainnet.V3-operator-fill.safe-batch.json`, assets: withWrapped },
    { id: "protocol_operator", label: "Protocol operator fill (EOA)", kind: "wallet", address: EVM_PROTOCOL_OPERATOR, custody: "ProtocolRevenueVault.operator (hot EOA)", role: "First $10,000 (lifetime, static admin price) of protocol revenue", citation: `${rec}/mainnet.V3-operator-fill.safe-batch.json`, assets: native },
    { id: "safe", label: "Safe multisig", kind: "multisig", address: EVM_SAFE, custody: "Safe (owner/admin of every contract)", role: "ProtocolRevenueVault overflow; arena war pool protocol share", citation: "docs/claude/evm-deployments.md (Safe); ProtocolRevenueVault.overflowTreasury", assets: withWrapped },
    { id: "weekly_league", label: "Weekly league vault (TreasuryVaultV2)", kind: "vault", address: a.weekly, custody: "Root-posted claims", role: "30% of the league slice", citation: `contracts/TreasuryRouterV4.sol:76,475-480; ${rec}`, assets: native },
    { id: "monthly_league", label: "Monthly league treasury (replacement)", kind: "vault", address: a.monthly, custody: "MonthlyLeagueTreasury; sealMonth overflow above cap goes to charity", role: "70% of the league slice", citation: `${rec}/mainnet.monthly-league-treasury-v2.json; ${rec}/mainnet.M2-monthly-league-accept.safe-batch.json`, assets: native },
    { id: "monthly_league_old", label: "Old monthly league treasury (wei cap)", kind: "vault", address: a.monthlyOld, custody: "Superseded; monthlyCapUsd unit bug", role: "No longer routed to; watch for stranded funds", citation: "docs/claude/payouts-and-rewards.md (Monthly league vaults capped at a few wei)", assets: native, flags: ["retired"] },
    { id: "recruiter_vault", label: "RecruiterRewardsVault", kind: "vault", address: a.recruiter, custody: "operator payout(), capped per tx/day", role: "12.5% (OG 15%) of linked trades", citation: "contracts/RecruiterRewardsVault.sol:54-72", assets: native },
    { id: "community_vault", label: "CommunityRewardsVault", kind: "vault", address: a.community, custody: "Airdrop + squad pools; funds RewardDistributor batches", role: "Unlinked recruiter slice (airdrop) and squad slice", citation: "contracts/CommunityRewardsVault.sol:58-115", assets: native },
    { id: "creator_vault_v2", label: "CreatorRewardsVaultV2 (gen-6)", kind: "vault", address: a.creatorV2, custody: "Creator / holder / buyback balances per campaign", role: "5.6% creator slice of gen-6 trades", citation: `contracts/CreatorRewardsVaultV2.sol:318-325,663-674; ${rec}/mainnet.evmgen-fees.json`, assets: native },
    { id: "creator_vault_v1", label: "CreatorRewardsVault (gen-4)", kind: "vault", address: a.creatorV1, custody: "pendingCreatorFees per creator", role: "5% creator slice of gen-4 trades (TreasuryRouterV3)", citation: `${rec}/mainnet.treasury-router-v3.json`, assets: native },
    { id: "post_grad_league", label: "PostGradLeagueTreasuryV2", kind: "vault", address: a.postGrad, custody: "Pending per epoch; permissionless claimMonthly/claimQuarterly", role: "20% of arena entries, split 60% monthly / 40% quarterly", citation: "contracts/PostGradLeagueTreasuryV2.sol:16,101-138", assets: native },
    { id: "mwl_monthly", label: "MWL monthly vault (TreasuryVaultV2)", kind: "vault", address: a.mwlMonthly, custody: "MWL roots, epoch code 3", role: "PostGrad monthlyReceiver", citation: `${rec}/mainnet.mwl-vaults.json; ${rec}/mainnet.MWL1-mwl-vaults.safe-batch.json`, assets: native },
    { id: "mwl_quarterly", label: "MWL quarterly vault (TreasuryVaultV2)", kind: "vault", address: a.mwlQuarterly, custody: "MWL roots, epoch code 4", role: "PostGrad quarterlyReceiver", citation: `${rec}/mainnet.mwl-vaults.json`, assets: native },
    { id: "war_pool", label: "ArenaWarPoolTreasuryV2", kind: "contract", address: a.warPool, custody: "Holds stakes, boosts and unclaimed prizes per pool", role: "Arena money in flight", citation: "contracts/ArenaWarPoolTreasuryV2.sol:77-79,503-509,627-701", assets: native },
    { id: "airdrop_distributor", label: "Airdrop RewardDistributor", kind: "contract", address: a.airdropDistributor, custody: "Weekly airdrop batches; Safe recovers unclaimed", role: "Funded from the community vault", citation: "docs/claude/payouts-and-rewards.md (BNB / Robinhood payouts switched on)", assets: native },
    { id: "holder_distributor", label: "Holder RewardDistributor (gen-6)", kind: "contract", address: a.holderDistributor, custody: "Holder reward batches from CreatorRewardsVaultV2", role: "Holder share of creator fees", citation: `${rec}/mainnet.evmgen-fees.json`, assets: native },
    { id: "charity", label: "CharityTreasury", kind: "vault", address: a.charity, custody: "Immutable charity receiver of the monthly league", role: "Monthly league overflow above the USD cap", citation: "contracts/MonthlyLeagueTreasury.sol:189-211", assets: native },
    { id: "event_prize", label: "EventPrizeVaultV1", kind: "vault", address: a.eventPrize, custody: "Per-event prize pools", role: "70% of sponsorships", citation: "contracts/WarzoneSponsorshipRouterV1.sol:23-24,181-182", assets: native },
    { id: "lp_locker", label: a.lockerName, kind: "contract", address: a.locker, custody: "Permanently locked graduation liquidity; pendingProtocolToken holds refused shares", role: "Harvests LP fees 80% creator / 20% protocol", citation: "contracts/PermanentLpLocker.sol:45-46,403-441; contracts/PermanentV3PositionLocker.sol:74-75", assets: withWrapped },
    { id: "router_v4", label: "TreasuryRouterV4 (should hold nothing)", kind: "contract", address: a.routerV4, custody: "Forwards in the same call", role: "Live fee router (gen-6)", citation: `${rec}/mainnet.evmgen-fees.json`, assets: native },
    { id: "deployer", label: "Deployer (watch only)", kind: "wallet", address: EVM_DEPLOYER, custody: "Deploy key; keeps only immutable adapter admin roles", role: "Must never hold user money. No fee path in contract code pays it.", citation: "docs/claude/evm-deployments.md (Mainnet inputs)", assets: native, flags: ["deployer", "watch"] },
  ];

  const flows = [
    tradeFlowV4(a.routerV4, a.wrapped),
    {
      id: "evm_trade_v3",
      label: "Bonding-curve buy / sell (gen-4 campaigns)",
      trigger: "Trades on campaigns created by the gen-4 factory (create is paused; existing coins still trade)",
      router: `TreasuryRouterV3 ${a.routerV3}`,
      totalFee: "2%",
      status: "live for existing gen-4 coins",
      splits: [
        { destinationId: "weekly_league", share: "11.25%" },
        { destinationId: "monthly_league", share: "26.25%" },
        { destinationId: "creator_vault_v1", share: "5%" },
        { destinationId: "recruiter_vault", share: "12.5% linked / 15% OG / 0% unlinked" },
        { destinationId: "community_vault", share: "2.5% squad (linked + OG); 15% airdrop (unlinked)" },
        { destinationId: "protocol_vault", share: "42.5% (OG 40%), remainder" },
      ],
      citation: "contracts/TreasuryRouterV3.sol:186-206,421-480",
      notes: [],
    },
    finalizeFlow(`TreasuryRouterV4 ${a.routerV4} (gen-4: V3, same split)`),
    {
      id: "evm_protocol_drain",
      label: "ProtocolRevenueVault forwarding",
      trigger: "receive() on every native deposit (no crank)",
      router: `ProtocolRevenueVault ${a.protocol}`,
      totalFee: "100% of native deposits",
      status: "live",
      splits: [
        { destinationId: "protocol_operator", share: "Until $10,000 lifetime at the admin-set native price" },
        { destinationId: "safe", share: "Everything after the cap (overflowTreasury)" },
      ],
      citation: "contracts/ProtocolRevenueVault.sol:40-81",
      notes: [
        "The vault has no ERC20 withdraw: LP protocol shares routed as tokens (routeLpToken) stay in it. See the wrapped-token balance.",
        "A reverting operator or overflow address would revert every trade (strict routing).",
      ],
    },
    {
      id: "evm_lp_fees",
      label: "LP fees after graduation",
      trigger: "Locker harvest (EVM_LP_HARVEST crank on the API, or anyone)",
      router: `${a.lockerName} ${a.locker} → routeLpToken`,
      totalFee: "Pool LP fee",
      status: "live",
      splits: [
        { destinationId: "creator_vault_v2", share: "80% (CREATOR_FEE_BPS 8000)", note: "Creator payout recipient, or CreatorRewardsVaultV2 when the creator's choice is not keep" },
        { destinationId: "protocol_vault", share: `20% (PROTOCOL_FEE_BPS 2000), as ${a.wrapped}`, note: "Refused or unset router parks it in the locker's pendingProtocolToken" },
      ],
      citation: "contracts/PermanentLpLocker.sol:403-441; contracts/TreasuryRouterV4.sol:178-185",
      notes: [],
    },
    {
      id: "evm_arena",
      label: "Arena war pools",
      trigger: "Stakes / buy-ins / boosts, claimed after resolution",
      router: `ArenaWarPoolTreasuryV2 ${a.warPool}`,
      totalFee: "Entry 25% taken; boost 10% taken",
      status: "live",
      splits: [
        { destinationId: "post_grad_league", share: "20% of entries (ENTRY_LEAGUE_BPS 2000)", note: "claimLeague → depositCompetitionShare" },
        { destinationId: "safe", share: "5% of entries + 10% of boosts", note: "protocolReceiver (operatorReceiver unset)" },
      ],
      citation: "contracts/ArenaWarPoolTreasuryV2.sol:77-79,503-509,627-701",
      notes: [
        "75% of entries and 90% of boosts are the prize, held in the war pool until claimed.",
        "Entries are battle stakes and tournament buy-ins (vote battles included). A cancelled pool refunds everything, so nothing is earned until it resolves.",
        "Revenue lanes: arena-boosts (10% of confirmed boosts on finished battles) and arena-entries (league share / 4) in api/lib/financeRevenueLanes.js.",
      ],
    },
    {
      id: "evm_post_grad",
      label: "Major War League share",
      trigger: "claimMonthly / claimQuarterly (permissionless)",
      router: `PostGradLeagueTreasuryV2 ${a.postGrad}`,
      totalFee: "100% of the arena league share",
      status: "live",
      splits: [
        { destinationId: "mwl_monthly", share: "60% (MONTHLY_BPS 6000)" },
        { destinationId: "mwl_quarterly", share: "40%" },
      ],
      citation: "contracts/PostGradLeagueTreasuryV2.sol:16,101-138",
      notes: [],
    },
    {
      id: "evm_upvotes",
      label: "Paid UP votes",
      trigger: "voteWithBNB / voteWithToken",
      router: `UPVoteTreasury ${a.upvote}`,
      totalFee: "100% of the vote price",
      status: "live",
      splits: [{ destinationId: "protocol_vault", share: "100% (feeReceiver)" }],
      citation: `contracts/UPVoteTreasury.sol:128-170; ${chainId === 56 ? `${rec}/mainnet.V2-upvote-fee-receiver.safe-batch.json` : `${rec}/mainnet.upvote-treasury.json`}`,
      notes: chainId === 56 ? ["Before Safe batch V2, BNB votes went straight to the Safe."] : [],
    },
    {
      id: "evm_sponsorship",
      label: "Event sponsorships",
      trigger: "Sponsor payment",
      router: `WarzoneSponsorshipRouterV1 ${a.sponsorship}`,
      totalFee: "30% taken",
      status: "live",
      splits: [
        { destinationId: "event_prize", share: "70% (EVENT_BPS 7000)" },
        { destinationId: "protocol_vault", share: "20% marketing + 10% protocol" },
      ],
      citation: `contracts/WarzoneSponsorshipRouterV1.sol:23-24,181-182; ${rec}/mainnet.sponsorship-v1.json`,
      notes: ["Revenue lane: sponsorships (marketing 20% + protocol 10% of confirmed sponsorship_payments). No refund path in the router."],
    },
    ...(chainId === 56 ? [{
      id: "evm_import_swaps",
      label: "Imported-coin swaps",
      trigger: "Swap from an imported coin page (KyberSwap, PancakeSwap pools only)",
      router: "KyberSwap aggregator fee (feeReceiver checked by the API)",
      totalFee: "0.5% (IMPORT_SWAP_FEE_BPS default 50), always in BNB",
      status: "live, not indexed",
      splits: [{ destinationId: "protocol_vault", share: "100% of the swap fee (IMPORT_SWAP_FEE_RECEIVER_56)" }],
      citation: "frontend/api/importSwap.js:10-21,36,204-231",
      notes: ["The API does not record import swaps, so this fee has no revenue lane yet: it is only visible as part of the protocol vault's forwarded balance."],
    }] : []),
    homePlacementsFlow(),
  ];

  const wiring = [
    ...ROUTER_GETTERS.map(([destId, getter]) => ({ id: `v4_${getter}`, label: `TreasuryRouterV4.${getter}`, contract: a.routerV4, getter, expected: destinations.find((d) => d.id === destId).address })),
    ...ROUTER_GETTERS.map(([destId, getter]) => ({ id: `v3_${getter}`, label: `TreasuryRouterV3.${getter}`, contract: a.routerV3, getter, expected: destId === "creator_vault_v2" ? a.creatorV1 : destinations.find((d) => d.id === destId).address })),
    { id: "prv_operator", label: "ProtocolRevenueVault.operator", contract: a.protocol, getter: "operator", expected: EVM_PROTOCOL_OPERATOR },
    { id: "prv_overflow", label: "ProtocolRevenueVault.overflowTreasury", contract: a.protocol, getter: "overflowTreasury", expected: EVM_SAFE },
    { id: "war_protocol", label: "ArenaWarPoolTreasuryV2.protocolReceiver", contract: a.warPool, getter: "protocolReceiver", expected: EVM_SAFE },
    { id: "war_operator", label: "ArenaWarPoolTreasuryV2.operatorReceiver", contract: a.warPool, getter: "operatorReceiver", expected: "0x0000000000000000000000000000000000000000" },
    { id: "pg_monthly", label: "PostGradLeagueTreasuryV2.monthlyReceiver", contract: a.postGrad, getter: "monthlyReceiver", expected: a.mwlMonthly },
    { id: "pg_quarterly", label: "PostGradLeagueTreasuryV2.quarterlyReceiver", contract: a.postGrad, getter: "quarterlyReceiver", expected: a.mwlQuarterly },
    { id: "upvote_receiver", label: "UPVoteTreasury.feeReceiver", contract: a.upvote, getter: "feeReceiver", expected: a.protocol },
    { id: "sponsor_protocol", label: "SponsorshipRouter.protocolReceiver", contract: a.sponsorship, getter: "protocolReceiver", expected: a.protocol },
    { id: "sponsor_marketing", label: "SponsorshipRouter.marketingReceiver", contract: a.sponsorship, getter: "marketingReceiver", expected: a.protocol },
    { id: "locker_router", label: `${a.lockerName}.treasuryRouter`, contract: a.locker, getter: "treasuryRouter", expected: a.routerV4 },
  ];

  return {
    network,
    deployer: EVM_DEPLOYER,
    destinations,
    flows,
    wiring,
    inflowDestinations: {
      weekly: "weekly_league", monthly: "monthly_league", recruiter: "recruiter_vault",
      airdrop: "community_vault", squad: "community_vault", protocol: "protocol_vault",
      creator: "creator_vault_v2", votes: "protocol_vault", mwl: "post_grad_league",
    },
    alerts: [
      { level: "warning", message: `LP protocol shares reach ProtocolRevenueVault as ${a.wrapped} (routeLpToken → safeTransferFrom). The vault only forwards native on receive() and has no ERC20 withdraw, so that 20% is neither operator-filled nor movable by the Safe once it lands. Contract code: ProtocolRevenueVault.sol, NativeTreasuryVaultBase.sol:27-33, TreasuryRouterV4.sol:178-185.` },
      { level: "info", message: "The first $10,000 of protocol revenue goes to operator EOA 0x4CB6…7810 (intended per Safe batch V3); everything after goes to the Safe." },
    ],
  };
}

function testnetRegistry(chainId) {
  const t = TESTNET_ROUTERS[chainId];
  const network = EVM_FEE_ROUTING_CHAINS[chainId];
  const wrapped = Object.keys(network.tokens)[0];
  const labels = {
    weekly_league: "Weekly league vault", monthly_league: "Monthly league treasury", recruiter_vault: "Recruiter vault",
    community_vault: "Community rewards vault", protocol_vault: "Protocol revenue vault", creator_vault_v2: "Creator rewards vault V2",
  };
  const destinations = ROUTER_GETTERS.map(([destId, getter]) => ({
    id: destId, label: labels[destId], kind: "vault", address: null, resolveFrom: { contract: t.router, getter },
    custody: "Resolved live from the router (no pinned record in this view)", role: "", citation: `${t.record}; TreasuryRouterV4.${getter}()`,
    assets: destId === "protocol_vault" ? ["native", wrapped] : ["native"],
  }));
  return {
    network,
    deployer: EVM_DEPLOYER,
    destinations,
    flows: [tradeFlowV4(t.router, wrapped), finalizeFlow(`TreasuryRouterV4 ${t.router}`)],
    wiring: [],
    inflowDestinations: { weekly: "weekly_league", monthly: "monthly_league", recruiter: "recruiter_vault", airdrop: "community_vault", squad: "community_vault", protocol: "protocol_vault", creator: "creator_vault_v2" },
    alerts: [{ level: "info", message: "Testnet: destinations are read from the gen-6 router's getters at request time. The live API reads the production database, which holds no testnet routing events." }],
  };
}

// Home top row / featured slots: sold off-chain, so there is no on-chain
// destination. Shared with the Solana registry.
export function homePlacementsFlow() {
  return {
    id: "home_placements",
    label: "Home placements (sponsored slots)",
    trigger: "Admin marks a sponsorship application paid (admin/sponsorship.js patchApplication)",
    router: "Off-chain: no contract or program",
    totalFee: "Package price in USD (sponsorship_packages)",
    status: "off-chain, admin-recorded",
    splits: [],
    citation: "frontend/api/admin/sponsorship.js:46-77; public.sponsored_placements, public.sponsorship_applications",
    notes: [
      "100% protocol revenue when paid. Revenue lane home-placements values the package price in USD at paid_at (api/lib/financeRevenueLanes.js).",
      "No payment reference or transaction is stored, so the amount rests on the admin's paid mark.",
    ],
  };
}

/**
 * UP vote treasury and ProtocolRevenueVault of a mainnet, from the deployment
 * record above (deployments/<chain>/mainnet.*.json). null for other chains.
 */
export function evmMainnetVoteAddresses(chainId) {
  const a = MAINNET[Number(chainId)];
  return a ? { voteTreasury: a.upvote, protocolRevenueVault: a.protocol } : null;
}

export function evmFeeRoutingRegistry(chainId) {
  if (MAINNET[chainId]) return mainnetRegistry(chainId);
  if (TESTNET_ROUTERS[chainId]) return testnetRegistry(chainId);
  throw new Error(`No EVM fee routing registry for chain ${chainId}.`);
}
