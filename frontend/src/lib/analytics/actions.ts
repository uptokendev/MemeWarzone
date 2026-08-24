import { analytics } from "./client";

export function analyticsErrorCode(error: unknown): string {
  const anyError = error as { code?: string; shortMessage?: string; message?: string } | null;
  const text = String(anyError?.shortMessage || anyError?.message || anyError?.code || "error");
  if (/user rejected|rejected by user|denied transaction|denied request/i.test(text)) return "rejected";
  if (/insufficient/i.test(text)) return "insufficient";
  if (/cooldown|not eligible|live campaign limit/i.test(text)) return "not_eligible";
  return "error";
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
    analytics.track(options.fail, { ...properties, error_code: analyticsErrorCode(error) });
    throw error;
  }
}
