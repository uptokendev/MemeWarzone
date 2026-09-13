"use strict";

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
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} = web3;
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const { createAuthorizationDigest } = require("./authorization-v4.cjs");
const { AnchorProvider, BN, Program, Wallet } = anchor;

const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const REWARDS_TREASURY = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgVsfzcCCoZBKX");
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TRADE_AUTH_DOMAIN = Buffer.from("MEMEWARZONE_SOLANA_TRADE_V1", "utf8");
const TRADE_AUTH_SCHEMA_VERSION = 3;
const TRADE_SIDE_BUY = 1;
const TRADE_SIDE_SELL = 2;
const ROUTE_PROFILE_UNLINKED = 1;
const GRADUATION_TARGET_USD_MICROS = 6_000_000n;
const BUY_LAMPORTS = 5_000_000n;
const REPORT = process.env.SOLANA_GOLDEN_REPORT || "/tmp/mwz-solana-wallet-golden.json";
const IDL_PATH = path.resolve(__dirname, "../../target/idl/memewarzone_solana.json");
const MANIFEST_PATH = path.resolve(__dirname, "../../config/solana/devnet-generation-v3.json");

function fail(message) { throw new Error(`[candidate-wallet-golden] ${message}`); }
function requiredEnv(name) { const v=String(process.env[name]||"").trim(); if(!v) fail(`${name} is required`); return v; }
function readJson(file) { return JSON.parse(fs.readFileSync(file,"utf8")); }
function loadKeypair(file) { const v=readJson(file); if(!Array.isArray(v)||v.length!==64) fail(`invalid keypair ${file}`); return Keypair.fromSecretKey(Uint8Array.from(v)); }
function hash32(value) { return crypto.createHash("sha256").update(value).digest(); }
function fixed32(value) { return Array.from(Buffer.from(value)); }
function derivePda(programId, ...seeds) { return PublicKey.findProgramAddressSync(seeds.map((s)=>Buffer.isBuffer(s)?s:Buffer.from(s)), programId)[0]; }
function u16le(v){const b=Buffer.alloc(2);b.writeUInt16LE(v);return b;}
function u64le(v){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;}
function i64le(v){const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(v));return b;}
function sameBytes(a,b){return Buffer.from(a).equals(Buffer.from(b));}
async function chainUnixTimestamp(connection){const slot=await connection.getSlot("confirmed");return (await connection.getBlockTime(slot))??Math.floor(Date.now()/1000);}
function tradeDigest({campaign,mint,trader,side,amountIn,minOut,deadline,nonce,nativeTargetLamports,routeProfile}){
  return crypto.createHash("sha256").update(Buffer.concat([
    TRADE_AUTH_DOMAIN,u16le(TRADE_AUTH_SCHEMA_VERSION),PROGRAM_ID.toBuffer(),campaign.toBuffer(),mint.toBuffer(),trader.toBuffer(),Buffer.from([side]),u64le(amountIn),u64le(minOut),i64le(deadline),Buffer.from(nonce),u64le(nativeTargetLamports),Buffer.from([routeProfile]),
  ])).digest();
}
function rewardVaultKeys(){return ["league_vault","airdrop_vault","monthly_league_vault","recruiter_vault","squad_vault","protocol_vault"].map((s)=>derivePda(REWARDS_TREASURY,s));}
function altPlan(globalConfig){return [PROGRAM_ID,globalConfig,Ed25519Program.programId,ComputeBudgetProgram.programId,SYSVAR_INSTRUCTIONS_PUBKEY,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,SystemProgram.programId,REWARDS_TREASURY,...rewardVaultKeys()];}
async function sendControl(connection,payer,instructions){const latest=await connection.getLatestBlockhash("confirmed");const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:latest.blockhash}).add(...instructions);tx.sign(payer);const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});const c=await connection.confirmTransaction({signature,...latest},"confirmed");if(c.value.err) fail(`control tx failed ${JSON.stringify(c.value.err)}`);return signature;}
async function createTempAlt(connection,operator,globalConfig){const slot=await connection.getSlot("confirmed");const [ix,address]=AddressLookupTableProgram.createLookupTable({authority:operator.publicKey,payer:operator.publicKey,recentSlot:Math.max(0,slot-1)});await sendControl(connection,operator,[ix]);const addresses=altPlan(globalConfig);for(let i=0;i<addresses.length;i+=20){await sendControl(connection,operator,[AddressLookupTableProgram.extendLookupTable({payer:operator.publicKey,authority:operator.publicKey,lookupTable:address,addresses:addresses.slice(i,i+20)})]);}for(let i=0;i<20;i++){const table=(await connection.getAddressLookupTable(address)).value;const current=await connection.getSlot("confirmed");if(table&&current>Number(table.state.lastExtendedSlot||0)&&addresses.every((key)=>table.state.addresses.some((x)=>x.equals(key))))return table;await new Promise((r)=>setTimeout(r,1000));}fail(`ALT ${address.toBase58()} not active`);}
async function loadV0(){const {loadSolanaV0Module}=await import("../../frontend/scripts/load-solana-v0-module.mjs");return loadSolanaV0Module();}
async function executeLaunchpadV0({v0,connection,payer,ed25519,programIx,lookupTable,instructions,label}){
  const ixes=instructions||[ed25519,programIx];
  const expectation={payer:payer.publicKey,ed25519Instruction:ed25519,programInstruction:programIx,lookupTableAccounts:[lookupTable],allowInstructionPrivilegePromotion:true};
  const compiled=await v0.compileLaunchpadV0WithLatestBlockhash(web3,connection,{payer:payer.publicKey,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
  compiled.transaction.sign([payer]);
  const stats=v0.assertLaunchpadV0Intent(web3,compiled.transaction,expectation);
  const sim=await v0.simulateLaunchpadV0OrThrow(connection,compiled.transaction,label);
  const raw=compiled.transaction.serialize();
  const signature=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3});
  const confirmed=await connection.confirmTransaction({signature,...compiled.latest},"confirmed");
  if(confirmed.value.err) fail(`${label} confirmation failed ${JSON.stringify(confirmed.value.err)}`);
  const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3});
  if(retrySig!==signature) fail(`${label} identical retry signature changed`);
  const replay=await v0.compileLaunchpadV0WithLatestBlockhash(web3,connection,{payer:payer.publicKey,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
  replay.transaction.sign([payer]);
  const replaySim=await connection.simulateTransaction(replay.transaction,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
  if(!replaySim.value.err) fail(`${label} fresh-blockhash replay unexpectedly simulated successfully`);
  const bogus=Keypair.generate().publicKey.toBase58();
  const expired=v0.compileAndAssertLaunchpadV0(web3,{payer:payer.publicKey,recentBlockhash:bogus,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
  expired.transaction.sign([payer]);
  const expiredSim=await connection.simulateTransaction(expired.transaction,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
  if(!expiredSim.value.err) fail(`${label} unknown/expired blockhash unexpectedly simulated successfully`);
  return {status:"PASS",version:"V0",altUsage:`YES:${lookupTable.key.toBase58()}`,freshBlockhash:"YES",lastValidBlockHeight:compiled.latest.lastValidBlockHeight,payer:payer.publicKey.toBase58(),requiredSigners:stats.requiredSigners,simulation:`PASS units=${sim.unitsConsumed??"unknown"}`,serializedPacketBytes:stats.serializedBytes,sendMethod:"sendRawTransaction(skipPreflight=false,maxRetries=3)",confirmationMethod:"confirmTransaction({signature,blockhash,lastValidBlockHeight},confirmed)",expiryBehavior:`PASS rejected unknown/expired blockhash: ${JSON.stringify(expiredSim.value.err)}`,retryBehavior:"PASS identical serialized retry returned same signature",duplicateReplayBehavior:`PASS same signed packet deduped; fresh-blockhash same intent rejected: ${JSON.stringify(replaySim.value.err)}` ,signature};
}
async function setupWallet(program,connection,operator,globalConfig,clusterId,label){const keypair=Keypair.generate();await sendControl(connection,operator,[SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:keypair.publicKey,lamports:100_000_000})]);const creatorProfile=derivePda(PROGRAM_ID,"creator",keypair.publicKey.toBuffer());const riskProfile=derivePda(PROGRAM_ID,"risk",keypair.publicKey.toBuffer());if(label==="creator"){await program.methods.syncCreatorProfile({wallet:keypair.publicKey,tier:1,trustScore:7000,liveBondingCount:0,lastLaunchTimestamp:new BN(0),totalLaunches:new BN(0),successfulGraduations:new BN(0),restricted:false,manualReviewRequired:false,creatorBuyCapBps:1000}).accountsStrict({authority:operator.publicKey,globalConfig,creatorProfile,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});}await program.methods.syncRiskProfile({wallet:keypair.publicKey,riskLevel:0,restricted:false,clusterId:fixed32(clusterId),manualReviewRequired:false}).accountsStrict({authority:operator.publicKey,globalConfig,riskProfile,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});return {keypair,creatorProfile,riskProfile};}
async function runGolden({program,connection,operator,routeSigner,globalConfig,generationConfig,generation,clusterId,clusterProfile,v0,label}){
  const creator=await setupWallet(program,connection,operator,globalConfig,clusterId,"creator");
  const buyer=await setupWallet(program,connection,operator,globalConfig,clusterId,"buyer");
  const unique=`${label}:${Date.now()}:${crypto.randomBytes(12).toString("hex")}`;
  const campaignId=hash32(`campaign:${unique}`), nonce=hash32(`create:${unique}`), now=await chainUnixTimestamp(connection);
  const args={campaignId:fixed32(campaignId),metadataHash:fixed32(hash32(`metadata:${unique}`)),clusterHash:fixed32(clusterId),tickerHash:fixed32(hash32(`ticker:${unique}`)),reservationIdHash:fixed32(hash32(`reservation:${unique}`)),reservationVersion:new BN(1),launchAt:new BN(0),graduationTargetUsdMicros:new BN(GRADUATION_TARGET_USD_MICROS.toString()),deadline:new BN(now+3600),nonce:fixed32(nonce)};
  const campaign=derivePda(PROGRAM_ID,"campaign",campaignId), mint=derivePda(PROGRAM_ID,"campaign-mint",campaignId), tokenVault=derivePda(PROGRAM_ID,"token-vault",campaignId), solVault=derivePda(PROGRAM_ID,"sol-vault",campaignId), createAuthorization=derivePda(PROGRAM_ID,"create-auth",creator.keypair.publicKey.toBuffer(),nonce), feeEscrow=derivePda(PROGRAM_ID,"fee-escrow",campaign.toBuffer()), creatorFeeVault=derivePda(PROGRAM_ID,"creator-fee-vault",campaign.toBuffer());
  const profile=await program.account.creatorProfile.fetch(creator.creatorProfile);
  const digest=createAuthorizationDigest({programId:PROGRAM_ID,generationConfigKey:generationConfig,generation,creator:creator.keypair.publicKey,riskClusterId:clusterId,creatorBuyLockSeconds:profile.creatorBuyLockSeconds,creatorBuyCapBps:profile.creatorBuyCapBps,campaign,mint,tokenVault,solVault,tokenProgram:TOKEN_PROGRAM_ID,args});
  const edCreate=Ed25519Program.createInstructionWithPrivateKey({privateKey:routeSigner.secretKey,message:digest});
  const createIx=await program.methods.createCampaign(args).accountsStrict({creator:creator.keypair.publicKey,globalConfig,generationConfig,creatorProfile:creator.creatorProfile,riskProfile:creator.riskProfile,clusterProfile,campaign,mint,tokenVault,solVault,createAuthorization,instructions:SYSVAR_INSTRUCTIONS_PUBKEY,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction();
  const alt=await createTempAlt(connection,operator,globalConfig);
  const create=await executeLaunchpadV0({v0,connection,payer:creator.keypair,ed25519:edCreate,programIx:createIx,lookupTable:alt,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),edCreate,createIx],label:`${label} CREATE`});
  await program.methods.initializeFeeEscrow().accountsStrict({payer:operator.publicKey,campaign,feeEscrow,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});
  await program.methods.initializeCreatorFeeVault().accountsStrict({payer:operator.publicKey,campaign,creatorFeeVault,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});
  const buyerAta=getAssociatedTokenAddressSync(mint,buyer.keypair.publicKey);
  const buyNonce=hash32(`buy:${unique}`), buyDeadline=(await chainUnixTimestamp(connection))+3600, buyAuth=derivePda(PROGRAM_ID,"trade-auth",buyer.keypair.publicKey.toBuffer(),buyNonce);
  const buyDigest=tradeDigest({campaign,mint,trader:buyer.keypair.publicKey,side:TRADE_SIDE_BUY,amountIn:BUY_LAMPORTS,minOut:1n,deadline:buyDeadline,nonce:buyNonce,nativeTargetLamports:40_000_000n,routeProfile:ROUTE_PROFILE_UNLINKED});
  const edBuy=Ed25519Program.createInstructionWithPrivateKey({privateKey:routeSigner.secretKey,message:buyDigest});
  const buyIx=await program.methods.buyTokens({lamportsIn:new BN(BUY_LAMPORTS.toString()),minTokensOut:new BN(1),deadline:new BN(buyDeadline),nonce:fixed32(buyNonce),nativeTargetLamports:new BN("40000000"),routeProfile:ROUTE_PROFILE_UNLINKED}).accountsStrict({trader:buyer.keypair.publicKey,globalConfig,campaign,mint,tokenVault,solVault,traderTokenAccount:buyerAta,riskProfile:buyer.riskProfile,clusterProfile,tradeAuthorization:buyAuth,instructions:SYSVAR_INSTRUCTIONS_PUBKEY,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId,feeEscrow,creatorFeeVault}).instruction();
  const buy=await executeLaunchpadV0({v0,connection,payer:buyer.keypair,ed25519:edBuy,programIx:buyIx,lookupTable:alt,instructions:[createAssociatedTokenAccountInstruction(buyer.keypair.publicKey,buyerAta,buyer.keypair.publicKey,mint),edBuy,buyIx],label:`${label} BUY`});
  const token=await getAccount(connection,buyerAta,"confirmed");const balance=BigInt(token.amount.toString());if(balance<4n) fail(`${label} BUY returned insufficient tokens`);const tokensIn=balance/4n;
  const sellNonce=hash32(`sell:${unique}`), sellDeadline=(await chainUnixTimestamp(connection))+3600, sellAuth=derivePda(PROGRAM_ID,"trade-auth",buyer.keypair.publicKey.toBuffer(),sellNonce);
  const sellDigest=tradeDigest({campaign,mint,trader:buyer.keypair.publicKey,side:TRADE_SIDE_SELL,amountIn:tokensIn,minOut:1n,deadline:sellDeadline,nonce:sellNonce,nativeTargetLamports:0n,routeProfile:ROUTE_PROFILE_UNLINKED});
  const edSell=Ed25519Program.createInstructionWithPrivateKey({privateKey:routeSigner.secretKey,message:sellDigest});
  const sellIx=await program.methods.sellTokens({tokensIn:new BN(tokensIn.toString()),minLamportsOut:new BN(1),deadline:new BN(sellDeadline),nonce:fixed32(sellNonce),routeProfile:ROUTE_PROFILE_UNLINKED}).accountsStrict({trader:buyer.keypair.publicKey,globalConfig,campaign,mint,tokenVault,solVault,traderTokenAccount:buyerAta,riskProfile:buyer.riskProfile,clusterProfile,tradeAuthorization:sellAuth,instructions:SYSVAR_INSTRUCTIONS_PUBKEY,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId,feeEscrow,creatorFeeVault}).instruction();
  const sell=await executeLaunchpadV0({v0,connection,payer:buyer.keypair,ed25519:edSell,programIx:sellIx,lookupTable:alt,label:`${label} SELL`});
  return {create,buy,sell,campaign:campaign.toBase58(),mint:mint.toBase58(),alt:alt.key.toBase58()};
}
async function main(){
  const operator=loadKeypair(requiredEnv("SOLANA_OPERATOR_KEYPAIR")),routeSigner=loadKeypair(requiredEnv("SOLANA_NEW_ROUTE_SIGNER_KEYPAIR"));
  const connection=new web3.Connection(String(process.env.SOLANA_RPC_URL||"https://api.devnet.solana.com"),"confirmed");
  if((await connection.getGenesisHash())!==EXPECTED_DEVNET_GENESIS) fail("not devnet");
  const idl=readJson(IDL_PATH),manifest=readJson(MANIFEST_PATH),provider=new AnchorProvider(connection,new Wallet(operator),{commitment:"confirmed",preflightCommitment:"confirmed"});anchor.setProvider(provider);const program=new Program(idl,provider);assert(program.programId.equals(PROGRAM_ID));
  const globalConfig=derivePda(PROGRAM_ID,"global"),global=await program.account.globalConfig.fetch(globalConfig);if(!new PublicKey(global.admin).equals(operator.publicKey)) fail("operator is not GlobalConfig.admin");if(!new PublicKey(global.routeSigner).equals(routeSigner.publicKey)) fail("route signer mismatch");
  const generationId=hash32(manifest.generationIdSeed),generationConfig=derivePda(PROGRAM_ID,"generation",generationId),generation=await program.account.generationConfig.fetch(generationConfig);if(!sameBytes(global.activeGenerationId,generationId)) fail("active generation mismatch");const clusterId=hash32(manifest.riskClusterIdSeed),clusterProfile=derivePda(PROGRAM_ID,"cluster",clusterId);
  const original={paused:Boolean(global.paused),createPaused:Boolean(global.createPaused),buyPaused:Boolean(global.buyPaused),sellPaused:Boolean(global.sellPaused),graduationPaused:Boolean(global.graduationPaused),claimsPaused:Boolean(global.claimsPaused)};
  let restored=false;try{await program.methods.setPauseFlags({...original,paused:false,createPaused:false,buyPaused:false,sellPaused:false}).accountsStrict({globalConfig,authority:operator.publicKey}).rpc({commitment:"confirmed"});const v0=await loadV0();const first=await runGolden({program,connection,operator,routeSigner,globalConfig,generationConfig,generation,clusterId,clusterProfile,v0,label:"FIRST"});const final=await runGolden({program,connection,operator,routeSigner,globalConfig,generationConfig,generation,clusterId,clusterProfile,v0,label:"FINAL"});const report={createdAt:new Date().toISOString(),programId:PROGRAM_ID.toBase58(),first,final};fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));}finally{try{await program.methods.setPauseFlags(original).accountsStrict({globalConfig,authority:operator.publicKey}).rpc({commitment:"confirmed"});restored=true;console.log("restored original devnet pause flags");}catch(e){console.error("CRITICAL restore failure",e);}if(!restored)process.exitCode=2;}
}
main().catch((e)=>{console.error(e?.stack||e);process.exit(1);});
