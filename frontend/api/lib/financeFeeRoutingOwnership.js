// Who each fee-routing destination's balance belongs to.
//
//   ours  - protocol-owned: nothing in code obliges it to anyone else.
//   owed  - held for others (creators, league / MWL / recruiter / airdrop /
//           squad winners, prize pools, charity), or a balance that mixes our
//           share with theirs and cannot be split from the balance alone.
//   watch - keys we watch but no fee path pays (deployer keys, devnet key).
//
// The class is read from the contract / program code and the destination's
// custody, never from the label. `mixed: true` marks a balance that holds both
// our share and money owed to others; it is counted as owed (never inflates
// "Ours") and the reason says what is in it. A destination missing from this
// table is counted as owed and flagged, so a new destination can never land
// in "Ours" by accident (the registry test fails first).

const T = "programs/mwz_rewards_treasury/src";
const L = "programs/memewarzone_solana/src";

const ours = (reason) => ({ ownership: "ours", reason });
const owed = (reason, extra = {}) => ({ ownership: "owed", reason, ...extra });
const watch = (reason) => ({ ownership: "watch", reason });

export const SOLANA_OWNERSHIP = Object.freeze({
  protocol_vault: ours(`Treasury protocol_vault PDA. Its only exit is flush_operator_fill to the operator (up to the cap) and the Squads overflow (${T}/lib.rs:175-227).`),
  route_operator: ours(`route_state.operator: receives protocol_vault flushes up to the $10k cap (${T}/route.rs:84-114) and the import-swap platform fee (frontend/api/importSwap.js:27). Hot wallet; it also pays its own transaction fees.`),
  squads_vault: ours(`Squads multisig fk5Y…: route_state.overflow_treasury, protocol revenue above the operator cap (${T}/route.rs:84-114).`),
  league_weekly: owed(`Weekly league prizes, paid by posted league roots (${T}/route.rs:13-14).`),
  league_monthly: owed(`Monthly league prizes, paid by posted league roots (${T}/route.rs:13-14).`),
  mwl_vault: owed(`Major War League prizes, MWL monthly + quarterly roots (${T}/arena.rs:36-37).`),
  airdrop_vault: owed(`Weekly airdrop pot, paid by airdrop roots (${L}/authorized_trade.rs:1396-1433).`),
  recruiter_vault: owed(`Recruiter earnings, paid by weekly recruiter batch roots (${T}/route.rs:43-56).`),
  squad_vault: owed(`Squad slice of linked trades (${T}/route.rs:43-56). No attribution rule exists yet, so it accrues, but it is designated for squads, not the protocol.`),
  creator_fee_vaults: owed(`Per-campaign creator fee vaults, claimed by the creator (${L}/fee_escrow.rs:642-660). Not read.`),
  vote_treasury: ours("Paid UP votes are 100% protocol revenue: a plain System transfer with no payout path (frontend/api/dev-fix/solana-vote-ingest.js:160-166; counted as the upvotes revenue lane in admin/finance.js)."),
  lp_protocol_treasury: ours("Receives the protocol's 20% of post-graduation LP fees (realtime-indexer/src/solanaLpFees.ts:21-45, PROTOCOL_FEE_BPS 2000). The creator's 80% is paid to the creator wallet, not here."),
  dbc_fee_collector: owed("Meteora DBC partner fees before the re-split: most of it goes on to the league, recruiter, squad and airdrop vaults and, in platform mode, the creator's 7%; only the remainder is the protocol's (realtime-indexer/src/dbc/dbcFeeSplit.ts:7-60). Hot key that also pays its own fees.", { mixed: true }),
  dbc_referral: ours("Meteora referral fee on our swaps; the weekly sweep sends 100% of it to protocol_vault (realtime-indexer/src/dbc/dbcReferralSweep.ts:80-100)."),
  import_swap_fee_owner: ours("Jupiter platform fee on imported-coin swaps, 100% protocol (frontend/api/importSwap.js:20,27)."),
  deployer: watch("Deployer key: no fee path pays it and it must never hold user money (CLAUDE.md §1)."),
  devnet_deployer: watch("Devnet key HuKfoF: only an LP-harvest fallback when SOLANA_PROTOCOL_TREASURY_ADDRESS is unset (realtime-indexer/src/solanaLpFees.ts:25,32-45)."),
});

