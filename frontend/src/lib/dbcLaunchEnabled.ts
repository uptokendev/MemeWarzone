const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isDbcLaunchEnabled(): boolean {
  return TRUE_VALUES.has(String(import.meta.env.VITE_DBC_LAUNCH_ENABLED || "").trim().toLowerCase());
}
