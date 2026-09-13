import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const [migration, ownerGuard, auth, access, accessAdmin, accessApi, analytics, apiAuth, proxy, promotors, recruiters, submissionNotes] = await Promise.all([
  read('../../../db/migrations/20260913_000001_dashboard_access_rbac.sql'),
  read('../../../db/migrations/20260913_000002_dashboard_owner_guard.sql'),
  read('./_auth.js'),
  read('./_access.js'),
  read('./_accessAdmin.js'),
  read('../admin/access.js'),
  read('../analytics/admin.js'),
  read('../lib/apiAuth.js'),
  read('../../server/railwayProxy.js'),
  read('./promotors.js'),
  read('./recruiters.js'),
  read('./submissionNotes.js'),
])

test('IAM schema is additive and separate from Abuse RBAC', () => {
  for (const table of ['dashboard_members', 'dashboard_member_permissions', 'dashboard_access_invitations', 'dashboard_access_audit']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`))
  }
  assert.doesNotMatch(migration, /alter table public\.employee_permissions|drop table.*employee_permissions|delete from public\.employee_permissions/i)
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/)
  assert.match(migration, /REVOKE ALL ON TABLE public\.dashboard_members FROM authenticated/)
})

test('database serializes concurrent last-owner removal attempts', () => {
  assert.match(ownerGuard, /dashboard_members_preserve_last_owner/)
  assert.match(ownerGuard, /pg_advisory_xact_lock\(hashtext\('mwz\.dashboard\.active-owner-guard'\)\)/)
  assert.match(ownerGuard, /remaining_active_owners < 1/)
  assert.match(ownerGuard, /MWZ_LAST_OWNER_PROTECTION/)
  assert.match(ownerGuard, /BEFORE UPDATE OF role, status OR DELETE/)
})

test('master/founder break glass stays explicit and server-side', () => {
  assert.match(auth, /MASTER_ADMIN_ROLES = new Set\(\["master_admin", "founder"\]\)/)
  assert.match(auth, /DASHBOARD_MASTER_ADMIN_USER_IDS/)
  assert.match(auth, /DASHBOARD_MASTER_ADMIN_EMAILS/)
  assert.match(access, /identity\.isMasterAdmin/)
  assert.match(access, /syntheticPrincipal\(identity, "owner"/)
})

test('legacy admin compatibility does not acquire Access Management or Abuse grants', () => {
  for (const permission of ['access.manage', 'abuse.view', 'abuse.reply', 'abuse.manage', 'abuse.admin']) {
    assert.match(access, new RegExp(`LEGACY_ADMIN_EXCLUSIONS[\\s\\S]*"${permission.replace('.', '\\.')}`))
  }
  assert.match(access, /legacy_admin_schema_fallback/)
  assert.match(access, /legacy_admin/)
})

test('Metrics Reader is exactly dashboard analytics launchpad at preset level', () => {
  assert.match(access, /metrics_reader: \["dashboard\.view", "analytics\.view", "launchpad\.view"\]/)
})

test('Finance Reader and Manager preserve read/manage separation', () => {
  assert.match(access, /finance_reader: \["dashboard\.view", "finance\.view"\]/)
  assert.match(access, /finance_manager: \["dashboard\.view", "finance\.view", "finance\.manage"\]/)
  assert.match(proxy, /method === "GET" \|\| method === "HEAD" \? "finance\.view" : "finance\.manage"/)
  assert.match(proxy, /authorizeDashboardBearer\(req, res, permission\)/)
})

test('Operations and Community endpoints enforce read/manage separation server-side', () => {
  assert.match(submissionNotes, /\? "operations\.view" : "operations\.manage"/)
  assert.match(submissionNotes, /requireDashboardPermission\(req, res, permission\)/)
  assert.match(promotors, /manage \? "community\.manage" : "community\.view"/)
  assert.match(promotors, /requireDashboardPermission\(req, res/)
  assert.match(recruiters, /manage \? "community\.manage" : "community\.view"/)
  assert.match(recruiters, /requireDashboardPermission\(req, res/)
  assert.match(recruiters, /dashboardRecruiterMember[\s\S]*requireCommunity\(req, res, true\)/)
  assert.match(proxy, /dispatchAdminSponsorship[\s\S]*\? "operations\.view" : "operations\.manage"/)
})

test('Arena review and Tournament admin routes require explicit control capabilities', () => {
  assert.match(proxy, /dispatchAdminArenaImports[\s\S]*"arena_imports\.manage"/)
  assert.match(proxy, /dispatchAdminArenaTournaments[\s\S]*"tournaments\.manage"/)
})

test('valid pending invitation activation is atomic and revoked or expired invites fail closed', () => {
  assert.match(access, /activateInvitedMembership/)
  assert.match(access, /status = 'pending'/)
  assert.match(access, /expires_at is null or expires_at > now\(\)/)
  assert.match(access, /status = 'accepted'/)
  assert.match(access, /DASHBOARD_INVITATION_INVALID/)
})

test('Access API exposes controlled member and invitation actions behind access.manage', () => {
  assert.match(accessApi, /requireDashboardPermission\(req, res, "access\.manage"\)/)
  for (const route of ['members', 'invitations', 'audit']) assert.match(accessApi, new RegExp(`/api/admin/access/${route}`))
  assert.match(accessApi, /\(resend\|revoke\)/)
  assert.match(accessApi, /\(disable\|restore\)/)
  assert.match(accessAdmin, /expectedVersion/)
  assert.match(accessAdmin, /LAST_OWNER_PROTECTION/)
  assert.match(accessAdmin, /SELF_DISABLE_PROTECTION/)
})

test('Supabase invitation delivery is service-role server-side and redirect is explicit', () => {
  assert.match(accessAdmin, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.match(accessAdmin, /DASHBOARD_INVITE_REDIRECT_URL/)
  assert.match(accessAdmin, /\/auth\/v1\/invite/)
  assert.match(accessAdmin, /Authorization: `Bearer \$\{serviceRole\}`/)
})

test('Analytics and Launchpad backend routes enforce their real capabilities', () => {
  assert.match(analytics, /tail === "launchpad" \? "launchpad\.view" : "analytics\.view"/)
  assert.match(analytics, /requireDashboardPermission\(req, res, permission\)/)
})

test('strict legacy admin handlers receive a facade only after server-side capability authorization', () => {
  assert.match(proxy, /async function authorizeDashboardBearer/)
  assert.match(proxy, /requireDashboardPermission\(req, res, permission\)/)
  assert.match(proxy, /req\.dashboardPrincipal = principal/)
  assert.match(apiAuth, /if \(req\.dashboardPrincipal\)/)
  assert.match(apiAuth, /mode: "admin"/)
  assert.match(apiAuth, /authorizationSource: "dashboard-permission"/)
  assert.match(apiAuth, /dashboardPrincipalAsAdmin/)
})

test('existing ops-key Finance callers remain on the established finance authorization path', () => {
  assert.match(proxy, /authorizeDashboardBearer\(req, res, permission\)/)
  assert.match(proxy, /const financeAdmin = \(await import\("\.\.\/api\/admin\/finance\.js"\)\)\.default/)
  assert.match(apiAuth, /if \(allowOps && opsExpected && opsProvided && opsProvided === opsExpected\)/)
})

test('Access API is dispatched locally without adding market or indexer routing', () => {
  assert.match(proxy, /dispatchAdminAccess/)
  assert.match(proxy, /\/api\/admin\/access/)
})
