// Auto-import (founder, 2026-10-09): a coin that earned creator fees through the swap widget but has no
// MemeWarzone page is imported by MemeWarzone itself, through the same pipeline as a user import
// (projectImports.js systemImportProject: lookup, safety scan, still-bonding refusal, admission scan).
// The creator then finds the coin with "Creator earned X - Claim it" and can claim. Up to `max` coins
// per run; a coin that was refused (still bonding, blocked by the scan) is retried at most every 6 h.
// Runs after the fee scan (financeImportSwapFees.js). On when the 1% split is on; IMPORT_AUTO_IMPORT=false
// turns it off.

const RETRY_HOURS = 6;
const OUTAGE_CODES = new Set(["PROJECT_IMPORT_RESOLVER_UNAVAILABLE", "PROJECT_IMPORT_RPC_UNAVAILABLE", "PROJECT_IMPORT_CHAIN_MISMATCH", "PROJECT_IMPORT_DB_UNAVAILABLE"]);

export function autoImportEnabled(env = process.env) {
  if (/^(0|false|no|off)$/i.test(String(env.IMPORT_AUTO_IMPORT || "").trim())) return false;
  return Boolean(String(env.SOLANA_IMPORT_FEE_COLLECTOR || "").trim());
}

/** The wallet recorded as importer: ours (the collector on Solana, the fee vault on EVM). */
export function systemImporter(chainId, env = process.env) {
  if (Number(chainId) === 101) return String(env.SOLANA_IMPORT_FEE_COLLECTOR || "").trim() || null;
  const vault = String(env[`IMPORT_FEE_VAULT_${chainId}`] || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(vault) ? vault : null;
}

export async function coinsToAutoImport(db, chainId, max) {
  const { rows } = await db.query(
    `select distinct c.token_address
       from public.import_creator_fees c
      where c.chain_id = $1 and c.token_address is not null
        and c.payee_kind = 'import_owner' -- a MemeWarzone coin pays its creator directly; never imported
        and not exists (select 1 from public.arena_token_imports i where i.chain_id = c.chain_id and i.token_address = c.token_address)
        and not exists (select 1 from public.import_auto_imports a where a.chain_id = c.chain_id and a.token_address = c.token_address
                          and (a.outcome in ('imported', 'exists') or a.last_attempt_at > now() - make_interval(hours => $3::int)))
      limit $2`,
    [chainId, max, RETRY_HOURS],
  );
  return rows.map((row) => String(row.token_address));
}

async function record(db, chainId, token, outcome, error = null) {
  await db.query(
    `insert into public.import_auto_imports (chain_id, token_address, attempts, outcome, error, last_attempt_at)
     values ($1, $2, 1, $3, $4, now())
     on conflict (chain_id, token_address) do update set attempts = import_auto_imports.attempts + 1, outcome = excluded.outcome, error = excluded.error, last_attempt_at = now()`,
    [chainId, token, outcome, error ? String(error).slice(0, 500) : null],
  );
}

export async function autoImportMissing({ db, chainId, env = process.env, max = 5, importProject = null }) {
  if (!db || !autoImportEnabled(env)) return { chainId, skipped: "off" };
  const importer = systemImporter(chainId, env);
  if (!importer) return { chainId, skipped: "no importer wallet for this chain" };
  let tokens;
  try {
    tokens = await coinsToAutoImport(db, chainId, max);
  } catch (error) {
    if (error?.code === "42P01") return { chainId, skipped: "tables missing" };
    throw error;
  }
  if (!tokens.length) return { chainId, imported: 0 };
  const run = importProject || (await import("../projectImports.js")).systemImportProject;
  const out = { chainId, imported: 0, refused: 0, errors: 0 };
  for (const token of tokens) {
    try {
      const result = await run({ chainId, tokenAddress: token, importerWallet: importer });
      await record(db, chainId, token, result.created ? "imported" : "exists");
      if (result.created) out.imported += 1;
    } catch (error) {
      const code = String(error?.code || "");
      // The import's own refusals (still bonding, security scan, review needed, not a token) are "refused";
      // an outage (resolver / RPC down) or anything unexpected is "error". Both retry after 6 hours.
      const refused = code.startsWith("PROJECT_IMPORT_") && !OUTAGE_CODES.has(code) || code === "INVALID_TOKEN";
      await record(db, chainId, token, refused ? "refused" : "error", `${code} ${error?.message || error}`.trim());
      if (refused) out.refused += 1;
      else out.errors += 1;
    }
  }
  return out;
}
