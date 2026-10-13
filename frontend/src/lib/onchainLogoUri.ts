const MAX_ONCHAIN_LOGO_URI_CHARS = 512;

/** On-chain logoURI must be a short http(s) URL. Data URLs blow estimateGas. */
export function assertOnchainLogoUri(value: unknown): string {
  const url = String(value || "").trim();
  if (!url) throw new Error("Campaign logo is missing. Upload a PNG, JPG or WebP first.");
  if (/^data:/i.test(url)) {
    throw new Error(
      "Logo storage is not configured. The image was not uploaded, so deploy was blocked. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the API, then upload again.",
    );
  }
  if (!/^https:\/\//i.test(url)) {
    throw new Error("Campaign logo must be an https URL. Upload the image again.");
  }
  if (url.length > MAX_ONCHAIN_LOGO_URI_CHARS) {
    throw new Error("Campaign logo URL is too long to write on-chain. Upload a smaller hosted image.");
  }
  return url;
}
