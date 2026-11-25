// Discord slash commands for the owner only: /ask sends one question to Gemini,
// /model picks the Gemini model, /usage shows today's request counts and /panel is a
// button-and-menu control panel for the same settings plus the Siri channel, and /help
// is a private guide to the whole system.
// No calendar, Google account, notes or voice-key access is reachable from here.
import { answerText } from './voice.js';
import { cancelTask, agendaMarkdown, ensureTaskTables, describeDue, isChinese, TaskError } from './tasks.js';
const API = 'https://discord.com/api/v10';
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const DEFAULT_FALLBACK_MODEL = 'gemini-flash-lite-latest';
const CLOUDFLARE_MODEL = '@cf/zai-org/glm-4.7-flash';
const MAX_BODY = 65536;
const MAX_CHUNK = 1900;
const MAX_CHUNKS = 4;
const encoder = new TextEncoder();

export const COMMANDS = [{
  name: 'ask', type: 1, description: 'Ask Gemini a question',
  options: [
    { type: 3, name: 'question', description: 'What do you want to ask?', required: true, max_length: 1500 },
    { type: 5, name: 'web', description: 'Let Gemini search the web with Google first', required: false },
  ],
}, {
  name: 'model', type: 1, description: 'See or change the Gemini model /ask uses',
  options: [
    { type: 1, name: 'show', description: 'Show which models /ask uses now' },
    { type: 1, name: 'list', description: 'List the Gemini models your key can use' },
    { type: 1, name: 'set', description: 'Change the model /ask uses', options: [
      { type: 3, name: 'name', description: 'Model name, e.g. gemini-flash-latest', required: true, autocomplete: true, max_length: 60 },
      { type: 5, name: 'backup', description: 'Change the backup model instead of the main one', required: false },
    ] },
    { type: 1, name: 'reset', description: 'Go back to the default models' },
  ],
}, {
  name: 'usage', type: 1, description: 'Show how many AI requests Pocket Agent made today',
}, {
  name: 'panel', type: 1, description: 'Open the Pocket Agent control panel (models, usage, Siri)',
}, {
  name: 'todo', type: 1, description: 'Show deadlines and to-dos for the next 14 days',
}, {
  name: 'help', type: 1, description: 'How Pocket Agent works: every command, button and iPhone shortcut',
}];
const LIMITS_URL = 'https://aistudio.google.com/usage';

