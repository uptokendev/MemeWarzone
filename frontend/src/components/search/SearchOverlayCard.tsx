import { resolveImageUri } from "@/lib/media";

export function formatSearchMcapUsd(native: number | null | undefined, usdPrice: number | null | undefined): string {
  if (native == null || !Number.isFinite(native) || native <= 0 || !usdPrice) return "";
  const usd = native * usdPrice;
  if (!Number.isFinite(usd) || usd <= 0) return "";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(usd);
}

export function SearchOverlayCard({
  name,
  symbol,
  logoURI,
  mcapLabel,
  onClick,
}: {
  name: string;
  symbol?: string;
  logoURI?: string;
  mcapLabel?: string;
  onClick: () => void;
}) {
  const image = resolveImageUri(logoURI || "") || "/placeholder.svg";
  const ticker = String(symbol || "").trim();
  const tickerLabel = ticker ? (ticker.startsWith("$") ? ticker : `$${ticker}`) : "";
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative h-[132px] w-[132px] shrink-0 snap-start overflow-hidden border border-orange-400/25 bg-black text-left transition hover:border-orange-300/70"
    >
      <img src={image} alt="" className="h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/90" />
      <div className="absolute inset-x-0 top-0 p-2">
        <div className="line-clamp-2 break-all text-[10px] font-semibold leading-tight text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">{name}</div>
      </div>
      <div className="absolute inset-x-0 bottom-0 p-2">
        {mcapLabel ? <div className="text-[11px] font-semibold text-white">{mcapLabel}</div> : null}
        {tickerLabel ? <div className="truncate text-[12px] font-semibold text-orange-200">{tickerLabel}</div> : null}
      </div>
    </button>
  );
}
