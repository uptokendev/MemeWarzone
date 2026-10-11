// Audit B-02 regression at the route: POST /api/routing/gen8/create-authorization (and the gen-8 branch of
// /api/routing/create-authorization) refuses a wallet written without 0x, in ICAP form or with whitespace (400), and
// the go-live canary refuses an outsider in the strict form (403). Nothing here reaches a DB or an RPC: every request
// is refused before the create preflight.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

const LAUNCHER = "0x1111111111111111111111111111111111111111";
const CANARY = "0x9999999999999999999999999999999999999999";
const OUTSIDER = ethers.Wallet.createRandom().address;

process.env.CREATE_CANARY_WALLETS = CANARY;
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/test"; // never connected: server/db.js only needs a URL
process.env.PG_DISABLE_SSL ||= "1";
process.env.EVM_GEN8_LAUNCHER_97 = LAUNCHER;
process.env.EVM_GEN8_HOOK_97 = "0x2222222222222222222222222222222222222222";
process.env.EVM_GEN8_POOL_MANAGER_97 = "0x4444444444444444444444444444444444444444";
process.env.EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
const { routingCreateAuthorization, routingGen8CreateAuthorization } = await import("./route-auth.js");

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = JSON.parse(s); },
  };
}
const body = (walletAddress, over = {}) => ({ chainId: 97, walletAddress, campaignRequest: { name: "N", symbol: "S", logoURI: "ipfs://x" }, ...over });

test("gen-8 create route: loose wallet forms are refused (400) before the canary, outsiders get the canary 403", async () => {
  const loose = [OUTSIDER.slice(2), OUTSIDER.slice(2).toLowerCase(), ethers.getIcapAddress(OUTSIDER), ` ${OUTSIDER}`, `${OUTSIDER}\n`, "", undefined];
  for (const handler of [
    (b) => routingGen8CreateAuthorization({ method: "POST", body: b }, fakeRes.current = fakeRes()),
    (b) => routingCreateAuthorization({ method: "POST", body: { ...b, factoryAddress: LAUNCHER } }, fakeRes.current = fakeRes()),
  ]) {
    for (const wallet of loose) {
      await handler(body(wallet));
      const res = fakeRes.current;
      assert.equal(res.statusCode, 400, `400 for ${JSON.stringify(wallet)}`);
      assert.equal(res.body.code, "GEN8_WALLET_INVALID");
    }
    for (const wallet of [OUTSIDER, OUTSIDER.toLowerCase()]) {
      await handler(body(wallet));
      const res = fakeRes.current;
      assert.deepEqual([res.statusCode, res.body.code], [403, "CREATE_CANARY_ONLY"], `canary for ${wallet}`);
    }
  }
});
