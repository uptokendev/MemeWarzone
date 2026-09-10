from pathlib import Path

p = Path("tests/solana/candidate-wallet-golden-devnet.cjs")
s = p.read_text()
start = s.index("async function executeLaunchpadV0(")
end = s.index("async function setupWallet(", start)
replacement = r'''async function executeLaunchpadV0({v0,connection,payer,ed25519,programIx,lookupTable,instructions,label}){
  const ixes=instructions||[ed25519,programIx];
  const expectation={payer:payer.publicKey,ed25519Instruction:ed25519,programInstruction:programIx,lookupTableAccounts:[lookupTable],allowInstructionPrivilegePromotion:true};
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
        if(status.confirmationStatus==="confirmed"||status.confirmationStatus==="finalized") { confirmed={value:{err:null}}; break; }
        fail(`${label} expiry retry refused because prior signature exists with status ${JSON.stringify(status)}`);
      }
      expiredAttempts.push({attempt,signature,blockhash:compiled.latest.blockhash,lastValidBlockHeight:compiled.latest.lastValidBlockHeight});
      console.log("CERT_EXPIRED_UNLANDED_RETRY",label,JSON.stringify(expiredAttempts[expiredAttempts.length-1]));
    }
  }
  if(!confirmed) fail(`${label} did not confirm`);
  let retryResult="";
  try {
    const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:5});
    if(retrySig!==signature) fail(`${label} identical retry signature changed`);
    retryResult="same signature";
  } catch(e) {
    const m=String(e?.message||e);
    if(!/already been processed/i.test(m)) throw e;
    retryResult="already processed";
  }
  const replay=await v0.compileLaunchpadV0WithLatestBlockhash(web3,connection,{payer:payer.publicKey,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
  replay.transaction.sign([payer]);
  const replaySim=await connection.simulateTransaction(replay.transaction,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
  if(!replaySim.value.err) fail(`${label} fresh-blockhash replay unexpectedly simulated successfully`);
  const bogus=Keypair.generate().publicKey.toBase58();
  const expired=v0.compileAndAssertLaunchpadV0(web3,{payer:payer.publicKey,recentBlockhash:bogus,instructions:ixes,lookupTableAccounts:[lookupTable]},expectation);
  expired.transaction.sign([payer]);
  const expiredSim=await connection.simulateTransaction(expired.transaction,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
  if(!expiredSim.value.err) fail(`${label} unknown/expired blockhash unexpectedly simulated successfully`);
  return {status:"PASS",version:"V0",altUsage:`YES:${lookupTable.key.toBase58()}`,freshBlockhash:"YES",blockhash:compiled.latest.blockhash,lastValidBlockHeight:compiled.latest.lastValidBlockHeight,payer:payer.publicKey.toBase58(),requiredSigners:stats.requiredSigners,simulation:`PASS units=${sim.unitsConsumed??"unknown"}`,serializedPacketBytes:stats.serializedBytes,sendMethod:"sendRawTransaction(skipPreflight=false,maxRetries=5)",confirmationMethod:"confirmTransaction({signature,blockhash,lastValidBlockHeight},confirmed); expiry-safe rebuild only after null signature status",expiryBehavior:`PASS unknown/expired blockhash rejected: ${JSON.stringify(expiredSim.value.err)}`,retryBehavior:`PASS identical signed packet deduped (${retryResult})`,duplicateReplayBehavior:`PASS same signed packet deduped; fresh-blockhash same intent rejected: ${JSON.stringify(replaySim.value.err)}`,expiredUnlandedAttempts:expiredAttempts,signature};
}
'''
p.write_text(s[:start] + replacement + s[end:])
print("expiry-safe final golden certification patch applied")
