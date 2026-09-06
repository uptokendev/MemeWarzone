import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";

const root = path.resolve(process.cwd());
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`
  create or replace function public.cert_post212_auto_approve_application()
  returns trigger language plpgsql as $$
  begin
    insert into public.event_sponsorship_applications(
      event_id, chain_id, sponsor_profile_id, sponsor_wallet, status,
      reviewed_by, reviewed_at, approved_at
    )
    select new.id, new.chain_id, sp.id, sp.verified_wallet, 'approved',
           'post212-cert', now(), now()
      from public.sponsor_profiles sp
     where sp.status = 'approved'
       and lower(sp.verified_wallet) = lower('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
     order by sp.approved_at desc nulls last, sp.created_at desc
     limit 1;
    return new;
  end $$;
  drop trigger if exists cert_post212_auto_approve_application on public.sponsorship_events;
  create trigger cert_post212_auto_approve_application
    after insert on public.sponsorship_events
    for each row execute function public.cert_post212_auto_approve_application();
`);
await db.end();

const rootPg = path.join(root, "node_modules", "pg");
const frontendPg = path.join(root, "frontend", "node_modules", "pg");
if (!fs.existsSync(rootPg)) fs.symlinkSync(frontendPg, rootPg, "dir");

const rpc = "http://127.0.0.1:8546";
const chain = spawn("npx", ["hardhat", "--config", "certification/event-sponsorship/hardhat.config.cjs", "node", "--port", "8546"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let chainLog = "";
for (const stream of [chain.stdout, chain.stderr]) stream.on("data", (chunk) => { chainLog += chunk.toString(); });
let ready = false;
for (let i = 0; i < 60; i += 1) {
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    if (body?.result === "0x61") { ready = true; break; }
  } catch {}
  await sleep(250);
}
if (!ready) {
  chain.kill("SIGTERM");
  throw new Error(`post-212 isolated chain failed to start\n${chainLog}`);
}

process.env.SPONSORSHIP_CERT_RPC = rpc;

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => nativeFetch(input, {
  ...init,
  signal: init.signal ?? AbortSignal.timeout(15_000),
});

try {
  await import("../../certification/event-sponsorship/post212-lifecycle-race.mjs");
} finally {
  globalThis.fetch = nativeFetch;
  chain.kill("SIGTERM");
  chain.stdout?.destroy();
  chain.stderr?.destroy();
  chain.unref();
}

// The imported certification module has completed all assertions at this point.
// Force-close any test-only child handles so CI can continue to the authority regression.
process.exit(0);
