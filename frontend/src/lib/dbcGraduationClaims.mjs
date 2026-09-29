/**
 * Creator-signed DBC graduation claims: 90% migration payout, 2% reserve locker,
 * 80% DAMM LP fees. Same sign-time checks as step 3 (fresh blockhash, allowlist,
 * simulate without a config object).
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  DynamicBondingCurveClient,
  deriveBaseKeyForLocker,
  deriveDammV2PoolAddress,
  deriveEscrow,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, getTokenProgram, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE } from "../../shared/dbcEconomics.mjs";
import { buildClaimVestingInstruction } from "./dbcJupiterLock.mjs";
import { DBC_TRADE_ALLOWED_PROGRAM_IDS, DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS } from "./dbcTrade.mjs";

export const METEORA_CP_AMM_PROGRAM_ID = DAMM_V2_PROGRAM_ID || "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

export const DBC_CREATOR_CLAIM_EXTRA_PROGRAMS = [
  String(METEORA_CP_AMM_PROGRAM_ID),
  TOKEN_PROGRAM_ID.toBase58(),
];

export function creatorClaimAllowedPrograms() {
  return new Set([
    ...DBC_TRADE_ALLOWED_PROGRAM_IDS,
    ...DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS,
    ...DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
  ]);
}

export function deriveDbcLockerEscrow(pool) {
  return deriveEscrow(deriveBaseKeyForLocker(new PublicKey(pool)));
}

/** The DAMM v2 pool a DBC coin graduates into: its mint against the coin's quote (SOL unless bound). */
export function deriveDbcDammPool(mint, quoteMint = NATIVE_MINT) {
  const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[DBC_MIGRATION_FEE_OPTION_CUSTOMIZABLE]);
  return deriveDammV2PoolAddress(dammConfig, new PublicKey(mint), new PublicKey(quoteMint));
}

function unwrapPool(wrap) {
  return wrap?.poolState ?? wrap;
}

export async function loadCreatorRewards(connection, { pool, creator, includeLp = true }) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const poolPk = new PublicKey(pool);
  const wrap = await client.state.getPool(poolPk);
  const state = unwrapPool(wrap);
  if (!state) throw new Error("DBC pool is not on chain.");
  const creatorPk = new PublicKey(creator);
  const withdrawn = (Number(state.migrationFeeWithdrawStatus ?? state.migration_fee_withdraw_status ?? 0) & 0b010) !== 0;
  const migrated = Number(state.isMigrated ?? state.is_migrated) === 1;
  const cfgWrap = await client.state.getPoolConfig(state.config);
  const cfg = cfgWrap?.poolConfig ?? cfgWrap;
  const threshold = BigInt(String(cfg?.migrationQuoteThreshold ?? cfg?.migration_quote_threshold ?? 0));
  const intoPool = (threshold * 78n + 99n) / 100n;
  const fee = threshold - intoPool;
  // The migration fee only exists once the pool has migrated; before that this is the expected
  // amount, shown but not claimable.
  const graduationPayout = withdrawn ? 0n : (fee * 90n) / 100n;
  const graduationPayoutClaimable = migrated && !withdrawn && graduationPayout > 0n;
  const mint = String(state.baseMint?.toBase58?.() || state.base_mint || "");
  const locker = deriveDbcLockerEscrow(poolPk);
  let reserve = 0n;
  try {
    const info = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(mint), locker, true));
    reserve = BigInt(info.value.amount);
  } catch {
    reserve = 0n;
  }
  let lpFees = 0n;
  let dammPool = "";
  let position = null;
  const quoteMint = new PublicKey(cfg?.quoteMint || NATIVE_MINT);
  if (includeLp && migrated && mint) {
    dammPool = deriveDbcDammPool(mint, quoteMint).toBase58();
    const cpAmm = new CpAmm(connection);
    try {
      const positions = await cpAmm.getUserPositionByPool(new PublicKey(dammPool), creatorPk);
      if (positions.length) {
        position = positions[0];
        const dpool = await cpAmm.fetchPoolState(new PublicKey(dammPool));
        const unclaimed = getUnClaimLpFee(dpool, position.positionState);
        lpFees = BigInt(String(
          dpool.tokenBMint.equals(quoteMint) ? (unclaimed?.feeTokenB ?? unclaimed?.feeQuote ?? 0) : (unclaimed?.feeTokenA ?? 0),
        ));
      }
    } catch {
      lpFees = 0n;
    }
  }
  return {
    pool: String(pool),
    mint,
    creator: creatorPk.toBase58(),
    migrated,
    graduationPayout: graduationPayout.toString(),
    graduationPayoutClaimable,
    reserve: reserve.toString(),
    lpFees: lpFees.toString(),
    locker: locker.toBase58(),
    dammPool,
    quoteMint: quoteMint.toBase58(),
    position: position ? String(position.position) : null,
  };
}

export async function buildGraduationPayoutTransaction({ connection, pool, creator }) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const tx = await client.creator.creatorWithdrawMigrationFee({
    pool: new PublicKey(pool),
    sender: new PublicKey(creator),
  });
  tx.feePayer = new PublicKey(creator);
  return tx;
}

export async function buildReserveClaimTransaction({ connection, mint, creator, locker }) {
  const mintPk = new PublicKey(mint);
  const recipient = new PublicKey(creator);
  const escrow = new PublicKey(locker);
  const recipientToken = getAssociatedTokenAddressSync(mintPk, recipient);
  const escrowToken = getAssociatedTokenAddressSync(mintPk, escrow, true);
  let maxAmount;
  if (connection) {
    try {
      const bal = await connection.getTokenAccountBalance(escrowToken);
      maxAmount = BigInt(bal.value.amount);
    } catch {
      maxAmount = undefined;
    }
  }
  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      recipient,
      recipientToken,
      recipient,
      mintPk,
    ),
    buildClaimVestingInstruction({
      escrow,
      escrowToken,
      recipient,
      recipientToken,
      maxAmount,
    }),
  );
  tx.feePayer = recipient;
  return tx;
}

export async function buildCreatorLpFeeTransaction({ connection, dammPool, creator }) {
  const cpAmm = new CpAmm(connection);
  const owner = new PublicKey(creator);
  const poolPk = new PublicKey(dammPool);
  const positions = await cpAmm.getUserPositionByPool(poolPk, owner);
  if (!positions.length) throw new Error("Creator has no DAMM v2 position.");
  const pos = positions[0];
  const dpool = await cpAmm.fetchPoolState(poolPk);
  const tx = await cpAmm.claimPositionFee({
    owner,
    position: pos.position,
    pool: poolPk,
    positionNftAccount: pos.positionNftAccount,
    tokenAMint: dpool.tokenAMint,
    tokenBMint: dpool.tokenBMint,
    tokenAVault: dpool.tokenAVault,
    tokenBVault: dpool.tokenBVault,
    // A stock-bound pool holds a Token-2022 side; the pool records which program each side uses.
    tokenAProgram: getTokenProgram(dpool.tokenAFlag),
    tokenBProgram: getTokenProgram(dpool.tokenBFlag),
    feePayer: owner,
  });
  tx.feePayer = owner;
  return tx;
}
