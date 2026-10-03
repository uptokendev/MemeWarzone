import { apiFetch } from "@/lib/apiBase";
import { signSolanaMessage } from "@/lib/solanaWallet";

function isSolanaChain(chainId?: number | null) {
  const id = Number(chainId);
  return id === 101 || id === 102;
}

/**
 * Profile image upload for the Edit profile tab (CO-19, 2026-10-03): `avatar` or `profile_banner`.
 * Same request and wallet-signed auth as the existing avatar upload in useEditableProfile.
 */
export async function uploadProfileImage(
  file: File,
  kind: "avatar" | "profile_banner",
  opts: { chainId: number; address: string; signer?: { signMessage: (m: string) => Promise<string> } | null },
): Promise<string> {
  const maxBytes = (kind === "avatar" ? 3 : 5) * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(`Image must be <= ${kind === "avatar" ? 3 : 5} MB.`);
  if (!/^(image\/png|image\/jpeg|image\/jpg|image\/webp)$/.test(file.type)) throw new Error("Use a PNG, JPG or WebP image.");

  const sol = isSolanaChain(opts.chainId);
  const addr = sol ? opts.address.trim() : opts.address.trim().toLowerCase();
  const fd = new FormData();
  fd.append("file", file);
  const qs = new URLSearchParams({ kind, chainId: String(opts.chainId), address: addr });

  const { signWalletAction } = await import("@/lib/walletActionAuth");
  const auth = sol
    ? await signWalletAction({
        action: "upload_avatar",
        walletAddress: addr,
        chainId: Number(opts.chainId),
        walletType: "solana",
        signMessage: async (message: string) => (await signSolanaMessage(message, addr)).signature,
      })
    : opts.signer
      ? await signWalletAction({ action: "upload_avatar", walletAddress: addr, chainId: Number(opts.chainId), signer: opts.signer as any })
      : null;
  if (!auth) throw new Error("Wallet signer is not available. Reconnect your wallet and try again.");
  fd.append("action", auth.action);
  fd.append("walletAddress", auth.walletAddress);
  fd.append("nonce", auth.nonce);
  fd.append("message", auth.message);
  fd.append("signature", auth.signature);
  if ((auth as any).walletType) fd.append("walletType", (auth as any).walletType);

  const res = await apiFetch(`/api/upload?${qs.toString()}`, { method: "POST", body: fd });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Upload failed (${res.status})`);
  if (!j?.url) throw new Error("Upload did not return a URL.");
  return String(j.url);
}
