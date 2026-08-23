import assert from "node:assert/strict";
import test from "node:test";
import { createCampaignLeaseRegistry } from "../solanaCampaignLease.js";

test("a running campaign cannot start a second lease", () => {
  const leases = createCampaignLeaseRegistry();
  const first = leases.begin("FSH");
  assert.ok(first);
  assert.equal(leases.begin("FSH"), null);
  assert.equal(leases.get("FSH")?.runId, first.runId);
});

test("an old run cannot clear a newer campaign lease", () => {
  const leases = createCampaignLeaseRegistry();
  const first = leases.begin("TRL")!;
  assert.equal(leases.release("TRL", first.runId, "timeout"), true);
  const second = leases.begin("TRL")!;
  assert.notEqual(second.runId, first.runId);
  assert.equal(leases.release("TRL", first.runId, "success"), false);
  assert.equal(leases.get("TRL")?.runId, second.runId);
  assert.equal(leases.release("TRL", second.runId, "success"), true);
  assert.equal(leases.get("TRL"), undefined);
});

test("public lease list exposes runId, age and state", () => {
  const leases = createCampaignLeaseRegistry();
  const lease = leases.begin("FSH")!;
  const listed = leases.list(lease.startedAt + 1_500);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].campaign, "FSH");
  assert.equal(listed[0].runId, lease.runId);
  assert.equal(listed[0].state, "running");
  assert.equal(listed[0].ageMs, 1_500);
});
