const EVM = /^0x[a-fA-F0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LONG_ID = /^\d{10,}$/;

function looksLikeSolana(segment) {
  return SOLANA.test(segment) && /[0-9]/.test(segment) && /[A-Z]/.test(segment);
}

export function templatePath(pathname) {
  const path = String(pathname || "/").split("?")[0] || "/";
  const parts = path.split("/").map((segment) => {
    if (!segment) return segment;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    if (EVM.test(decoded) || looksLikeSolana(decoded)) return ":address";
    if (UUID.test(decoded) || LONG_ID.test(decoded)) return ":id";
    return decoded;
  });
  const joined = parts.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}
