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

test("stale running leases are aborted and released", () => {
  const leases = createCampaignLeaseRegistry();
  const lease = leases.begin("FSH")!;
  assert.equal(leases.expireStale(10_000, lease.startedAt + 1_000).length, 0);
  assert.equal(leases.get("FSH")?.runId, lease.runId);
  const expired = leases.expireStale(10_000, lease.startedAt + 10_001);
  assert.deepEqual(expired, ["FSH"]);
  assert.equal(lease.abort.signal.aborted, true);
  assert.equal(leases.get("FSH"), undefined);
  assert.ok(leases.begin("FSH"));
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
