import crypto from 'node:crypto';
import { normalizeProjectIdentity } from './projectImportCore.js';

export const IMPORT_REVIEW_POLICY = 'import_review_v1_20260910_markets';
export const REVIEW_MAX_AGE_MS = 15 * 60 * 1000;
const EVERGLEN = {id:'de2321a6-3314-45e5-8114-48cedbd50213',chainId:101,token:'FcBb7avR9LgmgwFxRcVJDiroZxZfgvtnUJrRKQ7kpump'};
const error = (message,code) => Object.assign(new Error(message),{code});
export const maskImportWallet = value => {const s=String(value||'');return s.length>8?`${s.slice(0,4)}...${s.slice(-4)}`:s;};
function sameAddress(a,b,chainId){return Number(chainId)===101?a===b:String(a).toLowerCase()===String(b).toLowerCase();}
export function isRetainedImportPage(project) {
  return project?.id===EVERGLEN.id && Number(project.chain_id)===EVERGLEN.chainId && project.token_address===EVERGLEN.token && project.ownership_status==='ownership_verified';
}
export function assertNewImportMarket(resolved) {
  if(resolved?.market?.verified===true && resolved.market.phase==='bonding') throw error('This token is still bonding on another platform. Return after graduation.','PROJECT_IMPORT_STILL_BONDING');
}
// Called only AFTER server-side nonce/signature verification. Never accepts a client evidence object.
export function importProofReceipt(auth) {
  return {signedWallet:auth.walletAddress,action:auth.action||null,messageHash:crypto.createHash('sha256').update(String(auth.message||'')).digest('hex'),verifiedBy:'server_wallet_action'};
}
export function assessProjectImport({resolved,security,claimantWallet,proof=null,checkedAt=new Date().toISOString()}) {
  const identity=normalizeProjectIdentity(resolved?.chainId,resolved?.tokenAddress);
  const market=resolved.market||{phase:'unknown',verified:false,reason:'market_not_verified'};
  const authority=resolved.currentAuthority||null;
  const known=resolved.automaticOwnershipAvailable===true&&Boolean(authority);
  const match=known&&sameAddress(authority,claimantWallet,identity.chainId)&&resolved.signedWalletMatchesAuthority===true;
  const mismatch=known&&!match;
  const bonding=market.verified===true&&market.phase==='bonding';
  const postgrad=market.verified===true&&['postgrad','dex_market'].includes(market.phase)&&market.liquidityAvailable===true;
  const technicalFailure=Boolean(resolved.resolverError)||Boolean(resolved.projectAuthorityEvidence?.authorityError)||(security?.reviewRisks||[]).some(r=>/unavailable|no_security_data|invalid|uninitialized/.test(r.code));
  const launchReview=market.requiresLaunchReview===true;
  const marketControlsOk=market.pricingValid!==false && market.buyEnabled!==false && market.sellEnabled!==false;
  const venue=market.venue||'Supported DEX';
  const platform=market.platform==='fourmeme'?'Four.meme':market.platform==='pumpfun'?'Pump.fun':'another launch platform';
  const safe=security?.status==='pass';
  const checks=[
    {key:'identity',status:resolved.resolverError?'unknown':'pass',title:'Token identity',finding:resolved.resolverError?'Token checks could not finish.':`${resolved.name||'Token'} (${resolved.symbol||'symbol unavailable'}) on ${identity.chainId===101?'Solana':'BNB'}.`,meaning:'This identifies the token, not its owner or safety.',nextAction:resolved.resolverError?'Retry the technical check.':'Confirm the Contract Address matches the project.'},
    {key:'market',status:bonding?'blocked':postgrad?'pass':'unknown',title:'Market stage',finding:bonding?`Still bonding on ${platform}.`:postgrad?`${venue} pool identity and actual funded reserves verified.${launchReview?' Launch origin is unresolved; independent review is required.':''}`:['migration_pending','postgrad_unverified'].includes(market.phase)?'Bonding completed; this verifier has not established a supported post-grad market. This does not prove migration is pending.':'Launch stage or market is not supported by the current automatic verifier.',meaning:'Bonding tokens cannot be newly imported for the post-grad system. A detected pool is not a trading approval.',nextAction:bonding?'Return after graduation.':postgrad?(launchReview?'Independently confirm the launch history and absence of active external bonding; record the evidence reference.':'Continue ownership and safety review.'):'Escalate for a supported market verifier; do not approve on a chart alone.'},
    {key:'ownership',status:mismatch?'blocked':match?'pass':'review',title:'Project wallet',finding:mismatch?`Connected wallet does not match recorded creator ${maskImportWallet(authority)}.`:match?'The signed wallet matches the detected project authority.':resolved.projectAuthorityEvidence?.authorityType==='fee_sharing'?'Pump.fun uses an automated fee-sharing account.':'Automatic project authority is unavailable.',meaning:'Wallet control, fee entitlement and project-management authority are different.',nextAction:mismatch?'Connect the identified creator wallet. Use the Pump.fun wallet guide if needed.':match?'Keep this signature proof with the claim.':'Review the recorded relationships and obtain independent project-management authorization.'},
    {key:'security',status:safe?'pass':security?.status==='blocked'?'blocked':'review',title:'Token safety',finding:safe?'Configured safety checks passed.':(security?.criticalRisks||[]).concat(security?.reviewRisks||[]).map(x=>x.label).join('; ')||'Safety data unavailable.',meaning:'No scan guarantees future safety. Ownership approval does not clear token risk.',nextAction:safe?'Keep the dated results; recheck before future competition admission.':'Resolve confirmed restrictions or escalate uncertain evidence. Do not call missing data safe.'},
  ];
  const automaticImportAllowed=match&&postgrad&&safe&&!technicalFailure&&!launchReview&&marketControlsOk;
  const manualRequestAllowed=!bonding&&!mismatch&&!automaticImportAllowed;
  const decision=bonding?'not_eligible':mismatch?'wrong_wallet':technicalFailure||!postgrad||!marketControlsOk?'technical_review':automaticImportAllowed?'automatic':'manual_review';
  return {
    schemaVersion:1,policyVersion:IMPORT_REVIEW_POLICY,checkedAt,...identity,claimantWallet,
    proof,observedSlot:resolved.observedSlot??null,observedBlock:resolved.observedBlock??null,launchEvidence:resolved.launchEvidence??null,
    authority:{status:mismatch?'mismatch':match?'matched':'unresolved',address:authority,source:resolved.authoritySource??null,reason:resolved.ownershipReason??null,evidence:resolved.projectAuthorityEvidence??null},
    market,security,checks,decision,automaticImportAllowed,manualRequestAllowed,
    canVerifyOwner:!bonding&&!mismatch&&postgrad&&!technicalFailure&&marketControlsOk&&['pass','review'].includes(security?.status),
    permissions:{battle:'locked',trading:'locked',graduationAsset:'not_approved'},
  };
}
export function assertAutomaticImport(assessment) {
  if(!assessment.automaticImportAllowed)throw error('Automatic import is not cleared. Review the token checks and next steps.','PROJECT_IMPORT_REVIEW_REQUIRED');
}
export function assertReviewApproval(snapshot,{project,evidenceId,expectedEvidenceId,now=Date.now(),reviewProof}) {
  if(!snapshot||snapshot.schemaVersion!==1||snapshot.policyVersion!==IMPORT_REVIEW_POLICY||!evidenceId||evidenceId!==expectedEvidenceId) throw error('Current import evidence is required. Recheck this claim.','PROJECT_IMPORT_EVIDENCE_REQUIRED');
  const age=now-Date.parse(snapshot.checkedAt);
  if(!Number.isFinite(age)||age< -30000||age>REVIEW_MAX_AGE_MS)throw error('Import evidence is stale. Recheck before approval.','PROJECT_IMPORT_EVIDENCE_STALE');
  if(snapshot.chainId!==Number(project.chain_id)||!sameAddress(snapshot.tokenAddress,project.token_address,snapshot.chainId)||!sameAddress(snapshot.claimantWallet,project.manual_claim_wallet,snapshot.chainId))throw error('Evidence belongs to another project or claimant.','PROJECT_IMPORT_EVIDENCE_MISMATCH');
  if(!snapshot.proof||snapshot.proof.verifiedBy!=='server_wallet_action'||!sameAddress(snapshot.proof.signedWallet,project.manual_claim_wallet,project.chain_id))throw error('A fresh signed claim is required; this legacy record has no persisted signature receipt.','PROJECT_IMPORT_SIGNED_CLAIM_REQUIRED');
  if(snapshot.market?.phase==='bonding')throw error('Bonding tokens cannot be approved for a new public import.','PROJECT_IMPORT_STILL_BONDING');
  if(!snapshot.canVerifyOwner||!['postgrad','dex_market'].includes(snapshot.market?.phase)||snapshot.market?.verified!==true||snapshot.market?.liquidityAvailable!==true||snapshot.authority?.status==='mismatch'||snapshot.market?.pricingValid===false||snapshot.market?.buyEnabled===false||snapshot.market?.sellEnabled===false||!['pass','review'].includes(snapshot.security?.status))throw error('The checks require technical review. Ownership approval cannot override them.','PROJECT_IMPORT_TECHNICAL_REVIEW');
  if(snapshot.market?.requiresLaunchReview===true) {
    const valid=reviewProof?.marketMethod==='independent_launch_history' && String(reviewProof.marketReference||'').trim().length>=12;
    if(!valid)throw error('A DEX pool alone does not prove graduation. Record independently checked launch history and absence of active external bonding.','PROJECT_IMPORT_MARKET_PROOF_REQUIRED');
  }
  if(snapshot.authority?.status!=='matched') {
    const valid=reviewProof?.method==='independent_project_authorization'&&String(reviewProof.reference||'').trim().length>=12;
    if(!valid)throw error('Record independently checked project authorization. Fee recipient status alone is not ownership.','PROJECT_IMPORT_REVIEW_PROOF_REQUIRED');
  }
}
