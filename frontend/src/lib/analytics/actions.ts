import { analytics } from "./client";

export function analyticsErrorCode(error: unknown): string {
  const anyError = error as { code?: string; shortMessage?: string; message?: string; reason?: string } | null;
  const text = String(anyError?.shortMessage || anyError?.reason || anyError?.message || anyError?.code || "error");
  if (/user rejected|rejected by user|denied transaction|denied request/i.test(text)) return "rejected";
  if (/insufficient/i.test(text)) return "insufficient";
  if (/cooldown|not eligible|live campaign limit/i.test(text)) return "not_eligible";
  if (/ConstraintSeeds|PDA does not match|program seeds/i.test(text)) return "constraint_seeds";
  if (/InvalidCreateAuthorization|route digest mismatch|Ed25519/i.test(text)) return "invalid_create_authorization";
  if (/CreateAuthorizationExpired|authorization deadline expired/i.test(text)) return "authorization_expired";
  if (/InvalidCampaign|partial prior create|mint PDA already exists/i.test(text)) return "invalid_campaign";
  if (/GraduationTargetNotAllowed|graduation target is not allowed/i.test(text)) return "graduation_target_not_allowed";
  if (/CreatePaused|LaunchpadPaused|creation is paused/i.test(text)) return "creation_paused";
  if (/CampaignGenerationInactive|generation is not active/i.test(text)) return "generation_inactive";
  if (/AccountOwnedByWrongProgram|owned by the wrong program/i.test(text)) return "wrong_account_owner";
  if (/AccountDiscriminatorMismatch/i.test(text)) return "account_layout_mismatch";
  if (/Access violation|stack frame|Program failed to complete|BPF execution/i.test(text)) return "program_execution_failure";
  if (/Simulation failed|simulation/i.test(text)) return "simulation_failed";
  if (/blockhash|expired before confirmation/i.test(text)) return "blockhash_expired";
  if (/429|rate limit|too many requests/i.test(text)) return "rpc_rate_limited";
  if (/rpc|endpoint|network request|fetch failed|503|502|504/i.test(text)) return "rpc_or_network";
  return "error";
}

export function analyticsErrorMessage(error: unknown): string {
  const anyError = error as { shortMessage?: string; reason?: string; message?: string; code?: string } | null;
  const text = String(anyError?.shortMessage || anyError?.reason || anyError?.message || anyError?.code || "Unknown error")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 240);
}

export async function runCatalogAction<T>(options: {
  fn: string;
  start: string;
  success: string;
  fail: string;
  properties?: Record<string, unknown>;
  work: () => Promise<T>;
}): Promise<T> {
  const properties = options.properties || {};
  analytics.track(options.start, properties);
  try {
    const result = await analytics.measure(options.fn, properties, options.work);
    analytics.track(options.success, properties);
    return result;
  } catch (error) {
    analytics.track(options.fail, {
      ...properties,
      error_code: analyticsErrorCode(error),
      error_message: analyticsErrorMessage(error),
    });
    throw error;
  }
}
