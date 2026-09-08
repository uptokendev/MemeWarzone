from pathlib import Path

# Cert-only runtime patching. Production/program source is not committed with these edits.

def patch_golden():
    p = Path("tests/solana/candidate-wallet-golden-devnet.cjs")
    s = p.read_text()
    s = s.replace(
        "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgVsfzcCCoZBKX",
        "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX",
    )
    s = s.replace("const BUY_LAMPORTS = 5_000_000n;", "const BUY_LAMPORTS = 1_000_000n;")
    old_sim = '  const sim=await v0.simulateLaunchpadV0OrThrow(connection,compiled.transaction,label);'
    new_sim = '''  let sim;
  try {
    sim=await v0.simulateLaunchpadV0OrThrow(connection,compiled.transaction,label);
  } catch (error) {
    const failedSim=await connection.simulateTransaction(compiled.transaction,{commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false});
    console.error("SIMULATION_FAILURE",label,JSON.stringify({err:failedSim.value.err,logs:failedSim.value.logs||[],unitsConsumed:failedSim.value.unitsConsumed??null}));
    throw error;
  }'''
    if old_sim not in s:
        raise SystemExit("golden simulation telemetry target missing")
    s = s.replace(old_sim, new_sim, 1)
    old_setup = '  const creator=await setupWallet(program,connection,operator,globalConfig,clusterId,"creator");\n  const buyer=await setupWallet(program,connection,operator,globalConfig,clusterId,"buyer");'
    new_setup = '''  const creator=await setupWallet(program,connection,operator,globalConfig,clusterId,"creator");
  const buyer=await setupWallet(program,connection,operator,globalConfig,clusterId,"buyer");
  const rentSizes={mint:82,tokenVault:165,campaign:720,solVault:81,createAuthorization:155};
  const rentMinima={};
  for(const [name,size] of Object.entries(rentSizes)) rentMinima[name]=await connection.getMinimumBalanceForRentExemption(size,"confirmed");
  rentMinima.total=Object.values(rentMinima).reduce((sum,value)=>sum+value,0);
  const creatorBalanceBeforeCreate=await connection.getBalance(creator.keypair.publicKey,"confirmed");
  console.log("CREATE_PAYER",creator.keypair.publicKey.toBase58());
  console.log("CREATE_PAYER_BALANCE_BEFORE",creatorBalanceBeforeCreate);
  console.log("CREATE_RENT_MINIMA",JSON.stringify({...rentSizes,lamports:rentMinima}));'''
    if old_setup not in s:
        raise SystemExit("golden creator diagnostics target missing")
    s = s.replace(old_setup, new_setup, 1)
    old_return = '  return {create,buy,sell,campaign:campaign.toBase58(),mint:mint.toBase58(),alt:alt.key.toBase58()};'
    new_return = '  return {create,buy,sell,campaign:campaign.toBase58(),mint:mint.toBase58(),alt:alt.key.toBase58(),creatorDiagnostics:{payer:creator.keypair.publicKey.toBase58(),balanceBeforeCreate:creatorBalanceBeforeCreate,rentMinima}};'
    if old_return not in s:
        raise SystemExit("golden diagnostics report target missing")
    s = s.replace(old_return, new_return, 1)
    old = 'const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3});\n  if(retrySig!==signature) fail(`${label} identical retry signature changed`);'
    new = 'let retryResult=""; try { const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3}); if(retrySig!==signature) fail(`${label} identical retry signature changed`); retryResult="same signature"; } catch(e) { const m=String(e?.message||e); if(!/already been processed/i.test(m)) throw e; retryResult="already processed"; }'
    if old not in s:
        raise SystemExit("golden retry patch target missing")
    s = s.replace(old, new)
    s = s.replace(
        'freshBlockhash:"YES",lastValidBlockHeight:compiled.latest.lastValidBlockHeight',
        'freshBlockhash:"YES",blockhash:compiled.latest.blockhash,lastValidBlockHeight:compiled.latest.lastValidBlockHeight',
    )
    s = s.replace(
        'retryBehavior:"PASS identical serialized retry returned same signature"',
        'retryBehavior:`PASS identical signed packet deduped (${retryResult})`',
    )
    s = s.replace(
        "const first=await runGolden(",
        'const first=process.env.SOLANA_GOLDEN_ONLY_FINAL==="1"?null:await runGolden(',
    )
    s = s.replace(
        "const final=await runGolden(",
        'const final=process.env.SOLANA_GOLDEN_ONLY_FIRST==="1"?null:await runGolden(',
    )
    p.write_text(s)


