import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bondingProgressPct,
  leakedBnbGraduationDefault,
  nativeGraduationTarget,
} from "./feedGraduationTarget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("KAIJU88 55% was SOL raised / 50 BNB; real close is $30k in SOL", () => {
  const raised = 27.480476477;
  const leaked = bondingProgressPct({
    chainId: 101,
    raisedNative: raised,
    nativeUsd: 233,
    suppliedTarget: 50,
  });
  assert.ok(leakedBnbGraduationDefault(101, 50));
  assert.ok(Math.abs(leaked - 21.37) < 0.05, leaked);
  assert.ok(Math.abs((raised / 50) * 100 - 54.96) < 0.02);
  assert.equal(nativeGraduationTarget({ chainId: 56, suppliedTarget: 50 }), 50);
});

test("homepage and campaigns feed recompute Solana progress instead of using 50 SOL", () => {
  const grid = fs.readFileSync(path.join(here, "../components/home/CampaignGrid.tsx"), "utf8");
  const api = fs.readFileSync(path.join(here, "../../api/campaigns-base.js"), "utf8");
  const history = fs.readFileSync(path.join(here, "../../api/chat/history.js"), "utf8");
  assert.match(grid, /bondingProgressPct/);
  assert.match(grid, /leakedBnbGraduationDefault/);
  assert.match(api, /nativeGraduationTarget/);
  assert.match(api, /resolveSolUsdPrice/);
  assert.doesNotMatch(history, /ensureChatSchema/);
});
