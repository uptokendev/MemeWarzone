import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { isSolanaChainId } from "@/lib/chainConfig";
import { type ArenaImportItem, uploadArenaImportImage } from "@/lib/arenaImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const ENABLED = ["1", "true", "yes", "on"].includes(
  String(import.meta.env.VITE_ARENA_IMPORT_IMAGE_UPLOAD || "").trim().toLowerCase(),
);

function sameWallet(left: string | null | undefined, right: string | null | undefined, solana: boolean) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  return solana ? a === b : a.toLowerCase() === b.toLowerCase();
}

export function ArenaImportImageUpload({
  item,
  onUploaded,
}: {
  item: ArenaImportItem;
  onUploaded?: (next: ArenaImportItem) => void;
}) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [imageUrl, setImageUrl] = useState(item.imageUrl || "");
  const solana = isSolanaChainId(item.chainId);
  const connectedOwner = solana ? solanaWallet.solanaAccount : wallet.account;
  const isOwner = sameWallet(connectedOwner, item.ownerWallet, solana);

  if (!ENABLED || !isOwner) return null;

  const handleFile = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error("Image is too large. Maximum upload size is 5 MB.");
      return;
    }
    if (!ALLOWED_TYPES.has(file.type.toLowerCase())) {
      toast.error("Unsupported image type. Use PNG, JPEG, or WEBP.");
      return;
    }

    setUploading(true);
    const toastId = toast.loading(imageUrl ? "Replacing token image..." : "Uploading token image...");
    try {
      const auth = solana
        ? await signWalletAction({
            action: "arena_import_image",
            walletAddress: item.ownerWallet,
            chainId: item.chainId,
            walletType: "solana",
            extraLines: [`Import: ${item.id}`],
            signMessage: async (message) => (await signSolanaMessage(message, item.ownerWallet)).signature,
          })
        : await signWalletAction({
            action: "arena_import_image",
            walletAddress: item.ownerWallet,
            chainId: item.chainId,
            extraLines: [`Import: ${item.id}`],
            signer: wallet.signer,
          });

      const result = await uploadArenaImportImage({ item, file, auth });
      setImageUrl(result.url);
      const next = {
        ...item,
        imageUrl: result.url,
        metadataUpdatedAt: result.metadataUpdatedAt || item.metadataUpdatedAt || null,
        verifiedAt: result.verifiedAt || item.verifiedAt || null,
      };
      onUploaded?.(next);
      toast.success(imageUrl ? "Token image replaced." : "Token image uploaded.");
    } catch (error: any) {
      toast.error(String(error?.message || "Token image upload failed."));
    } finally {
      toast.dismiss(toastId);
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="rounded-md border border-white/10 bg-black/20 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-white/5">
          {imageUrl ? (
            <img src={imageUrl} alt={`${item.symbol || item.name || "Imported token"} token`} className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-7 w-7 text-white/35" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-retro text-xs uppercase tracking-[0.16em] text-foreground">Token image</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Verified import owner only. PNG, JPEG or WEBP, up to 5 MB. The API verifies the actual file signature and dimensions before Storage accepts it.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 font-retro"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
            {imageUrl ? "REPLACE TOKEN IMAGE" : "UPLOAD TOKEN IMAGE"}
          </Button>
        </div>
      </div>
    </div>
  );
}
