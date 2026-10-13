/**
 * Generation 8 timed launch from a draft (API leftover). The app no longer calls this: a scheduled gen-8 launch
 * creates the pool immediately with LaunchRequest.openAt set to the chosen time (PushDraftLive deployGen8). The
 * schedule_gen8 API is left in place so gen-6/7 and DBC scheduling stay untouched.
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
