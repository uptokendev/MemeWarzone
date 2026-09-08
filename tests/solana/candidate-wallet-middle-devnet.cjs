"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const { AnchorProvider, BN, Program, Wallet } = anchor;
const { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = web3;

const REWARDS_PROGRAM_ID = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const REPORT = process.env.SOLANA_MIDDLE_REPORT || "/tmp/mwz-solana-wallet-middle.json";
const REWARDS_IDL = path.resolve(__dirname, "../../target/idl/mwz_rewards_treasury.json");
const PACKET_LIMIT = 1232;
const CONFIG_SEED = Buffer.from("arena_money_config_v2");
const POOL_SEED = Buffer.from("arena_competition_v2");
const RECEIPT_SEED = Buffer.from("arena_money_entry_v2");

function fail(msg) { throw new Error(`[candidate-wallet-middle] ${msg}`); }
function loadKeypair(file) { const v=JSON.parse(fs.readFileSync(file,"utf8")); if(!Array.isArray(v)||v.length!==64) fail(`invalid keypair ${file}`); return Keypair.fromSecretKey(Uint8Array.from(v)); }
function requiredEnv(name){const v=String(process.env[name]||"").trim();if(!v)fail(`${name} required`);return v;}
function hash32(s){return crypto.createHash("sha256").update(s).digest();}
function pda(seeds){return PublicKey.findProgramAddressSync(seeds,REWARDS_PROGRAM_ID)[0];}
async function fund(connection,payer,to,lamports=50_000_000){const latest=await connection.getLatestBlockhash("confirmed");const tx=new web3.Transaction({feePayer:payer.publicKey,recentBlockhash:latest.blockhash}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:to,lamports}));tx.sign(payer);const sig=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});const c=await connection.confirmTransaction({signature:sig,...latest},"confirmed");if(c.value.err)fail(`fund failed ${JSON.stringify(c.value.err)}`);}
function signerKeys(tx){const n=tx.message.header.numRequiredSignatures;return tx.message.staticAccountKeys.slice(0,n).map(k=>k.toBase58());}
async function executeV0({connection,payer,instructions,label,replayMode}){
  const latest=await connection.getLatestBlockhash("confirmed");
  const msg=new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:latest.blockhash,instructions}).compileToV0Message();
  const tx=new VersionedTransaction(msg);tx.sign([payer]);const raw=tx.serialize();if(raw.length>PACKET_LIMIT)fail(`${label} packet ${raw.length}>${PACKET_LIMIT}`);
  const diagnostics={payerBalanceBeforeSimulation:await connection.getBalance(payer.publicKey,"confirmed")};
  if(label==="UPVOTE"){
    const account1=tx.message.staticAccountKeys[1];
    const payerBalance=await connection.getBalance(payer.publicKey,"confirmed");
    const account1Balance=account1?await connection.getBalance(account1,"confirmed"):null;
    console.log("UPVOTE_PAYER",payer.publicKey.toBase58());
    console.log("UPVOTE_PAYER_BALANCE_BEFORE_SIM",payerBalance);
    console.log("UPVOTE_ACCOUNT_INDEX_1",account1?.toBase58()||"MISSING");
    console.log("UPVOTE_ACCOUNT_INDEX_1_BALANCE_BEFORE_SIM",account1Balance);
    Object.assign(diagnostics,{accountIndex1:account1?.toBase58(),accountIndex1BalanceBeforeSimulation:account1Balance});
  }
  const sim=await connection.simulateTransaction(tx,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});if(sim.value.err)fail(`${label} simulation ${JSON.stringify(sim.value.err)} ${(sim.value.logs||[]).join(" | ")}`);
  const sig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3});const conf=await connection.confirmTransaction({signature:sig,...latest},"confirmed");if(conf.value.err)fail(`${label} confirmation ${JSON.stringify(conf.value.err)}`);
  const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3});if(retrySig!==sig)fail(`${label} same packet retry changed signature`);
  const replayLatest=await connection.getLatestBlockhash("confirmed");const replayTx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:replayLatest.blockhash,instructions}).compileToV0Message());replayTx.sign([payer]);const replaySim=await connection.simulateTransaction(replayTx,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
  if(replayMode==="must-fail"&&!replaySim.value.err)fail(`${label} fresh-blockhash replay unexpectedly succeeds`);
  if(replayMode==="repeatable"&&replaySim.value.err)fail(`${label} repeatable fresh intent unexpectedly fails ${JSON.stringify(replaySim.value.err)}`);
  const bogus=Keypair.generate().publicKey.toBase58();const expiredTx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:bogus,instructions}).compileToV0Message());expiredTx.sign([payer]);const expired=await connection.simulateTransaction(expiredTx,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});if(!expired.value.err)fail(`${label} unknown/expired blockhash unexpectedly succeeds`);
  return {diagnostics,status:"PASS",version:"V0",altUsage:"NO",freshBlockhash:"YES",lastValidBlockHeight:latest.lastValidBlockHeight,payer:payer.publicKey.toBase58(),requiredSigners:signerKeys(tx),simulation:`PASS units=${sim.value.unitsConsumed??"unknown"}`,serializedPacketBytes:raw.length,sendMethod:"sendRawTransaction(skipPreflight=false,maxRetries=3)",confirmationMethod:"confirmTransaction({signature,blockhash,lastValidBlockHeight},confirmed)",expiryBehavior:`PASS unknown/expired blockhash rejected: ${JSON.stringify(expired.value.err)}`,retryBehavior:"PASS identical signed packet returned same signature",duplicateReplayBehavior:replayMode==="must-fail"?`PASS fresh-blockhash duplicate rejected: ${JSON.stringify(replaySim.value.err)}`:"EXPECTED repeatable intent: same signed packet deduped; fresh-blockhash UpVote intent simulates successfully",signature:sig};
}
async function main(){
  const operator=loadKeypair(requiredEnv("SOLANA_OPERATOR_KEYPAIR"));const connection=new web3.Connection(String(process.env.SOLANA_RPC_URL||"https://api.devnet.solana.com"),"confirmed");if((await connection.getGenesisHash())!==EXPECTED_DEVNET_GENESIS)fail("not devnet");
  const idl=JSON.parse(fs.readFileSync(REWARDS_IDL,"utf8"));const provider=new AnchorProvider(connection,new Wallet(operator),{commitment:"confirmed",preflightCommitment:"confirmed"});const program=new Program(idl,provider);if(!program.programId.equals(REWARDS_PROGRAM_ID))fail("rewards IDL mismatch");
  const out={createdAt:new Date().toISOString()};
  // UpVote user rail: V0 memo + SOL transfer. A disposable certification treasury is used on devnet.
  const voter=Keypair.generate(),voteTreasury=Keypair.generate().publicKey,subject=Keypair.generate().publicKey;await fund(connection,operator,voter.publicKey);
  const voteTreasuryInitialBalance=await connection.getBalance(voteTreasury,"confirmed");
  const voteTreasuryRentMinimum=await connection.getMinimumBalanceForRentExemption(0,"confirmed");
  console.log("UPVOTE_ACCOUNT_INDEX_1_INITIAL_BALANCE",voteTreasuryInitialBalance);
  console.log("UPVOTE_ACCOUNT_INDEX_1_RENT_MINIMUM",voteTreasuryRentMinimum);
  if(voteTreasuryInitialBalance<voteTreasuryRentMinimum)await fund(connection,operator,voteTreasury,voteTreasuryRentMinimum-voteTreasuryInitialBalance);
  const memo=new TransactionInstruction({keys:[{pubkey:voter.publicKey,isSigner:true,isWritable:false}],programId:MEMO_PROGRAM_ID,data:Buffer.from(`mwz-upvote:${subject.toBase58()}`)});const transfer=SystemProgram.transfer({fromPubkey:voter.publicKey,toPubkey:voteTreasury,lamports:10_000});
  out.upvote=await executeV0({connection,payer:voter,instructions:[memo,transfer],label:"UPVOTE",replayMode:"repeatable"});out.upvote.destination=voteTreasury.toBase58();out.upvote.destinationInitialBalance=voteTreasuryInitialBalance;out.upvote.destinationRentMinimum=voteTreasuryRentMinimum;

  fs.writeFileSync(REPORT,JSON.stringify(out,null,2)+"\n");
  console.log("UPVOTE",JSON.stringify(out.upvote));
  const config=pda([CONFIG_SEED]);
  const configInfo=await connection.getAccountInfo(config,"confirmed");
  console.log("ARENA_MONEY_V2_CONFIG",JSON.stringify({address:config.toBase58(),exists:Boolean(configInfo),owner:configInfo?.owner.toBase58(),bytes:configInfo?.data.length??0}));
  if(!configInfo){
    out.battlePayment={status:"BLOCK",reason:"ArenaMoneyV2 config missing",config:config.toBase58()};
    out.tournamentPayment={...out.battlePayment};
    fs.writeFileSync(REPORT,JSON.stringify(out,null,2)+"\n");
    fail(`ArenaMoneyV2 config ${config} is missing; shared protocol initialization is outside harness-only repair`);
  }
  const configState=await program.account.arenaMoneyConfigV2.fetch(config);if(!new PublicKey(configState.authority).equals(operator.publicKey))fail(`ArenaMoneyV2 authority ${configState.authority} != cert operator ${operator.publicKey}`);const wasPaused=Boolean(configState.paused);
  try{
    if(wasPaused)await program.methods.setArenaMoneyV2Pause(false).accountsStrict({authority:operator.publicKey,config}).rpc({commitment:"confirmed"});
    for(const spec of [{key:"battlePayment",kind:0},{key:"tournamentPayment",kind:1}]){
      const entrant=Keypair.generate();await fund(connection,operator,entrant.publicKey,80_000_000);const other=Keypair.generate();const assetA=Keypair.generate().publicKey,assetB=Keypair.generate().publicKey;const id=hash32(`${spec.key}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`);const pool=pda([POOL_SEED,id]);const now=Math.floor(Date.now()/1000);
      await program.methods.openCompetitionPoolV2(Array.from(id),spec.kind,assetA,assetB,entrant.publicKey,other.publicKey,new BN(5_000_000),new BN(now-30),new BN(now+1800)).accountsStrict({authority:operator.publicKey,config,pool,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});
      const entryAsset=assetA;const receipt=pda([RECEIPT_SEED,id,entryAsset.toBuffer(),entrant.publicKey.toBuffer()]);const ix=await program.methods.depositCompetitionEntryV2(Array.from(id),entryAsset).accountsStrict({entrant:entrant.publicKey,config,pool,receipt,systemProgram:SystemProgram.programId}).instruction();
      out[spec.key]=await executeV0({connection,payer:entrant,instructions:[ix],label:spec.key.toUpperCase(),replayMode:"must-fail"});out[spec.key].pool=pool.toBase58();out[spec.key].receipt=receipt.toBase58();
    }
  } finally { if(wasPaused) await program.methods.setArenaMoneyV2Pause(true).accountsStrict({authority:operator.publicKey,config}).rpc({commitment:"confirmed"}); }
  fs.writeFileSync(REPORT,JSON.stringify(out,null,2)+"\n");console.log(JSON.stringify(out,null,2));
}
main().catch(e=>{console.error(e?.stack||e);process.exit(1);});
