"use strict";

/**
 * PROOF, local validator only: what does today's launchpad binary pay at
 * graduation under the LIVE mainnet generation economics?
 *
 * Generation here = mainnet GenerationConfig economics exactly:
 *   supply 1e15 raw (6 dec), curve 8400 bps, liquidity 1400 bps (reserve 200),
 *   base 1 lamport, slope 850, economics v3, fees 200/200/200, post-finalize 2000/8000,
 *   cluster_kind mainnet-beta (2), tier mask 14 ($15K/$30K/$50K), target $15K.
 * The route signer is a local throwaway (mainnet GlobalConfig is not cloned).
 *
 * Buys until net raised >= ceil(15_000e6 * 1e9 / 118_590_000), then runs
 * scripts/solana/graduate-campaign.mjs exactly as Gate K2 does with
 * SOLANA_GRADUATION_ORACLE_PRICE_USD_MICROS=118590000, and reads every number
 * off the confirmed transactions.
 *
 *   bash scripts/solana/run-proof-graduation-payout.sh
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} = web3;
const {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");

const { createAuthorizationDigest } = require("./authorization-v4.cjs");
const { decodeCampaign } = require("./decode-campaign.cjs");

const { AnchorProvider, BN, Program, setProvider } = anchor;

const PROGRAM_ID = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const SO_PATH = path.resolve(__dirname, "../../target/deploy/memewarzone_solana.so");
const CERTIFIED_SHA = "e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2";
const TRADE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_TRADE_V1", "utf8");
const TRADE_AUTH_SCHEMA_VERSION = 3;
const TRADE_SIDE_BUY = 1;
const ROUTE_PROFILE_UNLINKED = 1;
const REWARDS_TREASURY = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const METAPLEX_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const METEORA_CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Live mainnet GenerationConfig economics.
const MAINNET = {
  clusterKind: 2,
  allowedGraduationTierMask: 14,
  economicsVersion: 3,
  tokenTotalSupply: 1_000_000_000_000_000n,
  tokenDecimals: 6,
  curveSupplyBps: 8_400,
  liquidityTokenBps: 1_400,
  basePriceLamports: 1n,
  priceSlopeLamports: 850n,
  buyFeeBps: 200,
  sellFeeBps: 200,
  finalizeFeeBps: 200,
  creatorPostFinalizeBps: 2_000,
  liquidityPostFinalizeBps: 8_000,
};
const TARGET_USD_MICROS = 15_000_000_000n;
const ORACLE_USD_MICROS = 118_590_000n;
const NATIVE_TARGET = (TARGET_USD_MICROS * 1_000_000_000n + ORACLE_USD_MICROS - 1n) / ORACLE_USD_MICROS;

const hash32 = (label) => crypto.createHash("sha256").update(label, "utf8").digest();
const fixed32 = (value) => Array.from(Buffer.from(value));
const derivePda = (programId, ...seeds) =>
  PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), programId)[0];
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n), 0); return b; };
const sol = (l) => (Number(l) / 1e9).toFixed(9);
const tok = (raw) => (Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

function tradeDigest(i) {
  return crypto.createHash("sha256").update(Buffer.concat([
    TRADE_AUTH_DOMAIN, u16le(TRADE_AUTH_SCHEMA_VERSION),
    new PublicKey(i.programId).toBuffer(), new PublicKey(i.campaign).toBuffer(),
    new PublicKey(i.mint).toBuffer(), new PublicKey(i.trader).toBuffer(),
    Buffer.from([i.side]), u64le(i.amountIn), u64le(i.minOut), i64le(i.deadline),
    Buffer.from(i.nonce), u64le(i.nativeTargetLamports), Buffer.from([i.routeProfile]),
  ])).digest();
}

const VAULT_SEEDS = ["league_vault", "airdrop_vault", "monthly_league_vault", "recruiter_vault", "squad_vault", "protocol_vault"];
const rewardVaults = () => Object.fromEntries(VAULT_SEEDS.map((s) => [s, derivePda(REWARDS_TREASURY, s)]));

describe("PROOF: graduation payout under live mainnet economics (local validator)", function () {
  this.timeout(1_000_000);

  const provider = AnchorProvider.env();
  setProvider(provider);
  const idl = require(path.resolve(__dirname, "../../target/idl/memewarzone_solana.json"));
  const program = new Program(idl, provider);
  const connection = provider.connection;
  const admin = provider.wallet.publicKey;
  const adminKeypair = provider.wallet.payer;
  const routeSigner = Keypair.generate();
  const globalConfig = derivePda(program.programId, "global");
  const generationId = hash32("proof-graduation-payout-mainnet-economics");
  const generationConfig = derivePda(program.programId, "generation", generationId);
  const emptyClusterId = Buffer.alloc(32);
  const clusterProfile = derivePda(program.programId, "cluster", emptyClusterId);
  let v0Helpers;
  let lookupTableAccount;

  async function fund(pubkey, lamports) {
    const sig = await connection.requestAirdrop(pubkey, Number(lamports));
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  }

  async function sendLegacy(payer, ixs, signers = [payer]) {
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...ixs);
    tx.sign(...signers);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const c = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (c.value.err) throw new Error(`tx failed ${JSON.stringify(c.value.err)}`);
    return signature;
  }

  async function setupWallet(lamports) {
    const keypair = Keypair.generate();
    await fund(keypair.publicKey, lamports);
    const creatorProfile = derivePda(program.programId, "creator", keypair.publicKey.toBuffer());
    const riskProfile = derivePda(program.programId, "risk", keypair.publicKey.toBuffer());
    await program.methods.syncCreatorProfile({
      wallet: keypair.publicKey, tier: 1, trustScore: 7_000, liveBondingCount: 0,
      lastLaunchTimestamp: new BN(0), totalLaunches: new BN(0), successfulGraduations: new BN(0),
      restricted: false, manualReviewRequired: false, creatorBuyCapBps: 1_000,
    }).accountsStrict({ authority: admin, globalConfig, creatorProfile, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    await program.methods.syncRiskProfile({
      wallet: keypair.publicKey, riskLevel: 0, restricted: false,
      clusterId: Array.from(emptyClusterId), manualReviewRequired: false,
    }).accountsStrict({ authority: admin, globalConfig, riskProfile, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    return { keypair, creatorProfile, riskProfile };
  }

  before(async function () {
    const soHash = crypto.createHash("sha256").update(fs.readFileSync(SO_PATH)).digest("hex");
    console.log(`[proof] .so sha256=${soHash}`);
    assert.equal(soHash, CERTIFIED_SHA, "the binary on disk is not the certified mainnet launchpad");
    assert.equal(program.programId.toBase58(), PROGRAM_ID);
    const genesis = await connection.getGenesisHash();
    assert.ok(!["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"].includes(genesis),
      "refusing: this proof runs on a local validator only");
    assert.ok(/127\.0\.0\.1|localhost/.test(connection.rpcEndpoint), "refusing: RPC is not local");

    if ((await connection.getBalance(admin, "confirmed")) < 50 * LAMPORTS_PER_SOL) {
      await fund(admin, 100n * 1_000_000_000n);
    }
    assert.equal(await connection.getAccountInfo(globalConfig, "confirmed"), null, "restart the validator with --reset");

    await program.methods.initializeGlobalConfig({
      admin, pauser: admin, tierAdmin: admin, riskAdmin: admin, routeSigner: routeSigner.publicKey,
      rewardOperator: admin, treasuryOperator: admin, generationOperator: admin,
    }).accountsStrict({ admin, globalConfig, systemProgram: SystemProgram.programId }).rpc({ commitment: "confirmed" });
    await program.methods.lockSecurityDefaults().accountsStrict({ globalConfig, admin }).rpc({ commitment: "confirmed" });
    await program.methods.setPauseFlags({
      paused: false, createPaused: false, buyPaused: false, sellPaused: false, graduationPaused: false, claimsPaused: true,
    }).accountsStrict({ globalConfig, authority: admin }).rpc({ commitment: "confirmed" });

    await program.methods.initializeGenerationConfig({
      generationId: fixed32(generationId),
      clusterKind: MAINNET.clusterKind,
      allowedGraduationTierMask: MAINNET.allowedGraduationTierMask,
      economicsVersion: MAINNET.economicsVersion,
      curveKind: 1,
      tokenTotalSupply: new BN(MAINNET.tokenTotalSupply.toString()),
      tokenDecimals: MAINNET.tokenDecimals,
      curveSupplyBps: MAINNET.curveSupplyBps,
      liquidityTokenBps: MAINNET.liquidityTokenBps,
      basePriceLamports: new BN(MAINNET.basePriceLamports.toString()),
      priceSlopeLamports: new BN(MAINNET.priceSlopeLamports.toString()),
      buyFeeBps: MAINNET.buyFeeBps,
      sellFeeBps: MAINNET.sellFeeBps,
      finalizeFeeBps: MAINNET.finalizeFeeBps,
      creatorPostFinalizeBps: MAINNET.creatorPostFinalizeBps,
      liquidityPostFinalizeBps: MAINNET.liquidityPostFinalizeBps,
      dexAdapter: 1,
      tradeRouteProfile: fixed32(hash32("trade-route-profile-v1")),
      finalizeRouteProfile: fixed32(hash32("finalize-route-profile-v1")),
      treasuryProfile: fixed32(hash32("treasury-profile-v1")),
      dexProfile: fixed32(hash32("dex-profile-v1")),
      oracleProfile: fixed32(hash32("oracle-profile-v1")),
      activeCreation: true,
      supportEnabled: true,
      manifestHash: fixed32(hash32("generation-manifest-proof-mainnet-economics")),
      routeAuthorizationRequired: true,
      authorizedTradingRequired: true,
    }).accountsStrict({ authority: admin, globalConfig, generationConfig, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });

    for (const vault of Object.values(rewardVaults())) {
      if ((await connection.getBalance(vault, "confirmed")) === 0) await fund(vault, 1_000_000_000n);
    }

    const { loadSolanaV0Module } = await import("../../frontend/scripts/load-solana-v0-module.mjs");
    v0Helpers = await loadSolanaV0Module();
    const plan = v0Helpers.buildLaunchpadAltPlan(web3);
    const slot = await connection.getSlot("confirmed");
    const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: admin, payer: admin, recentSlot: Math.max(0, slot - 1),
    });
    await sendLegacy(adminKeypair, [createIx]);
    for (let i = 0; i < plan.length; i += 20) {
      await sendLegacy(adminKeypair, [AddressLookupTableProgram.extendLookupTable({
        payer: admin, authority: admin, lookupTable, addresses: plan.slice(i, i + 20).map((e) => e.address),
      })]);
    }
    await new Promise((r) => setTimeout(r, 2500));
    lookupTableAccount = await v0Helpers.fetchAndVerifyLaunchpadLookupTable(web3, connection, {
      allowMutableTable: true, address: lookupTable.toBase58(),
      requiredAddresses: plan.map((e) => e.address), expectedAuthority: admin,
    });
  });

  it("graduates a $15K campaign at $118.59/SOL and measures who gets what", async function () {
    const meteora = await connection.getAccountInfo(METEORA_CP_AMM, "confirmed");
    assert.ok(meteora?.executable, "Meteora DAMM v2 must be loaded");
    const creator = await setupWallet(5n * 1_000_000_000n);
    const buyer = await setupWallet(200n * 1_000_000_000n);

    // ---- create (production shape, same as the lifecycle harness) ----
    const now = (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
    const createArgs = {
      campaignId: fixed32(hash32("campaign:proof-k88-economics")),
      name: "Proof K88 Economics",
      symbol: "PK88",
      metadataHash: fixed32(hash32("metadata:proof-k88")),
      launchAt: new BN(0),
      graduationTargetUsdMicros: new BN(TARGET_USD_MICROS.toString()),
      deadline: new BN(now + 3_600),
    };
    const id = Buffer.from(createArgs.campaignId);
    const acc = {
      campaign: derivePda(program.programId, "campaign", id),
      mint: derivePda(program.programId, "campaign-mint", id),
      tokenVault: derivePda(program.programId, "token-vault", id),
      solVault: derivePda(program.programId, "sol-vault", id),
    };
    acc.tokenMetadata = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METAPLEX_METADATA_PROGRAM.toBuffer(), acc.mint.toBuffer()], METAPLEX_METADATA_PROGRAM)[0];
    acc.feeEscrow = derivePda(program.programId, "fee-escrow", acc.campaign.toBuffer());
    acc.creatorFeeVault = derivePda(program.programId, "creator-fee-vault", acc.campaign.toBuffer());

    const generation = await program.account.generationConfig.fetch(generationConfig);
    const profile = await program.account.creatorProfile.fetch(creator.creatorProfile);
    const digest = createAuthorizationDigest({
      programId: program.programId, generationConfigKey: generationConfig, generation,
      creator: creator.keypair.publicKey, riskClusterId: emptyClusterId,
      creatorBuyLockSeconds: profile.creatorBuyLockSeconds, creatorBuyCapBps: profile.creatorBuyCapBps,
      campaign: acc.campaign, mint: acc.mint, tokenVault: acc.tokenVault, solVault: acc.solVault,
      tokenProgram: TOKEN_PROGRAM_ID, args: createArgs,
    });
    const createIx = await program.methods.createCampaign(createArgs).accountsStrict({
      creator: creator.keypair.publicKey, globalConfig, generationConfig,
      creatorProfile: creator.creatorProfile, riskProfile: creator.riskProfile, clusterProfile,
      campaign: acc.campaign, mint: acc.mint, tokenVault: acc.tokenVault, solVault: acc.solVault,
      tokenMetadata: acc.tokenMetadata, tokenMetadataProgram: METAPLEX_METADATA_PROGRAM,
      feeEscrow: acc.feeEscrow, creatorFeeVault: acc.creatorFeeVault,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    const createSig = await sendLegacy(creator.keypair, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      Ed25519Program.createInstructionWithPrivateKey({ privateKey: routeSigner.secretKey, message: digest }),
      createIx,
    ], [creator.keypair]);
    console.log(`[proof] create ${createSig}`);
    const created = decodeCampaign((await connection.getAccountInfo(acc.campaign, "confirmed")).data);
    console.log(`[proof] campaign curve=${created.curveTokenSupply} liquidity=${created.liquidityTokenSupply} reserve=${created.reserveTokenSupply} target=${created.graduationTargetUsdMicros} cluster=${created.clusterKind}`);

    // ---- buy until the $15K native target closes the curve ----
    const buyerAta = getAssociatedTokenAddressSync(acc.mint, buyer.keypair.publicKey);
    await sendLegacy(buyer.keypair, [createAssociatedTokenAccountInstruction(buyer.keypair.publicKey, buyerAta, buyer.keypair.publicKey, acc.mint)]);

    async function buy(lamportsIn) {
      const t = (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
      const nonce = hash32(`buy:${Date.now()}:${lamportsIn}:${Math.random()}`);
      const deadline = t + 3_600;
      const d = tradeDigest({
        programId: program.programId, campaign: acc.campaign, mint: acc.mint, trader: buyer.keypair.publicKey,
        side: TRADE_SIDE_BUY, amountIn: lamportsIn, minOut: 1n, deadline, nonce,
        nativeTargetLamports: NATIVE_TARGET, routeProfile: ROUTE_PROFILE_UNLINKED,
      });
      const ed25519 = Ed25519Program.createInstructionWithPrivateKey({ privateKey: routeSigner.secretKey, message: d });
      const tradeAuth = derivePda(program.programId, "trade-auth", buyer.keypair.publicKey.toBuffer(), nonce);
      const buyIx = await program.methods.buyTokens({
        lamportsIn: new BN(lamportsIn.toString()), minTokensOut: new BN(1), deadline: new BN(deadline),
        nonce: Array.from(nonce), nativeTargetLamports: new BN(NATIVE_TARGET.toString()), routeProfile: ROUTE_PROFILE_UNLINKED,
      }).accountsStrict({
        trader: buyer.keypair.publicKey, globalConfig, campaign: acc.campaign, mint: acc.mint,
        tokenVault: acc.tokenVault, solVault: acc.solVault, traderTokenAccount: buyerAta,
        riskProfile: buyer.riskProfile, clusterProfile, tradeAuthorization: tradeAuth,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId, feeEscrow: acc.feeEscrow,
      }).instruction();
      const compiled = await v0Helpers.compileLaunchpadV0WithLatestBlockhash(web3, connection,
        { payer: buyer.keypair.publicKey, instructions: [ed25519, buyIx], lookupTableAccounts: [lookupTableAccount] },
        { payer: buyer.keypair.publicKey, ed25519Instruction: ed25519, programInstruction: buyIx, lookupTableAccounts: [lookupTableAccount] });
      compiled.transaction.sign([buyer.keypair]);
      const sim = await connection.simulateTransaction(compiled.transaction, { sigVerify: false });
      if (sim.value.err) throw new Error(`buy sim failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-10).join("\n")}`);
      const sig = await connection.sendTransaction(compiled.transaction, { skipPreflight: true, maxRetries: 5 });
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error(`buy landed with error ${JSON.stringify(st.value.err)}`);
        if (["confirmed", "finalized"].includes(st?.value?.confirmationStatus)) return sig;
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(`buy ${sig} not confirmed`);
    }

    const buySigs = [];
    const CHUNK = 20n * 1_000_000_000n;
    for (let i = 0; i < 40; i += 1) {
      const c = decodeCampaign((await connection.getAccountInfo(acc.campaign, "confirmed")).data);
      if (c.curveClosed) break;
      const need = NATIVE_TARGET - BigInt(c.netRaisedLamports);
      // gross = curve cost + 2% fee; a little headroom so the last buy crosses the target.
      const exact = (need * 10_200n + 9_999n) / 10_000n + 1_000n;
      const lamportsIn = exact < CHUNK ? exact : CHUNK;
      buySigs.push(await buy(lamportsIn));
    }
    const closed = decodeCampaign((await connection.getAccountInfo(acc.campaign, "confirmed")).data);
    assert.equal(closed.curveClosed, true, "curve must close at the $15K native target");
    console.log(`[proof] buys ${buySigs.length}: ${buySigs.join(" ")}`);
    console.log(`[proof] closed: nativeTarget=${NATIVE_TARGET} (${sol(NATIVE_TARGET)} SOL) netRaised=${closed.netRaisedLamports} (${sol(closed.netRaisedLamports)} SOL) sold=${closed.soldTokens} (${tok(closed.soldTokens)} tokens)`);

    // ---- snapshot before graduation ----
    const binding = require("../../scripts/solana/graduation-binding.cjs");
    const programQuote = binding.graduationQuote(closed);
    const mintSupplyBefore = BigInt((await connection.getTokenSupply(acc.mint, "confirmed")).value.amount);
    const creatorBalBefore = BigInt(await connection.getBalance(creator.keypair.publicKey, "confirmed"));
    const solVaultBefore = BigInt(await connection.getBalance(acc.solVault, "confirmed"));
    const vaults = rewardVaults();
    const vaultBefore = {};
    for (const [k, v] of Object.entries(vaults)) vaultBefore[k] = BigInt(await connection.getBalance(v, "confirmed"));

    // ---- graduate exactly as Gate K2 / the production keeper ----
    const { spawnSync } = require("node:child_process");
    const run = spawnSync(process.execPath, [path.join(__dirname, "../../scripts/solana/graduate-campaign.mjs"), acc.campaign.toBase58()], {
      env: {
        ...process.env,
        SOLANA_RPC_URL: connection.rpcEndpoint,
        SOLANA_LAUNCHPAD_PROGRAM_ID: program.programId.toBase58(),
        SOLANA_LAUNCHPAD_IDL: path.join(__dirname, "../../scripts/solana/idl/memewarzone_solana.json"),
        SOLANA_TREASURY_OPERATOR_KEYPAIR: JSON.stringify(Array.from(adminKeypair.secretKey)),
        SOLANA_ROUTE_SIGNER_KEYPAIR: JSON.stringify(Array.from(routeSigner.secretKey)),
        SOLANA_GRADUATION_ORACLE_PRICE_USD_MICROS: ORACLE_USD_MICROS.toString(),
        SOLANA_GRADUATION_ALT_MODE: "per-graduation",
        SOLANA_GRADUATION_QUOTE_PROFILE: "native",
        SOLANA_GRADUATION_SEND: "true",
      },
      encoding: "utf8",
      timeout: 180_000,
    });
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    console.log(out.split("\n").map((l) => `    [operator] ${l}`).join("\n"));
    assert.equal(run.status, 0, `operator failed:\n${out}`);
    const gradSig = (out.match(/"signature":\s*"([1-9A-HJ-NP-Za-km-z]+)"/) || [])[1];
    const flushSig = (out.match(/fees flushed: ([1-9A-HJ-NP-Za-km-z]+)/) || [])[1] || null;
    assert.ok(gradSig, "graduation signature not found in operator output");

    const graduated = decodeCampaign((await connection.getAccountInfo(acc.campaign, "confirmed")).data);
    assert.equal(graduated.graduated, true);

    // ---- measure from the confirmed graduation transaction ----
    const tx = await connection.getTransaction(gradSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    assert.ok(tx && tx.meta && tx.meta.err === null, "graduation tx must be confirmed without error");
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
      .keySegments().flat().map((k) => k.toBase58());
    const lamDelta = (pk) => {
      const i = keys.indexOf(pk.toBase58());
      return i < 0 ? null : BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    };
    const tokenBal = (list, pk) => {
      const i = keys.indexOf(pk.toBase58());
      const e = (list || []).find((b) => b.accountIndex === i);
      return e ? BigInt(e.uiTokenAmount.amount) : 0n;
    };
    const pool = binding.deriveMeteoraPool(acc.mint);
    const meteoraTokenVault = PublicKey.findProgramAddressSync([Buffer.from("token_vault"), acc.mint.toBuffer(), pool.toBuffer()], METEORA_CP_AMM)[0];
    const meteoraSolVault = PublicKey.findProgramAddressSync([Buffer.from("token_vault"), NATIVE_MINT.toBuffer(), pool.toBuffer()], METEORA_CP_AMM)[0];
    const creatorAta = getAssociatedTokenAddressSync(acc.mint, creator.keypair.publicKey);

    const creatorSolDelta = lamDelta(creator.keypair.publicKey);
    const vaultDeltas = Object.fromEntries(Object.entries(vaults).map(([k, v]) => [k, lamDelta(v) ?? 0n]));
    const finalizeRouted = Object.values(vaultDeltas).reduce((a, b) => a + b, 0n);
    const poolSol = tokenBal(tx.meta.postTokenBalances, meteoraSolVault);
    const poolTokens = tokenBal(tx.meta.postTokenBalances, meteoraTokenVault);
    const creatorTokensDelta = tokenBal(tx.meta.postTokenBalances, creatorAta) - tokenBal(tx.meta.preTokenBalances, creatorAta);
    const mintSupplyAfter = BigInt((await connection.getTokenSupply(acc.mint, "confirmed")).value.amount);
    const burned = mintSupplyBefore - mintSupplyAfter;
    const solVaultDelta = lamDelta(acc.solVault);
    const solVaultAfter = BigInt(await connection.getBalance(acc.solVault, "confirmed"));
    const creatorBalAfter = BigInt(await connection.getBalance(creator.keypair.publicKey, "confirmed"));

    // Event, as a cross-check on what the program says it did.
    let event = null;
    try {
      const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
      for (const e of parser.parseLogs(tx.meta.logMessages || [])) if (e.name === "campaignGraduated" || e.name === "CampaignGraduated") event = e.data;
    } catch (_) { /* event decode is a cross-check only */ }

    const net = BigInt(closed.netRaisedLamports);
    const remaining = net - programQuote.finalizeFeeLamports;
    const intendedCreator = (remaining * 2_000n) / 10_000n;
    const pct = (x) => `${((Number(x) / Number(net)) * 100).toFixed(2)}%`;

    const report = {
      signatures: { create: createSig, buys: buySigs, flush: flushSig, graduation: gradSig },
      nativeTargetLamports: NATIVE_TARGET.toString(),
      netRaisedLamports: net.toString(),
      soldTokensRaw: closed.soldTokens.toString(),
      finalSpotNano: programQuote.spotNano.toString(),
      programQuote: {
        finalizeFee: programQuote.finalizeFeeLamports.toString(),
        lpSol: programQuote.maxLiquidityLamports.toString(),
        lpTokens: programQuote.maxLiquidityTokens.toString(),
        creatorPayout: programQuote.creatorPayoutLamports.toString(),
        desiredTokensUncapped: ((BigInt(remaining * 8_000n / 10_000n)) * 10n ** 6n * 1_000_000_000n / programQuote.spotNano).toString(),
      },
      measured: {
        creatorSolDeltaInGraduationTx: creatorSolDelta?.toString(),
        creatorBalanceDeltaAcrossGraduation: (creatorBalAfter - creatorBalBefore).toString(),
        finalizeRoutedToRewardVaults: finalizeRouted.toString(),
        rewardVaultDeltas: Object.fromEntries(Object.entries(vaultDeltas).map(([k, v]) => [k, v.toString()])),
        poolSolVault: poolSol.toString(),
        poolTokenVault: poolTokens.toString(),
        creatorReserveTokensDelivered: creatorTokensDelta.toString(),
        mintSupplyBefore: mintSupplyBefore.toString(),
        mintSupplyAfter: mintSupplyAfter.toString(),
        tokensBurned: burned.toString(),
        solVaultBefore: solVaultBefore.toString(),
        solVaultDeltaInGraduationTx: solVaultDelta?.toString(),
        solVaultAfter: solVaultAfter.toString(),
      },
      event: event ? Object.fromEntries(Object.entries(event).map(([k, v]) => [k, v?.toString?.() ?? v])) : null,
      shares: {
        creatorOfRaised: pct(creatorSolDelta),
        protocolOfRaised: pct(finalizeRouted),
        poolOfRaised: pct(poolSol),
        intendedCreatorLamports: intendedCreator.toString(),
        intendedCreatorOfRaised: pct(intendedCreator),
      },
    };
    console.log(`[proof] REPORT ${JSON.stringify(report, null, 2)}`);
    console.log(`[proof] creator ${sol(creatorSolDelta)} SOL (${pct(creatorSolDelta)}) | protocol ${sol(finalizeRouted)} SOL | pool ${sol(poolSol)} SOL + ${tok(poolTokens)} tokens | burned ${tok(burned)} | reserve ${tok(creatorTokensDelta)} | intended creator ${sol(intendedCreator)} SOL`);
    fs.writeFileSync(process.env.PROOF_REPORT_PATH || "/tmp/mwz-proof-graduation-payout.json", JSON.stringify(report, null, 2));
  });
});