class DiscordError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function hexBytes(hex, length) {
  if (typeof hex !== 'string' || !new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
}
// Only fixed setting names are reported, never values.
export function missingDiscordSettings(env) {
  const missing = [];
  if (!/^\d{15,22}$/.test(env.DISCORD_APPLICATION_ID || '')) missing.push('DISCORD_APPLICATION_ID');
  if (!hexBytes((env.DISCORD_PUBLIC_KEY || '').trim(), 32)) missing.push('DISCORD_PUBLIC_KEY');
  if (!(env.DISCORD_BOT_TOKEN || '').trim()) missing.push('DISCORD_BOT_TOKEN');
  if (!/^\d{15,22}$/.test((env.DISCORD_ALLOWED_USER_ID || '').trim())) missing.push('DISCORD_ALLOWED_USER_ID');
  if (!(env.GEMINI_API_KEY || '').trim()) missing.push('GEMINI_API_KEY');
  return missing;
}
async function rawBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new DiscordError('Missing body.');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new DiscordError('Body too large.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
async function verified(request, env, body) {
  const signature = hexBytes(request.headers.get('X-Signature-Ed25519') || '', 64);
  const timestamp = request.headers.get('X-Signature-Timestamp') || '';
  const keyBytes = hexBytes((env.DISCORD_PUBLIC_KEY || '').trim(), 32);
  if (!signature || !/^\d{1,12}$/.test(timestamp) || !keyBytes) return false;
  // Reject stale signed requests so a captured one cannot be replayed later.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, signature, encoder.encode(timestamp + body));
  } catch { return false; }
}

export function splitMessage(text) {
  const chunks = [];
  let rest = text.trim();
  while (rest && chunks.length < MAX_CHUNKS) {
    if (rest.length <= MAX_CHUNK) { chunks.push(rest); rest = ''; break; }
    // Prefer to break at a paragraph, then a line, then a space.
    let cut = rest.lastIndexOf('\n\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf(' ', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks[chunks.length - 1] += '\n\n*(Reply shortened: it was too long for Discord.)*';
  return chunks;
}

const BUSY_STATUS = new Set([500, 502, 503, 504]);
// Temporary trouble (overload, rate limit, timeout): worth trying another model.
export class BusyError extends DiscordError {}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function modelName(value) {
  const model = String(value || '').trim();
  if (!/^[a-z0-9.\-]{3,60}$/.test(model)) throw new DiscordError('The saved Gemini model name is not valid. Use /model reset.');
  return model;
}

// ---- Saved model choice and usage counts (D1) ----
const SETTINGS_TABLE = 'CREATE TABLE IF NOT EXISTS discord_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)';
const USAGE_TABLE = 'CREATE TABLE IF NOT EXISTS ai_usage (day TEXT NOT NULL, model TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, model))';
export function database(env) { return typeof env.DB?.withSession === 'function' ? env.DB.withSession('first-primary') : null; }
const today = () => new Date().toISOString().slice(0, 10);
// Discord setting wins over the Cloudflare variable, which wins over the default.
export async function currentModels(env) {
  let saved = {};
  const db = database(env);
  if (db) {
    try {
      const rows = (await db.prepare("SELECT key, value FROM discord_settings WHERE key IN ('model', 'backup')").all()).results || [];
      saved = Object.fromEntries(rows.map(row => [row.key, row.value]));
    } catch { /* Table not created yet: re-register commands. Use defaults meanwhile. */ }
  }
  const pick = (stored, variable, fallback) => stored ? [stored, 'set in Discord']
    : (variable || '').trim() ? [variable.trim(), 'Cloudflare variable'] : [fallback, 'default'];
  const [main, mainSource] = pick(saved.model, env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL);
  const [backup, backupSource] = pick(saved.backup, env.GEMINI_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL);
  return { main: modelName(main), mainSource, backup: modelName(backup), backupSource };
}
export async function recordUsage(env, model, limited = false) {
  const db = database(env);
  if (!db) return;
  try {
    await db.prepare('INSERT INTO ai_usage (day, model, requests, limited) VALUES (?, ?, 1, ?) ON CONFLICT(day, model) DO UPDATE SET requests = requests + 1, limited = limited + excluded.limited')
      .bind(today(), model, limited ? 1 : 0).run();
  } catch { /* Counting is best effort and must never block an answer. */ }
}
let modelCache = { at: 0, models: [] };
// Text-chat Gemini models this key can call. Google's list does not include remaining quota.
export async function listModels(env, timeout = 5000) {
  if (Date.now() - modelCache.at < 600000 && modelCache.models.length) return modelCache.models;
  let response;
  try {
    response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      signal: AbortSignal.timeout(timeout), headers: { 'x-goog-api-key': env.GEMINI_API_KEY.trim() } });
  } catch { throw new DiscordError('Google did not answer in time. Try again.'); }
  if (!response.ok) throw new DiscordError(`Google returned HTTP ${response.status} for the model list. Check GEMINI_API_KEY.`);
  const data = await response.json();
  const models = (data.models || [])
    .filter(m => typeof m.name === 'string' && m.name.startsWith('models/gemini') &&
      (m.supportedGenerationMethods || []).includes('generateContent') &&
      !/(embedding|tts|image|audio|live|robotics|computer-use)/.test(m.name))
    .map(m => ({ id: m.name.slice(7), label: String(m.displayName || m.name.slice(7)).slice(0, 60) }))
    .filter(m => /^[a-z0-9.\-]{3,60}$/.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), models };
  return models;
}
function systemPrompt(env, extra = '') {
  return `You are Pocket Agent, a helpful personal assistant answering in Discord. Reply in the language the user writes in (Hong Kong Cantonese in Traditional Chinese if they write Chinese). Be concise and practical; Discord markdown is allowed. You have no access to the user's calendar, email or files and cannot take actions; never claim to have done so.${extra} Current UTC time: ${new Date().toISOString()}. User timezone: ${env.CALENDAR_TIME_ZONE || 'Europe/Copenhagen'}.`;
}
async function geminiOnce(env, model, body, timeout) {
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY.trim() },
      body: JSON.stringify(body),
    });
  } catch { await recordUsage(env, model); throw new BusyError('Gemini did not answer in time.'); }
  await recordUsage(env, model, response.status === 429);
  // Never include Gemini's error body: it can echo request details.
  if (response.status === 429) throw new BusyError('Gemini free limit reached for now.');
  if (BUSY_STATUS.has(response.status)) throw new BusyError(`Gemini is overloaded (HTTP ${response.status}).`);
  if (response.status === 400 || response.status === 401 || response.status === 403)
    throw new DiscordError(`Gemini refused the request (HTTP ${response.status}) for \`${model}\`. Check GEMINI_API_KEY in Cloudflare, or pick another model with /model set.`);
  if (response.status === 404) throw new DiscordError(`Gemini model \`${model}\` not found. Pick a current one with /model list and /model set.`);
  if (!response.ok) throw new DiscordError(`Gemini is unavailable (HTTP ${response.status}). Please try again later.`);
  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(part => typeof part.text === 'string' && !part.thought ? part.text : '').join('').trim();
  if (!text) {
    if (data?.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') throw new DiscordError('Gemini declined to answer that question.');
    throw new BusyError('Gemini returned an empty answer.');
  }
  const sources = [];
  for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
    const uri = chunk?.web?.uri;
    if (typeof uri === 'string' && /^https:\/\//.test(uri) && sources.length < 5)
      sources.push(`- [${String(chunk.web.title || 'source').replace(/[\[\]\n]/g, '').slice(0, 80)}](<${uri}>)`);
  }
  return sources.length ? `${text}\n\n**Sources**\n${sources.join('\n')}` : text;
}

