// Owner / internal wallets -- the indexer's copy of frontend/shared/ownerWallets.mjs (that file is
// the canonical list and explains it). Same addresses, same labels; frontend/shared/
// ownerWallets.test.mjs and src/rewards/ownerWallets.test.ts fail if the two drift.
//
// Founder, 2026-10-05: "Exclude all owner wallets from leagues and recruiters." Used here to leave
// them out of the pre-grad league winners (incl. the recruiter league), out of recruiter credit and
// out of recruiter links. Selection only: nothing here signs, moves money or rewrites a posted root.
//
// Extend without a code change: OWNER_WALLETS (and MODERATION_INTERNAL_WALLETS), comma separated,
// each "address" or "address:label". Matching is case-insensitive (recruiters.wallet_address stores
// Solana keys lowercased).

export type OwnerWallet = { address: string; chain: "solana" | "evm"; label: string };

export const OWNER_WALLETS: ReadonlyArray<OwnerWallet> = Object.freeze([
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
]);

type Env = Record<string, string | undefined>;

function envWallets(env: Env): OwnerWallet[] {
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
      return { address: evm ? trimmed.toLowerCase() : trimmed, chain: evm ? "evm" : "solana", label: rest.join(":").trim() || "Owner wallet (OWNER_WALLETS)" } as OwnerWallet;
    })
    .filter((row) => row.address);
}

/** Map of lower-cased address -> owner wallet: the code list plus env additions. */
export function ownerWalletIndex(env: Env = process.env): Map<string, OwnerWallet> {
  const index = new Map<string, OwnerWallet>();
  for (const row of [...OWNER_WALLETS, ...envWallets(env)]) {
    const key = row.address.toLowerCase();
    if (!index.has(key)) index.set(key, { ...row });
  }
  return index;
}

export function ownerWalletLabel(address: unknown, index: Map<string, OwnerWallet> = ownerWalletIndex()): string | null {
  const key = String(address || "").trim().toLowerCase();
  if (!key) return null;
  return index.get(key)?.label || null;
}

export function isOwnerWallet(address: unknown, index: Map<string, OwnerWallet> = ownerWalletIndex()): boolean {
  return ownerWalletLabel(address, index) !== null;
}

type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * The owner label a recruiter (recruiters.id) is tied to, or null: its signup wallet (any chain, as
 * stored on recruiters and recruiter_accounts) or any of its payout wallets is an owner wallet. Such a
 * recruiter is internal (a founder test account): no recruiter-league place, no recruiter credit.
 */
export async function internalRecruiterLabel(db: Db, recruiterId: number, index: Map<string, OwnerWallet> = ownerWalletIndex()): Promise<string | null> {
  const { rows } = await db.query(
    `select r.wallet_address,
            r.metadata #>> '{signup,solanaWalletAddress}' as sol,
            r.metadata #>> '{signup,bnbWalletAddress}' as bnb,
            r.metadata #>> '{signup,evmWalletAddress}' as evm,
            a.signup_wallet,
            coalesce((select array_agg(w.wallet_address) from public.recruiter_payout_wallets w where w.recruiter_id = a.recruiter_id), '{}') as payout
       from public.recruiters r
       left join public.recruiter_accounts a on a.code = r.code
      where r.id = $1`,
    [recruiterId],
  );
  for (const row of rows) {
    for (const value of [row.wallet_address, row.sol, row.bnb, row.evm, row.signup_wallet, ...(row.payout || [])]) {
      const label = ownerWalletLabel(value, index);
      if (label) return label;
    }
  }
  return null;
}

/**
 * Leaderboard rows without the ones paying an owner wallet. Order is kept, so the next eligible row
 * takes the freed place.
 */
export function withoutOwnerRecipients<T extends { recipient: string }>(rows: T[], index: Map<string, OwnerWallet> = ownerWalletIndex()): T[] {
  return rows.filter((row) => !isOwnerWallet(row.recipient, index));
}
