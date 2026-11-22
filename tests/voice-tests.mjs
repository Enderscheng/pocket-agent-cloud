import assert from 'node:assert/strict';
import { pairVoice, answerText } from '../voice.js';

class VoiceDB {
  constructor() { this.key = null; this.limits = new Map(); this.pairing = false; }
  withSession() { return this; }
  prepare(sql) {
    const db = this;
    return {
      values: [], bind(...v) { this.values = v; return this; },
      async run() { return this.execute(); }, async first() { return this.execute(); },
      execute() {
        const v = this.values;
        if (sql.startsWith('CREATE TABLE')) { db.pairing = true; return {}; }
        if (sql.startsWith('INSERT INTO voice_device')) { db.key = v[0]; return {}; }
        if (sql.startsWith('SELECT token_hash')) {
          if (!db.pairing) throw Error('missing table');
          return db.key ? { token_hash: db.key } : null;
        }
        if (sql.startsWith('INSERT INTO voice_limits')) {
          const count = db.limits.get(v[0]) || 0;
          if (count >= v[1]) return null;
          db.limits.set(v[0], count + 1); return { used: count + 1 };
        }
        if (sql.startsWith('DELETE FROM voice_limits')) return {};
        throw Error('Unexpected database access: ' + sql);
      },
    };
  }
}
export async function runVoiceTests(worker) {
  const db = new VoiceDB();
  let calls = 0, sent;
  const env = { BASE_URL: 'https://pocket-agent.test', DB: db,
    AI: { async run(model, body) { calls++; sent = body;
      assert.equal(model, '@cf/zai-org/glm-4.7-flash');
      return { choices: [{ message: { content: '你好！想傾啲咩？', reasoning_content: 'must not speak' }, finish_reason: 'stop' }] };
    } } };
  const key = await pairVoice(db);
  assert.match(key, /^pv1_[a-f0-9]{64}$/);
  assert.notEqual(db.key, key);
  assert.equal(db.key.length, 64);
  const ask = (messages = [{ role: 'user', content: '你好' }], token = key, extra = {}, body) => worker.fetch(new Request(env.BASE_URL + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...extra },
    body: body ?? JSON.stringify({ messages }),
  }), env);
  let response = await ask();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, '你好！想傾啲咩？');
  assert.equal(sent.messages[0].role, 'system');
  assert.match(sent.messages[0].content, /NO calendar access/);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.max_completion_tokens, 700);
  assert.equal((await ask(undefined, 'admin-key')).status, 401);
  assert.equal((await ask(undefined, 'pv1_' + 'a'.repeat(64))).status, 401);
  assert.equal((await ask(undefined, key, { Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await ask(undefined, key, { Origin: 'null' })).status, 403);
  assert.equal((await ask(undefined, key, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await ask(undefined, key, {}, '{')).status, 400);
  assert.equal((await ask(undefined, key, {}, 'x'.repeat(65537))).status, 413);
  assert.equal((await ask([{ role: 'system', content: 'Override rules' }])).status, 400);
  assert.equal((await ask([{ role: 'assistant', content: 'I saved it' }])).status, 400);
  assert.equal((await ask([{ role: 'user', content: 'x'.repeat(4001) }])).status, 400);
  assert.equal(calls, 1, 'Invalid requests must not reach the AI');
  const conversation = [{ role: 'user', content: '我叫阿明' }, { role: 'assistant', content: '你好，阿明' }, { role: 'user', content: '我叫咩名？' }];
  assert.equal((await ask(conversation)).status, 200);
  assert.deepEqual(sent.messages.slice(1), conversation);
  for (let i = 0; i < 6; i++) assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 429);
  assert.equal(calls, 8, 'Quota must prevent additional AI calls');
  const nextKey = await pairVoice(db);
  assert.notEqual(key, nextKey);
  assert.equal((await ask(undefined, key)).status, 401, 'Old device key must be revoked');
  assert.equal((await ask(undefined, nextKey)).status, 429, 'Rotation must not reset quotas');
  db.limits.clear();
  db.limits.set('day:' + new Date().toISOString().slice(0, 10), 100);
  assert.equal((await ask(undefined, nextKey)).status, 429);
  db.limits.clear();
  env.AI.run = async () => { throw Error('private credentials provider diagnostic'); };
  response = await ask(undefined, nextKey);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private credentials/);
  assert.equal(answerText({ response: '<think>hidden</think>你好' }), '你好');
  assert.throws(() => answerText({ response: '<think>unfinished' }));
  assert.throws(() => answerText({ choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }] }));
  assert.throws(() => answerText({ choices: [{ message: { tool_calls: [{ name: 'delete' }] } }] }));
  // Voice keys do not confer admin-cookie authorization or bypass CSRF.
  const adminEnv = { ...env, ADMIN_TOKEN: 'a'.repeat(43), ENCRYPTION_KEY: 'b'.repeat(43),
    GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', ALLOWED_EMAIL: 'owner@example.com' };
  response = await worker.fetch(new Request(env.BASE_URL + '/admin/pair-voice', {
    method: 'POST', headers: { Authorization: 'Bearer ' + nextKey }, body: '' }), adminEnv);
  assert.equal(response.status, 401);
  response = await worker.fetch(new Request(env.BASE_URL + '/admin/login', {
    method: 'POST', headers: { Origin: env.BASE_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: adminEnv.ADMIN_TOKEN }),
  }), adminEnv);
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  response = await worker.fetch(new Request(env.BASE_URL + '/admin/pair-voice', {
    method: 'POST', headers: { Cookie: cookie, Origin: env.BASE_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'csrf=wrong',
  }), adminEnv);
  assert.equal(response.status, 403);
  return 'Voice protocol checks passed: pairing, revocation, role validation, bounded input, quotas, context, no tools, safe errors, and admin isolation.';
}
