import fs from 'node:fs';

function patch(path, from, to) {
  const src = fs.readFileSync(path, 'utf8');
  if (!src.includes(from)) throw new Error(`Patch anchor missing in ${path}: ${from.slice(0,100)}`);
  fs.writeFileSync(path, src.replace(from, to));
}

patch('api/lib/projectImportSecurity.js',
'  registrationImage: "project_import_registration_image",\n});',
'  registrationImage: "project_import_registration_image",\n  pumpChallengeStart: "project_import_pump_challenge_start",\n  pumpChallengeCheck: "project_import_pump_challenge_check",\n});');

patch('api/projectImports.js',
'import { withImportTransaction, appendImportEvidence, latestImportEvidence, importEvidenceHistory } from "./lib/projectImportEvidenceStore.js";',
'import { withImportTransaction, appendImportEvidence, latestImportEvidence, importEvidenceHistory } from "./lib/projectImportEvidenceStore.js";\nimport { applyVerifiedPumpChallenge, createPumpOwnershipChallenge, latestPumpOwnershipChallenge, pumpChallengeConnection, pumpChallengePublic, verifyPumpOwnershipChallenge } from "./lib/projectImportPumpChallenge.js";');

patch('api/projectImports.js',
'  try { resolved = await resolveForSigner(identity, signer); }\n  catch (error) { if (!fallback || !canFallbackToManual(error)) throw error; resolved = unresolvedEvidence(identity, error); }\n  const security = await scanProjectImportSecurity',
'  try { resolved = await resolveForSigner(identity, signer); }\n  catch (error) { if (!fallback || !canFallbackToManual(error)) throw error; resolved = unresolvedEvidence(identity, error); }\n  resolved = await applyVerifiedPumpChallenge(pool, identity, signer, resolved);\n  const security = await scanProjectImportSecurity');

const challengeHandlers = `
    if (req.method === "POST" && path === "/pump-challenge") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      if (identity.chainId !== 101) throw Object.assign(new Error("Pump.fun wallet verification is only available on Solana."), { code: "INVALID_CHAIN" });
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.pumpChallengeStart });
      if (!auth) return;
      const resolved = await resolveForSigner(identity, auth.walletAddress);
      if (resolved?.authoritySource !== "pump_bonding_curve_creator" || !resolved?.currentAuthority) throw Object.assign(new Error("A signable Pump.fun creator wallet could not be established for this token."), { code: "PROJECT_IMPORT_PUMP_CHALLENGE_UNAVAILABLE" });
      if (resolved.signedWalletMatchesAuthority) throw Object.assign(new Error("This wallet already matches the Pump.fun creator wallet."), { code: "PROJECT_IMPORT_PUMP_CHALLENGE_NOT_NEEDED" });
      const challenge = await createPumpOwnershipChallenge(pool, { tokenAddress: identity.tokenAddress, creatorWallet: resolved.currentAuthority, claimantWallet: auth.walletAddress });
      return json(res, 201, { challenge: pumpChallengePublic(challenge) });
    }

    if (req.method === "POST" && path === "/pump-challenge/check") {
      const body = await readJson(req);
      const identity = normalizeProjectIdentity(body.chainId, body.tokenAddress);
      if (identity.chainId !== 101) throw Object.assign(new Error("Pump.fun wallet verification is only available on Solana."), { code: "INVALID_CHAIN" });
      const intentBody = { challengeId: String(body.challengeId || "") };
      const auth = await strictAuth(res, body, { identity, action: PROJECT_IMPORT_ACTIONS.pumpChallengeCheck, intentBody });
      if (!auth) return;
      const challenge = await latestPumpOwnershipChallenge(pool, { tokenAddress: identity.tokenAddress, claimantWallet: auth.walletAddress });
      if (!challenge || challenge.id !== intentBody.challengeId) throw Object.assign(new Error("Verification challenge not found. Start a new one."), { code: "PROJECT_IMPORT_PUMP_CHALLENGE_NOT_FOUND" });
      const current = await resolveForSigner(identity, auth.walletAddress);
      if (current?.authoritySource !== "pump_bonding_curve_creator" || current?.currentAuthority !== challenge.creator_wallet) throw Object.assign(new Error("The Pump.fun creator record changed. Start verification again."), { code: "PROJECT_IMPORT_PUMP_CREATOR_CHANGED" });
      const verified = await verifyPumpOwnershipChallenge(pool, challenge, pumpChallengeConnection());
      const { resolved, security, assessment } = await buildImportChecks(identity, auth.walletAddress, body.auth, true);
      const project = await enrichExistingProjectIdentity(identity, resolved) || await lookupProjectImport(pool, identity);
      return json(res, 200, { challenge: pumpChallengePublic(verified), resolved: { ...resolved, security, assessment, retainedPageOnly: isRetainedImportPage(project) }, project: publicProject(project) });
    }
`;
patch('api/projectImports.js',
'    if (req.method === "POST" && path === "/resolve") {',
challengeHandlers + '\n    if (req.method === "POST" && path === "/resolve") {');

