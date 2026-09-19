/**
 * Solana counterpart to graduationReconciler.
 *
 * BNB and Robinhood have had a keeper closing the gap between "the curve hit its
 * target" and "the token trades on a DEX" since launch. Solana had none: a
 * campaign reached curve_closed and stopped, with nothing scheduled to carry it
 * further and no error to notice. The handoff route spawns
 * SOLANA_GRADUATION_HANDOFF_COMMAND, which until now pointed at nothing.
 *
 * This scans for campaigns the chain says are eligible and runs the operator for
 * each. It deliberately re-reads the campaign account rather than trusting the
 * database: the indexer can lag, and graduating on stale state would be worse
 * than graduating late.
 */
import { spawn } from "node:child_process";

import { ENV } from "./env.js";
import { pool } from "./db.js";

const SOLANA_CHAIN_ID = 101;
const LOOP_SYMBOL = Symbol.for("memewarzone.solanaGraduationReconcilerStarted");
const globalState = globalThis as Record<symbol, unknown>;

/**
 * Campaign accounts must be exactly this size to be read.
 *
 * Earlier program versions wrote a shorter record: devnet still holds 718-byte
 * campaigns alongside current 720-byte ones. Reading fields relative to the end
 * of the buffer silently misreads those, and the current program rejects them
 * anyway (CAMPAIGN_ACCOUNT_BYTES in campaign_view.rs). Skipping them by size is
 * both safer and honest about what this keeper can act on.
 */
const CAMPAIGN_ACCOUNT_BYTES = 720;
const GRADUATED_OFFSET_FROM_END = 7;
const CURVE_CLOSED_OFFSET_FROM_END = 6;

const attemptedAt = new Map<string, number>();

function cooldownMs(): number {
  return Math.max(60_000, Number(ENV.SOLANA_GRADUATION_RETRY_COOLDOWN_MS || 300_000));
}

function inCooldown(campaign: string): boolean {
  const last = attemptedAt.get(campaign);
  if (!last) return false;
  if (Date.now() - last < cooldownMs()) return true;
  attemptedAt.delete(campaign);
  return false;
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const url = ENV.SOLANA_RPC_HTTP;
  if (!url) throw new Error("SOLANA_RPC_HTTP is not configured");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body?.result;
}

/**
 * Ask the chain, not the database, whether this campaign may graduate.
 *
 * curve_closed is the sticky eligibility lock set by the threshold-crossing buy.
 * graduated is only true once liquidity is actually in a pool.
 */
async function readEligibility(campaign: string): Promise<{ eligible: boolean; reason: string }> {
  const info = await rpc("getAccountInfo", [campaign, { encoding: "base64", commitment: "confirmed" }]);
  const encoded = info?.value?.data?.[0];
  if (!encoded) return { eligible: false, reason: "campaign account not found" };
  const data = Buffer.from(String(encoded), "base64");
  if (data.length !== CAMPAIGN_ACCOUNT_BYTES) {
    return {
      eligible: false,
      reason: `campaign account is ${data.length} bytes, not the current ${CAMPAIGN_ACCOUNT_BYTES}`,
    };
  }
  const graduated = data[data.length - GRADUATED_OFFSET_FROM_END] === 1;
  const curveClosed = data[data.length - CURVE_CLOSED_OFFSET_FROM_END] === 1;
  if (graduated) return { eligible: false, reason: "already graduated" };
  if (!curveClosed) return { eligible: false, reason: "curve still open" };
  return { eligible: true, reason: "curve closed and not graduated" };
}

function runOperator(campaign: string): Promise<{ ok: boolean; detail: string }> {
  const command = String(ENV.SOLANA_GRADUATION_HANDOFF_COMMAND || "").trim();
  if (!command) return Promise.resolve({ ok: false, detail: "SOLANA_GRADUATION_HANDOFF_COMMAND is not configured" });

  const parts = command.split(" ").map((part) => part.trim()).filter(Boolean);
  return new Promise((resolve) => {
    const child = spawn(parts[0], [...parts.slice(1), campaign], {
      env: { ...process.env, SOLANA_GRADUATION_SEND: "true", SOLANA_GRADUATION_CAMPAIGN: campaign },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.stderr?.on("data", (chunk) => { err += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, detail: String(error?.message || error) }));
    child.on("close", (code) => {
      const detail = (err || out).split("\n").filter(Boolean).slice(-3).join(" | ");
      resolve({ ok: code === 0, detail: detail || `exit ${code}` });
    });
  });
}

export async function runSolanaGraduationReconcilerOnce() {
  if (!ENV.ENABLE_SOLANA_GRADUATION_RECONCILER) {
    return { enabled: false, scanned: 0, graduated: 0, skipped: 0, errors: 0 };
  }

  let scanned = 0;
  let graduated = 0;
  let skipped = 0;
  let errors = 0;

  // The database narrows the candidates; the chain decides. A campaign the
  // indexer has not caught up on yet simply waits for the next pass.
  const candidates = await pool.query(
    `select campaign_address
       from public.campaigns
      where chain_id=$1
        and is_active=true
        and graduated_at_chain is null
        and campaign_address is not null
      order by updated_at desc nulls last
      limit 25`,
    [SOLANA_CHAIN_ID],
  );

  for (const row of candidates.rows as Array<{ campaign_address?: string }>) {
    const campaign = String(row.campaign_address || "").trim();
    if (!campaign) continue;
    if (inCooldown(campaign)) { skipped += 1; continue; }
    scanned += 1;
    try {
      const eligibility = await readEligibility(campaign);
      if (!eligibility.eligible) { skipped += 1; continue; }

      attemptedAt.set(campaign, Date.now());
      const result = await runOperator(campaign);
      if (result.ok) {
        graduated += 1;
        console.log(`[solana-graduation] graduated ${campaign}: ${result.detail}`);
      } else {
        errors += 1;
        console.error(`[solana-graduation] ${campaign} failed: ${result.detail}`);
      }
    } catch (error: any) {
      errors += 1;
      console.error(`[solana-graduation] ${campaign} errored: ${error?.message || String(error)}`);
    }
  }

  return { enabled: true, scanned, graduated, skipped, errors };
}

export function startSolanaGraduationReconcilerLoop() {
  if (!ENV.ENABLE_SOLANA_GRADUATION_RECONCILER || globalState[LOOP_SYMBOL]) return;
  globalState[LOOP_SYMBOL] = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runSolanaGraduationReconcilerOnce();
      if (result.graduated || result.errors) {
        console.log("[solana-graduation] pass", result);
      }
    } catch (error: any) {
      console.error("[solana-graduation] loop failed", error?.message || String(error));
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void tick(), 5_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), Math.max(15_000, Number(ENV.SOLANA_GRADUATION_INTERVAL_MS || 60_000)));
  timer.unref?.();
}
