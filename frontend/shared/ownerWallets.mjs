// Owner / internal wallets: keys and accounts that belong to MemeWarzone itself (founders,
// deployers, operators, keepers, resolvers, multisigs, protocol vaults). ONE list, used to
//   - flag them on the moderation page ("internal" badge),
//   - leave them out of league winner selection (pre-grad weekly/monthly incl. the recruiter
//     league, MWL monthly, quarterly championship), airdrop candidates and recruiter credit,
//   - refuse linking them to a recruiter.
// Founder, 2026-10-05: "Exclude all owner wallets from leagues and recruiters."
//
// Every entry here is a role key from config or deployment records ("certain"). Founder test
// wallets found only in data go in through env until the founder confirms them.
// Mirrored byte-for-byte (addresses + labels) in realtime-indexer/src/rewards/ownerWallets.ts;
// ownerWallets.test.mjs fails if the two lists drift.
//
// Format: Solana base58 exactly as the key is written (case matters for a signature); EVM
// lowercased. Matching is case-insensitive on purpose: recruiters.wallet_address stores Solana keys
// lowercased, so a case-sensitive compare would miss them. Two distinct base58 keys that differ only
// in case are not a practical collision for 32-byte keys.
//
// Extend without a code change: OWNER_WALLETS (and the older MODERATION_INTERNAL_WALLETS, read for
// the same list), comma separated, each "address" or "address:label".
//
// Selection only: nothing here signs, moves money or rewrites a published root.

export const OWNER_WALLETS = Object.freeze([
  // Solana: founder and deployer keys
  { address: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H", chain: "solana", label: "Solana mainnet deployer (founder key, multisig member)" },
  { address: "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9", chain: "solana", label: "Solana devnet deployer (founder key)" },
  { address: "3D2tAmcZwzk7SBb2L7NYnirCLXAChx6oWLNYN8VGwKFj", chain: "solana", label: "Founder Solana CLI default key" },
  // Solana: multisig
  { address: "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv", chain: "solana", label: "Squads multisig vault" },
  { address: "C43Ddmgt3iC9PTeHLyiQvtUtFAXC7U2v3d7KyzdF5YzY", chain: "solana", label: "Squads multisig account" },
  { address: "E8BPQi8VdjdJJMf4HV8vKwgrqu6eLuDpBpPvZSdXy9iQ", chain: "solana", label: "Squads multisig member" },
  { address: "EGHZWuxMhdrEigBttzw2UuphegApSfj5bWEVbUTFzXtn", chain: "solana", label: "Squads multisig member" },
  // Solana: operators, keepers, resolvers
  { address: "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB", chain: "solana", label: "Solana treasury operator (protocol fee flush)" },
  { address: "7hKQd798Z1ERmRUhm7shmstB1V13FQNnDLqtYjZBuJUz", chain: "solana", label: "Solana route signer" },
  { address: "8rEczXrZZMzpp3MAUbs8TWftaZcJxctydwnkHLsdWaRv", chain: "solana", label: "Solana arena resolver" },
  { address: "BZd4Tfo8gDurVGGJKxwFqRjBwYQPS634m4yH5zsKQcGf", chain: "solana", label: "Solana graduation keeper / LP harvest signer" },
  { address: "5PKtjVSfEj9JccFWbHcZXZvshbiPvfivxWveV273SfnC", chain: "solana", label: "Solana reward poster" },
  { address: "Crmw8dwU1TYY7ykwvZNQo7Uy63CQHdxBzSUpr8vz9e7t", chain: "solana", label: "Solana fee-escrow payer" },
  // Solana: DBC launch-type keys and the mainnet canary wallets
  { address: "3NWtsXixUR3eJjPSNTSVJ62eVxTD4ExHyvdop6TURorY", chain: "solana", label: "DBC fee collector" },
  { address: "AkdT8o6iBZvJPui5xovmDVmhM6XkXch7diJqPu3SrsD8", chain: "solana", label: "DBC config payer" },
  { address: "C1UCuiHeoK1QjBDE8DAe6WvmeHdUMi6rx9vahnWLjzHa", chain: "solana", label: "DBC referral owner" },
  { address: "4T7q9fkgnUe1nsB8xXgwwJ4q1oXE6Pv854uPJzNDDz3n", chain: "solana", label: "DBC referral owner 2" },
  { address: "aZ9YkXDX9b3oh4mrHyFswVMpPuhqLBYfTik1KuiQW3C", chain: "solana", label: "DBC mainnet canary collector" },
  { address: "Fpt1easa83ZJf1S8fygj1UHZdDQysfUAWkAr9JBnkxuj", chain: "solana", label: "DBC mainnet canary creator" },
  { address: "EWpx5nJ1cj1vAXW1Wx4YjZdmT8u8LuD7R7sbSmgUghem", chain: "solana", label: "DBC mainnet canary trader" },
  // Solana: protocol vaults and receivers
  { address: "4AjT4LkVuf9mrgoPN4KisZnKKQwiPw7JbMUJckBEhy8j", chain: "solana", label: "Solana UP vote treasury" },
  { address: "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que", chain: "solana", label: "Solana protocol receiver" },
  { address: "68FNNeXDMAU8XaJsNYL4VFY2YnprnE36LCncCm8uRyJg", chain: "solana", label: "Solana MWL receiver" },
  // EVM (BNB 56/97, Robinhood 4663/46630)
  { address: "0x77f96a7d3bea7a090aacbd00a50002d2b9ae0714", chain: "evm", label: "EVM mainnet deployer (BNB + Robinhood)" },
  { address: "0x1a367016f10b230e28cf1abda2594c47bf60fe34", chain: "evm", label: "BNB mainnet factory deployer (phase A, founder key)" },
  { address: "0x13ad79765e14927df2c554d9662bbe539e89c8e8", chain: "evm", label: "BNB testnet deployer (founder key)" },
  { address: "0x1edcedf5e5d9c2fad5f9f6b964077dd74020a7a7", chain: "evm", label: "EVM Safe (owner of the mainnet contracts)" },
  { address: "0xab2789a8b226ba0655e2ce4824c572df1208fdaa", chain: "evm", label: "BNB testnet treasury Safe" },
  { address: "0xdcf07eb07e6d6722c246161e7530dc905f9eaa50", chain: "evm", label: "EVM payout operator EOA (root poster)" },
  { address: "0x4cb68c7e131ef7855b2ceee1b99cc163dfd47810", chain: "evm", label: "EVM protocol operator" },
  { address: "0xd66f443a02c553cd7a50b74fdc8ac130d9fbd5e6", chain: "evm", label: "EVM graduation keeper" },
  { address: "0x20652bdb1d986220fec30f4733587f279403e773", chain: "evm", label: "EVM creator-choice operator" },
  { address: "0x632061ca786f7b585bbd46a792fda92b02f70671", chain: "evm", label: "ProtocolRevenueVault" },
  // Founder-confirmed own wallets (2026-10-05): test wallets and the partners' recruiter wallets.
  { address: "3SyuXsZfQB3JCjGFTpzioswp8ZkVuf7QGVEYwF6k8nG2", chain: "solana", label: "Founder test wallet (linked to test recruiter 114)" },
  { address: "Bop7oDBz9DtaRTtdeBbP3iL1CCNG4uYbrHNt8mUDsPhT", chain: "solana", label: "Founder test wallet (linked to test recruiter 114)" },
  { address: "0x3e2372ad05ffc35e6563dbc031a7299518d41ec8", chain: "evm", label: "Founder wallet (recruiter 16 signup)" },
  { address: "0xb989a99823ea96552c3e3198a40cdbf682edf1aa", chain: "evm", label: "Robinhood route authority (linked to recruiter 1)" },
  { address: "0x105b2b109a1970a56d3c53be269df2b4419a9f29", chain: "evm", label: "Founder wallet (recruiter 115 / therealmwzte)" },
  { address: "0xf12871613f5cd35c4b520d37544b3ad6404643df", chain: "evm", label: "Founder test wallet (recruiter 107 tester)" },
  { address: "0x38eea4ef1c501ae9e056cc7963120485515876ae", chain: "evm", label: "Founder test wallet (recruiter 107 tester)" },
  { address: "0x587f58ac69be91b575de459a6f69958b8a4d1c77", chain: "evm", label: "Sven (recruiter 29 svenvth)" },
]);

function envWallets(env) {
  return [env?.OWNER_WALLETS, env?.MODERATION_INTERNAL_WALLETS]
    .map((value) => String(value || ""))
    .join(",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [address, ...rest] = part.split(":");
      const trimmed = address.trim();
      const evm = trimmed.toLowerCase().startsWith("0x");
      return { address: evm ? trimmed.toLowerCase() : trimmed, chain: evm ? "evm" : "solana", label: rest.join(":").trim() || "Owner wallet (OWNER_WALLETS)" };
    })
    .filter((row) => row.address);
}

