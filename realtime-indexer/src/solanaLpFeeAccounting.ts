export const CREATOR_FEE_BPS = 8000n;
export const PROTOCOL_FEE_BPS = 2000n;
export const BPS = 10_000n;

export type GrossClaimEvidence = {
  label: string;
  preVaultAmount: bigint;
  postVaultAmount: bigint;
  pendingBefore?: bigint;
};

export type GrossClaimSplit = {
  gross: bigint;
  creator: bigint;
  protocol: bigint;
};

export function splitGrossClaim(total: bigint): GrossClaimSplit {
  if (total < 0n) throw new Error("gross claim cannot be negative");
  const creator = (total * CREATOR_FEE_BPS) / BPS;
  const protocol = total - creator;
  if (creator + protocol !== total) throw new Error("80/20 split does not conserve gross claim");
  return { gross: total, creator, protocol };
}

export function deriveGrossClaimFromVaultMovement(input: GrossClaimEvidence): GrossClaimSplit {
  const { label, preVaultAmount, postVaultAmount, pendingBefore } = input;
  if (preVaultAmount < 0n || postVaultAmount < 0n) {
    throw new Error(`${label}: vault balance evidence cannot be negative`);
  }
  if (postVaultAmount > preVaultAmount) {
    throw new Error(`${label}: claim source vault increased during claim; evidence is not a fee withdrawal`);
  }
  const gross = preVaultAmount - postVaultAmount;
  if (pendingBefore != null && pendingBefore > 0n && gross === 0n) {
    throw new Error(`${label}: positive pre-claim entitlement produced zero authoritative vault movement`);
  }
  if (pendingBefore != null && gross > 0n && gross < pendingBefore) {
    throw new Error(`${label}: authoritative vault movement is smaller than pre-claim entitlement`);
  }
  if (pendingBefore != null && gross > pendingBefore) {
    throw new Error(`${label}: authoritative vault movement is larger than pre-claim entitlement`);
  }
  return splitGrossClaim(gross);
}

export function verifyClaimAssetEffect(input: {
  label: string;
  gross: bigint;
  native: boolean;
  operatorAssetDelta: bigint;
  transactionFeeLamports?: bigint;
}): void {
  const { label, gross, native, operatorAssetDelta, transactionFeeLamports = 0n } = input;
  if (gross === 0n) {
    if (operatorAssetDelta > 0n) throw new Error(`${label}: zero gross claim produced positive operator asset custody`);
    return;
  }
  if (native) {
    const feeAdjustedReceipt = operatorAssetDelta + transactionFeeLamports;
    if (feeAdjustedReceipt < gross) {
      throw new Error(`${label}: WSOL unwrap effect does not cover authoritative gross claim`);
    }
    return;
  }
  if (operatorAssetDelta < gross) {
    throw new Error(`${label}: SPL claim receiver effect is smaller than authoritative gross claim`);
  }
}
