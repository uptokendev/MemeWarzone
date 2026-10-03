/**
 * Images from our Supabase storage, served at the size they are shown (Featured card, ad row).
 * The browser shrinking a 1568px file into a 300px card looks soft (large downscale ratio, plus the
 * card's hover zoom); Supabase's render endpoint resizes on the server and the result is crisp and
 * ~5x smaller. Anything not on Supabase storage (or a data:/blob: URL) is returned unchanged.
 */
const OBJECT_PATH = "/storage/v1/object/public/";
const RENDER_PATH = "/storage/v1/render/image/public/";

export function supabaseRenderUrl(src, width, height, quality = 85) {
  const value = String(src || "").trim();
  if (!value || !/^https:\/\/[a-z0-9]+\.supabase\.co\//i.test(value) || !value.includes(OBJECT_PATH)) return null;
  const [base] = value.split("?");
  const params = new URLSearchParams({ width: String(Math.round(width)), height: String(Math.round(height)), resize: "cover", quality: String(quality) });
  return `${base.replace(OBJECT_PATH, RENDER_PATH)}?${params.toString()}`;
}

/** { src, srcSet } for an image shown at width x height CSS px (1x and 2x), or the original. */
export function sizedImageProps(src, width, height) {
  const one = supabaseRenderUrl(src, width, height);
  if (!one) return { src: src || "", srcSet: undefined };
  return { src: one, srcSet: `${one} 1x, ${supabaseRenderUrl(src, width * 2, height * 2)} 2x` };
}