/** Map of lower-cased address -> { address, chain, label }: the code list plus env additions. */
export function ownerWalletIndex(env = process.env) {
  const index = new Map();
  for (const row of [...OWNER_WALLETS, ...envWallets(env)]) {
    const key = row.address.toLowerCase();
    if (!index.has(key)) index.set(key, { ...row });
  }
  return index;
}

/** The owner label of `address`, or null. `index` defaults to the code list plus process.env. */
export function ownerWalletLabel(address, index = ownerWalletIndex()) {
  const key = String(address || "").trim().toLowerCase();
  if (!key) return null;
  return index.get(key)?.label || null;
}

export function isOwnerWallet(address, index = ownerWalletIndex()) {
  return ownerWalletLabel(address, index) !== null;
}

/**
 * Rows without the ones whose wallet (picked by `pick`) is an owner wallet. Order is kept, so the
 * next eligible row takes the freed place.
 */
export function withoutOwnerWallets(rows, pick, index = ownerWalletIndex()) {
  if (!Array.isArray(rows)) return rows;
  return rows.filter((row) => !isOwnerWallet(pick(row), index));
}

/**
 * The owner label a recruiter is tied to, or null. A recruiter whose own signup wallet (any chain)
 * or any payout wallet is an owner wallet is internal: it is left out of the recruiter league and
 * earns no recruiter credit.
 */
export function internalRecruiterLabel({ walletAddress, signup, signupWallet, payoutWallets } = {}, index = ownerWalletIndex()) {
  const s = signup || {};
  for (const value of [walletAddress, signupWallet, s.solanaWalletAddress, s.bnbWalletAddress, s.evmWalletAddress, ...(payoutWallets || [])]) {
    const label = ownerWalletLabel(value, index);
    if (label) return label;
  }
  return null;
}
