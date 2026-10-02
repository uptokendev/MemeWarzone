import assert from "node:assert/strict";
import test from "node:test";
import { contractAddressInBody, feedImagePath, isOwnFeedImage } from "./feedPostMedia.js";
import { buildPostCreateMessage } from "./postsCanon.js";

const BASE = "https://abc.supabase.co";
const EVM = "0x77F96A7d0000000000000000000000000000aBcD";
const SOL = "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB";

test("feed images live in the author's own folder", () => {
  const path = feedImagePath({ wallet: EVM, uuid: "u-1", ext: "PNG" });
  assert.equal(path, `social-posts/${EVM.toLowerCase()}/u-1.png`);
  const url = `${BASE}/storage/v1/object/public/MEMEBATTLES/${path}`;
  assert.equal(isOwnFeedImage(url, { storageBase: BASE, wallet: EVM }), true);
  assert.equal(isOwnFeedImage(url, { storageBase: BASE, wallet: SOL }), false, "someone else's image");
  assert.equal(isOwnFeedImage(`https://evil.example/${path}`, { storageBase: BASE, wallet: EVM }), false);
  assert.equal(isOwnFeedImage(`${BASE}/storage/v1/object/public/MEMEBATTLES/social-posts/${EVM.toLowerCase()}/../x.png`, { storageBase: BASE, wallet: EVM }), false);
  const solPath = feedImagePath({ wallet: SOL, uuid: "u-2", ext: "webp" });
  assert.equal(isOwnFeedImage(`${BASE}/storage/v1/object/public/b/${solPath}`, { storageBase: BASE, wallet: SOL }), true, "Solana keeps case");
});

test("a contract address in the body is found; a tx hash is not", () => {
  assert.equal(contractAddressInBody(`aped ${EVM} early`), EVM);
  assert.equal(contractAddressInBody(`sol one ${SOL}`), SOL);
  assert.equal(contractAddressInBody("0x" + "a".repeat(64)), "");
  assert.equal(contractAddressInBody("no address here, $K88 is up"), "");
});

test("a plain post signs exactly the old message; image and quote add bound lines", () => {
  const plain = buildPostCreateMessage({ chainId: 56, address: EVM, nonce: "n", body: "hi" });
  assert.equal(plain, ["MemeWarzone Post", "Action: POST_CREATE", "ChainId: 56", `Address: ${EVM.toLowerCase()}`, "Nonce: n", "", "hi"].join("\n"));
  const rich = buildPostCreateMessage({ chainId: 56, address: EVM, nonce: "n", body: "hi", mediaUrl: "https://x/y.png", quoteOf: 42 });
  assert.match(rich, /\nMedia: https:\/\/x\/y\.png\nQuote: 42\n\nhi$/);
});
