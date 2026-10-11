/**
 * Generation 8 timed launch from a draft: saves the launch time on the draft (POST /api/drafts/:id/deploy,
 * operation schedule_gen8, api/dev-fix/draftGen8Schedule.js). Nothing is created on chain; the creator launches the
 * coin at or after that time with the normal gen-8 create (MwzV4Launcher has no trading-open time).
 */
import { apiFetch } from "@/lib/apiBase";
import type { DraftActionAuth } from "@/lib/draftAuth";

export async function scheduleGen8DraftLaunch(input: { draftId: string; auth: DraftActionAuth; scheduledLaunchAt: number; graduationTargetWei: bigint }) {
  const res = await apiFetch(`/api/drafts/${encodeURIComponent(input.draftId)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "schedule_gen8",
      auth: input.auth,
      scheduledLaunchAt: input.scheduledLaunchAt,
      graduationTargetWei: input.graduationTargetWei.toString(),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((json as any)?.error || `Request failed (${res.status})`));
  return json as { ok: true; scheduledLaunchAt: string };
}
