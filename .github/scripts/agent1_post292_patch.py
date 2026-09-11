from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing pattern in {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))

# Arena layout: chain 101 remains application identity; environment+cluster selects genesis.
p = Path("frontend/src/lib/solanaArenaLayout.mjs")
s = p.read_text()
if "resolveCurrentSolanaAuthority" not in s:
    s = 'import { resolveCurrentSolanaAuthority } from "../../shared/solanaCurrentAuthority.mjs";\n\n' + s
s = s.replace(
'''export const SOLANA_GENESIS = Object.freeze({
  101: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKvcnbdEad4t",
  102: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wavy2uVvL2jH",
});

export function isSolanaWarzoneChainId(chainId) {
  const id = Number(chainId);
  return id === 101 || id === 102;
}

export function expectedGenesisHash(chainId) {
  return SOLANA_GENESIS[Number(chainId)] || "";
}''',
'''export const SOLANA_GENESIS_BY_CLUSTER = Object.freeze({
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wavy2uVvL2jH",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKvcnbdEad4t",
});

export function isSolanaWarzoneChainId(chainId) {
  return Number(chainId) === 101;
}

export function expectedGenesisHash(chainId, environment, cluster) {
  const authority = resolveCurrentSolanaAuthority({ chainId, environment, cluster });
  return authority ? SOLANA_GENESIS_BY_CLUSTER[authority.cluster] || "" : "";
}''')
s = s.replace(
'''export function validateCanonicalArenaConfig({ account, owner, genesisHash, chainId, PublicKey }) {
  const expectedOwner = REWARDS_TREASURY_PROGRAM_ID;
  const expectedGenesis = expectedGenesisHash(chainId);
  if (expectedGenesis && String(genesisHash || "") !== expectedGenesis) {''',
'''export function validateCanonicalArenaConfig({ account, owner, genesisHash, chainId, environment, cluster, PublicKey }) {
  const expectedOwner = REWARDS_TREASURY_PROGRAM_ID;
  const expectedGenesis = expectedGenesisHash(chainId, environment, cluster);
  if (!expectedGenesis) return { live: false, reason: "current-authority-invalid" };
  if (String(genesisHash || "") !== expectedGenesis) {''')
p.write_text(s)

replace("frontend/api/lib/solanaArenaPoolRead.js",
'''      chainId: id,
      PublicKey,''',
'''      chainId: id,
      environment: env("RUNTIME_ENVIRONMENT", "SOLANA_ENVIRONMENT", "VITE_RUNTIME_ENVIRONMENT"),
      cluster: env("SOLANA_CLUSTER", "VITE_SOLANA_CLUSTER"),
      PublicKey,''')

replace("frontend/api/dev-fix/solana-trade-authorization-v1.js",
'import { badMethod, isSolanaChain, json, readJson, isSolanaAddress } from "../../server/http.js";',
'import { badMethod, json, readJson, isSolanaAddress } from "../../server/http.js";\nimport { resolveCurrentSolanaAuthority } from "../../shared/solanaCurrentAuthority.mjs";')
replace("frontend/api/dev-fix/solana-trade-authorization-v1.js",
'''    if (!isSolanaChain(chainId)) {
      throw new SolanaTradeAuthorizationError("chainId must be a Solana chain (101).", {
        code: "NOT_A_SOLANA_CHAIN",
        httpStatus: 400,
      });
    }''',
'''    const solanaAuthority = resolveCurrentSolanaAuthority({
      chainId,
      environment: body.environment || process.env.RUNTIME_ENVIRONMENT || process.env.SOLANA_ENVIRONMENT || "",
      cluster: body.solanaCluster || body.cluster || process.env.SOLANA_CLUSTER || "",
    });
    if (!solanaAuthority) {
      throw new SolanaTradeAuthorizationError("Solana trade authorization requires chain 101 with explicit staging/devnet or production/mainnet-beta identity.", {
        code: "SOLANA_CURRENT_AUTHORITY_INVALID",
        httpStatus: 400,
      });
    }''')