// Tries the main model, retries it once if overloaded, then the lighter model.
// Discord allows about 30 seconds of background work, so every step respects a deadline.
// Returns { text, model } so the reply can say which model answered.
export async function askGemini(env, question, web, deadline = Date.now() + 20000, models = null, extra = '') {
  const { main: primary, backup: fallback } = models || await currentModels(env);
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(env, extra) }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: { maxOutputTokens: 2048, temperature: 0.6 },
  };
  if (web) body.tools = [{ google_search: {} }];
  const attempts = [[primary, 9000], [primary, 6000], [fallback, 7000]];
  let last;
  for (let i = 0; i < attempts.length; i++) {
    const [model, limit] = attempts[i];
    // A rate limit won't clear in a second, so skip the same-model retry; go to the lighter model.
    if (i === 1 && /limit/.test(last.message)) continue;
    if (i === 2 && model === primary) break;
    if (i === 1) await sleep(800);
    const left = deadline - Date.now();
    if (left < 2500) break;
    try { return { text: await geminiOnce(env, model, body, Math.min(limit, left)), model }; }
    catch (error) { if (!(error instanceof BusyError)) throw error; last = error; }
  }
  throw last || new BusyError('Gemini did not answer in time.');
}

// Free backup: the Cloudflare Workers AI model already used for voice chat.
export async function askCloudflare(env, question, deadline, extra = '') {
  const left = deadline - Date.now();
  if (left < 2000) throw new Error('no time left');
  let timer;
  await recordUsage(env, 'cloudflare-ai');
  const result = await Promise.race([
    env.AI.run(CLOUDFLARE_MODEL, {
      messages: [{ role: 'system', content: systemPrompt(env, extra + ' You cannot search the web.') }, { role: 'user', content: question }],
      max_completion_tokens: 900, temperature: 0.6, stream: false, chat_template_kwargs: { enable_thinking: false },
    }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), left); }),
  ]).finally(() => clearTimeout(timer));
  return answerText(result);
}

