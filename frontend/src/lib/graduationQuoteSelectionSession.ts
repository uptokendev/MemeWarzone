const STORAGE_PREFIX = "mwz:graduation-quote-selection:";

function storageKey(chainId: number | string) {
  return `${STORAGE_PREFIX}${Number(chainId)}`;
}

export function rememberGraduationQuoteAssetId(chainId: number | string, deploymentId: unknown) {
  if (typeof window === "undefined") return;
  const id = String(deploymentId || "").trim();
  try {
    if (id) window.sessionStorage.setItem(storageKey(chainId), id);
    else window.sessionStorage.removeItem(storageKey(chainId));
  } catch {
    // Selection persistence is convenience only. Server-side catalog binding stays authoritative.
  }
}

export function readRememberedGraduationQuoteAssetId(chainId: number | string): string {
  if (typeof window === "undefined") return "";
  try {
    return String(window.sessionStorage.getItem(storageKey(chainId)) || "").trim();
  } catch {
    return "";
  }
}

export function clearRememberedGraduationQuoteAssetId(chainId: number | string) {
  rememberGraduationQuoteAssetId(chainId, "");
}
