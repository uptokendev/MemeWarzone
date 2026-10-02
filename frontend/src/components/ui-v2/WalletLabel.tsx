import { useWalletHandle } from "@/lib/handlesApi";

export function shortWallet(wallet?: string | null) {
  const w = String(wallet || "");
  return w.length > 12 ? `${w.slice(0, 6)}...${w.slice(-4)}` : w;
}

/** Name to show for a wallet: display name, else @username, else the short address (founder, 2026-10-02). */
export function useWalletLabel(wallet?: string | null, displayName?: string | null) {
  const handle = useWalletHandle(wallet);
  const name = String(displayName || "").trim();
  if (name) return name;
  if (handle) return `@${handle}`;
  return shortWallet(wallet);
}

export function WalletLabel({ wallet, displayName, className }: { wallet?: string | null; displayName?: string | null; className?: string }) {
  const label = useWalletLabel(wallet, displayName);
  return <span className={className}>{label}</span>;
}
