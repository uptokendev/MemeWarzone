function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function falsy(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? "").trim());
}

function arenaViteEnabled(env = process.env) {
  return truthy(env.VITE_ENABLE_POSTGRAD) && truthy(env.VITE_ENABLE_POSTGRAD_ARENA);
}

export function isPostgradApiFlagEnabled(name, env = process.env) {
  const raw = env[name];
  if (falsy(raw)) return false;
  if (truthy(raw)) return true;
  if (truthy(env.POSTGRAD_API_ENABLED)) return true;
  // Coolify staging often copies the Vite Arena flags onto the API service.
  return arenaViteEnabled(env);
}
