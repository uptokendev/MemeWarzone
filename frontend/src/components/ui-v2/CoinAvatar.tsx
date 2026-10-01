import { useState } from "react";
import { cn } from "@/lib/utils";

/** Square coin logo with a ticker fallback when there is no image or it fails to load. */
export function CoinAvatar({
  src,
  ticker,
  size = 44,
  round = false,
  className,
}: {
  src?: string | null;
  ticker?: string | null;
  size?: number;
  round?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const label = String(ticker || "").replace(/^\$/, "").slice(0, 4).toUpperCase() || "?";
  const radius = round ? "50%" : Math.round(size * 0.22);
  const style = { width: size, height: size, borderRadius: radius };

  if (src && !failed) {
    return <img src={src} alt={ticker ? `${label} logo` : ""} style={style} className={cn("shrink-0 bg-[#2A1609] object-cover", className)} onError={() => setFailed(true)} loading="lazy" />;
  }
  return (
    <span
      role="img"
      aria-label={ticker ? `${label} logo` : undefined}
      style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.28)) }}
      className={cn("inline-flex shrink-0 items-center justify-center bg-[#2A1609] font-mw-brand text-[#FF9A4D]", className)}
    >
      {label}
    </span>
  );
}
