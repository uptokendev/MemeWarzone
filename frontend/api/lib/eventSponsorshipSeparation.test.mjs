import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../db/migrations/20260905_000002_event_sponsorship_authority.sql", import.meta.url);
const postgradUrl = new URL("../postgrad.js", import.meta.url);
const solanaRuntimeUrl = new URL("../arenaSponsorshipPublic.js", import.meta.url);
const evmRuntimeUrl = new URL("../arenaSponsorships.js", import.meta.url);

test("event sponsorship schema is additive and never mutates advertising sponsorship_applications", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists public\.event_sponsorship_applications/);
  assert.doesNotMatch(sql, /alter\s+table(?:\s+if\s+exists)?\s+public\.sponsorship_applications/i);
  assert.doesNotMatch(sql, /drop\s+table(?:\s+if\s+exists)?\s+public\.sponsorship_applications/i);
});

test("advertising routes remain independent and always-on", async () => {
  const source = await readFile(postgradUrl, "utf8");
  assert.match(source, /pattern: \/\^\\\/sponsored\$\//);
  assert.match(source, /pattern: \/\^\\\/sponsorship-applications\$\//);
  assert.match(source, /pattern: \/\^\\\/sponsorship-packages\$\//);
  assert.match(source, /pattern: \/\^\\\/sponsorship-settings\$\//);
  const alwaysOnCount = (source.match(/alwaysOn: true/g) || []).length;
  assert.ok(alwaysOnCount >= 4);
});

test("confirmed quote is unique so repeated confirmation cannot double-credit event prize", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /unique index if not exists sponsorship_payments_one_confirmed_quote_uidx/);
  assert.match(sql, /on public\.sponsorship_payments\(quote_id\)/);
  assert.match(sql, /where status = 'confirmed'/);
});

test("database enforces exact 70\/20\/10 conservation with integer-native remainder to prize", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /prize_native_raw \+ marketing_native_raw \+ protocol_native_raw = gross_native_raw/);
  assert.match(sql, /marketing_native_raw = floor\(\(gross_native_raw \* 2000\) \/ 10000\)/);
  assert.match(sql, /protocol_native_raw = floor\(\(gross_native_raw \* 1000\) \/ 10000\)/);
  assert.match(sql, /prize_native_raw = gross_native_raw - floor\(\(gross_native_raw \* 2000\) \/ 10000\) - floor\(\(gross_native_raw \* 1000\) \/ 10000\)/);
});

test("Solana recovery path returns an existing confirmed payment idempotently", async () => {
  const source = await readFile(solanaRuntimeUrl, "utf8");
  assert.match(source, /existing\?\.status === "confirmed"/);
  assert.match(source, /idempotent: true/);
  assert.match(source, /solana_payment_status='recovering'/);
  assert.match(source, /SPONSORSHIP_PAYMENT_UNVERIFIED/);
});

test("EVM confirmation verifies authoritative on-chain receipt before accounting", async () => {
  const source = await readFile(evmRuntimeUrl, "utf8");
  assert.match(source, /verifySponsorshipPayment/);
  assert.match(source, /SPONSORSHIP_PAYMENT_UNVERIFIED/);
  assert.match(source, /sponsorship_prize_native_raw = sponsorship_prize_native_raw \+ \$2/);
});
