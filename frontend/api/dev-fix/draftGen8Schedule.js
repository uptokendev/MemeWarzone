/**
 * Scheduled launch of a generation 8 draft (founder 2026-10-12: drafts and timed arms launch on the gen-8 launcher for
 * native coins). MwzV4Launcher has no trading-open time: the pool trades from the launch block (the hook stamps
 * launchTime = block.timestamp and the 60 s launch fee starts there). So a gen-8 timed arm cannot be "deploy now, open
 * later" as on gen-7. It works as Solana DBC scheduling already does (api/dbc/create.js handleSchedule): the draft
 * stores the launch time, nothing is created on chain, and the creator launches with the normal gen-8 create at or after
 * that time (the create authorization binds the creator as msg.sender, so nobody else can send it for them).
 *
 * POST /api/drafts/:id/deploy { operation: "schedule_gen8", auth (deploy_draft), scheduledLaunchAt, graduationTargetWei? }
 * from draftDeploy after the owner's deploy_draft signature is verified. Only where the chain has a gen-8 launcher.
 */
import { assertScheduleWindow, parseUnixSeconds } from "../../shared/dbcSchedule.mjs";
import { GEN8_TARGET_DEFAULT_USD, isGen8TargetAllowed } from "../../shared/evmGen8.mjs";
import { gen8ConfigFor } from "../lib/evmGen8Config.js";

export class Gen8ScheduleError extends Error {
  constructor(status, code, message) {
    super(message);
    this.httpStatus = status;
    this.code = code;
  }
}

/**
 * Validates and stores the launch time. `row` is the campaign_drafts row draftDeploy loaded. Returns the updated
 * draft row. deps: { db, env, nowSec, notify(row, at) }.
 */
export async function scheduleGen8Draft({ body, row, db, env = process.env, nowSec = Math.floor(Date.now() / 1000), notify = null }) {
  const chainId = Number(row.chain_id);
  if (!gen8ConfigFor(chainId, env)) throw new Gen8ScheduleError(400, "GEN8_NOT_CONFIGURED", "Generation 8 launches are not configured on this chain.");
  if (String(row.campaign_address || "").trim()) throw new Gen8ScheduleError(409, "DRAFT_ALREADY_DEPLOYED", "This draft is already live.");
  if (!["promotion_published", "ready_to_launch", "scheduled"].includes(String(row.status || ""))) {
    throw new Gen8ScheduleError(409, "DRAFT_NOT_READY", "Publish the promotion page before setting a launch time.");
  }
  let at;
  try {
    at = assertScheduleWindow(parseUnixSeconds(body?.scheduledLaunchAt), nowSec);
  } catch (error) {
    throw new Gen8ScheduleError(400, error.code === "DBC_SCHEDULE_TOO_FAR" ? "SCHEDULE_TOO_FAR" : "SCHEDULE_TOO_SOON", error.message);
  }
  let target = null;
  if (body?.graduationTargetWei != null && body.graduationTargetWei !== "") {
    let t;
    try {
      t = BigInt(String(body.graduationTargetWei));
    } catch {
      t = -1n;
    }
    if (t === 0n) t = GEN8_TARGET_DEFAULT_USD;
    if (!isGen8TargetAllowed(chainId, t)) throw new Gen8ScheduleError(400, "GEN8_TARGET_UNSUPPORTED", "Generation 8 coins graduate at a $30,000 or $50,000 market cap.");
    target = t.toString();
  }
  const atIso = new Date(at * 1000).toISOString();
  const updated = await db.query(
    `update public.campaign_drafts
        set status = 'scheduled',
            scheduled_launch_at = $2::timestamptz,
            graduation_target_wei = coalesce($3::numeric, graduation_target_wei),
            updated_at = now()
      where id::text = $1 and campaign_address is null
      returning *`,
    [String(row.id), atIso, target],
  );
  if (!updated.rows.length) throw new Gen8ScheduleError(409, "DRAFT_ALREADY_DEPLOYED", "This draft is already live.");
  if (notify) {
    try {
      await notify(updated.rows[0], atIso);
    } catch {
      // notifications are best-effort
    }
  }
  return { draft: updated.rows[0], scheduledLaunchAt: atIso };
}