async function sendFollowUp(env, token, chunks) {
  const hook = `${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;
  for (let i = 0; i < chunks.length; i++) {
    // allowed_mentions blocks AI text from pinging anyone.
    await fetch(i === 0 ? `${hook}/messages/@original` : hook, {
      method: i === 0 ? 'PATCH' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunks[i], allowed_mentions: { parse: [] } }),
    });
  }
}
async function answer(env, interaction, question, web) {
  const started = Date.now();
  let text;
  try {
    const result = await askGemini(env, question, web, started + 20000);
    text = `${result.text}\n\n-# ${result.model}${web ? ' · web search' : ''}`;
  } catch (error) {
    if (error instanceof BusyError && typeof env.AI?.run === 'function') {
      try { text = `${await askCloudflare(env, question, started + 27000)}\n\n-# Answered by Cloudflare AI because Gemini was busy (${error.message.replace(/\.$/, '')}).`; }
      catch { text = `⚠️ ${error.message} The Cloudflare AI backup also failed. Please try again in a minute.`; }
    } else {
      text = `⚠️ ${error instanceof DiscordError ? error.message : 'Something went wrong.'} Please try again in a minute.`;
    }
  }
  const quoted = question.length > 200 ? question.slice(0, 200) + '…' : question;
  try { await sendFollowUp(env, interaction.token, splitMessage(`> ${quoted.replace(/\n/g, ' ')}\n\n${text}`)); }
  catch { /* Discord unreachable: nothing else to report to. Never log content or tokens. */ }
}
function ephemeral(content) {
  return json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
}
const DEFER_PRIVATE = () => json({ type: 5, data: { flags: 64 } });
async function privateFollowUp(env, interaction, work) {
  let text;
  try { text = await work(); }
  catch (error) { text = `⚠️ ${error instanceof DiscordError || error instanceof TaskError ? error.message : 'Something went wrong. Please try again.'}`; }
  try { await sendFollowUp(env, interaction.token, splitMessage(text)); } catch { /* Discord unreachable. */ }
}
function describeModels(models) {
  return `**Main model:** \`${models.main}\` (${models.mainSource})\n**Backup model:** \`${models.backup}\` (${models.backupSource})\n` +
    '-# When the main model is busy, /ask retries it once, then uses the backup, then the free Cloudflare AI.';
}
async function modelList(env) {
  const [models, current] = await Promise.all([listModels(env), currentModels(env)]);
  if (!models.length) return 'Google returned no Gemini chat models for this key.';
  const lines = models.map(m => `${m.id === current.main ? '✅' : m.id === current.backup ? '🔁' : '•'} \`${m.id}\` — ${m.label}`);
  return `**Gemini models your key can use** (✅ main, 🔁 backup)\n${lines.join('\n')}\n\n` +
    `-# Names ending in -latest follow Google's newest version. Pro models have much lower free limits. Change with /model set.`;
}
async function setModel(env, name, backup) {
  const id = name.replace(/^models\//, '').trim().toLowerCase();
  if (!/^[a-z0-9.\-]{3,60}$/.test(id)) throw new DiscordError('That is not a valid model name. Use /model list to see the options.');
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}`, {
      signal: AbortSignal.timeout(8000), headers: { 'x-goog-api-key': env.GEMINI_API_KEY.trim() } });
  } catch { throw new DiscordError('Google did not answer in time. Try again.'); }
  if (response.status === 404 || response.status === 400) throw new DiscordError(`Google has no model called \`${id}\`. Use /model list to see the options.`);
  if (!response.ok) throw new DiscordError(`Google returned HTTP ${response.status}. Try again later.`);
  const info = await response.json();
  if (!(info.supportedGenerationMethods || []).includes('generateContent'))
    throw new DiscordError(`\`${id}\` can't answer chat questions. Pick another from /model list.`);
  await saveSetting(env, backup ? 'backup' : 'model', id);
  return `Saved. /ask now uses \`${id}\` as its ${backup ? 'backup' : 'main'} model.\n\n${describeModels(await currentModels(env))}`;
}
async function saveSetting(env, key, value) {
  const db = database(env);
  if (!db) throw new DiscordError('The database is not connected, so the choice cannot be saved.');
  try {
    await db.prepare('INSERT INTO discord_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, value).run();
  } catch { throw new DiscordError('Could not save the choice. Open /admin and tap Register Discord commands once, then try again.'); }
}
// The channel where Siri questions and answers are posted, set from /panel.
export async function siriChannel(env) {
  const db = database(env);
  if (!db) return null;
  try {
    const row = await db.prepare("SELECT value FROM discord_settings WHERE key = 'siri_channel'").first();
    return /^\d{15,22}$/.test(row?.value || '') ? row.value : null;
  } catch { return null; }
}
// Posts as the bot. Needs View Channel and Send Messages in that channel.
export async function postToChannel(env, channelId, text, extra = {}) {
  if (!/^\d{15,22}$/.test(channelId || '') || !(env.DISCORD_BOT_TOKEN || '').trim()) return false;
  let ok = true;
  const chunks = splitMessage(text);
  const send = body => fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...body }),
  });
  for (const [index, chunk] of chunks.entries()) {
    // Buttons go on the last part only.
    const last = index === chunks.length - 1 && Object.keys(extra).length > 0;
    try {
      let response = await send({ content: chunk, ...(last ? extra : {}) });
      if (!response.ok) {
        await notePostProblem(env, response);
        // If Discord refuses the buttons, still deliver the text.
        if (last && response.status === 400) response = await send({ content: chunk });
      }
      ok &&= response.ok;
    } catch { ok = false; }
  }
  return ok;
}
// Keeps only Discord's error code and short message (never message content or tokens),
// so /panel can show why a post failed.
async function notePostProblem(env, response) {
  let detail = '';
  try { const info = await response.clone().json(); detail = `${info.code ?? ''} ${String(info.message ?? '')}`.trim().slice(0, 150); } catch { /* not JSON */ }
  const db = database(env);
  if (!db) return;
  try {
    await db.prepare('INSERT INTO discord_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('post_problem', `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: HTTP ${response.status}${detail ? ' ' + detail : ''}`).run();
  } catch { /* settings table missing */ }
}
async function postProblem(env) {
  const db = database(env);
  if (!db) return '';
  try { return (await db.prepare("SELECT value FROM discord_settings WHERE key = 'post_problem'").first())?.value || ''; } catch { return ''; }
}
async function resetModels(env) {
  const db = database(env);
  if (db) { try { await db.prepare("DELETE FROM discord_settings WHERE key IN ('model', 'backup')").run(); } catch { /* nothing saved yet */ } }
  return `Back to the defaults.\n\n${describeModels(await currentModels(env))}`;
}
async function usageRows(env) {
  const db = database(env);
  if (!db) return [];
  try {
    // Keep about a month of counts.
    await db.prepare('DELETE FROM ai_usage WHERE day < ?').bind(new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10)).run();
    return (await db.prepare('SELECT model, requests, limited FROM ai_usage WHERE day = ? ORDER BY requests DESC').bind(today()).all()).results || [];
  } catch { return []; /* table not created yet */ }
}
function usageLines(rows) {
  return rows.length
    ? rows.map(r => `• \`${r.model}\`: ${r.requests} request${r.requests === 1 ? '' : 's'}${r.limited ? ` (${r.limited} hit the free limit)` : ''}`).join('\n')
    : 'No AI requests yet today.';
}
async function usageReport(env) {
  const body = usageLines(await usageRows(env));
  return `**AI requests today** (${today()}, UTC)\n${body}\n\n` +
    `-# Counted by Pocket Agent; retries count separately. Google doesn't report remaining quota to apps, so check your limits and usage at <${LIMITS_URL}>. Free limits reset daily (Pacific time).`;
}
async function autocomplete(env, interaction) {
  const set = interaction.data?.options?.find(o => o.name === 'set');
  const typed = String(set?.options?.find(o => o.focused)?.value || '').toLowerCase().slice(0, 60);
  let models = [];
  try { models = await listModels(env, 2000); } catch { /* answer with no suggestions */ }
  const choices = models.filter(m => m.id.includes(typed) || m.label.toLowerCase().includes(typed)).slice(0, 25)
    .map(m => ({ name: `${m.id} — ${m.label}`.slice(0, 100), value: m.id }));
  return json({ type: 8, data: { choices } });
}

