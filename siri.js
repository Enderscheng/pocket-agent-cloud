// Siri → Gemini → spoken answer, with a copy posted to the Discord channel chosen in /panel.
// Uses its own "Siri key" (ps1_...), which can only ask questions: it cannot change
// models, reach setup, Google Calendar or the voice-chat key.
import { askGemini, askCloudflare, currentModels, BusyError, DiscordError, siriChannel, postToChannel } from './discord.js';

const encoder = new TextEncoder();
const PER_MINUTE = 6;
const PER_DAY = 150;
class SiriError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function hash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

// Only invoked after the admin session and CSRF checks succeed.
export async function pairSiri(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS siri_device (id INTEGER PRIMARY KEY CHECK (id = 1), token_hash TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS siri_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL)').run();
  const key = 'ps1_' + Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  await db.prepare('INSERT INTO siri_device (id, token_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash')
    .bind(await hash(key)).run();
  return key;
}

async function bodyJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new SiriError('Missing question.');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new SiriError('Question is too long.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw new SiriError('The shortcut sent invalid JSON. Check the Request Body is set to JSON.'); }
}
async function allowance(db, bucket, limit) {
  const result = await db.prepare('INSERT INTO siri_limits (bucket, used) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used')
    .bind(bucket, limit).first();
  if (!result) throw new SiriError(`Siri limit reached. Please try later. (${PER_MINUTE} a minute, ${PER_DAY} a day.)`, 429);
}

// Markdown and source links read badly aloud.
export function speakable(text) {
  return text.split(/\n\n\*\*Sources\*\*\n/)[0]
    .replace(/\[([^\]]*)\]\(<?[^)>]*>?\)/g, '$1')
    .replace(/<https?:[^>]+>/g, '')
    .replace(/^\s{0,3}(#{1,6}|[-*•]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|>#]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export async function siriAsk(request, env, ctx) {
  try {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    let base;
    try { base = new URL(env.BASE_URL).origin; } catch { throw new SiriError('Set BASE_URL in Cloudflare.', 503); }
    if (new URL(request.url).origin !== base || (request.headers.has('Origin') && request.headers.get('Origin') !== base))
      throw new SiriError('Use the production server address.', 403);
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer ps1_[a-f0-9]{64}$/.test(authorization)) throw new SiriError('Add your Siri key to the shortcut. Create one on the setup page.', 401);
    if (!env.DB?.withSession) throw new SiriError('The database is not configured.', 503);
    const db = env.DB.withSession('first-primary');
    let device;
    try { device = await db.prepare('SELECT token_hash FROM siri_device WHERE id = 1').first(); }
    catch { throw new SiriError('Create a Siri key on the setup page first.', 503); }
    const supplied = await hash(authorization.slice(7));
    const expected = device?.token_hash || '0'.repeat(64);
    let mismatch = 0;
    for (let i = 0; i < 64; i++) mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
    if (!device || mismatch) throw new SiriError('Siri key expired or incorrect. Create a new one on the setup page.', 401);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
      throw new SiriError('The shortcut must send JSON. Set Request Body to JSON.', 415);
    const body = await bodyJSON(request);
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > 1500) throw new SiriError('I did not catch a question. Please try again.');
    const web = body.web === true || body.web === 'true';
    if (!(env.GEMINI_API_KEY || '').trim()) throw new SiriError('Gemini is not set up yet.', 503);
    const now = new Date().toISOString();
    await allowance(db, 'minute:' + now.slice(0, 16), PER_MINUTE);
    await allowance(db, 'day:' + now.slice(0, 10), PER_DAY);
    await db.prepare("DELETE FROM siri_limits WHERE bucket < ? AND bucket LIKE 'minute:%'").bind('minute:' + now.slice(0, 10)).run();
    await db.prepare("DELETE FROM siri_limits WHERE bucket < ? AND bucket LIKE 'day:%'").bind('day:' + now.slice(0, 10)).run();

    const style = ' This answer will be read aloud by Siri: use plain sentences with no markdown, lists or emoji, and keep it under about 80 words unless the user asks for detail.';
    const started = Date.now();
    let text, model;
    try {
      ({ text, model } = await askGemini(env, question, web, started + 20000, await currentModels(env), style));
    } catch (error) {
      if (!(error instanceof BusyError) || typeof env.AI?.run !== 'function') throw error;
      text = await askCloudflare(env, question, started + 27000, style).catch(() => { throw error; });
      model = 'cloudflare-ai';
    }
    const channel = await siriChannel(env);
    if (channel) {
      const quoted = question.length > 300 ? question.slice(0, 300) + '…' : question;
      ctx.waitUntil(postToChannel(env, channel, `🎙️ **Siri:** ${quoted.replace(/\n/g, ' ')}\n\n${text}\n\n-# ${model}${web ? ' · web search' : ''} · via Siri`));
    }
    return json({ answer: speakable(text) || text, model, posted_to_discord: Boolean(channel) });
  } catch (error) {
    // Spoken by the shortcut, so keep it short. Never log questions, keys or model errors.
    const message = error instanceof SiriError || error instanceof DiscordError ? error.message : 'Pocket Agent is unavailable right now.';
    // Always HTTP 200 so the shortcut reliably reads the message out instead of stopping silently.
    return json({ answer: message, error: message, status: error instanceof SiriError || error instanceof DiscordError ? (error.status || 400) : 503 });
  }
}
