import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isAnimatedTokenImage,
  presentTokenShareCardInput,
  tokenShareChainLabel,
} from "./tokenShareCard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("animated logos are GIFs; static PNG/JPEG are not", () => {
  assert.equal(isAnimatedTokenImage("https://cdn.example/token.gif"), true);
  assert.equal(isAnimatedTokenImage("https://cdn.example/token.GIF?v=2"), true);
  assert.equal(isAnimatedTokenImage("data:image/gif;base64,xxxx"), true);
  assert.equal(isAnimatedTokenImage("https://cdn.example/token.png"), false);
  assert.equal(isAnimatedTokenImage("/placeholder.svg"), false);
});

test("token share payload carries MCAP holders volume name ticker and chain", () => {
  const input = presentTokenShareCardInput({
    name: "Derpy Dave",
    ticker: "$DERPYDAVE",
    chainId: 101,
    status: "Live",
    mcap: "$59.8K",
    holders: "159",
    volume: "$12.7",
    image: "https://cdn.example/derpy.gif",
    pageUrl: "https://app.memewar.zone/token/abc",
  });
  assert.equal(input.ticker, "DERPYDAVE");
  assert.equal(input.chain, "SOLANA");
  assert.equal(input.mcap, "$59.8K");
  assert.equal(input.holders, "159");
  assert.equal(input.volume, "$12.7");
  assert.equal(tokenShareChainLabel(4663), "ROBINHOOD");
  assert.equal(tokenShareChainLabel(56), "BNB CHAIN");
});

test("TokenDetails mounts the share card CTA and snapshot modal", () => {
  const page = fs.readFileSync(path.join(here, "../pages/TokenDetails.tsx"), "utf8");
  const modal = fs.readFileSync(path.join(here, "../components/token/TokenShareCardModal.tsx"), "utf8");
  assert.match(page, /TokenShareCardModal/);
  assert.match(page, /data-token-share-card-cta/);
  assert.match(page, /Share card/);
  assert.match(modal, /data-token-share-snapshot/);
  assert.match(modal, /Snapshot image/);
  assert.match(modal, /snapshotTokenImage/);
  assert.match(modal, /\/api\/token-share-card/);
});
