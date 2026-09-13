import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./_accessAdmin.js', import.meta.url), 'utf8')

test('Supabase dashboard invites pass redirect_to as an encoded query parameter', () => {
  assert.match(source, /const inviteUrl = new URL\(`\$\{supabaseUrl\}\/auth\/v1\/invite`\)/)
  assert.match(source, /inviteUrl\.searchParams\.set\("redirect_to", redirectTo\)/)
  assert.match(source, /fetch\(inviteUrl,/)
})

test('Supabase dashboard invite body does not contain redirect_to', () => {
  assert.match(source, /body: JSON\.stringify\(\{ email \}\)/)
  assert.doesNotMatch(source, /JSON\.stringify\(\{ email, redirect_to:/)
})
