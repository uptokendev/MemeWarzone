export const PUBLIC_SPONSOR_EVENT_TYPES = Object.freeze([
  "normal_tournament",
  "vote_tournament",
  "monthly_mwl",
  "quarterly_championship",
]);

export function canonicalPublicSponsorEventType(value) {
  const type = String(value || "").trim();
  return type === "mwl_quarter_finals" ? "quarterly_championship" : type;
}

export function publicSponsorRegistryTypes(value) {
  const type = canonicalPublicSponsorEventType(value);
  return type === "quarterly_championship"
    ? ["quarterly_championship", "mwl_quarter_finals"]
    : [type];
}

export function safeHttpsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function projectPublicSponsors(rows = []) {
  const seen = new Set();
  const sponsors = [];
  for (const row of rows) {
    if (String(row?.sponsorship_status || "") !== "active") continue;
    if (String(row?.profile_status || "") !== "approved") continue;
    const sponsorProfileId = String(row?.sponsor_profile_id || "").trim();
    const projectName = String(row?.project_name || "").trim();
    if (!sponsorProfileId || !projectName || seen.has(sponsorProfileId)) continue;
    seen.add(sponsorProfileId);
    sponsors.push({
      sponsorProfileId,
      projectName,
      foundingSponsor: Boolean(row.event_founding_sponsor || row.founding_sponsor),
    });
  }
  return sponsors;
}
