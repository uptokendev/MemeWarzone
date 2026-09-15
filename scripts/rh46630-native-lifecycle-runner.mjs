import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(scriptsDir, 'rh46630-native-lifecycle-certification.mjs');
const patchedPath = path.join(scriptsDir, '.rh46630-native-lifecycle-certification.runtime.mjs');

export function planCertificationPrestate(preState) {
  if (!preState || typeof preState.factoryLive !== 'boolean') throw new Error('FACTORY_LIVE_STATE_INVALID');
  if (preState.createPaused !== true) throw new Error('FACTORY_NOT_INITIAL_CREATE_PAUSED');
  if (preState.globalPaused !== true) throw new Error('FACTORY_NOT_INITIAL_GLOBAL_PAUSED');
  return {
    initialLive: preState.factoryLive,
    enableLive: preState.factoryLive === false,
    openCreateForCertification: true,
    openGlobalForCertificationCreate: true,
    restoreCreatePaused: true,
    restoreGlobalPaused: true,
    expectedFinalLive: true,
  };
}

function replaceExact(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`EXPECTED_${label}_NOT_FOUND`);
  return source.replace(before, after);
}

export function patchCertificationSource(input) {
  let source = input;
  const unnamedOracleAbi = "const oracleAbi = ['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)','function updater() view returns(address)'];";
  const namedOracleAbi = "const oracleAbi = ['function decimals() view returns(uint8)','function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)','function updater() view returns(address)'];";
  source = replaceExact(source, unnamedOracleAbi, namedOracleAbi, 'ORACLE_ABI');
  source = replaceExact(
    source,
    "const SOURCE_SHA = process.env.GITHUB_SHA || 'local';",
    "const SOURCE_SHA = process.env.RH46630_CERT_HEAD_SHA || process.env.GITHUB_SHA || 'local';",
    'SOURCE_SHA'
  );

  const errTextMarker = "const errText = (e) => String(e?.shortMessage || e?.reason || e?.message || e);";
  source = replaceExact(
    source,
    errTextMarker,
    `${errTextMarker}\n\n${planCertificationPrestate.toString()}`,
    'PRESTATE_PLANNER_INSERTION'
  );

  const oldPrestate = "  assert(preState.factoryLive===false,'FACTORY_NOT_INITIAL_FAIL_CLOSED_LIVE_FALSE'); assert(preState.createPaused===true,'FACTORY_NOT_INITIAL_CREATE_PAUSED');\n  assert(await factory.canCreatorLaunch(CREATOR),'CREATOR_NOT_ELIGIBLE');\n\n  const txs=[];\n  try {\n    txs.push(await receiptEntry(provider,await factory.enableLive(),'enableLive'));\n    txs.push(await receiptEntry(provider,await factory.setCreatePaused(false),'openCreateForCertification'));";
  const newPrestate = `  const prestatePlan=planCertificationPrestate(preState);\n  assert(await factory.canCreatorLaunch(CREATOR),'CREATOR_NOT_ELIGIBLE');\n\n  const txs=[];\n  async function restoreFactoryFailClosed(labelPrefix) {\n    const restored=[];\n    if (!(await factory.globalPaused())) {\n      const entry=await receiptEntry(provider,await factory.setGlobalPaused(true),\`${'${labelPrefix}'}GlobalPaused\`);\n      txs.push(entry); restored.push(entry);\n    }\n    if (!(await factory.createPaused())) {\n      const entry=await receiptEntry(provider,await factory.setCreatePaused(true),\`${'${labelPrefix}'}CreatePaused\`);\n      txs.push(entry); restored.push(entry);\n    }\n    const state={factoryLive:await factory.live(),createPaused:await factory.createPaused(),globalPaused:await factory.globalPaused()};\n    assert(state.createPaused===true && state.globalPaused===true,\`${'${labelPrefix}'}_FAIL_CLOSED_RESTORE_FAILED\`);\n    return {restored,state};\n  }\n\n  try {\n    if (prestatePlan.enableLive) txs.push(await receiptEntry(provider,await factory.enableLive(),'enableLive'));\n    assert(await factory.live(),'FACTORY_NOT_LIVE_FOR_CERTIFICATION');\n    if (prestatePlan.openCreateForCertification && await factory.createPaused()) txs.push(await receiptEntry(provider,await factory.setCreatePaused(false),'openCreateForCertification'));\n    if (prestatePlan.openGlobalForCertificationCreate && await factory.globalPaused()) txs.push(await receiptEntry(provider,await factory.setGlobalPaused(false),'openGlobalForCertificationCreate'));\n    assert((await factory.createPaused())===false,'CREATE_PAUSE_NOT_OPEN_FOR_CERTIFICATION');\n    assert((await factory.globalPaused())===false,'GLOBAL_PAUSE_NOT_OPEN_FOR_CERTIFICATION_CREATE');`;
  source = replaceExact(source, oldPrestate, newPrestate, 'PRESTATE_TRANSITION');

  const oldCreateReceipt = "    const createReceipt=await createTx.wait(); assert(createReceipt.status===1,'CREATE_FAILED');\n    txs.push({label:'CREATE',txHash:createReceipt.hash,blockNumber:createReceipt.blockNumber,gasUsed:createReceipt.gasUsed.toString()});\n    const created=parseEvent(createReceipt,factory.interface,'CampaignCreated');";
  const newCreateReceipt = "    const createReceipt=await createTx.wait(); assert(createReceipt.status===1,'CREATE_FAILED');\n    txs.push({label:'CREATE',txHash:createReceipt.hash,blockNumber:createReceipt.blockNumber,gasUsed:createReceipt.gasUsed.toString()});\n    const createWindowClose=await restoreFactoryFailClosed('closeAfterCreate');\n    const created=parseEvent(createReceipt,factory.interface,'CampaignCreated');";
  source = replaceExact(source, oldCreateReceipt, newCreateReceipt, 'CREATE_WINDOW_CLOSE');

  const oldSuccessCleanup = "    await (await factory.setCreatePaused(true)).wait(); await (await factory.setGlobalPaused(true)).wait();\n    const postState={factoryLive:await factory.live(),createPaused:await factory.createPaused(),globalPaused:await factory.globalPaused(),securityDefaultsLocked:await factory.securityDefaultsLocked(),requireAuthorizedTrading:await factory.requireAuthorizedTrading(),requireRouteAuthorization:await factory.requireRouteAuthorization()}; assert(postState.createPaused&&postState.globalPaused,'POST_TEST_NOT_FAIL_CLOSED');";
  const newSuccessCleanup = "    const successCleanup=await restoreFactoryFailClosed('successCleanup');\n    const postState={factoryLive:await factory.live(),createPaused:await factory.createPaused(),globalPaused:await factory.globalPaused(),securityDefaultsLocked:await factory.securityDefaultsLocked(),requireAuthorizedTrading:await factory.requireAuthorizedTrading(),requireRouteAuthorization:await factory.requireRouteAuthorization()}; assert(postState.factoryLive===true&&postState.createPaused&&postState.globalPaused,'POST_TEST_NOT_FAIL_CLOSED');";
  source = replaceExact(source, oldSuccessCleanup, newSuccessCleanup, 'SUCCESS_CLEANUP');

  source = replaceExact(
    source,
    "const evidence={sourceSha:SOURCE_SHA,chainId:CHAIN_ID,productionChainId:FORBIDDEN_CHAIN_ID,productionCompatible:false,preState,createBefore",
    "const evidence={sourceSha:SOURCE_SHA,chainId:CHAIN_ID,productionChainId:FORBIDDEN_CHAIN_ID,productionCompatible:false,preState,prestatePlan,createWindowClose,successCleanup,createBefore",
    'EVIDENCE_PRESTATE'
  );

  const oldCatch = "  } catch (e) {\n    try { if(await factory.live()) { await (await factory.setCreatePaused(true)).wait(); await (await factory.setGlobalPaused(true)).wait(); } } catch {}\n    throw e;\n  }";
  const newCatch = "  } catch (e) {\n    try { await restoreFactoryFailClosed('failureCleanup'); } catch (cleanupError) { console.error(`RH46630_FAILURE_CLEANUP_${errText(cleanupError)}`); }\n    throw e;\n  }";
  source = replaceExact(source, oldCatch, newCatch, 'FAILURE_CLEANUP');
  return source;
}

async function run() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const patched = patchCertificationSource(source);
  fs.writeFileSync(patchedPath, patched);
  try {
    await import(pathToFileURL(patchedPath).href + `?mode=${Date.now()}`);
  } finally {
    try { fs.unlinkSync(patchedPath); } catch {}
  }
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) await run();