// Cancel button under a deadline message: removes the calendar event and strikes the message through.
async function cancelFromButton(env, interaction) {
  const id = Number(interaction.data.custom_id.split(':')[2]);
  const original = String(interaction.message?.content || '');
  let content;
  try {
    const task = await cancelTask(env, id);
    const chinese = isChinese(task.title + (task.notes || ''));
    content = `~~${task.title} — ${describeDue(task, chinese)}~~\n${chinese ? '❌ 已取消，並已由日曆刪除。' : '❌ Cancelled and removed from the calendar.'}`;
  } catch (error) {
    const reason = error instanceof TaskError || error instanceof DiscordError ? error.message : 'Something went wrong.';
    await editOriginal(env, interaction.token, { content: `${original}\n\n⚠️ ${reason}`.slice(0, 2000) });
    return;
  }
  await editOriginal(env, interaction.token, { content, components: [] });
}

// ---- /panel: one private message with menus and buttons ----
async function editOriginal(env, token, payload) {
  try {
    await fetch(`${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`, {
      method: 'PATCH', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
    });
  } catch { /* Discord unreachable. Never log content or tokens. */ }
}
export async function panelMessage(env, note = '') {
  const [current, rows, channel, problem] = await Promise.all([currentModels(env), usageRows(env), siriChannel(env), postProblem(env)]);
  let models = [], listProblem = '';
  if ((env.GEMINI_API_KEY || '').trim()) {
    try { models = await listModels(env, 2500); } catch { listProblem = "Couldn't load Google's model list just now; press Refresh."; }
  }
  // Chosen models first so they always appear, even past Discord's 25-option limit.
  const seen = new Set();
  const ordered = [{ id: current.main, label: 'Current main model' }, { id: current.backup, label: 'Current backup model' }, ...models]
    .filter(m => !seen.has(m.id) && seen.add(m.id)).map(m => models.find(x => x.id === m.id) || m).slice(0, 25);
  const options = selected => ordered.map(m => ({ label: m.id.slice(0, 100), description: m.label.slice(0, 100), value: m.id, default: m.id === selected }));
  const embed = {
    title: 'Pocket Agent control panel', color: 0x174ab9,
    fields: [
      { name: 'Main model', value: `\`${current.main}\`\n-# ${current.mainSource}`, inline: true },
      { name: 'Backup model', value: `\`${current.backup}\`\n-# ${current.backupSource}`, inline: true },
      { name: 'Siri, deadline and daily-summary messages go to', value: channel ? `<#${channel}>` : 'Not set: press **Send Siri & deadline updates here** in the channel you want.', inline: false },
      { name: `Requests today (${today()} UTC)`, value: usageLines(rows).slice(0, 1000), inline: false },
      ...(problem ? [{ name: 'Last Discord posting problem', value: problem.slice(0, 1000), inline: false }] : []),
    ],
    footer: { text: `${listProblem ? listProblem + ' ' : ''}Google doesn't share remaining quota with apps: use "Quota on Google" to see it.`.slice(0, 2000) },
  };
  const components = [];
  if (ordered.length) {
    components.push({ type: 1, components: [{ type: 3, custom_id: 'panel:main', placeholder: 'Choose the main model', options: options(current.main) }] });
    components.push({ type: 1, components: [{ type: 3, custom_id: 'panel:backup', placeholder: 'Choose the backup model', options: options(current.backup) }] });
  }
  components.push({ type: 1, components: [
    { type: 2, style: 2, custom_id: 'panel:refresh', label: 'Refresh', emoji: { name: '🔄' } },
    { type: 2, style: 1, custom_id: 'panel:siri', label: 'Send Siri & deadline updates here', emoji: { name: '🎙️' } },
    { type: 2, style: 4, custom_id: 'panel:reset', label: 'Reset models' },
    { type: 2, style: 5, url: LIMITS_URL, label: 'Quota on Google' },
    { type: 2, style: 2, custom_id: 'help:home', label: 'Help', emoji: { name: '❓' } },
  ] });
  return { content: note, embeds: [embed], components };
}
async function panelAction(env, interaction) {
  const id = interaction.data?.custom_id;
  if (id === 'panel:main' || id === 'panel:backup') {
    const value = String(interaction.data.values?.[0] || '');
    const current = await currentModels(env);
    let offered = [];
    try { offered = await listModels(env, 2500); } catch { /* checked below */ }
    if (!offered.some(m => m.id === value) && value !== current.main && value !== current.backup)
      return panelMessage(env, '⚠️ That model is not offered any more. Press Refresh.');
    await saveSetting(env, id === 'panel:main' ? 'model' : 'backup', value);
    return panelMessage(env, `✅ ${id === 'panel:main' ? 'Main' : 'Backup'} model is now \`${value}\`.`);
  }
  if (id === 'panel:reset') { await resetModels(env); return panelMessage(env, '✅ Models reset to the defaults.'); }
  if (id === 'panel:siri') {
    const channel = String(interaction.channel_id || '');
    if (!/^\d{15,22}$/.test(channel)) return panelMessage(env, '⚠️ Open the panel inside a server channel to choose it for Siri.');
    await saveSetting(env, 'siri_channel', channel);
    const posted = await postToChannel(env, channel, '🎙️ Siri answers, new deadlines and the morning summary will be posted in this channel.');
    return panelMessage(env, posted ? '✅ Siri answers will be posted in this channel.'
      : "⚠️ Saved, but the bot couldn't post here. Give the Pocket Agent bot View Channel and Send Messages in this channel.");
  }
  return panelMessage(env, id === 'panel:refresh' ? '🔄 Refreshed.' : '');
}
async function panelUpdate(env, token, work) {
  let payload;
  try { payload = await work(); }
  catch (error) {
    const note = `⚠️ ${error instanceof DiscordError ? error.message : 'Something went wrong. Please try again.'}`;
    try { payload = await panelMessage(env, note); } catch { payload = { content: note, embeds: [], components: [] }; }
  }
  await editOriginal(env, token, payload);
}

