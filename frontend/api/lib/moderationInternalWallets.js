// Internal wallets: keys and accounts that belong to MemeWarzone itself
// (founders, deployers, operators, multisigs, protocol vaults). One list, so
// the moderation view flags a prize or a recruiter payout that lands on one of
// them. Read-only reference data: nothing here signs or moves money.
//
// Sources: CLAUDE.md (deployer, multisig), docs/claude/solana-devnet-step1.md
// (devnet deployer HuKfoF), docs/claude/battles.md + solana-programs.md
// (Solana treasury operator 2AMfRaxS, route signer, multisig), docs/claude/
// payouts-and-rewards.md (EVM operator EOA, Solana UP vote treasury),
// deployments/*.json (EVM deployers and the Safe).
//
// More can be added without a deploy of this file through
// MODERATION_INTERNAL_WALLETS (comma separated, optional "address:label").

export const INTERNAL_WALLETS = Object.freeze([
  // Solana
  { address: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H", chain: "solana", label: "Solana mainnet deployer (founder key, multisig member)" },
  { address: "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9", chain: "solana", label: "Solana devnet deployer (founder key)" },
  { address: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB", chain: "solana", label: "Solana treasury operator (protocol fee flush)" },
  { address: "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv", chain: "solana", label: "Squads multisig vault" },
  { address: "C43Ddmgt3iC9PTeHLyiQvtUtFAXC7U2v3d7KyzdF5YzY", chain: "solana", label: "Squads multisig account" },
  { address: "7hKQd798Z1ERmRUhm7shmstB1V13FQNnDLqtYjZBuJUz", chain: "solana", label: "Solana route signer" },
  { address: "4AjT4LkVuf9mrgoPN4KisZnKKQwiPw7JbMUJckBEhy8j", chain: "solana", label: "Solana UP vote treasury" },
  { address: "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que", chain: "solana", label: "Solana protocol receiver" },
  { address: "68FNNeXDMAU8XaJsNYL4VFY2YnprnE36LCncCm8uRyJg", chain: "solana", label: "Solana MWL receiver" },
  // EVM (BNB 56, Robinhood 4663)
  { address: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714", chain: "evm", label: "EVM mainnet deployer (BNB + Robinhood)" },
  { address: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7", chain: "evm", label: "EVM Safe (owner of the mainnet contracts)" },
  { address: "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50", chain: "evm", label: "EVM payout operator EOA" },
  { address: "0x1A367016f10b230E28Cf1ABda2594C47bf60fe34", chain: "evm", label: "BNB mainnet factory deployer (phase A, founder key)" },
  { address: "0x13AD79765e14927dF2c554d9662Bbe539e89C8e8", chain: "evm", label: "BNB testnet deployer (founder key)" },
  { address: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", chain: "evm", label: "ProtocolRevenueVault" },
]);

function envWallets(env) {
  return String(env?.MODERATION_INTERNAL_WALLETS || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [address, ...rest] = part.split(":");
      return { address: address.trim(), chain: address.trim().startsWith("0x") ? "evm" : "solana", label: rest.join(":").trim() || "Internal wallet (MODERATION_INTERNAL_WALLETS)" };
    })
    .filter((row) => row.address);
}

/**
 * Map of lower-cased address -> { address, chain, label }. Lower-cased on
 * purpose: recruiters.wallet_address stores Solana keys lower-cased, so a
 * case-sensitive compare would miss them.
 */
export function internalWalletIndex(env = process.env) {
  const index = new Map();
  for (const row of [...INTERNAL_WALLETS, ...envWallets(env)]) {
    const key = row.address.toLowerCase();
    if (!index.has(key)) index.set(key, { ...row });
  }
  return index;
}
