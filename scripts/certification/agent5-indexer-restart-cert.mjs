#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reports = path.join(root, "reports");
fs.mkdirSync(reports, { recursive: true });
const req = (name) => { const v = String(process.env[name] || "").trim(); if (!v) throw new Error(`${name} is required`); return v; };
const num = (name) => { const n = Number(req(name)); if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive`); return n; };
const databaseUrl = req("DATABASE_URL");
const sourceSha = req("MEMEWARZONE_SOURCE_SHA");
const bscUpstream = req("BSC_TESTNET_RPC");
const solUpstream = req("SOLANA_DEVNET_RPC");
const bnbCampaign = req("CERT_BNB_BONDING_CAMPAIGN").toLowerCase();
const bnbBondingFirst = num("CERT_BNB_BONDING_FIRST_BLOCK");
const bnbBondingMissed = num("CERT_BNB_BONDING_MISSED_BLOCK");
const bnbPool = req("CERT_BNB_TOPAZ_POOL").toLowerCase();
const bnbPostCampaign = req("CERT_BNB_TOPAZ_CAMPAIGN").toLowerCase();
const bnbToken = req("CERT_BNB_TOPAZ_TOKEN").toLowerCase();
const bnbWrapped = req("CERT_BNB_TOPAZ_WRAPPED").toLowerCase();
const bnbToken0 = req("CERT_BNB_TOPAZ_TOKEN0").toLowerCase();
const bnbToken1 = req("CERT_BNB_TOPAZ_TOKEN1").toLowerCase();
const bnbGraduation = num("CERT_BNB_TOPAZ_GRADUATION_BLOCK");
const bnbPostFirst = num("CERT_BNB_TOPAZ_FIRST_BLOCK");
const bnbPostMissed = num("CERT_BNB_TOPAZ_MISSED_BLOCK");
const solCampaign = req("CERT_SOLANA_BONDING_CAMPAIGN");
const solBondingFirstSig = req("CERT_SOLANA_BONDING_FIRST_SIGNATURE");
const solBondingMissedSig = req("CERT_SOLANA_BONDING_MISSED_SIGNATURE");
const solPostCampaign = req("CERT_SOLANA_METEORA_CAMPAIGN");
const solMint = req("CERT_SOLANA_METEORA_MINT");
const solPool = req("CERT_SOLANA_METEORA_POOL");
const solGraduationSlot = num("CERT_SOLANA_METEORA_GRADUATION_SLOT");
const solPostFirst = num("CERT_SOLANA_METEORA_FIRST_SLOT");
const solPostMissed = num("CERT_SOLANA_METEORA_MISSED_SLOT");
if (!(bnbBondingFirst < bnbBondingMissed && bnbPostFirst < bnbPostMissed && solPostFirst < solPostMissed)) throw new Error("first event must precede missed event");

function psql(sql, tuples = false) {
  const args = [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-At");
  const r = spawnSync("psql", args, { input: sql, encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr || r.stdout).slice(0, 2000)}`);
  return String(r.stdout || "").trim();
}
const q = (sql) => psql(sql, true);
const esc = (v) => String(v).replaceAll("'", "''");

const bnbCutoffFile = path.join(reports, ".agent5-bnb-cutoff");
const solCutoffFile = path.join(reports, ".agent5-sol-cutoff");
fs.writeFileSync(bnbCutoffFile, String(bnbBondingFirst));
fs.writeFileSync(solCutoffFile, String(solPostFirst));

