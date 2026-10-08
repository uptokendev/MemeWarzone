/** Widget build only (aliases "@/lib/analytics/actions"): no app analytics on other websites; run the work. */
export async function runCatalogAction<T>(input: { work: () => Promise<T> }): Promise<T> {
  return input.work();
}
