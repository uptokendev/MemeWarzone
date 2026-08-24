import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("admin sponsorship API requires admin/ops and does not grant anon writes", () => {
  const admin = fs.readFileSync(path.join(root, "api/admin/sponsorship.js"), "utf8");
  const apps = fs.readFileSync(path.join(root, "api/sponsorship-applications.js"), "utf8");
  const settings = fs.readFileSync(path.join(root, "api/sponsorship-settings.js"), "utf8");
  assert.match(admin, /requireAdminOrOps/);
  assert.match(admin, /resource === "packages"/);
  assert.match(admin, /patchPlacement/);
  assert.match(apps, /requireAdminOrOps/);
  assert.match(apps, /"submitted"/);
  assert.doesNotMatch(settings, /grant select, insert, update on table public.sponsorship_settings to anon/);
});
