#!/usr/bin/env node
/**
 * D12 proof, DEVNET ONLY: a creator's extra buy goes straight into a Jupiter Lock escrow in the same
 * transaction, and is released by date in 5 steps of 20%. Nobody can cancel it or redirect it.
 *
 * Jupiter Lock (LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn, v0.4.0) is the program Meteora's DBC
 * already uses for its own vesting. Its IDL is read from chain.
 *
 *   one tx: DBC swap2 ExactOut (exactly X tokens) -> create escrow token account -> create_vesting_escrow(X)
 *   checks: the creator's wallet balance of the token does not change in that tx; the escrow holds X;
 *           2 signers (creator + escrow base key); claim before the date releases nothing; then
 *           20% per step; cancel and recipient change are refused.
 *
 *   SOLANA_DEVNET_RPC_URL=<rpc> DBC_PROVE_FUNDER_KEYPAIR=<devnet key> node prove-creator-lock-devnet.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import anchor from "@coral-xyz/anchor";
import {
  DynamicBondingCurveClient, buildCurve, deriveDbcPoolAddress, SwapMode,
  TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode,
  MigrationOption, MigrationFeeOption, MigratedCollectFeeMode, DammV2DynamicFeeMode, ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const LOCK_PROGRAM = new PublicKey("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");
const conn = new Connection(process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const failures = [];
const check = (label, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`); if (!ok) failures.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chainNow = async () => Number(await conn.getBlockTime(await conn.getSlot("confirmed")));

async function getTx(sig) {
  for (let i = 0; i < 20; i++) { const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); if (t) return t; await sleep(1500); }
  throw new Error(`tx ${sig} not readable`);
}
async function tokenDelta(sig, account) {
  const t = await getTx(sig);
  const keys = t.transaction.message.staticAccountKeys || t.transaction.message.accountKeys;
  const i = keys.findIndex((k) => k.equals(account));
  const pick = (l) => BigInt(l.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
  return { delta: pick(t.meta.postTokenBalances) - pick(t.meta.preTokenBalances), present: i >= 0 };
}
async function balance(account) {
  const b = await conn.getTokenAccountBalance(account).catch(() => null);
  return b ? BigInt(b.value.amount) : 0n;
}

async function main() {
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Refusing: not devnet");
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DBC_PROVE_FUNDER_KEYPAIR, "utf8"))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-prove-lock-"));
  const keys = { partner: Keypair.generate(), creator: Keypair.generate(), config: Keypair.generate(), mint: Keypair.generate(), base: Keypair.generate() };
  fs.writeFileSync(path.join(dir, "keys.json"), JSON.stringify(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, Array.from(v.secretKey)]))));
  console.log(`throwaway keys in ${dir}\ncreator ${keys.creator.publicKey.toBase58()}`);

  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: keys.creator.publicKey, lamports: 1_500_000_000 }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: keys.partner.publicKey, lamports: 50_000_000 }),
  ), [funder]);

  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const curve = buildCurve({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 200, endingFeeBps: 200, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 7, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.Customizable, migrationFee: { feePercentage: 22, creatorFeePercentage: 90 }, migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 25 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 20, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 80, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp, percentageSupplyOnMigration: 20, migrationQuoteThreshold: 5,
  });
  const pool = deriveDbcPoolAddress(NATIVE_MINT, keys.mint.publicKey, keys.config.publicKey);
  console.log("\n[launch]");
  const createTx = await client.partner.createConfigAndPool({
    config: keys.config.publicKey, feeClaimer: keys.partner.publicKey, leftoverReceiver: keys.partner.publicKey, quoteMint: NATIVE_MINT, payer: keys.creator.publicKey, ...curve,
    preCreatePoolParam: { name: "MWZ Lock Proof", symbol: "MWZLOCK", uri: "https://memewar.zone/", poolCreator: keys.creator.publicKey, baseMint: keys.mint.publicKey },
  });
  console.log(`  ${await sendAndConfirmTransaction(conn, createTx, [keys.creator, keys.config, keys.mint])}`);

  // ---- the locked buy: exactly X tokens, straight into the escrow, one transaction ----
  console.log("\n[locked creator buy: swap ExactOut + create_vesting_escrow, one transaction]");
  const X = 5_000_000n * 1_000_000n; // 5M tokens (0.5% of supply), divisible by 5
  const step = X / 5n;
  const swapTx = await client.pool.swap2({
    owner: keys.creator.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.ExactOut, amountOut: new BN(X.toString()), maximumAmountIn: new BN(300_000_000),
  });
  const idl = JSON.parse(fs.readFileSync(process.env.JUP_LOCK_IDL || path.join(path.dirname(new URL(import.meta.url).pathname), "jup-lock-idl.json"), "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(keys.creator), {});
  const lock = new anchor.Program(idl, provider);
  const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), keys.base.publicKey.toBuffer()], LOCK_PROGRAM);
  const escrowToken = getAssociatedTokenAddressSync(keys.mint.publicKey, escrow, true);
  const creatorToken = getAssociatedTokenAddressSync(keys.mint.publicKey, keys.creator.publicKey);
  const start = await chainNow();
  const cliff = start + 45; const frequency = 20;
  const createEscrowIx = await lock.methods.createVestingEscrow({
    vestingStartTime: new BN(start), cliffTime: new BN(cliff), frequency: new BN(frequency),
    cliffUnlockAmount: new BN(step.toString()), amountPerPeriod: new BN(step.toString()), numberOfPeriod: new BN(4),
    updateRecipientMode: 0, cancelMode: 0,
  }).accountsPartial({
    base: keys.base.publicKey, escrow, escrowToken, sender: keys.creator.publicKey, senderToken: creatorToken,
    recipient: keys.creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  const lockedBuy = new Transaction().add(...swapTx.instructions,
    createAssociatedTokenAccountIdempotentInstruction(keys.creator.publicKey, escrowToken, escrow, keys.mint.publicKey),
    createEscrowIx);
  lockedBuy.feePayer = keys.creator.publicKey;
  lockedBuy.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  lockedBuy.sign(keys.creator, keys.base);
  const bytes = lockedBuy.serialize().length;
  const msg = lockedBuy.compileMessage();
  const sig = await sendAndConfirmTransaction(conn, lockedBuy, [keys.creator, keys.base]);
  console.log(`  sig ${sig}  (${bytes} bytes, ${msg.header.numRequiredSignatures} signers)`);
  check("locked buy is 2 signers (creator + escrow base key)", msg.header.numRequiredSignatures === 2);
  const creatorMove = await tokenDelta(sig, creatorToken);
  const escrowMove = await tokenDelta(sig, escrowToken);
  check("creator's wallet ends the transaction with none of the bought tokens", creatorMove.delta === 0n, `delta ${creatorMove.delta}`);
  check("escrow holds exactly the bought amount", escrowMove.delta === X && (await balance(escrowToken)) === X, `escrow ${await balance(escrowToken)}`);

  const claim = async (label) => {
    const before = await balance(creatorToken);
    try {
      const tx = await lock.methods.claim(new BN("18446744073709551615")).accountsPartial({
        escrow, escrowToken, recipient: keys.creator.publicKey, recipientToken: creatorToken, tokenProgram: TOKEN_PROGRAM_ID,
      }).transaction();
      await sendAndConfirmTransaction(conn, tx, [keys.creator]);
    } catch (e) { console.log(`  ${label}: claim refused (${String(e.message).split("\n")[0].slice(0, 90)})`); }
    const got = (await balance(creatorToken)) - before;
    console.log(`  ${label}: released ${got} (total out ${X - (await balance(escrowToken))})`);
    return got;
  };

  console.log("\n[while locked: nobody can take it back or redirect it]");
  const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  for (const [name, expectErr, build] of [
    ["cancel_vesting_escrow", "NotPermitToDoThisAction", () => lock.methods.cancelVestingEscrow(null).accountsPartial({ escrow, tokenMint: keys.mint.publicKey, escrowToken, creatorToken, recipientToken: creatorToken, rentReceiver: keys.creator.publicKey, signer: keys.creator.publicKey, memoProgram: MEMO, tokenProgram: TOKEN_PROGRAM_ID }).transaction()],
    ["update_vesting_escrow_recipient", "NotPermitToDoThisAction", () => lock.methods.updateVestingEscrowRecipient(Keypair.generate().publicKey, null).accountsPartial({ escrow, escrowMetadata: null, signer: keys.creator.publicKey, systemProgram: SystemProgram.programId }).transaction()],
  ]) {
    // Simulate (the program's own logs are the evidence); nothing is sent.
    const tx = await build();
    tx.feePayer = keys.creator.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
    const reason = sim.value.err ? (sim.value.logs || []).join(" ") : "ACCEPTED";
    const ok = reason.includes(expectErr);
    console.log(`  ${name}: ${ok ? expectErr : reason.slice(-300)}`);
    check(`${name} is refused by the program with ${expectErr}`, ok);
  }
  check("escrow still holds everything after the attempts", (await balance(escrowToken)) === X);

  console.log("\n[release schedule: cliff +45 s, then every 20 s]");
  check("nothing is released before the date", (await claim("before the date")) === 0n);
  for (let k = 1; k <= 5; k++) {
    const at = cliff + (k - 1) * frequency;
    while ((await chainNow()) < at + 2) await sleep(3000);
    const got = await claim(`step ${k}`);
    check(`step ${k} releases 20%`, got === step, `${got} vs ${step}`);
  }
  check("everything released, escrow empty", (await balance(escrowToken)) === 0n);

  console.log(`\n${failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS"}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => { console.error(e?.logs ? `${e.message}\n${e.logs.join("\n")}` : e); process.exit(1); });
