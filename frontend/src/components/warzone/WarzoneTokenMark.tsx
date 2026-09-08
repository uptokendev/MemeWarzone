import { useEffect, useState } from "react";
import { warzoneTokenInitials } from "@/lib/arena/warzoneChrome.mjs";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

export function WarzoneTokenMark({
  imageUrl,
  symbol,
  name,
  size = "md",
}: {
  imageUrl?: string | null;
  symbol?: string | null;
  name?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const resolved = resolveImageUri(imageUrl) || "";
  const usable = Boolean(resolved) && resolved !== "/placeholder.svg";
  const [failed, setFailed] = useState(!usable);

  useEffect(() => {
    setFailed(!usable);
  }, [usable, resolved]);

  const box = size === "lg" ? "h-20 w-20 md:h-24 md:w-24" : size === "sm" ? "h-10 w-10" : "h-12 w-12";
  const type = size === "lg" ? "text-xl md:text-2xl" : "text-sm";

  if (!usable || failed) {
    return (
      <div
        data-warzone-token-mark-fallback="true"
        className={cn(
          "flex shrink-0 items-center justify-center border border-white/12 bg-black/55 font-retro tracking-[0.14em] text-orange-200/75",
          box,
          type,
        )}
      >
        {warzoneTokenInitials(symbol, name)}
      </div>
    );
  }

  return (
    <img
      src={resolved}
      alt=""
      className={cn("shrink-0 border border-white/12 object-cover", box)}
      onError={() => setFailed(true)}
    />
  );
}
