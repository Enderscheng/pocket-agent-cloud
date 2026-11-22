import assert from 'node:assert/strict';

// In-memory D1 adapter for protocol tests. SQL is also checked with SQLite separately.
class FakeDB {
  constructor() { this.states = new Map(); this.link = null; }
  withSession() { return this; }
  prepare(sql) {
    const db = this;
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async run() { return this.execute(); },
      async first() { return this.execute(); },
      execute() {
        const v = this.values;
        if (sql === 'SELECT * FROM integration WHERE id = 1') return db.link && { ...db.link };
        if (sql.startsWith('DELETE FROM oauth_states WHERE expires_at')) {
          for (const [key, state] of db.states) if (state.expires_at < v[0]) db.states.delete(key);
          return { meta: { changes: 0 } };
        }
        if (sql.startsWith('INSERT INTO oauth_states')) {
          db.states.set(v[0], { session_id: v[1], verifier_cipher: v[2], expires_at: v[3] });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('DELETE FROM oauth_states WHERE state_hash')) {
          const state = db.states.get(v[0]);
          if (!state || state.session_id !== v[1] || state.expires_at <= v[2]) return null;
          db.states.delete(v[0]); return { verifier_cipher: state.verifier_cipher };
        }
        if (sql.startsWith('INSERT INTO integration')) {
          if (db.link && db.link.google_sub !== v[0]) return { meta: { changes: 0 } };
          db.link = { id: 1, calendar_id: null, create_state: 'idle', ...db.link,
            google_sub: v[0], email: v[1], refresh_cipher: v[2] };
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE integration SET create_state = 'creating'")) {
          if (!db.link || db.link.calendar_id || db.link.create_state !== 'idle') return { meta: { changes: 0 } };
          db.link.create_state = 'creating'; return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE integration SET calendar_id')) {
          db.link.calendar_id = v[0]; db.link.create_state = 'ready'; return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE integration SET create_state = 'uncertain'")) {
          db.link.create_state = 'uncertain'; return { meta: { changes: 1 } };
        }
        throw new Error('Unhandled mock SQL: ' + sql);
      },
    };
  }
}

