import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExistingSupabaseUserError,
  sendDashboardAccessEmail,
} from './_inviteDelivery.js'

const ORIGINAL_ENV = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  DASHBOARD_INVITE_REDIRECT_URL: process.env.DASHBOARD_INVITE_REDIRECT_URL,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
}

test.afterEach(() => {
  restoreEnv()
  delete global.fetch
})

test('existing Supabase user responses are recognized narrowly', () => {
  assert.equal(isExistingSupabaseUserError(422, { msg: 'A user with this email address has already been registered' }), true)
  assert.equal(isExistingSupabaseUserError(400, { message: 'User already exists' }), true)
  assert.equal(isExistingSupabaseUserError(500, { message: 'User already exists' }), false)
  assert.equal(isExistingSupabaseUserError(422, { message: 'Rate limit exceeded' }), false)
})

test('new user uses invite endpoint with Command Center redirect', async () => {
  process.env.SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
  process.env.SUPABASE_ANON_KEY = 'anon-key'
  process.env.DASHBOARD_INVITE_REDIRECT_URL = 'https://command-center.memewar.zone'

  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify({ id: 'user-id' }), { status: 200 })
  }

  const result = await sendDashboardAccessEmail('new@example.com')
  assert.equal(result.mode, 'invite')
  assert.equal(calls.length, 1)
  const inviteUrl = new URL(calls[0].url)
  assert.equal(inviteUrl.pathname, '/auth/v1/invite')
  assert.equal(inviteUrl.searchParams.get('redirect_to'), 'https://command-center.memewar.zone')
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'new@example.com' })
})

test('existing user falls back to magic link without creating a duplicate user', async () => {
  process.env.SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
  process.env.SUPABASE_ANON_KEY = 'anon-key'
  process.env.DASHBOARD_INVITE_REDIRECT_URL = 'https://command-center.memewar.zone'

  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      return new Response(JSON.stringify({ msg: 'A user with this email address has already been registered' }), { status: 422 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }

  const result = await sendDashboardAccessEmail('existing@example.com')
  assert.equal(result.mode, 'magic_link')
  assert.equal(calls.length, 2)

  const otpUrl = new URL(calls[1].url)
  assert.equal(otpUrl.pathname, '/auth/v1/otp')
  assert.equal(otpUrl.searchParams.get('redirect_to'), 'https://command-center.memewar.zone')
  assert.equal(calls[1].options.headers.apikey, 'anon-key')
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    email: 'existing@example.com',
    create_user: false,
  })
})
