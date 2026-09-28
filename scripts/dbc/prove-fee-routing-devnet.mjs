#!/usr/bin/env node
/**
 * Devnet proof of DBC fee routing (step 5). Throwaway keys only.
 * Optional DBC_PROVE_FUNDER_KEYPAIR.
 *
 * Real throwaway Postgres on 55432 (no hand-written stand-in). A trade lands
 * between accrual and claim. One swap names the referral ATA; the sweep pays
 * protocol_vault to the lamport and leaves the ATA open for a later swap.
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { SOLANA_GENESIS } from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { createDbcCreateHandler } from "../../frontend/api/dbc/create.js";
import { createDbcConfigLadder } from "../../frontend/api/lib/dbc/dbcConfigLadder.js";
import { buildWalletActionMessage, verifySolanaSignature } from "../../frontend/api/lib/walletActionAuth.js";
import { submitPreparedDbcCreate } from "../../frontend/src/lib/dbcCreateIntent.mjs";
import { readSolUsdMicros } from "../../frontend/api/lib/solUsdMicros.js";
import { startThrowawayPostgres } from "./throwaway-postgres.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} = requireFromFrontend("@solana/web3.js");
const {
  NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} = requireFromFrontend("@solana/spl-token");
const { DynamicBondingCurveClient, SwapMode } = requireFromFrontend("@meteora-ag/dynamic-bonding-curve-sdk");
const BN = requireFromFrontend("bn.js");
import cryptoNode from "node:crypto";

const ed25519Sign = (message, secretKey) => cryptoNode.sign(null, message, cryptoNode.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey).subarray(0, 32)]),
  format: "der", type: "pkcs8",
}));

const DEVNET = SOLANA_GENESIS.devnet;
const RPC = process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-fee-prove-"));
const failures = [];
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

function fakeRes() {
  return { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = JSON.parse(text); } };
}
function jsonReq(body) {
  const payload = JSON.stringify(body);
  return {
    method: "POST", url: "http://localhost/api/dbc/create",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload); },
  };
}
async function post(handle, body) {
  const res = fakeRes();
  await handle(jsonReq(body), res);
  return res;
}
function loadKeypairFile(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}
async function withRetry(label, fn, attempts = 8) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const msg = String(error?.message || error);
      if (!/429|Too Many Requests|fetch failed|ECONNRESET|timed out/i.test(msg) && i > 1) throw error;
      const wait = Math.min(12_000, 750 * 2 ** i);
      console.log(`  retry ${label} in ${wait}ms (${msg.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
async function fund(conn, dest, lamports) {
  const funderPath = process.env.DBC_PROVE_FUNDER_KEYPAIR;
  if (!funderPath) {
    const sig = await conn.requestAirdrop(dest, Number(lamports));
    await conn.confirmTransaction(sig, "confirmed");
    return;
  }
  const funder = loadKeypairFile(funderPath);
  const have = BigInt(await withRetry("getBalance", () => conn.getBalance(dest)));
  const want = BigInt(lamports);
  if (have >= want) return;
  await withRetry("fund", () => sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: dest, lamports: Number(want - have),
  })), [funder], { commitment: "confirmed" }));
}
function signBegin(creator, ticker) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const walletAddress = creator.publicKey.toBase58();
  const message = buildWalletActionMessage({ action: "dbc_create", walletAddress, chainId: 101, nonce, extraLines: [`Ticker: ${ticker}`] });
  const signature = Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), creator.secretKey)).toString("base64");
  return { action: "dbc_create", walletAddress, chainId: 101, nonce, message, signature, walletType: "solana" };
}
async function requireSignedBegin({ res, auth, expectedWallet, action, extraLines }) {
  const walletAddress = String(expectedWallet);
  const expected = buildWalletActionMessage({ action, walletAddress, chainId: 101, nonce: auth?.nonce, extraLines });
  if (String(auth?.message || "") !== expected || !verifySolanaSignature(auth.message, auth.signature, walletAddress)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "bad signature", code: "SIGNATURE_REQUIRED" }));
    return null;
  }
  return { walletAddress, chainId: 101 };
}
async function getTx(conn, sig) {
  for (let i = 0; i < 20; i += 1) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return t;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`tx ${sig} not readable`);
}
function nativeDelta(tx, pubkey) {
  const want = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  const message = tx.transaction.message;
  const keys = (typeof message.getAccountKeys === "function"
    ? message.getAccountKeys().staticAccountKeys
    : null) || message.staticAccountKeys || message.accountKeys || [];
  const keyStr = (entry) => (typeof entry === "string" ? entry : String(entry?.pubkey || entry?.toBase58?.() || ""));
  const i = keys.findIndex((k) => keyStr(k) === want);
  if (i < 0) return 0n;
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
}
async function swapExactIn(client, conn, owner, pool, amountIn, referralTokenAccount = null) {
  const tx = await client.pool.swap2({
    owner: owner.publicKey, pool: new PublicKey(pool), swapBaseForQuote: false,
    referralTokenAccount, swapMode: SwapMode.ExactIn,
    amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(1),
  });
  tx.feePayer = owner.publicKey;
  let sig = null;
  for (let i = 0; i < 8; i += 1) {
    try {
      sig = await conn.sendTransaction(tx, [owner], { skipPreflight: false });
      break;
    } catch (error) {
      if (error?.signature) { sig = error.signature; break; }
      const msg = String(error?.message || error);
      if (!/429|Too Many Requests|fetch failed|timed out/i.test(msg)) throw error;
      const wait = Math.min(12_000, 750 * 2 ** i);
      console.log(`  retry swap-send in ${wait}ms (${msg.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (!sig) throw new Error("swap send failed");
  await getTx(conn, sig);
  return sig;
}

async function main() {
  const pg = await startThrowawayPostgres();
  process.env.DATABASE_URL = pg.url;
  process.env.PG_DISABLE_SSL = "1";
  process.env.SOLANA_RPC_URL = RPC;
  process.env.SOLANA_RPC_HTTP = RPC;
  process.env.ABLY_API_KEY ||= "test:key";
  const db = pg.pool;
  try {
    const { indexDbcPool, decodeEvtSwap2FromTransaction, swapPayerFromTransaction } = await import("../../realtime-indexer/src/dbcIndexer.ts");
    const { accrueDbcFees } = await import("../../realtime-indexer/src/dbc/dbcFeeAccruals.ts");
    const { claimPoolPartnerFees, resolvePendingClaims } = await import("../../realtime-indexer/src/dbc/dbcFeeClaimer.ts");
    const { routeClaimedAccruals, resolvePendingRoutes, rewardVaults } = await import("../../realtime-indexer/src/dbc/dbcFeeRouter.ts");
    const { splitDbcCollectorFee } = await import("../../realtime-indexer/src/dbc/dbcFeeSplit.ts");
    const { sweepReferralToProtocol } = await import("../../realtime-indexer/src/dbc/dbcReferralSweep.ts");

    const conn = new Connection(RPC, "confirmed");
    const genesis = await conn.getGenesisHash();
    if (genesis !== DEVNET) throw new Error(`Refusing: not devnet (${genesis})`);
    const payer = Keypair.generate();
    const collector = Keypair.generate();
    const creator = Keypair.generate();
    const linked = Keypair.generate();
    const og = Keypair.generate();
    const unlinked = Keypair.generate();
    const referralOwner = Keypair.generate();
    fs.writeFileSync(path.join(DIR, "keys.json"), JSON.stringify({
      payer: Array.from(payer.secretKey), collector: Array.from(collector.secretKey),
      creator: Array.from(creator.secretKey), linked: Array.from(linked.secretKey),
      og: Array.from(og.secretKey), unlinked: Array.from(unlinked.secretKey),
      referralOwner: Array.from(referralOwner.secretKey),
    }));
    console.log(`devnet ${genesis}\nthrowaway keys in ${DIR}\npostgres ${pg.url}`);
    if (process.env.DBC_PROVE_FUNDER_KEYPAIR) {
      console.log(`funder ${loadKeypairFile(process.env.DBC_PROVE_FUNDER_KEYPAIR).publicKey.toBase58()}`);
    }
    await fund(conn, payer.publicKey, 120_000_000);
    await fund(conn, creator.publicKey, 180_000_000);
    await fund(conn, collector.publicKey, 50_000_000);
    await fund(conn, linked.publicKey, 35_000_000);
    await fund(conn, og.publicKey, 35_000_000);
    await fund(conn, unlinked.publicKey, 90_000_000);
    await fund(conn, referralOwner.publicKey, 30_000_000);

    const referralAta = getAssociatedTokenAddressSync(NATIVE_MINT, referralOwner.publicKey);
    await withRetry("referral-ata", () => sendAndConfirmTransaction(conn, new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        referralOwner.publicKey, referralAta, referralOwner.publicKey, NATIVE_MINT,
      ),
    ), [referralOwner], { commitment: "confirmed" }));

    const env = {
      DBC_LAUNCH_ENABLED: "true", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
      SOLANA_ROUTE_SIGNER_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
      DBC_CONFIG_PAYER_SECRET: JSON.stringify(Array.from(payer.secretKey)),
      DBC_FEE_COLLECTOR: collector.publicKey.toBase58(),
    };
    const now = new Date();
    const recLinked = await db.query(
      `insert into public.recruiters (wallet_address, code, is_og) values ('reclink', 'linked', false) returning id`,
    );
    const recOg = await db.query(
      `insert into public.recruiters (wallet_address, code, is_og) values ('recog', 'og', true) returning id`,
    );
    await db.query(
      `insert into public.wallet_recruiter_links (wallet_address, recruiter_id, link_source, linked_at, is_active)
       values ($1,$2,'manual',$3,true)`,
      [linked.publicKey.toBase58(), recLinked.rows[0].id, now],
    );
    await db.query(
      `insert into public.wallet_recruiter_links (wallet_address, recruiter_id, link_source, linked_at, is_active)
       values ($1,$2,'manual',$3,true)`,
      [og.publicKey.toBase58(), recOg.rows[0].id, now],
    );

    const client = new DynamicBondingCurveClient(conn, "confirmed");
    const ladder = createDbcConfigLadder({ db, env, cluster: "devnet", connection: conn, payer, feeClaimer: collector.publicKey, client });
    const handle = createDbcCreateHandler({ env, db, connection: conn, client, ladder, requireWalletActionAuth: requireSignedBegin, readSolUsdMicros });
    const ticker = `F${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;
    const begun = await post(handle, { operation: "begin", creatorWallet: creator.publicKey.toBase58(), ticker, auth: signBegin(creator, ticker) });
    if (!begun.body.ok) throw new Error(`begin failed ${begun.body.error}`);
    const mint = Keypair.generate();
    const auth = await post(handle, {
      operation: "authorize", sessionToken: begun.body.sessionToken, mint: mint.publicKey.toBase58(),
      name: "DBC Fee Proof", symbol: ticker, targetUsd: 150, feeChoice: "keep", firstBuyLamports: "0",
    });
    if (!auth.body.ok) throw new Error(`authorize failed ${auth.body.error}`);
    const created = await submitPreparedDbcCreate({
      connection: conn, transaction: Transaction.from(Buffer.from(auth.body.transaction, "base64")),
      mintSecretKey: mint.secretKey, mintAddress: mint.publicKey.toBase58(),
      creatorAddress: creator.publicKey.toBase58(), pool: auth.body.pool, config: auth.body.config, Keypair,
      signTransaction: async (unsigned) => { unsigned.partialSign(creator); return unsigned; },
    });
    await post(handle, { operation: "finalize", finalizeToken: auth.body.finalizeToken, signature: created.signature });
    const poolAddr = auth.body.pool;
    console.log(`pool ${poolAddr} mint ${mint.publicKey.toBase58()} create ${created.signature}`);

    const buyLamports = 20_000_000n;
    const sigLinked = await swapExactIn(client, conn, linked, poolAddr, buyLamports);
    const sigOg = await swapExactIn(client, conn, og, poolAddr, buyLamports);
    const sigUnlinked = await swapExactIn(client, conn, unlinked, poolAddr, buyLamports);
    console.log(`linked ${sigLinked}\nog ${sigOg}\nunlinked ${sigUnlinked}`);

    const indexed = await withRetry("indexDbcPool", () => indexDbcPool(db, {
      campaign: poolAddr, token: mint.publicKey.toBase58(), creator: creator.publicKey.toBase58(), migrated: false,
    }));
    console.log("indexer", indexed);
    const trades = await db.query(`select tx_hash from public.curve_trades where campaign_address=$1`, [poolAddr]);
    check("indexer wrote three trades", trades.rows.length === 3, String(trades.rows.length));

    for (const [label, sig, wallet] of [
      ["linked", sigLinked, linked.publicKey.toBase58()],
      ["og", sigOg, og.publicKey.toBase58()],
      ["unlinked", sigUnlinked, unlinked.publicKey.toBase58()],
    ]) {
      const tx = await getTx(conn, sig);
      const events = decodeEvtSwap2FromTransaction(tx);
      check(`${label} EvtSwap2 present`, events.length === 1, String(events.length));
      const swapPayer = swapPayerFromTransaction(tx);
      check(`${label} swap payer is the trader`, swapPayer === wallet, swapPayer);
      const event = events[0];
      const F = event.tradingFee + event.protocolFee + event.referralFee;
      console.log(`  ${label} F=${F.toString()} trading=${event.tradingFee.toString()} protocol=${event.protocolFee.toString()} referral=${event.referralFee.toString()}`);
      check(`${label} F is the EvtSwap2 sum, not a hardcoded 2% of 20M`, F === event.tradingFee + event.protocolFee + event.referralFee && F !== 400_000n);
      check(`${label} trading fee is 80% of F from the event`, event.tradingFee === (F * 80n) / 100n);
    }

    const accrued = await accrueDbcFees(db);
    console.log("accrued", accrued);
    const accrualRows = await db.query(`select * from public.dbc_fee_accruals where pool=$1 order by id`, [poolAddr]);
    check("three accruals", accrualRows.rows.length === 3, String(accrualRows.rows.length));
    check("linked profile", accrualRows.rows.find((a) => a.trader === linked.publicKey.toBase58())?.profile === "standard_linked");
    check("OG profile", accrualRows.rows.find((a) => a.trader === og.publicKey.toBase58())?.profile === "og_linked");
    check("unlinked profile", accrualRows.rows.find((a) => a.trader === unlinked.publicKey.toBase58())?.profile === "standard_unlinked");
    for (const row of accrualRows.rows) {
      const activity = await db.query(`select meta from public.activity_events where tx_hash=$1 and log_index=$2`, [row.tx_hash, row.log_index]);
      const meta = activity.rows[0]?.meta || {};
      const expected = splitDbcCollectorFee({
        tradingFee: BigInt(String(meta.trading_fee || "0")),
        protocolFee: BigInt(String(meta.protocol_fee || "0")),
        referralFee: BigInt(String(meta.referral_fee || "0")),
        mode: "creator",
        profile: row.profile,
      });
      check(
        `${row.profile} collector_amount matches split of EvtSwap2`,
        BigInt(row.collector_amount) === expected.collectorAmount,
        `got collector ${row.collector_amount} expected ${expected.collectorAmount.toString()}`,
      );
    }

    const expectedFirst = accrualRows.rows.reduce((s, a) => s + BigInt(a.collector_amount), 0n);
    const wrapBeforeExtra = await client.state.getPool(new PublicKey(poolAddr));
    const owedBeforeExtra = BigInt((wrapBeforeExtra?.poolState ?? wrapBeforeExtra).partnerQuoteFee.toString());
    check("partner fee counter equals sum of collector amounts before extra trade", owedBeforeExtra === expectedFirst, `owed ${owedBeforeExtra} expected ${expectedFirst}`);

    const sigExtra = await swapExactIn(client, conn, unlinked, poolAddr, buyLamports, referralAta);
    console.log(`extra-between-accrue-and-claim ${sigExtra}`);
    const wrapAfterExtra = await client.state.getPool(new PublicKey(poolAddr));
    const owedAfterExtra = BigInt((wrapAfterExtra?.poolState ?? wrapAfterExtra).partnerQuoteFee.toString());
    check("extra trade increased the partner fee counter", owedAfterExtra > expectedFirst, `owed ${owedAfterExtra} accrued ${expectedFirst}`);

    const claimed = await claimPoolPartnerFees({
      db, connection: conn, collector, pool: poolAddr, send: true, minLamports: 1n, client,
    });
    check("first claim not blocked", claimed.blocked === false, claimed.reason);
    check("first claim max is the accrued sum, not everything owed", claimed.expected === expectedFirst, `expected ${claimed.expected} first ${expectedFirst}`);
    for (let i = 0; i < 40; i += 1) {
      await resolvePendingClaims({ db, connection: conn, client });
      const pending = await db.query(`select status from public.dbc_fee_accruals where pool=$1 and status='claiming'`, [poolAddr]);
      if (!pending.rows.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const afterClaim = await db.query(`select status, collector_amount from public.dbc_fee_accruals where pool=$1`, [poolAddr]);
    check("first three accruals claimed", afterClaim.rows.filter((r) => r.status === "claimed").length === 3, JSON.stringify(afterClaim.rows.map((r) => r.status)));
    const wrapAfterClaim = await client.state.getPool(new PublicKey(poolAddr));
    const owedKept = BigInt((wrapAfterClaim?.poolState ?? wrapAfterClaim).partnerQuoteFee.toString());
    check("pool counter kept the extra trade", owedKept === owedAfterExtra - expectedFirst, `kept ${owedKept} extra ${owedAfterExtra - expectedFirst}`);

    const indexedExtra = await withRetry("indexDbcPool-extra", () => indexDbcPool(db, {
      campaign: poolAddr, token: mint.publicKey.toBase58(), creator: creator.publicKey.toBase58(), migrated: false,
    }));
    console.log("indexer extra", indexedExtra);
    const accruedExtra = await accrueDbcFees(db);
    check("fourth trade accrued on the next pass", accruedExtra.accrued === 1, JSON.stringify(accruedExtra));
    const claimedExtra = await claimPoolPartnerFees({
      db, connection: conn, collector, pool: poolAddr, send: true, minLamports: 1n, client,
    });
    check("second claim not blocked", claimedExtra.blocked === false, claimedExtra.reason);
    for (let i = 0; i < 40; i += 1) {
      await resolvePendingClaims({ db, connection: conn, client });
      const pending = await db.query(`select status from public.dbc_fee_accruals where pool=$1 and status='claiming'`, [poolAddr]);
      if (!pending.rows.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const allAccruals = await db.query(`select * from public.dbc_fee_accruals where pool=$1`, [poolAddr]);
    const vaults = rewardVaults();
    const routed = await routeClaimedAccruals({ db, connection: conn, collector, send: true });
    check("route submitted", Boolean(routed.signature), routed.skipped);
    if (!routed.signature) throw new Error(`route did not send: ${routed.skipped}`);
    for (let i = 0; i < 40; i += 1) {
      await resolvePendingRoutes({ db, connection: conn });
      const pending = await db.query(`select status from public.dbc_fee_accruals where pool=$1 and status='routing'`, [poolAddr]);
      if (!pending.rows.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const routeTx = await getTx(conn, routed.signature);
    for (const dest of routed.destinations) {
      const moved = nativeDelta(routeTx, dest.to);
      check(`${dest.seed} vault +${dest.lamports.toString()}`, moved === dest.lamports, `moved ${moved} expected ${dest.lamports}`);
    }
    const expectedWeekly = allAccruals.rows.reduce((s, a) => s + BigInt(a.league_weekly), 0n);
    const expectedMonthly = allAccruals.rows.reduce((s, a) => s + BigInt(a.league_monthly), 0n);
    const expectedRecruiter = allAccruals.rows.reduce((s, a) => s + BigInt(a.recruiter), 0n);
    const expectedSquad = allAccruals.rows.reduce((s, a) => s + BigInt(a.squad), 0n);
    const expectedAirdrop = allAccruals.rows.reduce((s, a) => s + BigInt(a.airdrop), 0n);
    const expectedProtocol = allAccruals.rows.reduce((s, a) => s + BigInt(a.protocol), 0n);
    check("weekly vault total", nativeDelta(routeTx, vaults.leagueWeekly.toBase58()) === expectedWeekly, `${expectedWeekly}`);
    check("monthly vault total", nativeDelta(routeTx, vaults.leagueMonthly.toBase58()) === expectedMonthly, `${expectedMonthly}`);
    check("recruiter vault total", nativeDelta(routeTx, vaults.recruiter.toBase58()) === expectedRecruiter, `${expectedRecruiter}`);
    check("squad vault total", nativeDelta(routeTx, vaults.squad.toBase58()) === expectedSquad, `${expectedSquad}`);
    check("airdrop vault total", nativeDelta(routeTx, vaults.airdrop.toBase58()) === expectedAirdrop, `${expectedAirdrop}`);
    check("protocol vault total", nativeDelta(routeTx, vaults.protocol.toBase58()) === expectedProtocol, `${expectedProtocol}`);
    check("OG recruiter slice > 0", expectedRecruiter > 0n);
    check("unlinked airdrop slice > 0", expectedAirdrop > 0n);
    const routedRows = await db.query(`select status from public.dbc_fee_accruals where pool=$1`, [poolAddr]);
    check("accruals marked routed", routedRows.rows.every((a) => a.status === "routed"));

    const extraEvt = decodeEvtSwap2FromTransaction(await getTx(conn, sigExtra));
    check("extra trade named the referral account", extraEvt[0]?.referralFee > 0n, `referral ${extraEvt[0]?.referralFee}`);
    const referralBefore = BigInt((await conn.getTokenAccountBalance(referralAta)).value.amount);
    check("referral ATA holds the referral fee", referralBefore === extraEvt[0].referralFee, `ata ${referralBefore} event ${extraEvt[0].referralFee}`);
    const protocolBefore = BigInt(await conn.getBalance(vaults.protocol));
    const swept = await sweepReferralToProtocol({
      db, connection: conn, collector, referralOwner, referralTokenAccount: referralAta.toBase58(), send: true,
    });
    check("sweep sent", Boolean(swept.signature), swept.skipped);
    const sweepTx = await getTx(conn, swept.signature);
    const protocolMoved = nativeDelta(sweepTx, vaults.protocol.toBase58());
    check("referral sweep paid protocol_vault to the lamport", protocolMoved === referralBefore, `moved ${protocolMoved} referral ${referralBefore}`);
    const referralAfter = await conn.getAccountInfo(referralAta, "confirmed");
    check("referral account still exists", Boolean(referralAfter));
    const sigLater = await swapExactIn(client, conn, unlinked, poolAddr, buyLamports, referralAta);
    check("later swap naming the referral account succeeded", Boolean(sigLater), sigLater);

    console.log(failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL CHECKS PASS");
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    await pg.stop();
  }
}

main().catch((error) => {
  console.error(error?.logs ? `${error.message}\n${error.logs.join("\n")}` : error);
  process.exit(1);
});
