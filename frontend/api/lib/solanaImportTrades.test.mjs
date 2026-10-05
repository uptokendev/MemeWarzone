import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaImportTrades, parseSolanaTrade } from "./solanaImportTrades.js";

const TOKEN = "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_OWNER = "HLnpSz9hPoolOwner111111111111111111111111111";
const PAIR = "BJ5468WZcJHK9uAgzoKSFJ26atrZQwVt2Rve5vvmJndq";
const bal = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { uiAmountString: String(amount) } });

function tx({ signer, pre, post, lamports = { pre: [0], post: [0] }, keys = [], fee = 5000, err = null }) {
  return {
    blockTime: 1_790_000_000,
    slot: 123,
    transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }, ...keys.map((k) => ({ pubkey: k, signer: false }))] } },
    meta: { err, fee, preTokenBalances: pre, postTokenBalances: post, preBalances: lamports.pre, postBalances: lamports.post },
  };
}

test("a normal buy: the signer gets the coin, SOL amount from the pool's wrapped SOL", () => {
  const me = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
  const t = parseSolanaTrade(
    tx({ signer: me, pre: [bal(POOL_OWNER, TOKEN, 1000000), bal(POOL_OWNER, WSOL, 78)], post: [bal(me, TOKEN, 2324), bal(POOL_OWNER, TOKEN, 997676), bal(POOL_OWNER, WSOL, 78.001)] }),
    "sig1", TOKEN, 200, PAIR,
  );
  assert.equal(t.side, "buy");
  assert.equal(t.maker, me);
  assert.equal(Math.round(t.tokenAmount), 2324);
  assert.ok(Math.abs(t.nativeAmount - 0.001) < 1e-9);
  assert.ok(Math.abs(t.volumeUsd - 0.2) < 1e-6);
});

test("a bot buys for someone paying in USDC: the wallet that got the coin is the trader", () => {
  const bot = "unicoEkaBot1111111111111111111111111111111";
  const user = "D6vyQPGSUser111111111111111111111111111111";
  const t = parseSolanaTrade(
    tx({
      signer: bot,
      pre: [bal(user, TOKEN, 10109852.67), bal(bot, TOKEN, 0), bal(POOL_OWNER, TOKEN, 185603780.37), bal(POOL_OWNER, WSOL, 78.08443), bal(user, USDC, 1), bal("83v8iPyZOther11111111111111111111111111111", WSOL, 427.15574)],
      post: [bal(user, TOKEN, 10114193.89), bal(bot, TOKEN, 0), bal(POOL_OWNER, TOKEN, 185599439.15), bal(POOL_OWNER, WSOL, 78.086288), bal(user, USDC, 0.7768), bal("83v8iPyZOther11111111111111111111111111111", WSOL, 427.15387)],
    }),
    "sig2", TOKEN, 0, PAIR,
  );
  assert.equal(t.side, "buy");
  assert.equal(t.maker, user);
  assert.equal(Math.round(t.tokenAmount), 4341);
  assert.ok(Math.abs(t.nativeAmount - 0.001858) < 1e-5);
});

test("a Pump.fun curve sale: SOL amount from the curve account's lamports", () => {
  const seller = "SellerWallet111111111111111111111111111111";
  const curve = "CurveAccount11111111111111111111111111111111";
  const t = parseSolanaTrade(
    tx({ signer: seller, keys: [curve], pre: [bal(seller, TOKEN, 500), bal(curve, TOKEN, 9000)], post: [bal(seller, TOKEN, 0), bal(curve, TOKEN, 9500)], lamports: { pre: [1e9, 50e9], post: [1.2e9, 49.8e9] } }),
    "sig3", TOKEN, 0, curve,
  );
  assert.equal(t.side, "sell");
  assert.equal(t.maker, seller);
  assert.equal(t.tokenAmount, 500);
  assert.ok(Math.abs(t.nativeAmount - 0.2) < 1e-9);
});

test("not a trade of this coin, or a failed transaction: null", () => {
  assert.equal(parseSolanaTrade(tx({ signer: "A1111111111111111111111111111111111111111111", pre: [bal(POOL_OWNER, WSOL, 1)], post: [bal(POOL_OWNER, WSOL, 2)] }), "s", TOKEN, 0, PAIR), null);
  assert.equal(parseSolanaTrade(tx({ signer: "A1111111111111111111111111111111111111111111", pre: [], post: [], err: { InstructionError: [0, "x"] } }), "s", TOKEN, 0, PAIR), null);
});

test("a pool is read once per 10 s, parsed transactions are never fetched twice, errors are final", async () => {
  const bodies = [];
  let page = ["s1", "s2"];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (!Array.isArray(body)) return { ok: true, json: async () => ({ result: page.map((signature) => ({ signature, err: null })) }) };
    return { ok: true, json: async () => body.map((b) => (b.params[0] === "s2" ? { id: b.id, error: { message: "unsupported" } } : { id: b.id, result: null })) };
  };
  let clock = 0;
  const src = createSolanaImportTrades({ fetchImpl, rpcUrl: "https://rpc.test", now: () => clock });
  await src.trades({ pairAddress: PAIR, tokenAddress: TOKEN });
  await src.trades({ pairAddress: PAIR, tokenAddress: TOKEN }); // cached
  assert.equal(bodies.length, 2, "one signatures call and one batch");
  assert.equal(bodies[1][0].params[1].maxSupportedTransactionVersion, 1, "accepts version 1 transactions");
  clock = 11_000;
  await src.trades({ pairAddress: PAIR, tokenAddress: TOKEN });
  assert.deepEqual(bodies[3].map((b) => b.params[0]), ["s1"], "s2 answered with an error and is not fetched again; s1 is retried");
});
