import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./_memberLifecycle.js', import.meta.url), 'utf8')

test('Command Center deletion is soft-delete only and detaches shared auth identity', () => {
  assert.match(source, /status = 'deleted'/)
  assert.match(source, /auth_user_id = null/)
  assert.match(source, /delete from public\.dashboard_member_permissions/)
  assert.match(source, /status = 'revoked'/)
  assert.doesNotMatch(source, /delete from auth\.users/i)
})

test('Command Center deletion protects self and last Owner', () => {
  assert.match(source, /SELF_DELETE_PROTECTION/)
  assert.match(source, /LAST_OWNER_PROTECTION/)
  assert.match(source, /Only an Owner can delete another Owner/)
})

test('Command Center deletion is audited', () => {
  assert.match(source, /action: "MEMBER_DELETED"/)
  assert.match(source, /subjectEmail: before\.email/)
})