export async function runTests(worker) {
  const realFetch = globalThis.fetch;
  const base = 'https://pocket-agent.test';
  const scope = 'https://www.googleapis.com/auth/calendar.app.created';
  const db = new FakeDB();
  const env = { DB: db, BASE_URL: base, ADMIN_TOKEN: 'a'.repeat(43), ENCRYPTION_KEY: 'b'.repeat(43),
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', ALLOWED_EMAIL: 'owner@example.com' };
  let calendarPosts = 0, tokenPosts = 0, account = 'owner@example.com', googleFailure = false, tokenScope = scope;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenPosts++;
      const params = options.body;
      if (params.get('grant_type') === 'authorization_code') assert.ok(params.get('code_verifier').length >= 43);
      if (params.get('grant_type') === 'refresh_token') assert.equal(params.get('refresh_token'), 'private-refresh');
      return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', scope: tokenScope });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
      return Response.json({ sub: 'account-1', email: account, email_verified: true });
    if (url === 'https://www.googleapis.com/calendar/v3/calendars') {
      calendarPosts++;
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).summary, 'Agent');
      if (googleFailure) throw new Error('network response lost');
      return Response.json({ id: 'agent-calendar-id' });
    }
    throw new Error('Unexpected external request: ' + url);
  };
  let passed = 0;
  const check = (condition, message) => { assert.ok(condition, message); passed++; };
  const send = (path, { method = 'GET', cookie, body, origin = base } = {}, config = env) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method === 'POST') { headers.Origin = origin; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    return worker.fetch(new Request(base + path, { method, headers,
      body: method === 'POST' ? new URLSearchParams(body || {}) : undefined }), config);
  };
  const login = async () => {
    const response = await send('/admin/login', { method: 'POST', body: { token: env.ADMIN_TOKEN } });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    const page = await (await send('/admin', { cookie })).text();
    return { cookie, csrf: page.match(/name="csrf" value="([^"]+)"/)[1] };
  };
  const start = async auth => {
    const response = await send('/oauth/start', { method: 'POST', cookie: auth.cookie, body: { csrf: auth.csrf } });
    assert.equal(response.status, 303);
    return new URL(response.headers.get('Location'));
  };
  try {
    check((await send('/health', {}, {})).status === 200, 'Health should work before configuration');
    check((await send('/admin', {}, {})).status === 503, 'Setup must fail closed before configuration');
    check((await send('/admin/create-calendar', { method: 'POST' })).status === 401, 'No anonymous creation');
    check((await send('/api/tasks', { method: 'POST' })).status === 404, 'No premature command endpoint');
    check((await send('/admin/login', { method: 'POST', body: { token: 'wrong' } })).status === 401, 'Wrong key');
    check((await send('/admin/login', { method: 'POST', body: { token: env.ADMIN_TOKEN }, origin: 'https://evil.test' })).status === 403, 'Cross-origin login');
    check((await send('/admin')).headers.get('Referrer-Policy') === 'same-origin', 'Login page must preserve the origin on browser form submissions');
    check((await send('/admin/login', { method: 'POST', body: { token: env.ADMIN_TOKEN }, origin: 'null' })).status === 403, 'Null origin remains forbidden');
    check((await worker.fetch(new Request(base + '/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: env.ADMIN_TOKEN }),
    }), env)).status === 403, 'Missing origin remains forbidden');
    check((await send('/admin/login', { method: 'POST', body: { token: 'x'.repeat(5000) } })).status === 413, 'Bounded request size');
    const auth = await login();
    check((await send('/oauth/start', { method: 'POST', cookie: auth.cookie, body: { csrf: 'wrong' } })).status === 403, 'CSRF token enforced');
    check((await send('/oauth/start', { method: 'POST', cookie: auth.cookie + 'tampered', body: { csrf: auth.csrf } })).status === 401, 'Signed session enforced');
    const authURL = await start(auth);
    check(authURL.searchParams.get('scope') === `openid email ${scope}`, 'Only intended scopes requested');
    check(authURL.searchParams.get('code_challenge_method') === 'S256', 'PKCE enabled');
    check(authURL.searchParams.get('redirect_uri') === base + '/oauth/callback', 'Exact callback origin');
    const callback = '/oauth/callback?code=test-code&state=' + authURL.searchParams.get('state');
    const other = await login();
    check((await send(callback, { cookie: other.cookie })).status === 403, 'OAuth state bound to initiating browser session');
    check(tokenPosts === 0, 'Invalid session cannot exchange OAuth code');
    check((await send(callback, { cookie: auth.cookie })).status === 303, 'Valid callback succeeds');
    check((await send(callback, { cookie: auth.cookie })).status === 403, 'OAuth callback replay denied');
    check(!db.link.refresh_cipher.includes('private-refresh'), 'Refresh token encrypted at rest');
    check(!JSON.stringify([...db.states.values()]).includes('test-code'), 'No authorization code storage');
    const status = await (await send('/admin', { cookie: auth.cookie })).text();
    check(!status.includes('private-refresh') && !status.includes('private-access'), 'No tokens in HTML');
    check((await send('/admin/create-calendar', { method: 'POST', cookie: auth.cookie, body: { csrf: auth.csrf } })).status === 303, 'Creates calendar');
    await send('/admin/create-calendar', { method: 'POST', cookie: auth.cookie, body: { csrf: auth.csrf } });
    check(calendarPosts === 1, 'Repeat submission reuses calendar');
    const reconnect = await start(auth);
    await send('/oauth/callback?code=again&state=' + reconnect.searchParams.get('state'), { cookie: auth.cookie });
    check(db.link.calendar_id === 'agent-calendar-id', 'Reconnect preserves calendar');
    account = 'someone-else@example.com';
    const wrongAccount = await start(auth);
    check((await send('/oauth/callback?code=bad&state=' + wrongAccount.searchParams.get('state'), { cookie: auth.cookie })).status === 403, 'Only designated Gmail account allowed');
    account = 'owner@example.com'; tokenScope = 'openid email';
    const noPermission = await start(auth);
    check((await send('/oauth/callback?code=bad&state=' + noPermission.searchParams.get('state'), { cookie: auth.cookie })).status === 403, 'Missing calendar grant rejected');
    tokenScope = scope;
    db.link.calendar_id = null; db.link.create_state = 'idle'; googleFailure = true;
    const firstFailure = await send('/admin/create-calendar', { method: 'POST', cookie: auth.cookie, body: { csrf: auth.csrf } });
    check(firstFailure.status === 502 && db.link.create_state === 'uncertain', 'Lost Google response marks uncertain creation');
    const before = calendarPosts;
    await send('/admin/create-calendar', { method: 'POST', cookie: auth.cookie, body: { csrf: auth.csrf } });
    check(calendarPosts === before, 'No duplicate calendar after uncertain creation');
    return `${passed} protocol checks passed. Google calls and D1 were mocked; live deployment not tested.`;
  } finally { globalThis.fetch = realFetch; }
}