patch('src/lib/projectImports.ts',
'  mintAuthority?: string | null;\n};',
'  mintAuthority?: string | null;\n  ownershipProofSource?: string | null;\n  ownershipProofTxSignature?: string | null;\n};\nexport type PumpOwnershipChallenge = { id:string; chainId:number; tokenAddress:string; creatorWallet:string; claimantWallet:string; lamports:string; solAmount:string; createdAt:string; expiresAt:string; verifiedAt?:string|null; txSignature?:string|null; status:"pending"|"verified"|"expired" };');

const clientFns = `
export async function startPumpOwnershipChallenge(input: { tokenAddress:string; chainId:number; auth:WalletActionAuthPayload }): Promise<PumpOwnershipChallenge> {
  const res=await apiFetch("/api/project-imports/pump-challenge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const json=await readJson(res); if(!res.ok||!json?.challenge) throw importRequestError(res,json,\`Pump.fun verification could not start (\${res.status})\`); return json.challenge;
}
export async function checkPumpOwnershipChallenge(input: { tokenAddress:string; chainId:number; challengeId:string; auth:WalletActionAuthPayload }): Promise<{challenge:PumpOwnershipChallenge;resolved:ProjectResolveResult;project:ProjectImportItem|null}> {
  const res=await apiFetch("/api/project-imports/pump-challenge/check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const json=await readJson(res); if(!res.ok||!json?.challenge||!json?.resolved) throw importRequestError(res,json,\`Pump.fun verification check failed (\${res.status})\`); return {challenge:json.challenge,resolved:json.resolved,project:json.project??null};
}
`;
fs.appendFileSync('src/lib/projectImports.ts', clientFns);

patch('src/pages/ProjectImport.tsx',
'  requestProjectManualCheck,\n  resolveProjectImportWithProject,',
'  requestProjectManualCheck,\n  startPumpOwnershipChallenge,\n  checkPumpOwnershipChallenge,\n  resolveProjectImportWithProject,');
patch('src/pages/ProjectImport.tsx',
'  type ProjectResolveResult,\n} from "@/lib/projectImports";',
'  type ProjectResolveResult,\n  type PumpOwnershipChallenge,\n} from "@/lib/projectImports";');
patch('src/pages/ProjectImport.tsx',
'  const [imageFile,setImageFile]=useState<File|null>(null); const [imagePreview,setImagePreview]=useState("");',
'  const [imageFile,setImageFile]=useState<File|null>(null); const [imagePreview,setImagePreview]=useState("");\n  const [pumpChallenge,setPumpChallenge]=useState<PumpOwnershipChallenge|null>(null); const [pumpNow,setPumpNow]=useState(Date.now());');
patch('src/pages/ProjectImport.tsx',
'  const reviewablePumpMismatch=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana")&&evidence?.authoritySource==="pump_bonding_curve_creator"&&assessment?.manualRequestAllowed===true;',
'  const reviewablePumpMismatch=lookupComplete&&evidence?.automaticOwnershipAvailable===true&&Boolean(evidence.currentAuthority)&&!sameWallet(evidence.currentAuthority,connectedWallet,chain==="solana")&&evidence?.signedWalletMatchesAuthority!==true&&evidence?.authoritySource==="pump_bonding_curve_creator"&&assessment?.manualRequestAllowed===true;');
patch('src/pages/ProjectImport.tsx',
'  const expectedAuthorityShort=wrongAuthorityWallet?shortenWallet(evidence?.currentAuthority):""; const connectedWalletShort=shortenWallet(connectedWallet);',
'  const expectedAuthorityShort=(wrongAuthorityWallet||reviewablePumpMismatch)?shortenWallet(evidence?.currentAuthority):""; const connectedWalletShort=shortenWallet(connectedWallet);');
patch('src/pages/ProjectImport.tsx',
'  const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);setResolvedFor("");setImageFile(null);setImagePreview("");setFeedback(null);};',
'  const reset=()=>{setItem(null);setEvidence(null);setLookupComplete(false);setResolvedFor("");setImageFile(null);setImagePreview("");setFeedback(null);setPumpChallenge(null);};');
patch('src/pages/ProjectImport.tsx',
'  useEffect(()=>{reset();},[chainId,connectedWallet]);',
'  useEffect(()=>{reset();},[chainId,connectedWallet]);\n  useEffect(()=>{if(!pumpChallenge||pumpChallenge.status!=="pending")return;const timer=setInterval(()=>setPumpNow(Date.now()),1000);return()=>clearInterval(timer);},[pumpChallenge]);');

