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
