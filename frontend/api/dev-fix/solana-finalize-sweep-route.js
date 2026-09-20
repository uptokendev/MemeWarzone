/**
 * Operator endpoint for the finalize sweep.
 *
 * GET  -> report which launches are unfinalized, sending nothing.
 * POST -> finish them.
 *
 * Both are safe to call repeatedly: the program refuses a campaign whose
 * metadata already exists, and the sweep only selects campaigns whose mint
 * authority is still live on chain.
 */
import { badMethod, getQuery, json, readJson } from "../../server/http.js";
import { findUnfinalizedCampaigns, runFinalizeSweep } from "./solana-finalize-sweep.js";

function requireOperator(req) {
  const expected = String(process.env.SOLANA_FINALIZE_SWEEP_TOKEN || "").trim();
  if (!expected) return { ok: false, reason: "SOLANA_FINALIZE_SWEEP_TOKEN is not set" };
  const header = String(req.headers["x-sweep-token"] || "").trim();
  if (header !== expected) return { ok: false, reason: "bad or missing x-sweep-token" };
  return { ok: true };
}

export async function solanaFinalizeSweep(req, res) {
  const method = String(req.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") return badMethod(res);

  const auth = requireOperator(req);
  if (!auth.ok) return json(res, 401, { ok: false, error: auth.reason });

  try {
    if (method === "GET") {
      const q = getQuery(req);
      const lookbackHours = Number(q.lookbackHours) || undefined;
      const pending = await findUnfinalizedCampaigns({ lookbackHours });
      return json(res, 200, {
        ok: true,
        pendingCount: pending.length,
        pending: pending.map((p) => ({
          campaign: p.campaign_address,
          mint: p.token_address,
          name: p.name,
          createdAt: p.created_at,
        })),
      });
    }

    const body = await readJson(req).catch(() => ({}));
    const result = await runFinalizeSweep({
      lookbackHours: Number(body?.lookbackHours) || undefined,
      maxPerRun: Number(body?.maxPerRun) || undefined,
      dryRun: body?.dryRun === true,
    });
    return json(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error("[solana/finalize-sweep]", error?.stack || error?.message || error);
    return json(res, 500, { ok: false, error: String(error?.message || error) });
  }
}

export default solanaFinalizeSweep;
