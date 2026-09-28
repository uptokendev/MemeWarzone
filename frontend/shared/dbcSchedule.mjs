/** D18: scheduled DBC launch is a draft timer. Same 5 min / 30 day window as today. */

export const DBC_MIN_SCHEDULE_SECONDS = 5 * 60;
export const DBC_MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
export const DBC_DUE_POPUP_COPY = "Your launch time has arrived. Deploy now to go live.";

export function parseUnixSeconds(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && String(value).trim() !== "") {
    return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function assertScheduleWindow(launchAtSeconds, nowSeconds) {
  const at = Number(launchAtSeconds);
  const now = Number(nowSeconds);
  if (!Number.isInteger(at) || at < now + DBC_MIN_SCHEDULE_SECONDS) {
    const err = new Error("Choose a launch time at least five minutes in the future.");
    err.code = "DBC_SCHEDULE_TOO_SOON";
    err.httpStatus = 400;
    throw err;
  }
  if (at > now + DBC_MAX_SCHEDULE_SECONDS) {
    const err = new Error("Scheduled launches cannot be more than 30 days away.");
    err.code = "DBC_SCHEDULE_TOO_FAR";
    err.httpStatus = 400;
    throw err;
  }
  return at;
}

export function isScheduleLocked(scheduledLaunchAt, nowMs = Date.now()) {
  const at = parseUnixSeconds(scheduledLaunchAt);
  if (!at) return false;
  return Math.floor(Number(nowMs) / 1000) < at;
}

export function isDueScheduledDraft(row, nowMs = Date.now()) {
  if (!row) return false;
  if (String(row.launchType || row.launch_type || "") !== "dbc") return false;
  const status = String(row.status || "");
  if (status === "deployed" || status === "archived") return false;
  if (row.campaignAddress || row.campaign_address) return false;
  const at = parseUnixSeconds(row.scheduledLaunchAt ?? row.scheduled_launch_at);
  if (!at) return false;
  return Math.floor(Number(nowMs) / 1000) >= at;
}

export function shouldShowDbcDuePopup({ draftId, dismissedIds }) {
  const id = String(draftId || "").trim();
  if (!id) return false;
  const dismissed = dismissedIds instanceof Set ? dismissedIds : new Set(dismissedIds || []);
  return !dismissed.has(id);
}
