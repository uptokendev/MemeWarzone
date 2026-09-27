/**
 * Logo handling for Story Mode: colours for the player and a PNG for the share card.
 * sharp decodes every format our uploads accept (png, jpeg, webp, gif) -- resvg cannot read webp.
 * Fetches are https-only, size-capped and time-boxed; results are cached per URL.
 */
import sharp from "sharp";

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 500;
export const FALLBACK_ACCENTS = Object.freeze({ accent: "#f06a1a", accent2: "#7c4dff" });

const cache = new Map();

function hex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}

/**
 * The rule the prototype used: bucket the vivid pixels (saturation and value >= 0.45) into 24 hues;
 * the two fullest buckets, averaged, are accent and accent2. A logo with no vivid colour gets the
 * MemeWarzone ember/violet pair.
 */
export function accentsFromPixels(rgb) {
  const buckets = new Map();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const [h, s, v] = rgbToHsv(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255);
    if (s < 0.45 || v < 0.45) continue;
    const key = Math.min(23, Math.floor(h * 24));
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n += 1; b.r += rgb[i]; b.g += rgb[i + 1]; b.b += rgb[i + 2];
    buckets.set(key, b);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n);
  if (!ranked.length) return { ...FALLBACK_ACCENTS };
  const avg = (b) => [b.r / b.n, b.g / b.n, b.b / b.n];
  const first = avg(ranked[0]);
  const second = ranked[1] ? avg(ranked[1]) : first.map((c) => c * 0.45);
  return { accent: hex(first), accent2: hex(second) };
}

async function fetchImage(url, fetchImpl = fetch) {
  if (!/^https:\/\//i.test(String(url || ""))) throw new Error("logo must be https");
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "image/*" } });
  if (!res.ok) throw new Error(`logo HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw new Error("logo too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("logo too large");
  return buf;
}

/**
 * { accent, accent2, animated, png } for a logo URL; png is a 480px square first frame for the share
 * card. Never throws: a logo that cannot be read yields the fallback colours and no png.
 */
export async function logoAssets(url, { fetchImpl = fetch, now = Date.now } = {}) {
  const key = String(url || "");
  const hit = cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  let value;
  try {
    const buf = await fetchImage(key, fetchImpl);
    const meta = await sharp(buf, { animated: true }).metadata();
    const [raw, png] = await Promise.all([
      sharp(buf).resize(48, 48, { fit: "cover" }).removeAlpha().raw().toBuffer(),
      sharp(buf).resize(480, 480, { fit: "cover" }).png().toBuffer(),
    ]);
    value = { ...accentsFromPixels(raw), animated: (meta.pages || 1) > 1, png };
  } catch {
    value = { ...FALLBACK_ACCENTS, animated: false, png: null };
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: now(), value });
  return value;
}
