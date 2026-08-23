export type CampaignLeaseState = "running" | "success" | "failed" | "timeout";

export type CampaignLease = {
  campaign: string;
  runId: string;
  startedAt: number;
  abort: AbortController;
  status: CampaignLeaseState;
};

export type CampaignLeasePublic = {
  campaign: string;
  runId: string;
  startedAt: string;
  ageMs: number;
  state: CampaignLeaseState;
};

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createCampaignLeaseRegistry() {
  const leases = new Map<string, CampaignLease>();

  function begin(campaign: string): CampaignLease | null {
    const existing = leases.get(campaign);
    if (existing?.status === "running") return null;
    const lease: CampaignLease = {
      campaign,
      runId: newRunId(),
      startedAt: Date.now(),
      abort: new AbortController(),
      status: "running",
    };
    leases.set(campaign, lease);
    return lease;
  }

  function release(campaign: string, runId: string, status: CampaignLeaseState): boolean {
    const current = leases.get(campaign);
    if (!current || current.runId !== runId) return false;
    current.status = status;
    leases.delete(campaign);
    return true;
  }

  function get(campaign: string): CampaignLease | undefined {
    return leases.get(campaign);
  }

  function list(nowMs = Date.now()): CampaignLeasePublic[] {
    return [...leases.values()].map((lease) => ({
      campaign: lease.campaign,
      runId: lease.runId,
      startedAt: new Date(lease.startedAt).toISOString(),
      ageMs: Math.max(0, nowMs - lease.startedAt),
      state: lease.status,
    }));
  }

  return { begin, release, get, list };
}
