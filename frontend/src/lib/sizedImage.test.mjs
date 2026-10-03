import assert from "node:assert/strict";
import test from "node:test";
import { sizedImageProps, supabaseRenderUrl } from "./sizedImage.mjs";

const RAW = "https://ellkfgoxnzykxqybajtn.supabase.co/storage/v1/object/public/MEMEBATTLES/sponsors/a.jpg";

test("Supabase storage images are resized on the server at 1x and 2x of the shown size", () => {
  const p = sizedImageProps(RAW, 300, 244);
  assert.equal(p.src, "https://ellkfgoxnzykxqybajtn.supabase.co/storage/v1/render/image/public/MEMEBATTLES/sponsors/a.jpg?width=300&height=244&resize=cover&quality=85");
  assert.match(p.srcSet, /width=300&height=244[^ ]* 1x, [^ ]*width=600&height=488[^ ]* 2x$/);
});

test("other hosts, data URLs and empty values are left alone", () => {
  assert.equal(supabaseRenderUrl("https://example.com/a.png", 300, 244), null);
  assert.equal(supabaseRenderUrl("data:image/png;base64,xx", 300, 244), null);
  assert.equal(supabaseRenderUrl("https://evil.supabase.co.example.com/storage/v1/object/public/a.png", 300, 244), null);
  assert.deepEqual(sizedImageProps("/assets/memewarzone.png", 300, 244), { src: "/assets/memewarzone.png", srcSet: undefined });
  assert.deepEqual(sizedImageProps("", 240, 90), { src: "", srcSet: undefined });
});