function startProxy(kind, upstream, cutoffFile, port) {
  const child = spawn(process.execPath, [path.join(root, "scripts/certification/agent5-rpc-cutoff-proxy.mjs")], {
    cwd: root,
    env: { ...process.env, CERT_RPC_KIND: kind, CERT_UPSTREAM_RPC: upstream, CERT_CUTOFF_FILE: cutoffFile, CERT_PROXY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  return child;
}
const bnbProxy = startProxy("evm", bscUpstream, bnbCutoffFile, 18545);
const solProxy = startProxy("solana", solUpstream, solCutoffFile, 18899);
await new Promise((r) => setTimeout(r, 1200));

function worker(mode, extra = {}) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/certification/agent5-indexer-worker.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      RUNTIME_ENVIRONMENT: "local",
      LOCAL_DISABLE_ABLY: "1",
      DATABASE_URL: databaseUrl,
      BSC_RPC_HTTP_97: "http://127.0.0.1:18545",
      DEFAULT_EVM_CHAIN_ID: "97",
      EVM_INDEXER_CHAIN_IDS: "97",
      SOLANA_RPC_HTTP: "http://127.0.0.1:18899",
      SOLANA_RPC_URL: "http://127.0.0.1:18899",
      SOLANA_LAUNCHPAD_PROGRAM_ID: process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt",
      INDEXER_NORMAL_SCOPE: "campaigns",
      CONFIRMATIONS: "0",
      INDEXER_LOG_CALL_DELAY_MS: "0",
      CERT_INDEXER_MODE: mode,
      ...extra,
    },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${mode} worker failed: ${String(r.stderr || r.stdout).slice(0, 4000)}`);
  return String(r.stdout || "").trim();
}

function snapshot() {
  const text = q(`select json_build_object(
    'bnbBondingRows',(select count(*) from public.curve_trades where chain_id=97 and campaign_address='${esc(bnbCampaign)}'),
    'bnbBondingVolume',(select coalesce(sum(bnb_amount_raw),0)::text from public.curve_trades where chain_id=97 and campaign_address='${esc(bnbCampaign)}'),
    'bnbBondingCursor',(select coalesce(max(last_indexed_block),0) from public.indexer_state where chain_id=97 and cursor='campaign:${esc(bnbCampaign)}'),
    'bnbDexRows',(select count(*) from public.dex_trades where chain_id=97 and pair_address='${esc(bnbPool)}'),
    'bnbDexVolume',(select coalesce(sum(native_amount_raw::numeric),0)::text from public.dex_trades where chain_id=97 and pair_address='${esc(bnbPool)}'),
    'bnbDexCursor',(select coalesce(max(last_indexed_block),0) from public.dex_pools where chain_id=97 and pair_address='${esc(bnbPool)}'),
    'solBondingRows',(select count(*) from public.curve_trades where chain_id=101 and campaign_address='${esc(solCampaign)}'),
    'solBondingVolume',(select coalesce(sum(bnb_amount_raw),0)::text from public.curve_trades where chain_id=101 and campaign_address='${esc(solCampaign)}'),
    'solProcessed',(select count(*) from public.solana_pda_scan_sigs where chain_id=101 and campaign_address='${esc(solCampaign)}'),
    'solMeteoraRows',(select count(*) from public.curve_trades where chain_id=101 and campaign_address='${esc(solPostCampaign)}' and log_index>=20000),
    'solMeteoraVolume',(select coalesce(sum(bnb_amount_raw),0)::text from public.curve_trades where chain_id=101 and campaign_address='${esc(solPostCampaign)}' and log_index>=20000),
    'solMeteoraCursor',(select coalesce(max(last_indexed_block),0) from public.indexer_state where chain_id=101 and cursor='solana:meteora:${esc(solPool)}'),
    'cross97OnSolCampaign',(select count(*) from public.curve_trades where chain_id=97 and campaign_address in ('${esc(solCampaign)}','${esc(solPostCampaign)}')),
    'cross101OnBnbCampaign',(select count(*) from public.curve_trades where chain_id=101 and campaign_address in ('${esc(bnbCampaign)}','${esc(bnbPostCampaign)}'))
  )::text;`);
  return JSON.parse(text);
}

try {
  psql(fs.readFileSync(path.join(root, "scripts/certification/agent5-indexer-cert-schema.sql"), "utf8"));
  psql(`
    insert into public.campaigns(chain_id,campaign_address,token_address,creator_address,created_block,is_active,updated_at)
      values(97,'${esc(bnbCampaign)}',null,'0x0000000000000000000000000000000000000001',${Math.max(1,bnbBondingFirst-500)},true,now()) on conflict do nothing;
    insert into public.campaigns(chain_id,campaign_address,token_address,creator_address,created_block,is_active,graduated_block,graduated_at_chain,market_stage,meta,updated_at)
      values(97,'${esc(bnbPostCampaign)}','${esc(bnbToken)}','0x0000000000000000000000000000000000000001',${Math.max(1,bnbGraduation-500)},false,${bnbGraduation},now(),'TOPAZ_ACTIVE','{}',now()) on conflict do nothing;
    insert into public.campaign_market_state(chain_id,campaign_address,token_address,market_stage,dex_pair_address,pool_verified,indexing_enabled)
      values(97,'${esc(bnbPostCampaign)}','${esc(bnbToken)}','TOPAZ_ACTIVE','${esc(bnbPool)}',true,true) on conflict do nothing;
    insert into public.dex_pools(chain_id,pair_address,campaign_address,token_address,wrapped_native_address,token0_address,token1_address,graduation_block,last_indexed_block)
      values(97,'${esc(bnbPool)}','${esc(bnbPostCampaign)}','${esc(bnbToken)}','${esc(bnbWrapped)}','${esc(bnbToken0)}','${esc(bnbToken1)}',${bnbGraduation},${Math.max(bnbGraduation,bnbPostFirst-1)}) on conflict do nothing;
    insert into public.campaigns(chain_id,campaign_address,token_address,creator_address,created_block,is_active,meta,updated_at)
      values(101,'${esc(solCampaign)}',null,'${esc(solCampaign)}',0,true,'{}',now()) on conflict do nothing;
    insert into public.campaigns(chain_id,campaign_address,token_address,creator_address,created_block,is_active,graduated_block,graduated_at_chain,market_stage,meta,updated_at)
      values(101,'${esc(solPostCampaign)}','${esc(solMint)}','${esc(solPostCampaign)}',0,false,${solGraduationSlot},now(),'TOPAZ_ACTIVE',jsonb_build_object('solanaGraduation',jsonb_build_object('dex','meteora-damm-v2','pool','${esc(solPool)}','slot','${solGraduationSlot}')),now()) on conflict do nothing;
  `);

  // Phase 1: each worker is a separate process and exits after ingesting the first real event.
  worker("bnb-bonding", { CERT_CAMPAIGN: bnbCampaign, CERT_FROM: String(bnbBondingFirst), CERT_TO: String(bnbBondingFirst) });
  fs.writeFileSync(bnbCutoffFile, String(bnbPostFirst));
  worker("bnb-postgrad");
  worker("solana-bonding", { CERT_CAMPAIGN: solCampaign, CERT_SIGNATURE: solBondingFirstSig });
  fs.writeFileSync(solCutoffFile, String(solPostFirst));
  worker("solana-postgrad");
  const phase1 = snapshot();

  // Worker is down here. Advance only the visible real-chain frontier, then restart.
  fs.writeFileSync(bnbCutoffFile, String(Math.max(bnbBondingMissed, bnbPostMissed)));
  fs.writeFileSync(solCutoffFile, String(solPostMissed));
  worker("bnb-bonding", { CERT_CAMPAIGN: bnbCampaign, CERT_FROM: String(bnbBondingMissed), CERT_TO: String(bnbBondingMissed) });
  worker("bnb-postgrad");
  worker("solana-bonding", { CERT_CAMPAIGN: solCampaign, CERT_SIGNATURE: solBondingMissedSig });
  worker("solana-postgrad");
  const phase2 = snapshot();

  // A second full restart/rerun must be inert.
  worker("bnb-bonding", { CERT_CAMPAIGN: bnbCampaign, CERT_FROM: String(bnbBondingMissed), CERT_TO: String(bnbBondingMissed) });
  worker("bnb-postgrad");
  worker("solana-bonding", { CERT_CAMPAIGN: solCampaign, CERT_SIGNATURE: solBondingMissedSig });
  worker("solana-postgrad");
  const phase3 = snapshot();

  const increasing = (a,b,k) => Number(b[k]) > Number(a[k]);
  const same = (a,b,k) => String(a[k]) === String(b[k]);
  const matrix = {
    bnbBondingRealEventIngest: Number(phase1.bnbBondingRows) > 0,
    bnbBondingMissedEventBackfill: increasing(phase1, phase2, 'bnbBondingRows'),
    bnbBondingSecondRestartInert: same(phase2, phase3, 'bnbBondingRows') && same(phase2, phase3, 'bnbBondingVolume'),
    bnbBondingCursorConverges: Number(phase2.bnbBondingCursor) >= bnbBondingMissed,
    bnbPostgradRealEventIngest: Number(phase1.bnbDexRows) > 0,
    bnbPostgradMissedEventBackfill: increasing(phase1, phase2, 'bnbDexRows'),
    bnbPostgradSecondRestartInert: same(phase2, phase3, 'bnbDexRows') && same(phase2, phase3, 'bnbDexVolume'),
    bnbPostgradCursorConverges: Number(phase2.bnbDexCursor) >= bnbPostMissed,
    solanaBondingRealEventIngest: Number(phase1.solBondingRows) > 0,
    solanaBondingMissedEventBackfill: increasing(phase1, phase2, 'solBondingRows'),
    solanaBondingSecondRestartInert: same(phase2, phase3, 'solBondingRows') && same(phase2, phase3, 'solBondingVolume'),
    solanaBondingSignatureCursorPersists: Number(phase2.solProcessed) >= 2,
    solanaPostgradRealEventIngest: Number(phase1.solMeteoraRows) > 0,
    solanaPostgradMissedEventBackfill: increasing(phase1, phase2, 'solMeteoraRows'),
    solanaPostgradSecondRestartInert: same(phase2, phase3, 'solMeteoraRows') && same(phase2, phase3, 'solMeteoraVolume'),
    solanaPostgradCursorConverges: Number(phase2.solMeteoraCursor) >= solPostMissed,
    noBnbIntoSolanaCursorOrRows: Number(phase3.cross97OnSolCampaign) === 0,
    noSolanaIntoBnbCursorOrRows: Number(phase3.cross101OnBnbCampaign) === 0,
  };
  const failed = Object.entries(matrix).filter(([,v]) => !v).map(([k]) => k);
  const report = { schemaVersion: 1, sourceSha, result: failed.length ? "FAIL" : "PASS", matrix, failed, phases: { phase1, phase2, phase3 }, rpcCredentialsLogged: false };
  fs.writeFileSync(path.join(reports, "agent5-indexer-restart-backfill.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ result: report.result, matrix, failed }, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  bnbProxy.kill('SIGTERM');
  solProxy.kill('SIGTERM');
  for (const p of [bnbCutoffFile, solCutoffFile]) { try { fs.unlinkSync(p); } catch {} }
}