// ---- /help: a private guide with one page per topic; buttons switch pages in place ----
const HELP_PAGES = {
  home: { label: '總覽', emoji: '📖', title: 'Pocket Agent 使用說明', text: [
    'Pocket Agent 將 **Discord**、**iPhone Siri**、**Gmail／學校 Outlook** 同 **日曆** 連埋一齊。',
    '',
    '**成個系統點運作**',
    '🎙️ 你問 Siri「問助手」→ Gemini 答你（讀出嚟）→ 同一份問答貼落 Discord',
    '📌 你講「記低」→ AI 搵出日期同分類 → 加入對應嘅 **Agent** 日曆（iPhone 日曆 App 都見到）→ Discord 出一張卡',
    '📬 Gmail 每 15 分鐘檢查新郵件 → 搵到 deadline → 同樣加入日曆 + Discord 卡',
    '☀️ 每朝自動貼未來 7 日要做嘅嘢',
    '',
    '**撳下面嘅掣睇每部分詳細說明** 👇',
    '-# 只有你睇到呢個訊息。隨時打 /help 再開。',
  ] },
  discord: { label: 'Discord 指令', emoji: '💬', title: 'Discord 指令同控制台', text: [
    '**斜線指令（Slash commands）**：喺訊息欄打 `/` 揀',
    '`/help` — 呢份說明',
    '`/ask question: …` — 問 Gemini。加 `web: True` 會先上 Google 搵資料，答案會列出來源',
    '`/todo` — 未來 14 日嘅 deadline 同要做嘅嘢',
    '`/panel` — 控制台（見下面）',
    '`/usage` — 今日用咗幾多次 AI',
    '`/model show` / `list` / `set name:…` / `reset` — 睇／揀／重設 Gemini 模型',
    '',
    '**/panel 控制台**',
    '• 兩個選單（menu）：揀主模型（Main model）同後備模型（Backup model）',
    '• 🔄 **Refresh** — 更新資料',
    '• 🎙️ **Send Siri & deadline updates here** — 喺你想收通知嘅頻道撳，之後 Siri 問答、deadline 卡同每朝摘要都貼去嗰度',
    '• **Reset models** — 返回預設模型',
    '• **Quota on Google** — 去 Google 睇免費額度仲剩幾多',
    '• ❓ **Help** — 開呢份說明',
    '',
    '**頻道入面嘅訊息**',
    '🎙️ Siri 問答　📌 記低　📬 郵件 deadline　☀️ 每朝摘要',
    'deadline 卡下面有 **取消（Cancel）** 掣：撳咗會刪走日曆活動，張卡會劃走。',
    '-# 只有你（擁有者）可以用呢啲指令。改咗指令之後要去 /admin → Register Discord commands。',
  ] },
  iphone: { label: 'iPhone Siri', emoji: '📱', title: 'iPhone 捷徑（Shortcuts）', text: [
    '對住 iPhone 講「嘿 Siri，<捷徑名>」。',
    '',
    '**問助手** — 問任何問題',
    '→ Siri 讀出答案，Discord 頻道會貼埋問答（有格式同連結）',
    '→ 問「我最近有乜嘢要做？」「今個星期有咩功課要交？」會直接讀出未來 7 日嘅 deadline，Discord 會列埋出嚟',
    '',
    '**記低** — 例：「記低星期五交 COMP2011 功課」',
    '→ 加入 **Agent** 日曆，Discord 出一張 📌 卡',
    '',
    '**我有咩要做** — 讀出未來 7 日要做嘅嘢',
    '',
    '**每個捷徑嘅設定**（捷徑 App → 取得 URL 內容（Get Contents of URL））',
    '• 方法（Method）：**POST**',
    '• 標頭（Headers）：`Authorization` = `Bearer ps1_…`（你嘅 Siri key）',
    '• 要求本文（Request Body）：**JSON**',
    '　問助手：`question` = 聽寫文字（Dictate Text）',
    '　記低：`note` = 聽寫文字',
    '　我有咩要做：`agenda` = 布林值（Boolean）**true**',
    '• 之後：取得辭典值（Get Dictionary Value）`answer` → 朗讀（Speak）',
    '揀變數：撳欄位 → **選取變數（Select Variable）** → 撳上面嘅「聽寫文字」動作。',
    '',
    '**限制**：每分鐘 6 次，每日 150 次。',
    '-# 詳細步驟：GitHub 入面嘅 SIRI-SETUP.md 同 MAIL-SETUP.md。',
  ] },
  mail: { label: '電郵同日曆', emoji: '📬', title: '電郵、日曆同每朝摘要', text: [
    '**Gmail**：Google Apps Script 每 15 分鐘檢查收件匣（Inbox）最近 2 日嘅新郵件（唔睇推廣 Promotions 同社交 Social）。',
    '**學校 Outlook**：自動轉寄去 Gmail，Gmail 篩選器加「學校」標籤。⚠️ 唔好揀「略過收件匣（Skip the Inbox）」，否則程式睇唔到。',
    '',
    '搵到 deadline → 加入 Google 日曆 → iPhone 日曆 App 都見到 → Discord 出 📬 卡。',
    '',
    '**日曆分類**：AI 會自動揀一個，每個分類係一個獨立日曆，有自己嘅顏色：',
    '📚 Agent · 功課　💼 Agent · 工作　🏠 Agent · 家庭　🎂 Agent · 生日（每年重複）　👤 Agent · 個人',
    '舊嘅黃色 **Agent** 日曆保留舊活動。',
    '想改顏色或者收埋某個分類：iPhone 日曆 App → 最底 **日曆（Calendars）** → 撳分類旁邊嘅 ⓘ → **顏色（Color）**；剔走就唔顯示。',
    '自己手動加活動時，都可以喺 **日曆（Calendar）** 嗰欄揀呢啲分類。',
    '',
    '**每朝摘要** ☀️：每日 06:00 UTC 自動貼未來 7 日要做嘅嘢。',
    '',
    '**私隱**：郵件內容只交俾 Cloudflare Workers AI 分析，唔會俾 Gemini，亦唔會記錄。',
    '',
    '⚠️ Gmail 儲存空間滿咗就收唔到新郵件，deadline 都會偵測唔到。',
    '-# 詳細步驟：GitHub 入面嘅 MAIL-SETUP.md。',
  ] },
  fix: { label: '出事點算', emoji: '🛠️', title: '出事點算', text: [
    '**Siri 答咗但 Discord 冇出**',
    '→ 開 /panel 睇「Siri, deadline and daily-summary messages go to」有冇設定頻道；冇就喺頻道撳 🎙️ **Send Siri & deadline updates here**',
    '→ 睇 /panel 有冇「**Last Discord posting problem**」，有就將嗰行影低',
    '→ Bot 要喺頻道有 **View Channel** 同 **Send Messages** 權限',
    '',
    '**Gemini 好慢／答唔到**',
    '→ 免費額度可能用晒：撳 /panel → **Quota on Google** 睇',
    '→ 系統會自動試後備模型，再唔得就用 Cloudflare AI',
    '',
    '**Siri 話「limit reached」** → 每分鐘 6 次／每日 150 次，等一陣再試',
    '',
    '**指令唔見咗／Unknown command** → /admin → **Register Discord commands**',
    '',
    '**日曆冇加到** → 去 /admin 撳 **Reconnect Google**（重新連接 Google）',
  ] },
};
export function helpMessage(page = 'home') {
  const current = HELP_PAGES[page] ? page : 'home';
  const { title, text } = HELP_PAGES[current];
  return {
    flags: 64, allowed_mentions: { parse: [] },
    embeds: [{ title, description: text.join('\n').slice(0, 4000), color: 0x174ab9 }],
    components: [{ type: 1, components: Object.entries(HELP_PAGES).map(([id, p]) => ({
      type: 2, style: id === current ? 1 : 2, custom_id: `help:${id}`, label: p.label, emoji: { name: p.emoji }, disabled: id === current,
    })) }],
  };
}

