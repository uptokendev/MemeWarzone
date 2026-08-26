export type RuntimeEnvironment = "local" | "staging" | "production";

const VALID_ENVIRONMENTS = new Set<RuntimeEnvironment>(["local", "staging", "production"]);

export function parseRuntimeEnvironment(value: unknown): RuntimeEnvironment {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (VALID_ENVIRONMENTS.has(normalized as RuntimeEnvironment)) {
    return normalized as RuntimeEnvironment;
  }
  throw new Error(`Invalid MemeWarzone runtime environment: ${normalized || "<empty>"}`);
}

export function getRuntimeEnvironment(): RuntimeEnvironment {
  const configured = import.meta.env.VITE_RUNTIME_ENVIRONMENT as string | undefined;

  // Production must be explicit. This avoids silently treating a production bundle
  // as staging/local merely because an env var is missing.
  if (import.meta.env.PROD && !configured) {
    throw new Error("VITE_RUNTIME_ENVIRONMENT must be set for production builds");
  }

  return configured ? parseRuntimeEnvironment(configured) : "local";
}

export function isProductionEnvironment(environment = getRuntimeEnvironment()): boolean {
  return environment === "production";
}

export function isStagingEnvironment(environment = getRuntimeEnvironment()): boolean {
  return environment === "staging";
}

export function assertEnvironmentMatch(
  runtimeEnvironment: RuntimeEnvironment,
  resourceEnvironment: RuntimeEnvironment,
  label: string,
): void {
  if (runtimeEnvironment !== resourceEnvironment) {
    throw new Error(
      `${label} environment mismatch: runtime=${runtimeEnvironment}, resource=${resourceEnvironment}`,
    );
  }
}
