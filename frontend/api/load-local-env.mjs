import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "..");

const DATABASE_URL_ALIASES = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SUPABASE_DB_URL",
  "SUPABASE_DATABASE_URL",
  "PG_CONNECTION_STRING",
];

const SUPABASE_URL_ALIASES = [
  "SUPABASE_URL",
  "SUPABASE_PROJECT_URL",
  "VITE_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
];

const SUPABASE_SERVICE_ROLE_KEY_ALIASES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SECRET_KEY",
];

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function truthy(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === "#" && !quote && /\s/.test(value[i - 1] || " ")) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function unquote(value) {
  const trimmed = stripInlineComment(value);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n");
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, value] = match;
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = unquote(value);
    }
  }

  return true;
}

function firstNonEmptyEnv(keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return { key, value };
  }
  return null;
}

function aliasEnv(targetKey, aliases) {
  if (String(process.env[targetKey] || "").trim()) return;
  const found = firstNonEmptyEnv(aliases);
  if (!found) return;
  process.env[targetKey] = found.value;
  if (found.key !== targetKey) {
    console.log(`[api/load-local-env] using ${found.key} as ${targetKey}`);
  }
}

function autoConfigureLocalPgSsl() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) return;

  const hasExplicitSslSetting =
    String(process.env.PG_DISABLE_SSL || "").trim() ||
    String(process.env.PG_SSL_ALLOW_SELF_SIGNED || "").trim() ||
    String(process.env.PG_CA_CERT || "").trim() ||
    String(process.env.PG_CA_CERT_B64 || "").trim();

  if (hasExplicitSslSetting) return;

  let host = "";
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return;
  }

  if (host.endsWith(".pooler.supabase.com") || host.includes("supabase.com")) {
    process.env.PG_SSL_ALLOW_SELF_SIGNED = "1";
    console.log("[api/load-local-env] enabled PG_SSL_ALLOW_SELF_SIGNED=1 for local Supabase pooler dev");
  }
}

function disableRemoteSupabaseForIsolatedLocalRuntime() {
  const runtime = String(process.env.RUNTIME_ENVIRONMENT || process.env.VITE_RUNTIME_ENVIRONMENT || "").trim().toLowerCase();
  if (runtime !== "local" || !truthy(process.env.LOCAL_DISABLE_REMOTE_SUPABASE)) return;

  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_PROJECT_URL",
    "VITE_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_SECRET_KEY",
  ]) {
    delete process.env[key];
  }
  console.log("[api/load-local-env] remote Supabase disabled for isolated local runtime");
}

const loaded = [
  path.join(frontendDir, ".env.local"),
  path.join(frontendDir, ".env"),
]
  .filter(loadEnvFile)
  .map((filePath) => path.basename(filePath));

if (loaded.length) {
  console.log(`[api/load-local-env] loaded ${loaded.join(", ")}`);
}

aliasEnv("DATABASE_URL", DATABASE_URL_ALIASES);
aliasEnv("SUPABASE_URL", SUPABASE_URL_ALIASES);
aliasEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY_ALIASES);
disableRemoteSupabaseForIsolatedLocalRuntime();
autoConfigureLocalPgSsl();

if (!String(process.env.DATABASE_URL || "").trim()) {
  const presentAliases = DATABASE_URL_ALIASES.filter((key) => process.env[key] != null);
  console.warn(
    `[api/load-local-env] DATABASE_URL is missing or empty. Add DATABASE_URL to frontend/.env.local. ` +
      `Checked aliases: ${DATABASE_URL_ALIASES.join(", ")}. ` +
      `Present aliases: ${presentAliases.length ? presentAliases.join(", ") : "none"}.`
  );
}

if (String(process.env.API_DEBUG_ENV || "").trim() === "1") {
  const hasSupabaseUrl = Boolean(String(process.env.SUPABASE_URL || "").trim());
  const hasSupabaseServiceRoleKey = Boolean(String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim());
  console.log(
    `[api/load-local-env] optional upload env: ` +
      `SUPABASE_URL=${hasSupabaseUrl ? "set" : "missing"}, ` +
      `SUPABASE_SERVICE_ROLE_KEY=${hasSupabaseServiceRoleKey ? "set" : "missing"}`
  );
}