export async function discordInteraction(request, env, ctx) {
  try {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const body = await rawBody(request);
    // Discord requires a 401 for bad signatures; it tests this when saving the endpoint.
    if (!await verified(request, env, body)) return json({ error: 'Invalid request signature.' }, 401);
    let interaction;
    try { interaction = JSON.parse(body); } catch { throw new DiscordError('Invalid JSON.'); }
    if (interaction.type === 1) return json({ type: 1 });
    if (![2, 3, 4].includes(interaction.type)) return json({ error: 'Unsupported interaction.' }, 400);
    if (String(interaction.application_id) !== String(env.DISCORD_APPLICATION_ID)) return json({ error: 'Wrong application.' }, 400);
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    const owner = (env.DISCORD_ALLOWED_USER_ID || '').trim();
    const isOwner = Boolean(owner) && userId === owner;
    const name = interaction.data?.name;
    if (interaction.type === 4) {
      if (!isOwner || name !== 'model' || !(env.GEMINI_API_KEY || '').trim()) return json({ type: 8, data: { choices: [] } });
      return autocomplete(env, interaction);
    }
    if (!isOwner) return ephemeral('Sorry, this Pocket Agent only answers its owner.');
    if (typeof interaction.token !== 'string' || !/^[\w.-]{20,500}$/.test(interaction.token)) return json({ error: 'Invalid token.' }, 400);
    if (interaction.type === 3 && /^task:cancel:\d{1,12}$/.test(interaction.data?.custom_id || '')) {
      ctx.waitUntil(cancelFromButton(env, interaction));
      return json({ type: 6 });
    }
    const helpPage = /^help:(\w{1,20})$/.exec(interaction.data?.custom_id || '')?.[1];
    if (interaction.type === 3 && helpPage) {
      // From /help, switch the page in place; from /panel, open the guide as a new private message.
      const inHelp = (interaction.message?.embeds || []).some(e => Object.values(HELP_PAGES).some(p => p.title === e.title));
      return json({ type: inHelp ? 7 : 4, data: helpMessage(helpPage) });
    }
    if (interaction.type === 3) {
      if (!/^panel:(main|backup|refresh|reset|siri)$/.test(interaction.data?.custom_id || '')) return ephemeral('This button is out of date. Open /panel again.');
      // Acknowledge now; the panel message is edited in place once the change is saved.
      ctx.waitUntil(panelUpdate(env, interaction.token, () => panelAction(env, interaction)));
      return json({ type: 6 });
    }
    if (!['ask', 'model', 'usage', 'panel', 'todo', 'help'].includes(name)) return ephemeral('Unknown command. Re-register commands from the setup page.');
    if (name === 'todo') {
      ctx.waitUntil(privateFollowUp(env, interaction, async () => `**未來 14 日要做嘅嘢**\n${await agendaMarkdown(env, 14)}\n-# 要取消，撳返嗰項通知下面嘅「取消」掣。`));
      return DEFER_PRIVATE();
    }
    if (name === 'panel') { ctx.waitUntil(panelUpdate(env, interaction.token, () => panelMessage(env))); return DEFER_PRIVATE(); }
    if (name === 'help') return json({ type: 4, data: helpMessage() });
    if (name === 'usage') return ephemeral(await usageReport(env));
    if (name === 'model') {
      const sub = interaction.data.options?.[0];
      if (sub?.name === 'show') return ephemeral(describeModels(await currentModels(env)));
      if (sub?.name === 'reset') return ephemeral(await resetModels(env));
      if (!(env.GEMINI_API_KEY || '').trim()) return ephemeral('Gemini is not set up yet: add GEMINI_API_KEY in Cloudflare.');
      if (sub?.name === 'list') { ctx.waitUntil(privateFollowUp(env, interaction, () => modelList(env))); return DEFER_PRIVATE(); }
      if (sub?.name === 'set') {
        const opts = Object.fromEntries((sub.options || []).map(o => [o.name, o.value]));
        if (typeof opts.name !== 'string') return ephemeral('Give a model name, e.g. gemini-flash-latest.');
        ctx.waitUntil(privateFollowUp(env, interaction, () => setModel(env, opts.name, opts.backup === true)));
        return DEFER_PRIVATE();
      }
      return ephemeral('Unknown /model option. Re-register commands from the setup page.');
    }
    const options = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
    const question = typeof options.question === 'string' ? options.question.trim() : '';
    if (!question || question.length > 1500) return ephemeral('Please ask a question under 1,500 characters.');
    if (!(env.GEMINI_API_KEY || '').trim()) return ephemeral('Gemini is not set up yet: add GEMINI_API_KEY in Cloudflare.');
    // Discord needs a reply within 3 seconds, so acknowledge now and answer afterwards.
    ctx.waitUntil(answer(env, interaction, question, options.web === true));
    return json({ type: 5 });
  } catch (error) {
    return json({ error: error instanceof DiscordError ? error.message : 'Discord endpoint unavailable.' },
      error instanceof DiscordError ? error.status : 500);
  }
}

// Called only after the admin session and CSRF checks succeed.
export async function registerCommands(env) {
  const missing = missingDiscordSettings(env).filter(name => name !== 'GEMINI_API_KEY');
  if (missing.length) throw new DiscordError(`Add these settings in Cloudflare first: ${missing.join(', ')}.`, 503);
  const db = database(env);
  if (!db) throw new DiscordError('The D1 database binding DB is missing.', 503);
  // Tables for /model, /usage, /panel and /todo; safe to run again.
  await db.prepare(SETTINGS_TABLE).run();
  await db.prepare(USAGE_TABLE).run();
  await ensureTaskTables(db);
  let response;
  try {
    response = await fetch(`${API}/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
      method: 'PUT', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
    });
  } catch { throw new DiscordError('Discord could not be reached. Try again.', 502); }
  if (response.status === 401) throw new DiscordError('Discord rejected DISCORD_BOT_TOKEN. Reset the bot token and update the secret.', 502);
  if (!response.ok) throw new DiscordError(`Discord returned HTTP ${response.status}. Check DISCORD_APPLICATION_ID.`, 502);
  return COMMANDS.map(c => '/' + c.name);
}
export { DiscordError };