export const EVM_OWNERSHIP = Object.freeze({
  protocol_vault: ours("ProtocolRevenueVault: native forwards on receive() to the operator (up to $10k) and the Safe (contracts/ProtocolRevenueVault.sol:40-81). Wrapped LP shares stay in it: the vault has no ERC20 withdraw, so that part is ours but cannot be moved."),
  protocol_forwarder: ours("ProtocolRevenueForwarder: forwards native to the ProtocolRevenueVault on receive() and unwraps the LP protocol share into it through flush(); withdrawToken pays only the Safe (contracts/ProtocolRevenueForwarder.sol:88-124)."),
  protocol_operator: ours("ProtocolRevenueVault.operator / war pool operator fill: the first $10k of protocol revenue (contracts/ProtocolRevenueVault.sol:46-73)."),
  safe: ours("Safe multisig: ProtocolRevenueVault.overflowTreasury and ArenaWarPoolTreasuryV2.protocolReceiver (contracts/ArenaWarPoolTreasuryV2.sol claimProtocol). Airdrop recoveries pass through it to the community vault in one batch (scripts/make-airdrop-recovery-batch.ts)."),
  weekly_league: owed("Weekly league prizes, root-posted claims (contracts/TreasuryRouterV4.sol:475-480)."),
  monthly_league: owed("Monthly league prizes; sealed winner reserves cannot be withdrawn (contracts/MonthlyLeagueTreasury.sol:176-262)."),
  monthly_league_old: owed("Superseded monthly league treasury: anything left was routed as league prizes. The Safe can withdraw only the unallocated residual (contracts/MonthlyLeagueTreasury.sol:250-262)."),
  recruiter_vault: owed("Recruiter earnings, operator payout() (contracts/RecruiterRewardsVault.sol:54-72)."),
  community_vault: owed("Airdrop and squad pools, funds RewardDistributor batches (contracts/CommunityRewardsVault.sol:58-115)."),
  creator_vault_v2: owed("Creator / holder / buyback balances per campaign (contracts/CreatorRewardsVaultV2.sol:318-325)."),
  creator_vault_v1: owed("pendingCreatorFees per creator (contracts/CreatorRewardsVault.sol)."),
  post_grad_league: owed("Arena league share pending per epoch, claimed into the MWL vaults (contracts/PostGradLeagueTreasuryV2.sol:101-138)."),
  mwl_monthly: owed("MWL monthly prizes (TreasuryVaultV2 roots, epoch code 3)."),
  mwl_quarterly: owed("MWL quarterly prizes (TreasuryVaultV2 roots, epoch code 4)."),
  war_pool: owed("Stakes, boosts and unclaimed prizes per pool. Resolved pools also hold pendingProtocol until claimProtocol pays the operator / Safe (contracts/ArenaWarPoolTreasuryV2.sol:503-509,627-645), so the balance mixes our share with players' money.", { mixed: true }),
  airdrop_distributor: owed("Weekly airdrop batches until claimed; unclaimed goes back to the community vault (docs/claude/payouts-and-rewards.md, Airdrop)."),
  holder_distributor: owed("Holder reward batches funded from creator fees."),
  charity: owed("CharityTreasury: monthly league overflow above the USD cap (contracts/MonthlyLeagueTreasury.sol:189-211). Only the Safe can move it, but it is earmarked for charity, not protocol revenue."),
  event_prize: owed("Per-event prize pools, 70% of sponsorships (contracts/WarzoneSponsorshipRouterV1.sol:23-24)."),
  lp_locker: owed("Locker balances mix creators' pendingToken / pendingNative with the protocol's pendingProtocolToken / pendingProtocolNative (contracts/PermanentLpLocker.sol:98-101,403-455).", { mixed: true }),
  router_v4: owed("Should hold nothing: receive() and forward() send any stray balance to the weekly league vault (contracts/TreasuryRouterV4.sol:145-151,456-459)."),
  deployer: watch("Deploy key: no fee path pays it and it must never hold user money."),
});

/** Classification for one registry destination. Unknown ids are owed + flagged, never ours. */
export function destinationOwnership(chain, destination) {
  const table = chain === "solana" ? SOLANA_OWNERSHIP : EVM_OWNERSHIP;
  const entry = Object.prototype.hasOwnProperty.call(table, destination.id) ? table[destination.id] : null;
  if (destination.flags?.includes("watch")) {
    return { ownership: "watch", ownershipReason: entry?.ownership === "watch" ? entry.reason : "Watch-only key; not counted.", ownershipMixed: false };
  }
  if (!entry || entry.ownership === "watch") {
    return { ownership: "owed", ownershipReason: "Not classified yet; counted as not ours until it is.", ownershipMixed: false, ownershipUnclassified: true };
  }
  return { ownership: entry.ownership, ownershipReason: entry.reason, ownershipMixed: Boolean(entry.mixed) };
}
