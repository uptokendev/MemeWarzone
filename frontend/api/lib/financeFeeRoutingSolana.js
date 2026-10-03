// Solana (chain 101, mainnet-beta) fee routing registry for the finance view.
//
// Source of truth is the program code; every split below cites the line it was
// read from (repo paths, HEAD 127c09da). Treasury PDAs are derived from their
// seeds at runtime, never typed in. Live wiring (who route_state, arena_config
// and arena_money_config_v2 actually pay) is read from chain by the caller and
// compared with what this registry expects.

import { PublicKey } from "@solana/web3.js";

export const SOLANA_TREASURY_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";
export const SOLANA_LAUNCHPAD_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
export const SOLANA_SQUADS_VAULT = "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv";
export const SOLANA_DEPLOYER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
export const SOLANA_DEVNET_DEPLOYER = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
export const SOLANA_ROUTE_OPERATOR = "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const VAULT_SEEDS = Object.freeze({
  rewardsConfig: "rewards_config",
  leagueWeekly: "league_vault",
  leagueMonthly: "monthly_league_vault",
  mwl: "mwl_vault",
  airdrop: "airdrop_vault",
  recruiter: "recruiter_vault",
  squad: "squad_vault",
  protocol: "protocol_vault",
  routeState: "route_state",
  arenaConfig: "arena_config",
  arenaMoneyV2: "arena_money_config_v2",
});

export function deriveSolanaTreasuryPdas(programId = SOLANA_TREASURY_PROGRAM_ID) {
  const program = new PublicKey(programId);
  const out = {};
  for (const [key, seed] of Object.entries(VAULT_SEEDS)) {
    out[key] = PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0].toBase58();
  }
  return out;
}

