import { findProgramAddressSync, publicKeyBytes } from "../dev-fix/solana-v4-primitives.js";

/**
 * Pure arithmetic for the creator's claimable fees. No database, no RPC, so
 * it can be unit-tested and run against raw account bytes.
 *
 * The creator's 5% is the seventh bucket of the campaign's fee collector
 * (FeeEscrow) and has no counter of its own: whatever the escrow holds above
 * its rent and the six pending league/recruiter/airdrop/squad/protocol slices
 * is the creator's, by construction (slices_sum == fee_lamports on every
 * trade, flush only ever spends the six). Campaigns that traded before V7.1
 * also hold real lamports in their CreatorFeeVault; claim_creator_fees drains
 * that first, so it is counted here too. This mirrors
 * claim_creator_fees_handler exactly so the page shows what the instruction
 * will pay.
 */

export const SOLANA_LAUNCHPAD_PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";

// 8 + FeeEscrow::INIT_SPACE and 8 + CreatorFeeVault::INIT_SPACE, pinned by
// fee_escrow_account_size_is_stable / creator_fee_vault_account_size_is_stable.
export const FEE_ESCROW_BYTES = 106;
export const CREATOR_FEE_VAULT_BYTES = 98;
// FeeEscrow: discriminator, campaign, then six u64 pending slices.
const PENDING_OFFSET = 8 + 32;
const PENDING_LANES = 6;

export function deriveCampaignFeeAccounts(campaignAddress, programId = SOLANA_LAUNCHPAD_PROGRAM_ID) {
  const campaign = publicKeyBytes(campaignAddress, "campaign");
  return {
    feeEscrow: findProgramAddressSync([Buffer.from("fee-escrow", "utf8"), campaign], programId).publicKey,
    creatorFeeVault: findProgramAddressSync([Buffer.from("creator-fee-vault", "utf8"), campaign], programId).publicKey,
  };
}

export function decodeRpcAccount(raw) {
  if (!raw || !raw.data) return null;
  const data = Buffer.from(raw.data[0] || "", "base64");
  return { lamports: BigInt(raw.lamports || 0), owner: String(raw.owner || ""), data };
}

function pendingSum(data) {
  let sum = 0n;
  for (let lane = 0; lane < PENDING_LANES; lane += 1) {
    sum += data.readBigUInt64LE(PENDING_OFFSET + lane * 8);
  }
  return sum;
}

function surplus(lamports, reserved) {
  return lamports > reserved ? lamports - reserved : 0n;
}

export function computeCreatorFeeClaimable({ escrow, vault, escrowRent, vaultRent, programId }) {
  const escrowOk = Boolean(escrow && escrow.owner === programId && escrow.data.length === FEE_ESCROW_BYTES);
  const vaultOk = Boolean(vault && vault.owner === programId && vault.data.length === CREATOR_FEE_VAULT_BYTES);
  const escrowSurplus = escrowOk ? surplus(escrow.lamports, BigInt(escrowRent) + pendingSum(escrow.data)) : 0n;
  const vaultSurplus = vaultOk ? surplus(vault.lamports, BigInt(vaultRent)) : 0n;
  return {
    escrowInitialized: escrowOk,
    vaultInitialized: vaultOk,
    escrowSurplusLamports: escrowSurplus,
    vaultSurplusLamports: vaultSurplus,
    claimableLamports: escrowSurplus + vaultSurplus,
  };
}

export function lamportsToSol(value) {
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
