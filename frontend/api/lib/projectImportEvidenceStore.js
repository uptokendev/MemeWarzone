import { IMPORT_REVIEW_POLICY } from './projectImportAssessment.js';
export async function withImportTransaction(pool,operation) {
  const client=await pool.connect();
  try {await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}
  catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release();}
}
export async function appendImportEvidence(db,{project,assessment,source}) {
  if(assessment.chainId!==Number(project.chain_id)||assessment.tokenAddress!==project.token_address||assessment.policyVersion!==IMPORT_REVIEW_POLICY)throw Object.assign(new Error('Import snapshot identity mismatch'),{code:'PROJECT_IMPORT_EVIDENCE_MISMATCH'});
  const r=await db.query(`INSERT INTO public.project_import_review_evidence (project_id,chain_id,token_address,claimant_wallet,claim_requested_at,source,policy_version,checked_at,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[project.id,assessment.chainId,assessment.tokenAddress,assessment.claimantWallet,project.manual_claim_requested_at||null,source,assessment.policyVersion,assessment.checkedAt,JSON.stringify(assessment)]);
  return r.rows[0];
}
export async function latestImportEvidence(db,project) {
  const r=await db.query(`SELECT * FROM public.project_import_review_evidence WHERE project_id=$1 AND claimant_wallet=$2 AND ($4::boolean OR claim_requested_at IS NOT DISTINCT FROM $3::timestamptz) ORDER BY sequence DESC LIMIT 1`,[project.id,project.manual_claim_wallet||project.project_owner_wallet,project.manual_claim_requested_at||null,project.ownership_status==='ownership_verified']);
  return r.rows[0]||null;
}
export async function importEvidenceHistory(db,projectId) {
  const r=await db.query(`SELECT id,source,checked_at,created_at,claimant_wallet,claim_requested_at,snapshot FROM public.project_import_review_evidence WHERE project_id=$1 ORDER BY sequence DESC LIMIT 30`,[projectId]);return r.rows;
}