function firstEnv(env, ...names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function validPubkey(value) {
  try {
    return value ? new PublicKey(value).toBase58() : "";
  } catch {
    return "";
  }
}

const T = "programs/mwz_rewards_treasury/src";
const L = "programs/memewarzone_solana/src";

/**
 * Registry for Solana mainnet. `env` supplies the off-chain receivers that are
 * configuration, not program state (vote treasury, LP protocol treasury, DBC
 * collector). Missing env means "not configured", never a guessed address.
 */
export function solanaFeeRoutingRegistry(env = process.env) {
  const pda = deriveSolanaTreasuryPdas();
  const voteTreasury = validPubkey(firstEnv(env, "SOLANA_MAINNET_VOTE_TREASURY_ADDRESS", "SOLANA_VOTE_TREASURY_ADDRESS", "VOTE_TREASURY_ADDRESS_101", "VITE_VOTE_TREASURY_ADDRESS_101", "VITE_SOLANA_VOTE_TREASURY_ADDRESS"));
  const lpProtocolTreasury = validPubkey(firstEnv(env, "FINANCE_SOLANA_LP_PROTOCOL_TREASURY_ADDRESS", "SOLANA_MAINNET_PROTOCOL_TREASURY_ADDRESS", "SOLANA_PROTOCOL_TREASURY_ADDRESS"));
  const dbcCollector = validPubkey(firstEnv(env, "DBC_FEE_COLLECTOR"));
  const dbcReferral = validPubkey(firstEnv(env, "DBC_REFERRAL_TOKEN_ACCOUNT", "DBC_REFERRAL_TOKEN_ACCOUNTS").split(",")[0]);
  const importSwapOwner = validPubkey(firstEnv(env, "SOLANA_IMPORT_SWAP_FEE_OWNER")) || SOLANA_ROUTE_OPERATOR;

  const destinations = [
    { id: "protocol_vault", label: "Protocol vault (PDA)", kind: "pda", address: pda.protocol, custody: "Treasury program; leaves only via permissionless flush_operator_fill", role: "Protocol share of trade, graduation, arena and sponsorship fees", citation: `${T}/lib.rs:8-26 (seed protocol_vault), lib.rs:175-227`, assets: ["native"] },
    { id: "route_operator", label: "Operator fill wallet", kind: "wallet", address: SOLANA_ROUTE_OPERATOR, custody: "route_state.operator (hot wallet)", role: "Receives protocol_vault flushes until the $10k cap is filled; also import-swap fee owner by default", citation: `${T}/route.rs:15,84-114; frontend/api/importSwap.js:27`, assets: ["native", "wsol"] },
    { id: "squads_vault", label: "Squads multisig vault", kind: "multisig", address: SOLANA_SQUADS_VAULT, custody: "Squads 2-of-3 (route_state.overflow_treasury)", role: "Protocol revenue above the operator cap", citation: "docs/claude/solana-programs.md:426-428", assets: ["native"] },
    { id: "league_weekly", label: "Weekly league vault (PDA)", kind: "pda", address: pda.leagueWeekly, custody: "Treasury program; paid by posted league roots", role: "30% of the league slice", citation: `${T}/route.rs:13-14`, assets: ["native"] },
    { id: "league_monthly", label: "Monthly league vault (PDA)", kind: "pda", address: pda.leagueMonthly, custody: "Treasury program; paid by posted league roots", role: "70% of the league slice", citation: `${T}/route.rs:13-14`, assets: ["native"] },
    { id: "mwl_vault", label: "Major War League vault (PDA)", kind: "pda", address: pda.mwl, custody: "Treasury program; MWL monthly + quarterly roots", role: "20% of arena entries (arena_config.mwl_receiver)", citation: `${T}/lib.rs:18,56-63; ${T}/arena.rs:36-37`, assets: ["native"] },
    { id: "airdrop_vault", label: "Airdrop / community vault (PDA)", kind: "pda", address: pda.airdrop, custody: "Treasury program; weekly airdrop roots", role: "Recruiter slice of unlinked trades (15%) and finalizes (17.5%)", citation: `${L}/authorized_trade.rs:1396-1433`, assets: ["native"] },
    { id: "recruiter_vault", label: "Recruiter vault (PDA)", kind: "pda", address: pda.recruiter, custody: "Treasury program; weekly recruiter batch roots", role: "12.5% of linked trades (OG 15%)", citation: `${T}/route.rs:43-56`, assets: ["native"] },
    { id: "squad_vault", label: "Squad vault (PDA)", kind: "pda", address: pda.squad, custody: "Treasury program; one global vault", role: "2.5% of linked trades; no attribution rule yet, slices accrue", citation: `${T}/route.rs:43-56; docs/claude/payouts-and-rewards.md:81`, assets: ["native"] },
    { id: "creator_fee_vaults", label: "Creator fee vaults (per campaign)", kind: "pda-set", address: null, custody: "Launchpad PDA [creator-fee-vault, campaign] per coin; creator claims", role: "5% of every trade fee", citation: `${L}/fee_escrow.rs:19-21,642-660`, assets: [] },
    { id: "vote_treasury", label: "UP vote treasury", kind: "wallet", address: voteTreasury || null, custody: "Plain System transfer with memo mwz-upvote:<campaign>", role: "Paid UP votes", citation: "frontend/api/lib/arenaVoteTreasury.js:34-40", assets: ["native"], missingEnv: "SOLANA_MAINNET_VOTE_TREASURY_ADDRESS" },
    { id: "lp_protocol_treasury", label: "LP-fee protocol treasury", kind: "wallet", address: lpProtocolTreasury || null, custody: "Indexer env SOLANA_PROTOCOL_TREASURY_ADDRESS", role: "20% of post-graduation LP fees", citation: "realtime-indexer/src/solanaLpFees.ts:21-45", assets: ["native", "wsol"], missingEnv: "FINANCE_SOLANA_LP_PROTOCOL_TREASURY_ADDRESS" },
    { id: "dbc_fee_collector", label: "Meteora DBC fee collector", kind: "wallet", address: dbcCollector || null, custody: "Hot key DBC_FEE_COLLECTOR_SECRET (indexer); partner feeClaimer + leftoverReceiver", role: "Partner share of DBC fees before re-split to the treasury PDAs", citation: "frontend/api/lib/dbc/dbcConfigLadder.js:232-236; realtime-indexer/src/dbc/dbcFeeRouter.ts", assets: ["native", "wsol"], missingEnv: "DBC_FEE_COLLECTOR" },
    { id: "dbc_referral", label: "Meteora DBC referral token account", kind: "token-account", address: dbcReferral || null, custody: "WSOL account; swept weekly to protocol_vault", role: "20% of Meteora's cut on swaps made on our site", citation: "realtime-indexer/src/dbc/dbcReferralSweep.ts:80-100", assets: ["native"], missingEnv: "DBC_REFERRAL_TOKEN_ACCOUNT" },
    { id: "deployer", label: "Deployer (watch only)", kind: "wallet", address: SOLANA_DEPLOYER, custody: "Founder key; holds rewards_config / route_state / arena authority", role: "Must never hold user money. No fee path in program code pays it.", citation: "CLAUDE.md §1; docs/claude/solana-programs.md:415", assets: ["native"], flags: ["deployer", "watch"] },
    { id: "devnet_deployer", label: "Devnet deployer HuKfoF (watch only)", kind: "wallet", address: SOLANA_DEVNET_DEPLOYER, custody: "Devnet key", role: "Indexer LP harvest falls back to this key when SOLANA_PROTOCOL_TREASURY_ADDRESS is unset", citation: "realtime-indexer/src/solanaLpFees.ts:25,32-45", assets: ["native", "wsol"], flags: ["devnet-key", "watch"] },
  ];
  if (importSwapOwner !== SOLANA_ROUTE_OPERATOR) {
    destinations.push({ id: "import_swap_fee_owner", label: "Import swap fee owner", kind: "wallet", address: importSwapOwner, custody: "SOLANA_IMPORT_SWAP_FEE_OWNER", role: "Jupiter platform fee on import swaps", citation: "frontend/api/importSwap.js:20,27", assets: ["native", "wsol"] });
  }
  const importSwapDest = importSwapOwner === SOLANA_ROUTE_OPERATOR ? "route_operator" : "import_swap_fee_owner";

  const flows = [
    {
      id: "sol_trade",
      label: "Bonding-curve buy / sell",
      trigger: "Every buy and sell on the launchpad curve",
      router: `Launchpad ${SOLANA_LAUNCHPAD_PROGRAM_ID} → per-campaign fee escrow → flush_campaign_fees`,
      totalFee: "2% of trade (LOCKED_BUY/SELL_FEE_BPS = 200)",
      status: "live",
      splits: [
        { destinationId: "league_weekly", share: "11.25%", note: "37.5% league x 30% weekly" },
        { destinationId: "league_monthly", share: "26.25%", note: "37.5% league x 70% monthly" },
        { destinationId: "creator_fee_vaults", share: "5%" },
        { destinationId: "recruiter_vault", share: "12.5% linked / 15% OG / 0% unlinked" },
        { destinationId: "squad_vault", share: "2.5% linked + OG / 0% unlinked" },
        { destinationId: "airdrop_vault", share: "15% unlinked only" },
        { destinationId: "protocol_vault", share: "42.5% (OG 40%), remainder" },
      ],
      citation: `${L}/lib.rs:50-54; ${L}/authorized_trade.rs:1396-1433; ${T}/route.rs:13-14,43-56`,
      notes: [
        "Buy/sell only accrue into the campaign's fee escrow (FeeSlicesAccrued); the permissionless flush moves the six slices to the vaults (FeeEscrowFlushed). Escrowed lamports are in transit and appear in no vault balance.",
        "The creator 5% stays in the escrow as surplus until claim_creator_fees.",
      ],
    },
    {
      id: "sol_graduation",
      label: "Graduation (finalize fee)",
      trigger: "begin_graduation by the treasury operator keeper",
      router: "Launchpad graduation.rs route_fee_slices (FeeSlicesRouted)",
      totalFee: "2% of net raised (LOCKED_FINALIZE_FEE_BPS = 200); remainder 80% liquidity / 20% creator",
      status: "live",
      splits: [
        { destinationId: "recruiter_vault", share: "15% linked / 17.5% OG" },
        { destinationId: "squad_vault", share: "2.5% linked + OG" },
        { destinationId: "airdrop_vault", share: "17.5% unlinked only" },
        { destinationId: "protocol_vault", share: "82.5% (OG 80%), remainder" },
      ],
      citation: `${L}/graduation.rs:808-816,873; ${L}/lib.rs:70-71; ${T}/route.rs:51-55`,
      notes: ["No league or creator slice on finalize."],
    },
    {
      id: "sol_protocol_flush",
      label: "Protocol vault drain",
      trigger: "flush_operator_fill (permissionless; indexer worker hourly at >= 0.05 SOL)",
      router: `route_state ${pda.routeState}`,
      totalFee: "100% of protocol_vault",
      status: "live",
      splits: [
        { destinationId: "route_operator", share: "Up to the $10,000 cap (OPERATOR_FILL_CAP_USD_MICROS)", note: "Converted with route_state.native_usd_micros" },
        { destinationId: "squads_vault", share: "Everything above the cap (overflow_treasury)" },
      ],
      citation: `${T}/lib.rs:175-227; ${T}/route.rs:15,84-114; realtime-indexer/src/solanaProtocolFlush.ts:18`,
      notes: ["Live operator, overflow and cap fill are read from route_state below."],
    },
    {
      id: "sol_lp_fees",
      label: "LP fees after graduation",
      trigger: "Indexer LP harvest (SOLANA_LP_HARVEST_AUTO, or the manual collect route)",
      router: "Keeper-owned locked positions → realtime-indexer solanaLpFees.ts",
      totalFee: "Pool LP fee",
      status: "live (off-chain split)",
      splits: [
        { destinationId: "creator_fee_vaults", share: "80% to the creator", note: "Paid to the creator wallet, not the campaign vault" },
        { destinationId: "lp_protocol_treasury", share: "20% (CREATOR_FEE_BPS 8000 / PROTOCOL_FEE_BPS 2000)" },
      ],
      citation: "realtime-indexer/src/solanaLpFees.ts:21-45",
      notes: ["If SOLANA_PROTOCOL_TREASURY_ADDRESS is unset on the indexer, the 20% falls back to SOLANA_VOTE_TREASURY_ADDRESS, then to devnet key HuKfoF. The auto loop refuses to start without it; the manual collect route (lpFeesRoutes.ts:673-693) does not check."],
    },
    {
      id: "sol_arena",
      label: "Arena battles (entries and boosts)",
      trigger: "Arena pool stake / buy-in / boost, claimed after resolution",
      router: `arena_config ${pda.arenaConfig}`,
      totalFee: "Entry: 25% taken; boost: 10% taken",
      status: "live",
      splits: [
        { destinationId: "mwl_vault", share: "20% of entries (ARENA_MWL_BPS 2000)", note: "arena_config.mwl_receiver" },
        { destinationId: "protocol_vault", share: "5% of entries + 10% of boosts", note: "arena_config.protocol_receiver" },
      ],
      citation: `${T}/arena.rs:36-41,694-699,903,917`,
      notes: ["75% of entries and 90% of boosts are the prize, held in each pool's arena_vault until claimed."],
    },
    {
      id: "sol_sponsorship",
      label: "Event sponsorships",
      trigger: "Sponsor payment into arena_money_v2",
      router: `arena_money_config_v2 ${pda.arenaMoneyV2}`,
      totalFee: "30% taken",
      status: "live",
      splits: [
        { destinationId: "protocol_vault", share: "20% marketing + 10% protocol", note: "marketing_receiver and protocol_receiver (both protocol_vault on mainnet)" },
      ],
      citation: `${T}/arena_money_v2/sponsorship.rs:11-13,162,176`,
      notes: ["70% goes to the event prize vault, then to the event receiver."],
    },
    {
      id: "sol_upvotes",
      label: "Paid UP votes",
      trigger: "Vote payment (System transfer + memo)",
      router: "No program; direct transfer",
      totalFee: "100% of the vote price",
      status: voteTreasury ? "live" : "receiver not configured on this API",
      splits: [{ destinationId: "vote_treasury", share: "100%" }],
      citation: "frontend/api/dev-fix/solana-vote-ingest.js:85,160-166; frontend/api/lib/arenaVoteTreasury.js:34-40",
      notes: [],
    },
    {
      id: "sol_import_swaps",
      label: "Imported-coin swaps",
      trigger: "Swap through Jupiter from an imported coin page",
      router: "Jupiter platform fee",
      totalFee: "0.5% (IMPORT_SWAP_FEE_BPS default 50)",
      status: "live",
      splits: [{ destinationId: importSwapDest, share: "100% of the platform fee, as WSOL" }],
      citation: "frontend/api/importSwap.js:20,27",
      notes: [],
    },
    {
      id: "sol_dbc",
      label: "Meteora DBC trades",
      trigger: "Every swap on a DBC launch",
      router: "Meteora DBC pool → partner claim by the collector → dbcFeeRouter System transfers",
      totalFee: "2% of trade (90% anti-sniper falling to 2% over 60 s)",
      status: "live",
      splits: [
        { destinationId: "dbc_fee_collector", share: "80% of the fee, less the creator's 7% of it", note: "Meteora keeps 20%" },
        { destinationId: "dbc_referral", share: "20% of Meteora's cut when the swap names our referral account" },
        { destinationId: "creator_fee_vaults", share: "7% of the post-Meteora 80% (5.6% of the fee)", note: "Paid by Meteora's creator claim, or held on the collector in platform mode" },
        { destinationId: "league_weekly", share: "11.25% of the whole fee", note: "Re-split from the collector with the launchpad bps" },
        { destinationId: "league_monthly", share: "26.25% of the whole fee" },
        { destinationId: "recruiter_vault", share: "12.5% linked / 15% OG" },
        { destinationId: "squad_vault", share: "2.5% linked + OG" },
        { destinationId: "airdrop_vault", share: "15% unlinked" },
        { destinationId: "protocol_vault", share: "Remainder of what the collector received" },
      ],
      citation: "frontend/shared/dbcEconomics.mjs:52-104; realtime-indexer/src/dbc/dbcFeeSplit.ts:7-60; docs/claude/meteora-dbc.md",
      notes: [
        "Migration fee 22% of the threshold, split 90% creator / 10% partner. Graduated DAMM v2 LP fees 80% creator / 20% partner.",
        "The referral account is swept weekly into protocol_vault.",
      ],
    },
  ];

  return { pda, destinations, flows };
}

function readPubkeyAt(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

/** RouteState: 8 disc, authority, operator, overflow_treasury, cap, filled, native_usd_micros, bump (lib.rs:1210-1218). */
export function decodeRouteState(data) {
  if (!data || data.length < 8 + 32 * 3 + 24) throw new Error("route_state account is too short.");
  return {
    authority: readPubkeyAt(data, 8),
    operator: readPubkeyAt(data, 40),
    overflowTreasury: readPubkeyAt(data, 72),
    capUsdMicros: data.readBigUInt64LE(104).toString(),
    filledUsdMicros: data.readBigUInt64LE(112).toString(),
    nativeUsdMicros: data.readBigUInt64LE(120).toString(),
  };
}

/** ArenaConfig: 8 disc, authority, resolver, protocol_receiver, mwl_receiver, deposits_paused (arena.rs:962-966). */
export function decodeArenaConfig(data) {
  if (!data || data.length < 8 + 32 * 4 + 1) throw new Error("arena_config account is too short.");
  return {
    authority: readPubkeyAt(data, 8),
    protocolReceiver: readPubkeyAt(data, 72),
    mwlReceiver: readPubkeyAt(data, 104),
    depositsPaused: data[136] === 1,
  };
}

/** ArenaMoneyConfigV2: 8 disc, generation u8, authority, resolver, protocol_receiver, marketing_receiver, paused (config.rs:9-17). */
export function decodeArenaMoneyV2(data) {
  if (!data || data.length < 8 + 1 + 32 * 4 + 1) throw new Error("arena_money_config_v2 account is too short.");
  return {
    authority: readPubkeyAt(data, 9),
    protocolReceiver: readPubkeyAt(data, 73),
    marketingReceiver: readPubkeyAt(data, 105),
    paused: data[137] === 1,
  };
}

/** RewardsConfig: 8 disc, authority, ... (lib.rs RewardsConfig). */
export function decodeRewardsConfigAuthority(data) {
  if (!data || data.length < 40) throw new Error("rewards_config account is too short.");
  return readPubkeyAt(data, 8);
}
