export function isAnimatedTokenImage(src) {
  const raw = String(src || "").trim().toLowerCase();
  if (!raw) return false;
  if (raw.startsWith("data:image/gif")) return true;
  if (raw.includes("image/gif")) return true;
  return /\.gif(?:$|[?#])/.test(raw) || /format=gif/.test(raw);
}

export function tokenShareChainLabel(chainId) {
  const id = Number(chainId);
  if (id === 101 || id === 102) return "SOLANA";
  if (id === 4663 || id === 46630) return "ROBINHOOD";
  return "BNB CHAIN";
}

export function presentTokenShareCardInput({
  name,
  ticker,
  chainId,
  status,
  mcap,
  holders,
  volume,
  image,
  pageUrl,
  logoDataUrl,
} = {}) {
  const symbol = String(ticker || "").replace(/^\$+/, "").trim();
  return {
    name: String(name || "TOKEN").trim(),
    ticker: symbol || "MWZ",
    chain: tokenShareChainLabel(chainId),
    status: String(status || "LIVE").trim(),
    mcap: String(mcap || "—").trim() || "—",
    holders: String(holders || "—").trim() || "—",
    volume: String(volume || "—").trim() || "—",
    logoUrl: String(image || "").trim(),
    logoDataUrl: String(logoDataUrl || "").trim(),
    link: String(pageUrl || "").replace(/^https?:\/\//i, "").slice(0, 34),
    pageUrl: String(pageUrl || "").trim(),
    description: "Live market snapshot from MemeWarzone.",
  };
}

export async function snapshotTokenImage(image) {
  if (typeof document === "undefined") return "";
  const source = typeof image === "string" ? null : image;
  const src = typeof image === "string" ? image : String(source?.currentSrc || source?.src || "").trim();
  if (!src) return "";

  const draw = (img) => {
    const canvas = document.createElement("canvas");
    const size = 296;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx || !img.naturalWidth) return "";
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  };

  if (source && source.naturalWidth) {
    try {
      return draw(source);
    } catch {
      /* tainted canvas — load a CORS copy */
    }
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        resolve(draw(img) || "");
      } catch {
        resolve("");
      }
    };
    img.onerror = () => resolve("");
    img.src = src;
  });
}
