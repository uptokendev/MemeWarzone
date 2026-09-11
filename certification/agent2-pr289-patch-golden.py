from pathlib import Path

p=Path("tests/solana/candidate-wallet-golden-devnet.cjs")
s=p.read_text()
s=s.replace("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgVsfzcCCoZBKX","2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX")
s=s.replace("const BUY_LAMPORTS = 5_000_000n;","const BUY_LAMPORTS = 100_000n;")

start=s.index("async function executeLaunchpadV0(")
end=s.index("async function setupWallet(",start)
replacement=r'''async function executeLaunchpadV0({v0,connection,payer,ed25519,programIx,lookupTable,instructions,label}){
  const ixes=instructions||[ed25519,programIx];
  const expectation={payer:payer.publicKey,ed25519Instruction:ed25519,programInstruction:programIx,lookupTableAccounts:[lookupTable],allowInstructionPrivilegePromotion:true};
  const payerBalanceBefore=await connection.getBalance(payer.publicKey,"confirmed");
  let compiled,stats,sim,raw,signature,confirmed;
  const expiredAttempts=[];
  for(let attempt=1;attempt<=3;attempt++){
    compiled=await v0.compileLaunchpadV0WithLatestBlockhash(web3,connection,{payer:payer.publicKey,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
    compiled.transaction.sign([payer]);
    stats=v0.assertLaunchpadV0Intent(web3,compiled.transaction,expectation);
    sim=await v0.simulateLaunchpadV0OrThrow(connection,compiled.transaction,`${label} attempt ${attempt}`);
    raw=compiled.transaction.serialize();
    signature=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:5});
    try {
      confirmed=await connection.confirmTransaction({signature,...compiled.latest},"confirmed");
      if(confirmed.value.err) fail(`${label} confirmation failed ${JSON.stringify(confirmed.value.err)}`);
      break;
    } catch(error) {
      if(!/expired|block height exceeded/i.test(String(error?.message||error)) || attempt===3) throw error;
      const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
      if(status){
        if(status.err) fail(`${label} expired confirmation later resolved with error ${JSON.stringify(status.err)}`);
        if(status.confirmationStatus==="confirmed"||status.confirmationStatus==="finalized"){confirmed={value:{err:null}};break;}
        fail(`${label} expiry retry refused because prior signature exists with status ${JSON.stringify(status)}`);
      }
      expiredAttempts.push({attempt,signature,blockhash:compiled.latest.blockhash,lastValidBlockHeight:compiled.latest.lastValidBlockHeight});
      console.log("CERT_EXPIRED_UNLANDED_RETRY",label,JSON.stringify(expiredAttempts[expiredAttempts.length-1]));
    }
  }
  if(!confirmed) fail(`${label} did not confirm`);
  let retryResult="";
  try {const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:5});if(retrySig!==signature)fail(`${label} identical retry signature changed`);retryResult="same signature";}
  catch(e){const m=String(e?.message||e);if(!/already been processed/i.test(m))throw e;retryResult="already processed";}
  const replay=await v0.compileLaunchpadV0WithLatestBlockhash(web3,connection,{payer:payer.publicKey,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
  replay.transaction.sign([payer]);
  const replaySim=await connection.simulateTransaction(replay.transaction,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
  if(!replaySim.value.err) fail(`${label} fresh-blockhash replay unexpectedly simulated successfully`);
  const bogus=Keypair.generate().publicKey.toBase58();
  const expired=v0.compileAndAssertLaunchpadV0(web3,{payer:payer.publicKey,recentBlockhash:bogus,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
  expired.transaction.sign([payer]);
  const expiredSim=await connection.simulateTransaction(expired.transaction,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
  if(!expiredSim.value.err) fail(`${label} unknown/expired blockhash unexpectedly simulated successfully`);
  return {status:"PASS",version:"V0",altUsage:`YES:${lookupTable.key.toBase58()}`,freshBlockhash:"YES",blockhash:compiled.latest.blockhash,lastValidBlockHeight:compiled.latest.lastValidBlockHeight,payer:payer.publicKey.toBase58(),payerBalanceBefore,requiredSigners:stats.requiredSigners,simulation:`PASS units=${sim.unitsConsumed??"unknown"}`,serializedPacketBytes:stats.serializedBytes,sendMethod:"sendRawTransaction(skipPreflight=false,maxRetries=5)",confirmationMethod:"confirmTransaction({signature,blockhash,lastValidBlockHeight},confirmed); expiry-safe rebuild only after null signature status",expiryBehavior:`PASS unknown/expired blockhash rejected: ${JSON.stringify(expiredSim.value.err)}`,retryBehavior:`PASS identical signed packet deduped (${retryResult})`,duplicateReplayBehavior:`PASS same signed packet deduped; fresh-blockhash same intent rejected: ${JSON.stringify(replaySim.value.err)}`,expiredUnlandedAttempts:expiredAttempts,signature};
}
'''
s=s[:start]+replacement+s[end:]

