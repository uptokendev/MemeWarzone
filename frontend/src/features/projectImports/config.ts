function readBoolean(value: unknown, fallback = false): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export const projectImportsEnabled = readBoolean(
  import.meta.env.VITE_ENABLE_PROJECT_IMPORTS,
  false,
);
