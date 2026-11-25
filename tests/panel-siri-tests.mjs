import assert from 'node:assert/strict';
import { pairSiri, speakable } from '../siri.js';
import { helpMessage } from '../discord.js';

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

// D1 stand-in for settings, usage, the Siri key and Siri limits.
class FakeDB {
  constructor() { this.settings = new Map(); this.usage = new Map(); this.limits = new Map(); this.siri = null; this.siriTables = false; }
  withSession() { return this; }
  prepare(sql) {
    const db = this;
    const run = v => {
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS siri')) { db.siriTables = true; return {}; }
      if (sql.startsWith('CREATE TABLE')) return {};
      if (sql.startsWith('SELECT key, value FROM discord_settings')) return [...db.settings].filter(([k]) => k !== 'siri_channel').map(([key, value]) => ({ key, value }));
      if (sql.startsWith("SELECT value FROM discord_settings WHERE key = 'siri_channel'")) return db.settings.has('siri_channel') ? { value: db.settings.get('siri_channel') } : null;
      if (sql.startsWith('INSERT INTO discord_settings')) { db.settings.set(v[0], v[1]); return {}; }
      if (sql.startsWith('DELETE FROM discord_settings')) { db.settings.delete('model'); db.settings.delete('backup'); return {}; }
      if (sql.startsWith('INSERT INTO ai_usage')) {
        const row = db.usage.get(v[1]) || { model: v[1], requests: 0, limited: 0 };
        row.requests++; row.limited += v[2]; db.usage.set(v[1], row); return {};
      }
      if (sql.startsWith('DELETE FROM ai_usage')) return {};
      if (sql.startsWith('SELECT model, requests, limited FROM ai_usage')) return [...db.usage.values()];
      if (sql.startsWith('INSERT INTO siri_device')) { db.siri = v[0]; return {}; }
      if (sql.startsWith('SELECT token_hash FROM siri_device')) {
        if (!db.siriTables) throw Error('no such table');
        return db.siri ? { token_hash: db.siri } : null;
      }
      if (sql.startsWith('INSERT INTO siri_limits')) {
        const used = db.limits.get(v[0]) || 0;
        if (used >= v[1]) return null;
        db.limits.set(v[0], used + 1); return { used: used + 1 };
      }
      if (sql.startsWith('DELETE FROM siri_limits')) return {};
      throw Error('Unexpected SQL: ' + sql);
    };
    return { values: [], bind(...v) { this.values = v; return this; },
      async run() { return run(this.values); }, async first() { return run(this.values); },
      async all() { return { results: run(this.values) }; } };
  }
}

