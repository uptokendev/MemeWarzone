import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 2026-09-25: withFeeEscrowTransaction replaced client.query on a pooled client and released it still
 * patched. pg-pool's pool.query calls client.query(text, values, callback); the patch dropped the
 * callback, so the next pool.query on that client never resolved and never released it. One leaked
 * client per Solana trade: the trade loop froze and the pool starved to 20/20 until restart.
 * Any file that assigns client.query must remove the patch before the client is released.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "tests" ? [] : sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

test("no pooled client is released with a patched query method", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/\bclient\.query\s*=/.test(text)) continue;
    const patches = text.match(/\bclient\.query\s*=/g)?.length ?? 0;
    const restores = text.match(/delete \(client as any\)\.query;\s*\n\s*client\.release\(/g)?.length ?? 0;
    if (restores < patches) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, []);
});

test("the pool fails a silent query instead of holding its client forever", () => {
  const db = readFileSync(path.join(SRC, "db.ts"), "utf8");
  assert.match(db, /query_timeout:\s*PG_QUERY_TIMEOUT_MS/);
  assert.match(db, /keepAlive:\s*true/);
});
