import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";

const CHECKS = [
  ["battles", "Arena battles", "arena_battles"],
  ["imports", "Token imports", "arena_token_imports"],
  ["tournaments", "Tournaments", "arena_tournaments"],
  ["tournamentInvites", "Tournament invites", "arena_tournament_invites"],
  ["tournamentEntries", "Tournament entries", "arena_tournament_entries"],
  ["leagueSeasons", "League seasons", "arena_league_seasons"],
  ["leagueEntries", "League entries", "arena_league_entries"],
  ["arenaVotes", "Arena votes", "arena_votes"],
  ["arenaVoteAggregates", "Arena vote aggregates", "arena_vote_aggregates"],
  ["supportEntries", "Support donations", "arena_support_entries"],
  ["notificationEmails", "Wallet notification emails", "wallet_notification_emails"],
  ["sponsorshipApplications", "Sponsorship applications", "sponsorship_applications"],
  ["sponsoredPlacements", "Sponsored placements", "sponsored_placements"],
];

async function checkTable([key, label, table]) {
  try {
    const result = await pool.query(`select count(*)::int as count from public.${table}`);
    return { key, label, table, ok: true, count: Number(result.rows?.[0]?.count || 0) };
  } catch (error) {
    return { key, label, table, ok: false, count: 0, error: String(error?.message || error || "Unknown database error") };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  const startedAt = Date.now();
  let databaseOk = false;
  let databaseError = null;

  try {
    await pool.query("select 1");
    databaseOk = true;
  } catch (error) {
    databaseError = String(error?.message || error || "Database unavailable");
  }

  const checks = await Promise.all(CHECKS.map(checkTable));
  const missingTables = checks.filter((check) => !check.ok).map((check) => check.table);
  const emailConfigured = Boolean(String(process.env.RESEND_API_KEY || process.env.NOTIFY_RESEND_API_KEY || "").trim());

  return json(res, 200, {
    ok: databaseOk && missingTables.length === 0,
    databaseOk,
    databaseError,
    checks,
    missingTables,
    importedTables: checks.filter((check) => check.ok).map((check) => check.table),
    email: { configured: emailConfigured },
    durationMs: Date.now() - startedAt,
    updatedAt: new Date().toISOString(),
  });
}
