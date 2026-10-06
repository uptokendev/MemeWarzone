// What a buy must leave in the wallet, used by MAX / % presets and the check
// before signing.
//
// Solana: a bonding-curve buy spends every lamport entered on curve cost plus
// fee (quoteBuyExactSolIn). Rent for a new token account (0.00203928 SOL) and
// the network fee are paid on top. Same buffer as the graduated-token page
// (FEE_BUFFER_LAMPORTS in SolanaGraduatedTokenDetails). Only applies when the
// buy is paid in SOL; a quote-token buy pays fees from a different balance.
export const SOLANA_BUY_FEE_RESERVE_LAMPORTS = 5_000_000n;
export const SOLANA_BUY_FEE_RESERVE_SOL = 0.005;

// EVM: gas is paid in the same native coin the buy spends. Generous for a
// bonding or Topaz/Uniswap buy at current BSC and Robinhood gas prices.
export const BNB_BUY_GAS_RESERVE_WEI = 500_000_000_000_000n; // 0.0005 BNB
export const ETH_BUY_GAS_RESERVE_WEI = 200_000_000_000_000n; // 0.0002 ETH (Robinhood chain)

export function evmBuyGasReserveWei(isRobinhood: boolean): bigint {
  return isRobinhood ? ETH_BUY_GAS_RESERVE_WEI : BNB_BUY_GAS_RESERVE_WEI;
}

export function solanaBuyFeeMessage(maxSpendLamports: bigint): string {
  const max = Number(maxSpendLamports) / 1e9;
  const maxLabel = max > 0 ? ` You can buy with up to ${max.toFixed(6).replace(/\.?0+$/, "")} SOL.` : "";
  return `Not enough SOL. Keep about ${SOLANA_BUY_FEE_RESERVE_SOL} SOL in your wallet for the token account and network fee.${maxLabel}`;
}

// DBC creator buys are locked (ExactOut swap + Jupiter Lock escrow, src/lib/dbcLockedBuy.mjs): the swap
// wraps up to DBC_TRADE_SLIPPAGE_PCT (5%) above the quote, and the transaction also pays rent for the
// wrapped-SOL account, the escrow and its token account plus the network fee. A launch-party buy of
// 7.2 SOL from a 7.48 SOL wallet failed in simulation on exactly this (2026-10-06).
export const DBC_CREATOR_BUY_RESERVE_LAMPORTS = 15_000_000n; // 0.015 SOL
export const DBC_CREATOR_BUY_RESERVE_SOL = 0.015;
export const DBC_CREATOR_BUY_BUFFER_PCT = 5;
// MAX / % presets leave a little more, so a small price rise between quote and landing still fits.
export const DBC_CREATOR_MAX_HEADROOM_PCT = 8;

/** SOL to suggest for a DBC creator buy from this balance (with the MAX headroom). */
export function dbcCreatorMaxSpendLamports(balanceLamports: bigint): bigint {
  const afterReserve = balanceLamports - DBC_CREATOR_BUY_RESERVE_LAMPORTS;
  if (afterReserve <= 0n) return 0n;
  return (afterReserve * 100n) / BigInt(100 + DBC_CREATOR_MAX_HEADROOM_PCT);
}

/** SOL a DBC creator buy of `amountLamports` may take from the wallet at most. */
export function dbcCreatorBuyNeedLamports(amountLamports: bigint): bigint {
  return (amountLamports * BigInt(100 + DBC_CREATOR_BUY_BUFFER_PCT)) / 100n + DBC_CREATOR_BUY_RESERVE_LAMPORTS;
}

export function dbcCreatorBuyMessage(maxSpendLamports: bigint): string {
  const max = Number(maxSpendLamports) / 1e9;
  const maxLabel = max > 0 ? ` You can buy with up to ${max.toFixed(4).replace(/\.?0+$/, "")} SOL.` : "";
  return `Not enough SOL. A creator buy keeps ${DBC_CREATOR_BUY_BUFFER_PCT}% extra for price movement plus about ${DBC_CREATOR_BUY_RESERVE_SOL} SOL for the lock and network fees.${maxLabel}`;
}