export async function runPanelSiriTests(worker) {
  const realFetch = globalThis.fetch;
  const base = 'https://pocket-agent.test';
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const db = new FakeDB();
  const env = { BASE_URL: base, DB: db, DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_PUBLIC_KEY: hex(await crypto.subtle.exportKey('raw', pair.publicKey)),
    DISCORD_BOT_TOKEN: 'private-bot-token', DISCORD_ALLOWED_USER_ID: '111111111111111111', GEMINI_API_KEY: 'private-gemini-key' };
  const token = 'interaction_token_' + 'x'.repeat(40);
  const channel = '222222222222222222';
  const calls = [];
  let answerText = '**Pasta** is quick.\n\n- Boil water\n- Add [sauce](<https://example.com>)';
  let geminiStatus = 200;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/v1beta/models?')) return Response.json({ models: [
      { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] }] });
    if (url.includes(':generateContent')) {
      if (geminiStatus !== 200) return new Response('busy', { status: geminiStatus });
      return Response.json({ candidates: [{ content: { parts: [{ text: answerText }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/src', title: 'Src' } }] } }] });
    }
    if (url.startsWith('https://discord.com/api/v10/')) return new Response(null, { status: url.includes('/channels/') ? 200 : 204 });
    throw new Error('Unexpected external request: ' + url);
  };
  let passed = 0;
  const check = (condition, message) => { assert.ok(condition, message); passed++; };
  const interact = async (payload, user = env.DISCORD_ALLOWED_USER_ID) => {
    const body = JSON.stringify({ application_id: env.DISCORD_APPLICATION_ID, token, channel_id: channel, member: { user: { id: user } }, ...payload });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(timestamp + body));
    const waits = [];
    const response = await worker.fetch(new Request(base + '/discord', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': hex(signature), 'X-Signature-Timestamp': String(timestamp) }, body }),
      env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    return response.json();
  };
  const lastEdit = () => JSON.parse(calls.filter(c => c.url.endsWith('/messages/@original')).at(-1).options.body);
  const siri = async (body, key, extra = {}) => {
    const waits = [];
    const response = await worker.fetch(new Request(base + '/api/siri', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}), ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body) }), env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    return { status: response.status, data: await response.json() };
  };
  try {
    // ---- /panel ----
    let r = await interact({ type: 2, data: { name: 'panel' } });
    check(r.type === 5 && r.data.flags === 64, '/panel opens privately');
    let panel = lastEdit();
    const selects = panel.components.flatMap(row => row.components).filter(c => c.type === 3);
    check(selects.length === 2 && selects[0].options.find(o => o.default).value === 'gemini-flash-latest', 'Panel has main and backup menus with the current model selected');
    check(selects[1].options.some(o => o.value === 'gemini-flash-lite-latest' && o.default), 'Backup menu includes the default backup even if Google omits it');
    check(panel.embeds[0].fields.some(f => f.value.includes('Not set')), 'Panel says Siri channel is not set');
    const buttons = panel.components.flatMap(row => row.components).filter(c => c.type === 2);
    check(buttons.some(b => b.style === 5 && b.url === 'https://aistudio.google.com/usage'), 'Panel links to Google quota page');

    r = await interact({ type: 3, data: { custom_id: 'panel:main', component_type: 3, values: ['gemini-2.5-pro'] } });
    panel = lastEdit();
    check(r.type === 6 && db.settings.get('model') === 'gemini-2.5-pro' && panel.content.includes('gemini-2.5-pro'), 'Main model menu saves and updates the panel in place');
    await interact({ type: 3, data: { custom_id: 'panel:backup', component_type: 3, values: ['made-up'] } });
    check(!db.settings.has('backup') && lastEdit().content.includes('not offered'), 'Model not offered by Google is refused');
    r = await interact({ type: 3, data: { custom_id: 'panel:main', component_type: 3, values: ['gemini-flash-latest'] } }, '999999999999999999');
    check(r.data.flags === 64 && db.settings.get('model') === 'gemini-2.5-pro', 'Strangers cannot use panel controls');
    r = await interact({ type: 3, data: { custom_id: 'evil:thing', component_type: 2 } });
    check(r.data.flags === 64, 'Unknown buttons are refused');

    calls.length = 0;
    await interact({ type: 3, data: { custom_id: 'panel:siri', component_type: 2 } });
    const confirm = calls.find(c => c.url === `https://discord.com/api/v10/channels/${channel}/messages`);
    check(db.settings.get('siri_channel') === channel && confirm && confirm.options.headers.Authorization === 'Bot private-bot-token', 'Siri channel saved and confirmed by the bot');
    check(lastEdit().embeds[0].fields.some(f => f.value === `<#${channel}>`), 'Panel shows the Siri channel');

    await interact({ type: 3, data: { custom_id: 'panel:reset', component_type: 2 } });
    check(!db.settings.has('model') && db.settings.get('siri_channel') === channel, 'Reset clears models but keeps the Siri channel');

    // ---- /help ----
    check(buttons.some(b => b.custom_id === 'help:home') && buttons.some(b => b.custom_id === 'cal:settings') && panel.components.length <= 5 && panel.components.every(row => row.components.length <= 5), 'Panel has Help and calendar buttons and stays within Discord limits');
    r = await interact({ type: 2, data: { name: 'help' } });
    const pages = r.data.components[0].components;
    check(r.type === 4 && r.data.flags === 64 && r.data.embeds[0].title.includes('使用說明'), '/help replies privately with the overview');
    check(pages.length === 5 && pages.every(b => /^help:\w+$/.test(b.custom_id)) && pages[0].disabled, '/help has one button per page, the current one disabled');
    r = await interact({ type: 3, data: { custom_id: 'help:discord', component_type: 2 }, message: { embeds: r.data.embeds } });
    check(r.type === 7 && ['/ask', '/todo', '/panel', '/usage', '/model', 'Cancel'].every(w => r.data.embeds[0].description.includes(w)), 'Help page buttons switch the page in place and list every command');
    r = await interact({ type: 3, data: { custom_id: 'help:iphone', component_type: 2 }, message: { embeds: panel.embeds } });
    check(r.type === 4 && r.data.flags === 64 && r.data.embeds[0].description.includes('ps1_'), 'Help from the panel opens a new private message');
    r = await interact({ type: 3, data: { custom_id: 'help:nope', component_type: 2 } });
    check(r.data.embeds[0].title.includes('使用說明'), 'Unknown help page falls back to the overview');
    check(['home', 'discord', 'iphone', 'mail', 'fix'].every(p => helpMessage(p).embeds[0].description.length < 4000), 'Every help page fits in a Discord embed');
    r = await interact({ type: 2, data: { name: 'help' } }, '999999999999999999');
    check(!r.data.embeds, 'Strangers do not get /help');

    // ---- Siri ----
    check((await siri({ question: 'hi' })).data.answer.includes('Siri key'), 'Siri without key is told to add one');
    check((await siri({ question: 'hi' }, 'ps1_' + 'a'.repeat(64))).data.answer.includes('Create a Siri key'), 'Siri before pairing is refused');
    const key = await pairSiri(db);
    check(/^ps1_[a-f0-9]{64}$/.test(key) && db.siri !== key, 'Siri key format; only its hash stored');
    check((await siri({ question: 'hi' }, 'ps1_' + 'b'.repeat(64))).data.status === 401, 'Wrong Siri key refused');
    check((await siri({ question: 'hi' }, 'pv1_' + 'b'.repeat(64))).data.status === 401, 'Voice key is not accepted for Siri');
    check((await siri({ question: 'hi' }, key, { Origin: 'https://evil.test' })).data.status === 403, 'Browser cross-origin calls refused');

    calls.length = 0;
    let s = await siri({ question: 'Quick dinner?', web: true }, key);
    const geminiBody = JSON.parse(calls.find(c => c.url.includes(':generateContent')).options.body);
    check(s.status === 200 && s.data.model === 'gemini-flash-latest', 'Siri gets an answer from Gemini');
    check(geminiBody.systemInstruction.parts[0].text.includes('read aloud') && geminiBody.tools, 'Siri asks for a speakable answer and honours web');
    check(!/[*\[\]<>#]/.test(s.data.answer) && s.data.answer.includes('Pasta is quick') && !s.data.answer.includes('Sources'), 'Spoken answer has no markdown, links or sources');
    const post = calls.find(c => c.url === `https://discord.com/api/v10/channels/${channel}/messages`);
    const posted = JSON.parse(post.options.body);
    check(posted.content.includes('🎙️ **Siri:** Quick dinner?') && posted.content.includes('**Pasta**') && posted.content.includes('via Siri') && posted.allowed_mentions.parse.length === 0, 'Siri conversation posted to Discord with formatting');
    check(!JSON.stringify(calls).includes(key), 'Siri key is never sent anywhere');

    geminiStatus = 503;
    env.AI = { async run() { return { choices: [{ message: { content: 'Backup says hi' }, finish_reason: 'stop' }] }; } };
    s = await siri({ question: 'Busy?' }, key);
    check(s.data.answer === 'Backup says hi' && s.data.model === 'cloudflare-ai', 'Siri falls back to Cloudflare AI when Gemini is busy');
    geminiStatus = 200; delete env.AI;

    check((await siri('not json', key)).data.answer.includes('invalid JSON'), 'Bad JSON explained');
    check((await siri({ question: '' }, key)).data.answer.includes('did not catch'), 'Empty dictation explained');
    db.limits.clear();
    for (let i = 0; i < 6; i++) await siri({ question: 'q' + i }, key);
    s = await siri({ question: 'one too many' }, key);
    check(s.data.status === 429 && s.data.answer.includes('limit'), 'Siri per-minute limit enforced');
    check(speakable('## Title\n**Bold** and [link](<https://x.y>)\n\n**Sources**\n- [a](<https://a.b>)') === 'Title\nBold and link', 'speakable strips markdown');
    return `${passed} panel and Siri checks passed. Discord and Gemini were mocked; live deployment not tested.`;
  } finally { globalThis.fetch = realFetch; }
}
