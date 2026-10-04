// A Solana bonding-curve buy spends every lamport entered on curve cost plus fee
// (quoteBuyExactSolIn). Rent for a new token account (0.00203928 SOL) and the
// network fee are paid on top, so buy MAX / % keeps this much back. Same buffer
// as the graduated-token page (FEE_BUFFER_LAMPORTS in SolanaGraduatedTokenDetails).
export const SOLANA_BUY_FEE_RESERVE_LAMPORTS = 5_000_000n;
export const SOLANA_BUY_FEE_RESERVE_SOL = 0.005;
