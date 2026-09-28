import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DBC_PROGRAM_ID } from "../../shared/dbcEconomics.mjs";
import { antiSniperFeeBps } from "../../shared/dbcAntiSniper.mjs";
import {
  DBC_TRADE_ALLOWED_PROGRAM_IDS,
  DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS,
  DBC_JUPITER_LOCK_PROGRAM_ID,
  assertDbcTradeIntent,
  loadReferralTokenAccount,
  quoteDbcExactIn,
} from "./dbcTrade.mjs";

const trader = Keypair.generate();
const pool = Keypair.generate();

function envelope({ programId = DBC_PROGRAM_ID, feePayer = trader.publicKey, extraProgram = null, includePool = true } = {}) {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.add(new TransactionInstruction({
    keys: includePool
      ? [
          { pubkey: trader.publicKey, isSigner: true, isWritable: true },
          { pubkey: pool.publicKey, isSigner: false, isWritable: true },
        ]
      : [{ pubkey: trader.publicKey, isSigner: true, isWritable: true }],
    programId: new PublicKey(programId),
    data: Buffer.alloc(0),
  }));
  if (extraProgram) {
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: trader.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey(extraProgram),
      data: Buffer.alloc(0),
    }));
  }
  return tx;
}

test("trade allowlist is DBC, System, SPL Token, ATA, compute budget", () => {
  assert.ok(DBC_TRADE_ALLOWED_PROGRAM_IDS.has(DBC_PROGRAM_ID));
  assert.ok(!DBC_TRADE_ALLOWED_PROGRAM_IDS.has(DBC_JUPITER_LOCK_PROGRAM_ID));
  assert.ok(DBC_LOCKED_BUY_ALLOWED_PROGRAM_IDS.has(DBC_JUPITER_LOCK_PROGRAM_ID));
});

test("creator claim extraPrograms can allow a DAMM program that trades refuse", () => {
  const damm = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
  assert.throws(
    () => assertDbcTradeIntent(envelope({ extraProgram: damm }), {
      trader: trader.publicKey.toBase58(),
      pool: pool.publicKey.toBase58(),
    }),
    /Unexpected program/,
  );
  assert.doesNotThrow(() => assertDbcTradeIntent(envelope({ extraProgram: damm }), {
    trader: trader.publicKey.toBase58(),
    pool: pool.publicKey.toBase58(),
    extraPrograms: [damm],
  }));
});

test("intent refuses a foreign program, a wrong fee payer, and a missing pool", () => {
  assert.doesNotThrow(() => assertDbcTradeIntent(envelope(), { trader: trader.publicKey.toBase58(), pool: pool.publicKey.toBase58() }));
  assert.throws(
    () => assertDbcTradeIntent(envelope({ extraProgram: Keypair.generate().publicKey.toBase58() }), {
      trader: trader.publicKey.toBase58(),
      pool: pool.publicKey.toBase58(),
    }),
    /Unexpected program/,
  );
  assert.throws(
    () => assertDbcTradeIntent(envelope({ feePayer: pool.publicKey }), {
      trader: trader.publicKey.toBase58(),
      pool: pool.publicKey.toBase58(),
    }),
    /fee payer/,
  );
  assert.throws(
    () => assertDbcTradeIntent(envelope({ includePool: false }), {
      trader: trader.publicKey.toBase58(),
      pool: pool.publicKey.toBase58(),
    }),
    /missing the pool/,
  );
});

test("quote fee bps follows the anti-sniper schedule at t = 0 / 5 / 30 / 60 / 120", () => {
  const client = {
    pool: {
      swapQuote2() {
        return { outputAmount: 1_000_000, tradingFee: 0, includedFeeInputAmount: 20_000_000 };
      },
    },
  };
  const cases = [0, 5, 30, 60, 120];
  for (const elapsed of cases) {
    const quoted = quoteDbcExactIn({
      client,
      pool: {},
      config: {},
      side: "buy",
      amountIn: 20_000_000n,
      hasReferral: false,
      nowUnix: 1_000 + elapsed,
      activationUnix: 1_000,
    });
    assert.equal(quoted.feeBps, antiSniperFeeBps(elapsed), `t=${elapsed}`);
  }
});

test("referral fallback when the account is missing does not throw", async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    const missing = await loadReferralTokenAccount({ getAccountInfo: async () => null }, {});
    assert.equal(missing, null);
    const unreadable = await loadReferralTokenAccount(
      { getAccountInfo: async () => { throw new Error("rpc"); } },
      { DBC_REFERRAL_TOKEN_ACCOUNT: "11111111111111111111111111111111" },
    );
    assert.equal(unreadable, null);
  } finally {
    console.warn = original;
  }
  assert.ok(warns.some((line) => /referral/.test(line)));
});
