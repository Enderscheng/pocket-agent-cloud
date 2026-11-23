import assert from 'node:assert/strict';
import { splitMessage, COMMANDS } from '../discord.js';

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
    check(posted.includes('model not found') && !posted.includes('Backup answer'), 'Wrong model name reported without fallback');
    delete env.AI;

    const parts = splitMessage(('word '.repeat(500) + '\n\n').repeat(4));
    check(parts.length <= 4 && parts.every(p => p.length <= 2000), 'Long answers split within Discord limits');

    r = await send(ask('x'.repeat(1501)));
    check(r.data.type === 4 && r.data.data.flags === 64, 'Oversized question refused');
    check(COMMANDS[0].name === 'ask' && COMMANDS[0].options[0].required, '/ask command definition');
    return `${passed} Discord checks passed. Discord and Gemini were mocked; live deployment not tested.`;
  } finally { globalThis.fetch = realFetch; }
}
