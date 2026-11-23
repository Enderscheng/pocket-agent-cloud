import assert from 'node:assert/strict';
import { splitMessage, COMMANDS } from '../discord.js';

// Minimal D1 stand-in for the settings and usage tables.
class DiscordDB {
  constructor() { this.settings = new Map(); this.usage = new Map(); this.tables = false; }
  withSession() { return this; }
  prepare(sql) {
    const db = this;
    const statement = { values: [], bind(...v) { this.values = v; return this; },
      async run() { return exec(this.values); }, async first() { return exec(this.values); },
      async all() { return { results: exec(this.values) } } };
    function exec(v) {
      if (sql.startsWith('CREATE TABLE')) { db.tables = true; return {}; }
      if (!db.tables) throw Error('no such table');
      if (sql.startsWith('SELECT key, value FROM discord_settings')) return [...db.settings].map(([key, value]) => ({ key, value }));
      if (sql.startsWith('INSERT INTO discord_settings')) { db.settings.set(v[0], v[1]); return {}; }
      if (sql.startsWith('DELETE FROM discord_settings')) { db.settings.clear(); return {}; }
      if (sql.startsWith('INSERT INTO ai_usage')) {
        const key = v[0] + '|' + v[1], row = db.usage.get(key) || { model: v[1], requests: 0, limited: 0 };
        row.requests++; row.limited += v[2]; db.usage.set(key, row); return {};
      }
      if (sql.startsWith('DELETE FROM ai_usage')) return {};
      if (sql.startsWith('SELECT model, requests, limited FROM ai_usage'))
        return [...db.usage].filter(([k]) => k.startsWith(v[0] + '|')).map(([, r]) => ({ ...r }));
      throw Error('Unexpected SQL: ' + sql);
    }
    return statement;
  }
}

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