replace("frontend/api/dev-fix/solana-vote-ingest.js",
'import { badMethod, isSolanaAddress, isSolanaChain, json, readJson } from "../../server/http.js";',
'import { badMethod, isSolanaAddress, json, readJson } from "../../server/http.js";\nimport { resolveCurrentSolanaAuthority } from "../../shared/solanaCurrentAuthority.mjs";')
replace("frontend/api/dev-fix/solana-vote-ingest.js",
'''    if (!isSolanaChain(chainId)) {
      return json(res, 400, { error: "chainId must be Solana (101).", code: "NOT_A_SOLANA_CHAIN" });
    }''',
'''    const solanaAuthority = resolveCurrentSolanaAuthority({
      chainId,
      environment: body.environment || process.env.RUNTIME_ENVIRONMENT || process.env.SOLANA_ENVIRONMENT || "",
      cluster: body.solanaCluster || body.cluster || process.env.SOLANA_CLUSTER || "",
    });
    if (!solanaAuthority) {
      return json(res, 400, { error: "Solana vote ingest requires chain 101 with explicit staging/devnet or production/mainnet-beta identity.", code: "SOLANA_CURRENT_AUTHORITY_INVALID" });
    }''')

replace("frontend/api/arenaVotes.js",
'import { badMethod, getQuery, isSolanaAddress, isSolanaChain, json, readJson } from "../server/http.js";',
'import { badMethod, getQuery, isSolanaAddress, json, readJson } from "../server/http.js";\nimport { resolveCurrentSolanaAuthority } from "../shared/solanaCurrentAuthority.mjs";')
replace("frontend/api/arenaVotes.js",
'  if (!isSolanaChain(chainId)) return json(res, 400, { ok: false, error: "chainId must be Solana (101)." });',
'''  const solanaAuthority = resolveCurrentSolanaAuthority({
    chainId,
    environment: body.environment || process.env.RUNTIME_ENVIRONMENT || process.env.SOLANA_ENVIRONMENT || "",
    cluster: body.solanaCluster || body.cluster || process.env.SOLANA_CLUSTER || "",
  });
  if (!solanaAuthority) return json(res, 400, { ok: false, error: "Arena vote ingest requires chain 101 with explicit staging/devnet or production/mainnet-beta identity.", code: "SOLANA_CURRENT_AUTHORITY_INVALID" });''')

replace("frontend/api/dev-fix/solana-graduation-authorization-v2.js",
'''  const rootRoute = item.policy?.config?.solanaGraduation || {};
  const route = rootRoute.chains?.[String(chainId)] || rootRoute;
  const quoteMint =''',
'''  const rootRoute = item.policy?.config?.solanaGraduation || {};
  const route = rootRoute.chains?.[String(chainId)] || rootRoute;
  const authorities = Array.isArray(route.authorities) ? route.authorities : [];
  const authorityMatches = authorities.some((candidate) =>
    String(candidate?.environment || "").trim().toLowerCase() === solanaAuthority?.environment &&
    String(candidate?.cluster || "").trim().toLowerCase() === solanaAuthority?.cluster
  ) || (
    String(route.environment || "").trim().toLowerCase() === solanaAuthority?.environment &&
    String(route.cluster || "").trim().toLowerCase() === solanaAuthority?.cluster
  );
  if (!authorityMatches) throw new SolanaGraduationAuthorizationError("Requested quote policy is not approved for the current Solana environment/cluster.", { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 409 });
  const quoteMint =''')

