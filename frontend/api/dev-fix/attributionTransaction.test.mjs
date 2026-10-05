import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const src = fs.readFileSync(new URL("./attribution.js", import.meta.url), "utf8");

test("wallet-connect link writes run in one transaction on one connection", () => {
  assert.doesNotMatch(src, /pool\.query\(\s*["'`](BEGIN|COMMIT|ROLLBACK)/i, "no transaction control on the pool");
  const begin = src.indexOf('await client.query("BEGIN")');
  const commit = src.indexOf('await client.query("COMMIT")');
  assert.ok(src.includes("const client = await pool.connect();"), "takes a dedicated connection");
  assert.ok(begin > 0 && commit > begin, "BEGIN then COMMIT on that connection");
  const body = src.slice(begin, commit);
  for (const table of ["wallet_recruiter_links", "wallet_squad_memberships", "wallet_referral_attribution_windows"]) {
    assert.match(body, new RegExp(`client\\.query\\([\\s\\S]*?${table}`), `${table} write uses the transaction connection`);
  }
  assert.doesNotMatch(body, /pool\.query\(/, "no write escapes to another connection inside the transaction");
  const tail = src.slice(commit, commit + 400);
  assert.match(tail, /catch \(error\) \{\s*await client\.query\("ROLLBACK"\)/, "rolls back on the same connection");
  assert.match(tail, /finally \{\s*client\.release\(\);/, "always releases the connection");
});