export async function runDiscordTests(worker) {
  const realFetch = globalThis.fetch;
  const base = 'https://pocket-agent.test';
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const env = { BASE_URL: base, DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_PUBLIC_KEY: hex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    DISCORD_BOT_TOKEN: 'private-bot-token', DISCORD_ALLOWED_USER_ID: '111111111111111111',
    GEMINI_API_KEY: 'private-gemini-key' };
  const token = 'interaction_token_' + 'x'.repeat(40);
  const calls = [];
  let gemini = () => Response.json({ candidates: [{ content: { parts: [
    { text: 'hidden reasoning', thought: true }, { text: 'Hello from **Gemini**' }] },
    groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'Example [A]' } }] } }] });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return gemini(url, options);
    if (url.startsWith('https://discord.com/api/v10/')) return new Response(null, { status: 204 });
    throw new Error('Unexpected external request: ' + url);
  };
  let passed = 0;
  const check = (condition, message) => { assert.ok(condition, message); passed++; };
  const send = async (payload, { key = pair.privateKey, timestamp = Math.floor(Date.now() / 1000), tamper = false } = {}) => {
    const body = JSON.stringify(payload);
    const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + body));
    const waits = [];
    const response = await worker.fetch(new Request(base + '/discord', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': hex(signature), 'X-Signature-Timestamp': String(timestamp) },
      body: tamper ? body.replace('ask', 'asx') : body }), env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    return { response, data: await response.json().catch(() => null), waited: waits.length };
  };
  const ask = (question, user = env.DISCORD_ALLOWED_USER_ID, extra = []) => ({
    type: 2, application_id: env.DISCORD_APPLICATION_ID, token, member: { user: { id: user } },
    data: { name: 'ask', options: [{ name: 'question', type: 3, value: question }, ...extra] } });
  try {
    let r = await send({ type: 1 });
    check(r.response.status === 200 && r.data.type === 1, 'Signed PING answered with PONG');
    r = await send({ type: 1 }, { key: other.privateKey });
    check(r.response.status === 401, 'Wrong signing key rejected with 401');
    r = await send(ask('hi'), { tamper: true });
    check(r.response.status === 401, 'Modified body rejected');
    r = await send({ type: 1 }, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    check(r.response.status === 401, 'Stale signed request rejected');
    const unsigned = await worker.fetch(new Request(base + '/discord', { method: 'POST', body: '{"type":1}' }), env, { waitUntil() {} });
    check(unsigned.status === 401, 'Unsigned request rejected');

    calls.length = 0;
    r = await send(ask('hi', '999999999999999999'));
    check(r.data.type === 4 && r.data.data.flags === 64 && calls.length === 0 && r.waited === 0, 'Other users get a private refusal and no Gemini call');

    calls.length = 0;
    r = await send(ask('What is up?', env.DISCORD_ALLOWED_USER_ID, [{ name: 'web', type: 5, value: true }]));
    check(r.data.type === 5 && r.waited === 1, 'Owner request is deferred within the 3-second window');
    const geminiCall = calls.find(c => c.url.startsWith('https://generativelanguage'));
    const sent = JSON.parse(geminiCall.options.body);
    check(geminiCall.options.headers['x-goog-api-key'] === 'private-gemini-key' && !geminiCall.url.includes('private-gemini-key'), 'Gemini key sent in header, not URL');
    check(geminiCall.url.includes('/models/gemini-flash-latest:generateContent'), 'Default Gemini model used');
    check(sent.tools?.[0]?.google_search && sent.contents[0].parts[0].text === 'What is up?', 'Web option enables Google Search grounding');
    const edit = calls.find(c => c.url.endsWith(`/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`));
    const content = JSON.parse(edit.options.body);
    check(edit.options.method === 'PATCH' && content.content.includes('Hello from **Gemini**'), 'Answer replaces the "thinking" message');
    check(!content.content.includes('hidden reasoning'), 'Model thoughts are not posted');
    check(content.content.includes('(<https://example.com/a>)') && !content.content.includes('[A]'), 'Sources listed safely without embeds');
    check(content.allowed_mentions.parse.length === 0, 'AI text cannot ping anyone');
    check(!calls.some(c => JSON.stringify(c.options.body || '').includes('private-bot-token')), 'Bot token never sent in follow-ups');

    calls.length = 0;
    await send(ask('No web'));
    check(!JSON.parse(calls[0].options.body).tools, 'Web search off by default');

    calls.length = 0;
    gemini = () => new Response('{"error":{"message":"key private-gemini-key invalid"}}', { status: 429 });
    await send(ask('again'));
    const limited = JSON.parse(calls.find(c => c.url.includes('@original')).options.body).content;
    check(limited.includes('free limit') && !limited.includes('private-gemini-key'), 'Rate-limit error explained without echoing Gemini body');

    // Overloaded Gemini: retry the same model, then succeed.
    calls.length = 0;
    let geminiCalls = 0;
    gemini = () => ++geminiCalls === 1 ? new Response('busy', { status: 503 })
      : Response.json({ candidates: [{ content: { parts: [{ text: 'Second try worked' }] } }] });
    await send(ask('retry please'));
    let posted = JSON.parse(calls.find(c => c.url.includes('@original')).options.body).content;
    check(geminiCalls === 2 && posted.includes('Second try worked'), 'Overloaded Gemini is retried once');

    // Still overloaded: lighter Gemini model, then Cloudflare AI backup.
    calls.length = 0;
    const models = [];
    gemini = url => { models.push(url.match(/models\/([^:]+):/)[1]); return new Response('busy', { status: 503 }); };
    let aiQuestion;
    env.AI = { async run(model, body) { aiQuestion = body.messages.at(-1).content;
      return { choices: [{ message: { content: 'Backup answer' }, finish_reason: 'stop' }] }; } };
    await send(ask('fallback please'));
    posted = JSON.parse(calls.find(c => c.url.includes('@original')).options.body).content;
    check(models.join(',') === 'gemini-flash-latest,gemini-flash-latest,gemini-flash-lite-latest', 'Lighter Gemini model tried after retries');
    check(aiQuestion === 'fallback please' && posted.includes('Backup answer') && posted.includes('Answered by Cloudflare AI'), 'Cloudflare AI answers and is labelled when Gemini is down');

    // Configuration errors are reported, not hidden behind a backup answer.
    calls.length = 0;
    gemini = () => new Response('nope', { status: 404 });
    await send(ask('bad model'));
    posted = JSON.parse(calls.find(c => c.url.includes('@original')).options.body).content;
    check(posted.includes('not found') && !posted.includes('Backup answer'), 'Wrong model name reported without fallback');
    delete env.AI;

    // ---- /model and /usage with a database ----
    env.DB = new DiscordDB();
    env.DB.tables = true;
    const cmd = (name, options) => ({ type: 2, application_id: env.DISCORD_APPLICATION_ID, token,
      member: { user: { id: env.DISCORD_ALLOWED_USER_ID } }, data: { name, options } });
    const googleModels = { models: [
      { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'TTS', supportedGenerationMethods: ['generateContent'] } ] };
    gemini = (url, options) => {
      if (url.includes('/models?')) return Response.json(googleModels);
      if (!options.method) {
        const id = url.split('/models/')[1];
        const found = googleModels.models.find(m => m.name === 'models/' + id);
        return found ? Response.json(found) : new Response('missing', { status: 404 });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    };
    r = await send(cmd('model', [{ type: 1, name: 'show' }]));
    check(r.data.data.flags === 64 && r.data.data.content.includes('`gemini-flash-latest` (default)'), '/model show reports default privately');

    calls.length = 0;
    r = await send(cmd('model', [{ type: 1, name: 'list' }]));
    let listed = JSON.parse(calls.find(c => c.url.includes('@original')).options.body).content;
    check(r.data.type === 5 && r.data.data.flags === 64, '/model list deferred privately');
    check(listed.includes('✅ `gemini-flash-latest`') && listed.includes('`gemini-2.5-pro`') && !listed.includes('embedding') && !listed.includes('tts'), '/model list shows only chat models and marks the current one');

    r = await send({ type: 4, application_id: env.DISCORD_APPLICATION_ID, token, member: { user: { id: env.DISCORD_ALLOWED_USER_ID } },
      data: { name: 'model', options: [{ type: 1, name: 'set', options: [{ name: 'name', value: 'pro', focused: true }] }] } });
    check(r.data.type === 8 && r.data.data.choices.length === 1 && r.data.data.choices[0].value === 'gemini-2.5-pro', 'Autocomplete suggests matching models');
    r = await send({ type: 4, application_id: env.DISCORD_APPLICATION_ID, token, member: { user: { id: '999999999999999999' } },
      data: { name: 'model', options: [{ type: 1, name: 'set', options: [{ name: 'name', value: '', focused: true }] }] } });
    check(r.data.data.choices.length === 0, 'Autocomplete gives strangers nothing');

    calls.length = 0;
    await send(cmd('model', [{ type: 1, name: 'set', options: [{ name: 'name', value: 'made-up-model' }] }]));
    listed = JSON.parse(calls.find(c => c.url.includes('@original')).options.body).content;
    check(listed.includes('no model called') && !env.DB.settings.size, 'Unknown model is rejected and not saved');

    calls.length = 0;
    await send(cmd('model', [{ type: 1, name: 'set', options: [{ name: 'name', value: 'gemini-2.5-pro' }] }]));
    check(env.DB.settings.get('model') === 'gemini-2.5-pro', '/model set saves the choice');
    calls.length = 0;
    await send(ask('Use the new model'));
    const used = calls.find(c => c.options.method === 'POST' && c.url.includes(':generateContent'));
    posted = JSON.parse(calls.find(c => c.url.includes('@original')).options.body).content;
    check(used.url.includes('/models/gemini-2.5-pro:') && posted.includes('-# gemini-2.5-pro'), '/ask uses the saved model and says so');

    r = await send(cmd('usage'));
    check(r.data.data.flags === 64 && r.data.data.content.includes('`gemini-2.5-pro`: 1 request') && r.data.data.content.includes('aistudio.google.com'), '/usage shows today\'s counts and where to see quota');

    r = await send(cmd('model', [{ type: 1, name: 'reset' }]));
    check(!env.DB.settings.size && r.data.data.content.includes('(default)'), '/model reset returns to defaults');
    delete env.DB;

    const parts = splitMessage(('word '.repeat(500) + '\n\n').repeat(4));
    check(parts.length <= 4 && parts.every(p => p.length <= 2000), 'Long answers split within Discord limits');

    r = await send(ask('x'.repeat(1501)));
    check(r.data.type === 4 && r.data.data.flags === 64, 'Oversized question refused');
    check(COMMANDS[0].name === 'ask' && COMMANDS[0].options[0].required, '/ask command definition');
    return `${passed} Discord checks passed. Discord and Gemini were mocked; live deployment not tested.`;
  } finally { globalThis.fetch = realFetch; }
}
