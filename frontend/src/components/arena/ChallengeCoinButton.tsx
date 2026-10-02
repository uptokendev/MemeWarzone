import { useState } from "react";
import { Swords } from "lucide-react";
import { ChallengeCoinModal } from "@/components/arena/ChallengeCoinModal";

/** Opens the existing Challenge a coin modal with this coin as the target (UI redesign: coin page header). */
export function ChallengeCoinButton({
  walletAddress,
  chainId,
  targetId,
  className,
}: {
  walletAddress?: string | null;
  chainId?: number | null;
  targetId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} data-challenge-this-coin="true">
        <Swords className="h-[18px] w-[18px]" aria-hidden="true" />
        Challenge
      </button>
      <ChallengeCoinModal open={open} onOpenChange={setOpen} walletAddress={walletAddress} chainId={chainId} initialTargetId={targetId} />
    </>
  );
}
