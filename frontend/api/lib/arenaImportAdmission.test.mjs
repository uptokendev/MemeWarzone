import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyAdmissionScan, failedAdmissionScan } from "./arenaImportAdmission.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("a thrown scan becomes needs_review and never fails the import", () => {
  const scan = failedAdmissionScan(new Error("rpc down"));
  assert.equal(scan.status, "needs_review");
  assert.equal(scan.scan.ok, false);
  assert.ok(scan.scan.reasons.includes("scan_failed"));
});

test("applyAdmissionScan writes status and scan payload without overwriting filled profile fields", async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ id: params[0], status: params[1] }] };
  };
  const next = await applyAdmissionScan(
    query,
    { id: "11111111-1111-1111-1111-111111111111", name: "Kept" },
    { status: "passed", name: "Scanned", symbol: "SCN", scan: { ok: true }, scanVersion: "v", scannedAt: "2026-09-24T00:00:00.000Z" },
    { imageUrl: "https://img", description: "d" },
  );
  assert.equal(next.status, "passed");
  assert.match(calls[0].sql, /scan_json/);
  assert.equal(calls[0].params[1], "passed");
  assert.equal(calls[0].params[5], "Scanned");
});

test("project import create and arena imports share the admission helper; public POST create is gone", () => {
  const admission = fs.readFileSync(path.join(here, "arenaImportAdmission.js"), "utf8");
  const project = fs.readFileSync(path.join(here, "../projectImports.js"), "utf8");
  const arena = fs.readFileSync(path.join(here, "../arenaImports.js"), "utf8");
  assert.match(admission, /export async function scanImportedToken/);
  assert.match(project, /runAdmissionScanForProject/);
  assert.doesNotMatch(arena, /if \(method === "POST" && path === "\/arena\/imports"\) return handleCreate/);
  assert.doesNotMatch(arena, /async function handleCreate/);
});