old='''  const creator=await setupWallet(program,connection,operator,globalConfig,clusterId,"creator");
  const buyer=await setupWallet(program,connection,operator,globalConfig,clusterId,"buyer");'''
new='''  const creator={keypair:operator,creatorProfile:derivePda(PROGRAM_ID,"creator",operator.publicKey.toBuffer()),riskProfile:derivePda(PROGRAM_ID,"risk",operator.publicKey.toBuffer())};
  const buyerKeypair=Keypair.generate();
  const buyer={keypair:buyerKeypair,creatorProfile:derivePda(PROGRAM_ID,"creator",buyerKeypair.publicKey.toBuffer()),riskProfile:derivePda(PROGRAM_ID,"risk",buyerKeypair.publicKey.toBuffer())};'''
if old not in s: raise SystemExit("setup target missing")
s=s.replace(old,new,1)

old='  const profile=await program.account.creatorProfile.fetch(creator.creatorProfile);'
new='''  const profile=await program.account.creatorProfile.fetch(creator.creatorProfile);
  const creatorBalanceBeforeCreate=await connection.getBalance(creator.keypair.publicKey,"confirmed");
  const liveBefore=Number(profile.liveBondingCount);
  const totalBefore=BigInt(profile.totalLaunches.toString());
  console.log("CREATE_PAYER",creator.keypair.publicKey.toBase58());
  console.log("CREATE_PAYER_BALANCE_BEFORE",creatorBalanceBeforeCreate);'''
if old not in s: raise SystemExit("profile target missing")
s=s.replace(old,new,1)

old='  const alt=await createTempAlt(connection,operator,globalConfig);'
new='''  const alt=(await connection.getAddressLookupTable(new PublicKey(process.env.SOLANA_GOLDEN_EXISTING_ALT))).value;
  if(!alt) fail(`reusable ALT missing ${process.env.SOLANA_GOLDEN_EXISTING_ALT}`);
  const missingAlt=altPlan(globalConfig).filter((key)=>!alt.state.addresses.some((x)=>x.equals(key)));
  if(missingAlt.length) fail(`reusable ALT missing required keys ${missingAlt.map((x)=>x.toBase58()).join(",")}`);'''
if old not in s: raise SystemExit("ALT target missing")
s=s.replace(old,new,1)

old='''  await program.methods.initializeFeeEscrow().accountsStrict({payer:operator.publicKey,campaign,feeEscrow,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});
  await program.methods.initializeCreatorFeeVault().accountsStrict({payer:operator.publicKey,campaign,creatorFeeVault,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});'''
new='''  const afterCreateProfile=await program.account.creatorProfile.fetch(creator.creatorProfile);
  const liveAfterCreate=Number(afterCreateProfile.liveBondingCount);
  const totalAfterCreate=BigInt(afterCreateProfile.totalLaunches.toString());
  if(liveAfterCreate!==liveBefore+1) fail(`CREATE liveBondingCount delta != 1 (${liveBefore}->${liveAfterCreate})`);
  if(totalAfterCreate!==totalBefore+1n) fail(`CREATE totalLaunches delta != 1 (${totalBefore}->${totalAfterCreate})`);
  await program.methods.initializeFeeEscrow().accountsStrict({payer:operator.publicKey,campaign,feeEscrow,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});
  await program.methods.initializeCreatorFeeVault().accountsStrict({payer:operator.publicKey,campaign,creatorFeeVault,systemProgram:SystemProgram.programId}).rpc({commitment:"confirmed"});
  await sendControl(connection,operator,[SystemProgram.transfer({fromPubkey:operator.publicKey,toPubkey:buyer.keypair.publicKey,lamports:5_000_000})]);'''
if old not in s: raise SystemExit("post-create target missing")
s=s.replace(old,new,1)

old='  return {create,buy,sell,campaign:campaign.toBase58(),mint:mint.toBase58(),alt:alt.key.toBase58()};'
new='  return {create,buy,sell,campaign:campaign.toBase58(),mint:mint.toBase58(),alt:alt.key.toBase58(),creatorDiagnostics:{payer:creator.keypair.publicKey.toBase58(),balanceBeforeCreate:creatorBalanceBeforeCreate,liveBefore,liveAfterCreate,totalBefore:totalBefore.toString(),totalAfterCreate:totalAfterCreate.toString()}};'
if old not in s: raise SystemExit("return target missing")
s=s.replace(old,new,1)

s=s.replace("const first=await runGolden(",'const first=process.env.SOLANA_GOLDEN_ONLY_FINAL==="1"?null:await runGolden(')
s=s.replace("const final=await runGolden(",'const final=process.env.SOLANA_GOLDEN_ONLY_FIRST==="1"?null:await runGolden(')

p.write_text(s)
print("PR289 low-spend exact-head golden certification patch applied")