# Add exact identity tests to existing Arena suite.
p = Path("frontend/src/lib/solanaArenaLayout.test.mjs")
s = p.read_text().replace('  isSolanaWarzoneChainId,\n', '  isSolanaWarzoneChainId,\n  expectedGenesisHash,\n', 1)
s = s.replace('    chainId: 101,\n    PublicKey,', '    chainId: 101,\n    environment: "production",\n    cluster: "mainnet-beta",\n    PublicKey,')
s = s.replace('      chainId: 101,\n      PublicKey,', '      chainId: 101,\n      environment: "production",\n      cluster: "mainnet-beta",\n      PublicKey,')
marker = 'test("isSolanaWarzoneMoneyLive requires configured and live both explicitly true", () => {'
extra = '''test("Arena genesis authority uses current chain 101 plus exact environment and cluster", () => {
  const devnet = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wavy2uVvL2jH";
  const mainnet = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKvcnbdEad4t";
  assert.equal(isSolanaWarzoneChainId(101), true);
  assert.equal(isSolanaWarzoneChainId(102), false);
  assert.equal(expectedGenesisHash(101, "staging", "devnet"), devnet);
  assert.equal(expectedGenesisHash(101, "production", "mainnet-beta"), mainnet);
  assert.equal(expectedGenesisHash(101, "staging", "mainnet-beta"), "");
  assert.equal(expectedGenesisHash(101, "production", "devnet"), "");
  assert.equal(expectedGenesisHash(102, "staging", "devnet"), "");
});

'''
if extra not in s:
    s = s.replace(marker, extra + marker, 1)
p.write_text(s)

Path("frontend/shared/solanaPost292Authority.test.mjs").write_text('''import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeSymbolFor, isSolanaChainId, isBnbChainId, isRobinhoodChainId } from "../api/lib/chainNative.js";
import { expectedGenesisHash, isSolanaWarzoneChainId } from "../src/lib/solanaArenaLayout.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (p) => readFile(path.join(root, p), "utf8");

test("native selector rejects 102 and preserves current chains", () => {
  assert.equal(isSolanaChainId(101), true); assert.equal(isSolanaChainId(102), false); assert.equal(nativeSymbolFor(101), "SOL");
  assert.throws(() => nativeSymbolFor(102), /not current financial authority/);
  for (const id of [56,97]) { assert.equal(isBnbChainId(id), true); assert.equal(nativeSymbolFor(id), "BNB"); }
  for (const id of [4663,46630]) { assert.equal(isRobinhoodChainId(id), true); assert.equal(nativeSymbolFor(id), "ETH"); }
});

test("Arena current identity rejects 102 and crossed clusters", () => {
  assert.equal(isSolanaWarzoneChainId(102), false);
  assert.equal(expectedGenesisHash(101,"staging","devnet"), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wavy2uVvL2jH");
  assert.equal(expectedGenesisHash(101,"production","mainnet-beta"), "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKvcnbdEad4t");
  assert.equal(expectedGenesisHash(101,"staging","mainnet-beta"), "");
  assert.equal(expectedGenesisHash(101,"production","devnet"), "");
  assert.equal(expectedGenesisHash(102,"staging","devnet"), "");
});

test("operational authorization boundaries do not use broad historical helper", async () => {
  for (const p of ["frontend/api/dev-fix/solana-trade-authorization-v1.js","frontend/api/dev-fix/solana-vote-ingest.js","frontend/api/arenaVotes.js"]) {
    const text=await source(p); assert.match(text,/resolveCurrentSolanaAuthority/); assert.match(text,/SOLANA_CURRENT_AUTHORITY_INVALID/); assert.doesNotMatch(text,/isSolanaChain\\(chainId\\)/);
  }
});

test("graduation quote policy is environment-bound", async () => {
  const text=await source("frontend/api/dev-fix/solana-graduation-authorization-v2.js"); assert.match(text,/authorityMatches/); assert.match(text,/current Solana environment\\/cluster/);
});

test("corrective quote migration uses chain 101 with distinct devnet and mainnet mints", async () => {
  const text=await source("frontend/supabase/migrations/20260911170000_solana_101_environment_quote_authority.sql");
  assert.match(text,/legacy chain 102/i); assert.match(text,/chain_id = '101'/); assert.match(text,/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU/); assert.match(text,/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/);
  for (const v of ['"staging"','"devnet"','"production"','"mainnet-beta"']) assert.match(text,new RegExp(v.replace('-','\\-')));
});

test("ArenaMoneyV2 remains canonical chain 101", async () => {
  const text=await source("frontend/api/lib/solanaArenaMoneyV2Read.js"); assert.match(text,/CURRENT_SOLANA_ARENA_CHAIN_ID = 101/); assert.match(text,/id !== CURRENT_SOLANA_ARENA_CHAIN_ID/);
});
''')