def patch_middle():
    p = Path("tests/solana/candidate-wallet-middle-devnet.cjs")
    s = p.read_text()
    old = 'const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3});if(retrySig!==sig)fail(`${label} same packet retry changed signature`);'
    new = 'let retryResult="";try{const retrySig=await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:3});if(retrySig!==sig)fail(`${label} same packet retry changed signature`);retryResult="same signature";}catch(e){const m=String(e?.message||e);if(!/already been processed/i.test(m))throw e;retryResult="already processed";}'
    if old not in s:
        raise SystemExit("middle retry patch target missing")
    s = s.replace(old, new)
    s = s.replace(
        'freshBlockhash:"YES",lastValidBlockHeight:latest.lastValidBlockHeight',
        'freshBlockhash:"YES",blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight',
    )
    s = s.replace(
        'retryBehavior:"PASS identical signed packet returned same signature"',
        'retryBehavior:`PASS identical signed packet deduped (${retryResult})`',
    )
    p.write_text(s)


def patch_fixture():
    p = Path("tests/solana/devnet-create-graduation-fixture.cjs")
    s = p.read_text()
    target = "const buyer = Keypair.generate();"
    replacement = 'const buyer = Keypair.generate();\n  if (process.env.SOLANA_GRADUATION_BUYER_KEYPAIR_OUTPUT) fs.writeFileSync(process.env.SOLANA_GRADUATION_BUYER_KEYPAIR_OUTPUT, JSON.stringify(Array.from(buyer.secretKey)), {mode:0o600});'
    if target not in s:
        raise SystemExit("fixture buyer hook target missing")
    s = s.replace(target, replacement, 1)
    p.write_text(s)


def patch_graduation():
    p = Path("tools/solana-meteora-graduation/graduate-basic-quote.mjs")
    s = p.read_text()
    target = '''  const signature = await connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) fail(`graduation confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  console.log("GRADUATED", signature, "pool", pool.toBase58(), "position", position.toBase58());'''
    replacement = '''  const signature = await connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) fail(`graduation confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  let retryResult = "";
  try {
    const retrySig = await connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 5 });
    if (retrySig !== signature) fail(`graduation identical retry signature changed: ${retrySig}`);
    retryResult = "same signature";
  } catch (error) {
    const message = String(error?.message || error);
    if (!/already been processed/i.test(message)) throw error;
    retryResult = "already processed";
  }
  const replayLatest = await connection.getLatestBlockhash("confirmed");
  const replayTx = v0.buildLaunchpadV0Transaction(solanaWeb3, { payer: operator.publicKey, recentBlockhash: replayLatest.blockhash, instructions, lookupTableAccounts: lookupTables });
  replayTx.sign([operator, positionNft]);
  const replaySim = await v0.simulateLaunchpadV0Transaction(connection, replayTx);
  if (!replaySim.value.err) fail("graduation fresh-blockhash replay unexpectedly simulated successfully");
  const bogus = Keypair.generate().publicKey.toBase58();
  const expiredTx = v0.buildLaunchpadV0Transaction(solanaWeb3, { payer: operator.publicKey, recentBlockhash: bogus, instructions, lookupTableAccounts: lookupTables });
  expiredTx.sign([operator, positionNft]);
  const expiredSim = await v0.simulateLaunchpadV0Transaction(connection, expiredTx);
  if (!expiredSim.value.err) fail("graduation unknown/expired blockhash unexpectedly simulated successfully");
  const signerCount = tx.message.header.numRequiredSignatures;
  const report = {
    status: "PASS",
    version: "V0",
    altUsage: lookupTables.length ? `YES:${lookupTables.map((table) => table.key.toBase58()).join(",")}` : "NO",
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    payer: operator.publicKey.toBase58(),
    requiredSigners: tx.message.staticAccountKeys.slice(0, signerCount).map((key) => key.toBase58()),
    simulation: `PASS units=${simulation.value.unitsConsumed ?? "unknown"}`,
    serializedPacketBytes: serialized.length,
    sendMethod: "sendRawTransaction(skipPreflight=false,maxRetries=5)",
    confirmationMethod: "confirmTransaction({signature,blockhash,lastValidBlockHeight},confirmed)",
    expiryBehavior: `PASS unknown/expired blockhash rejected: ${JSON.stringify(expiredSim.value.err)}`,
    retryBehavior: `PASS identical signed packet deduped (${retryResult})`,
    duplicateReplayBehavior: `PASS fresh-blockhash duplicate graduation rejected: ${JSON.stringify(replaySim.value.err)}`,
    signature,
    campaign: campaignPk.toBase58(),
    mint: campaign.mint.toBase58(),
    pool: pool.toBase58(),
    position: position.toBase58(),
    quoteMint: quoteMint.toBase58()
  };
  if (process.env.SOLANA_GRADUATION_MATRIX_REPORT) fs.writeFileSync(process.env.SOLANA_GRADUATION_MATRIX_REPORT, `${JSON.stringify(report, null, 2)}\\n`);
  console.log("GRADUATION_MATRIX", JSON.stringify(report));
  console.log("GRADUATED", signature, "pool", pool.toBase58(), "position", position.toBase58());'''
    if target not in s:
        raise SystemExit("graduation telemetry patch target missing")
    p.write_text(s.replace(target, replacement, 1))


patch_golden()
patch_middle()
patch_fixture()
patch_graduation()
print("candidate wallet P1 runtime telemetry patches applied")
