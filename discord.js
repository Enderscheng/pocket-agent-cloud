// Discord slash commands for the owner only: /ask sends one question to Gemini.
// No calendar, Google account, notes or voice-key access is reachable from here.
import { answerText } from './voice.js';
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
}];

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
class BusyError extends DiscordError {}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function modelName(value, fallback) {
  const model = (value || fallback).trim();
  if (!/^[a-z0-9.\-]{3,60}$/.test(model)) throw new DiscordError('GEMINI_MODEL or GEMINI_FALLBACK_MODEL is not a valid model name.');
  return model;
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
  } catch { throw new BusyError('Gemini did not answer in time.'); }
  // Never include Gemini's error body: it can echo request details.
  if (response.status === 429) throw new BusyError('Gemini free limit reached for now.');
  if (BUSY_STATUS.has(response.status)) throw new BusyError(`Gemini is overloaded (HTTP ${response.status}).`);
  if (response.status === 400 || response.status === 401 || response.status === 403)
    throw new DiscordError(`Gemini refused the request (HTTP ${response.status}). Check GEMINI_API_KEY and GEMINI_MODEL in Cloudflare.`);
  if (response.status === 404) throw new DiscordError('Gemini model not found. Set GEMINI_MODEL in Cloudflare to a current model name.');
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
export async function askGemini(env, question, web, deadline = Date.now() + 20000) {
  const primary = modelName(env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL);
  const fallback = modelName(env.GEMINI_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL);
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(env) }] },
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
    try { return await geminiOnce(env, model, body, Math.min(limit, left)); }
    catch (error) { if (!(error instanceof BusyError)) throw error; last = error; }
  }
  throw last || new BusyError('Gemini did not answer in time.');
}

// Free backup: the Cloudflare Workers AI model already used for voice chat.
export async function askCloudflare(env, question, deadline) {
  const left = deadline - Date.now();
  if (left < 2000) throw new Error('no time left');
  let timer;
  const result = await Promise.race([
    env.AI.run(CLOUDFLARE_MODEL, {
      messages: [{ role: 'system', content: systemPrompt(env, ' You cannot search the web.') }, { role: 'user', content: question }],
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
  try { text = await askGemini(env, question, web, started + 20000); }
  catch (error) {
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

export async function discordInteraction(request, env, ctx) {
  try {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const body = await rawBody(request);
    // Discord requires a 401 for bad signatures; it tests this when saving the endpoint.
    if (!await verified(request, env, body)) return json({ error: 'Invalid request signature.' }, 401);
    let interaction;
    try { interaction = JSON.parse(body); } catch { throw new DiscordError('Invalid JSON.'); }
    if (interaction.type === 1) return json({ type: 1 });
    if (interaction.type !== 2) return json({ error: 'Unsupported interaction.' }, 400);
    if (String(interaction.application_id) !== String(env.DISCORD_APPLICATION_ID)) return json({ error: 'Wrong application.' }, 400);
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    const owner = (env.DISCORD_ALLOWED_USER_ID || '').trim();
    if (!owner || userId !== owner) return ephemeral('Sorry, this Pocket Agent only answers its owner.');
    if (interaction.data?.name !== 'ask') return ephemeral('Unknown command. Re-register commands from the setup page.');
    const options = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
    const question = typeof options.question === 'string' ? options.question.trim() : '';
    if (!question || question.length > 1500) return ephemeral('Please ask a question under 1,500 characters.');
    if (!(env.GEMINI_API_KEY || '').trim()) return ephemeral('Gemini is not set up yet: add GEMINI_API_KEY in Cloudflare.');
    if (typeof interaction.token !== 'string' || !/^[\w.-]{20,500}$/.test(interaction.token)) return json({ error: 'Invalid token.' }, 400);
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