Path("frontend/supabase/migrations/20260911170000_solana_101_environment_quote_authority.sql").write_text('''begin;
-- Forward current-authority correction. Earlier migration and decision history remain immutable.
-- Application chain 101 is current; environment + cluster separates staging/devnet from production/mainnet-beta.
-- Legacy chain 102 must never authorize a current graduation quote.

update public.quote_asset_deployments set admin_state='disabled', state_version=state_version+1
where id='a2100000-0000-4000-8000-000000000211'::uuid and chain_id='102';
update public.quote_asset_policy_versions set new_graduation_enabled=false,
  policy_config=jsonb_set(policy_config,'{solanaGraduation,legacyAuthorityRetired}','true'::jsonb,true)
where id='a2100000-0000-4000-8000-000000000311'::uuid;

update public.quote_asset_deployments set chain_id='101', state_version=state_version+1
where id='a2100000-0000-4000-8000-000000000212'::uuid and chain_id='102'
  and contract_address_or_mint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
update public.quote_asset_policy_versions set policy_config=jsonb_set(jsonb_set(policy_config,'{solanaGraduation,environment}','"staging"'::jsonb,true),'{solanaGraduation,cluster}','"devnet"'::jsonb,true)
where id='a2100000-0000-4000-8000-000000000312'::uuid;

update public.quote_asset_policy_versions set policy_config=jsonb_set(policy_config,'{solanaGraduation,authorities}','[{"environment":"staging","cluster":"devnet"},{"environment":"production","cluster":"mainnet-beta"}]'::jsonb,true)
where id='a2100000-0000-4000-8000-000000000301'::uuid;
update public.quote_asset_policy_versions set policy_config=jsonb_set(jsonb_set(policy_config,'{solanaGraduation,environment}','"production"'::jsonb,true),'{solanaGraduation,cluster}','"mainnet-beta"'::jsonb,true)
where id='a2100000-0000-4000-8000-000000000302'::uuid
  and policy_config #>> '{solanaGraduation,quoteMint}'='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

insert into public.quote_asset_decision_history(deployment_id,provider_id,policy_version_id,state_version,decision,reason,decision_snapshot,actor_identity)
select d.id,d.provider_id,p.id,d.state_version,
 case when d.id='a2100000-0000-4000-8000-000000000212'::uuid then 'review' else 'rejected' end,
 case when d.id='a2100000-0000-4000-8000-000000000212'::uuid then 'Devnet Circle USDC moved to application chain 101 and bound to staging/devnet; existing market-health review stays fail-closed.' else 'Legacy chain 102 native certification deployment retired; current native SOL uses chain 101 plus explicit environment/cluster.' end,
 jsonb_build_object('chainId',d.chain_id,'adminState',d.admin_state,'environment',p.policy_config #>> '{solanaGraduation,environment}','cluster',p.policy_config #>> '{solanaGraduation,cluster}'),
 'migration:20260911170000_solana_101_environment_quote_authority'
from public.quote_asset_deployments d join public.quote_asset_policy_versions p on p.quote_asset_id=d.quote_asset_id
where d.id in ('a2100000-0000-4000-8000-000000000211'::uuid,'a2100000-0000-4000-8000-000000000212'::uuid)
and not exists(select 1 from public.quote_asset_decision_history h where h.deployment_id=d.id and h.actor_identity='migration:20260911170000_solana_101_environment_quote_authority');
commit;
''')