const challengeFns = `
  const startPumpChallenge=async()=>{
    if(!reviewablePumpMismatch||!connectedWallet||working)return;setWorking(true);setFeedback(null);
    try{const auth=await signAction("project_import_pump_challenge_start",null);if(!current())return;const challenge=await startPumpOwnershipChallenge({chainId,tokenAddress:tokenAddress.trim(),auth});if(!current())return;setPumpChallenge(challenge);setPumpNow(Date.now());}
    catch(error){showError(error);}finally{setWorking(false);}
  };
  const checkPumpChallenge=async()=>{
    if(!pumpChallenge||!connectedWallet||working)return;setWorking(true);setFeedback(null);
    try{const intentBody={challengeId:pumpChallenge.id};const auth=await signAction("project_import_pump_challenge_check",null,intentBody);if(!current())return;const result=await checkPumpOwnershipChallenge({chainId,tokenAddress:tokenAddress.trim(),challengeId:pumpChallenge.id,auth});if(!current())return;setPumpChallenge(result.challenge);setItem(result.project);setEvidence(result.resolved);setResolvedFor(contextKey);setLookupComplete(true);toast.success("Pump.fun creator wallet verified.");}
    catch(error){showError(error);}finally{setWorking(false);}
  };
  const pumpSecondsLeft=pumpChallenge?Math.max(0,Math.ceil((Date.parse(pumpChallenge.expiresAt)-pumpNow)/1000)):0;
  const pumpCountdown=\`${'${'}Math.floor(pumpSecondsLeft/60)}:${'${'}String(pumpSecondsLeft%60).padStart(2,"0")}\`;
`;
patch('src/pages/ProjectImport.tsx',
'  const securityRisks=[...(evidence?.security?.criticalRisks||[]),...(evidence?.security?.reviewRisks||[])];',
challengeFns + '\n  const securityRisks=[...(evidence?.security?.criticalRisks||[]),...(evidence?.security?.reviewRisks||[])];');

const challengeUi = `
    {reviewablePumpMismatch?<section role="status" data-pump-wallet-verification="true" className="rounded border border-sky-300/40 bg-sky-400/10 p-4"><h2 className="font-retro text-sm text-sky-100">VERIFY YOUR PUMP.FUN WALLET</h2><p className="mt-2 text-sm text-sky-50">Pump.fun created this token with <strong>{expectedAuthorityShort}</strong>, but you connected <strong>{connectedWalletShort}</strong>. This is common with Pump.fun.</p>{!pumpChallenge?<><p className="mt-2 text-sm text-sky-50">You do not need to import the Pump.fun wallet. Send a tiny one-time SOL amount from the Pump.fun creator wallet to your connected wallet and we can verify the link automatically.</p><Button type="button" className="mt-3" disabled={working} onClick={()=>void startPumpChallenge()}>START VERIFICATION</Button></>:pumpChallenge.status==="verified"?<p className="mt-3 text-sm font-semibold text-emerald-200">PUMP.FUN WALLET VERIFIED</p>:<div className="mt-3 rounded border border-sky-200/30 p-3"><p className="text-sm">Send exactly <strong>{pumpChallenge.solAmount} SOL</strong> within <strong>{pumpCountdown}</strong>.</p><p className="mt-2 break-all text-xs"><strong>From:</strong> {pumpChallenge.creatorWallet}</p><p className="mt-1 break-all text-xs"><strong>To:</strong> {pumpChallenge.claimantWallet}</p><p className="mt-2 text-xs text-sky-100/80">Only this exact transfer, after this challenge was created and before it expires, will count. MemeWarzone never receives the SOL.</p><div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={working||pumpSecondsLeft<=0} onClick={()=>void checkPumpChallenge()}>I SENT IT - CHECK NOW</Button><Button type="button" variant="outline" disabled={working} onClick={()=>void startPumpChallenge()}>NEW CHALLENGE</Button></div></div>}<details className="mt-3 text-xs"><summary className="cursor-pointer">Can't send from that wallet?</summary><p className="mt-2">Use the Pump.fun wallet guide above to connect the creator wallet, or request manual verification and prove the project through an established official account.</p></details></section>:null}
`;
patch('src/pages/ProjectImport.tsx',
'    {canRequestManual?<section role="status" data-import-manual-summary="true"',
challengeUi + '\n    {canRequestManual?<section role="status" data-import-manual-summary="true"');

patch('src/pages/ProjectImport.tsx',
'Pump.fun often uses a separate creator wallet. You can still request review and prove the project through its official account.',
'Pump.fun often uses a separate creator wallet. Use the quick wallet verification above, or request review if you cannot send from that wallet.');
patch('src/pages/ProjectImport.tsx',
'For Pump.fun creator-wallet mismatches, we can verify you through the project\'s official account. Other known wallet mismatches stay blocked.',
'For Pump.fun, try the quick creator-wallet transfer first. If that is not possible, we can verify the project manually through an established official account. Other known wallet mismatches stay blocked.');

// Customer-facing detail should be simple; admin evidence remains technical.
patch('src/pages/ProjectImport.tsx',
'{assessment?.checks?.length&&!stillBonding?<details className="rounded border p-3" data-import-checks="true"><summary>Why do we need to check it?</summary><div className="mt-3 space-y-3">{assessment.checks.map(check=><div key={check.key}><strong>{check.title}: {check.status}</strong><p className="text-sm">{check.finding}</p><p className="text-xs text-muted-foreground">Next: {check.nextAction}</p></div>)}</div></details>:null}',
'{assessment?.checks?.length&&!stillBonding?<details className="rounded border p-3" data-import-checks="true"><summary>Why do we need to check it?</summary><div className="mt-3 space-y-2">{assessment.checks.map(check=><div key={check.key} className="flex items-center justify-between gap-3 text-sm"><span>{check.title}</span><strong>{check.status==="pass"?"OK":check.status==="blocked"?"Needs proof":"Needs a check"}</strong></div>)}</div><p className="mt-3 text-xs text-muted-foreground">Our team sees the full technical details. You only need to follow the action shown above.</p></details>:null}');

fs.appendFileSync('src/project-imports-ui.test.mjs', `\n\ntest("Pump.fun mismatch offers a 15-minute creator-wallet transfer proof without weakening other mismatches",()=>{\n  assert.match(page,/VERIFY YOUR PUMP\\.FUN WALLET/);\n  assert.match(page,/START VERIFICATION/);\n  assert.match(page,/I SENT IT - CHECK NOW/);\n  assert.match(page,/MemeWarzone never receives the SOL/);\n  assert.match(page,/project_import_pump_challenge_start/);\n  assert.match(page,/project_import_pump_challenge_check/);\n});\n`);

console.log('Applied Pump.fun transfer challenge UI/API integration.');
