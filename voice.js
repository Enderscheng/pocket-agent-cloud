// Voice chat is deliberately text-only and has no calendar, notes, or shell tools.
const MODEL = '@cf/zai-org/glm-4.7-flash';
const encoder = new TextEncoder();
class VoiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function hash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function pairVoice(db) {
  // Only invoked after the existing admin session and CSRF checks succeed.
  await db.prepare('CREATE TABLE IF NOT EXISTS voice_device (id INTEGER PRIMARY KEY CHECK (id = 1), token_hash TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS voice_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL)').run();
  const key = 'pv1_' + Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  await db.prepare('INSERT INTO voice_device (id, token_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash')
    .bind(await hash(key)).run();
  return key;
}
async function bodyJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new VoiceError('Missing conversation.');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new VoiceError('Conversation is too large. Start a new chat.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw new VoiceError('Invalid conversation JSON.'); }
}
export function validateMessages(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 11)
    throw new VoiceError('Send between 1 and 11 conversation messages.');
  let size = 0;
  const messages = body.messages.map((message, index) => {
    // Alternating user/assistant turns only. Never accept client system prompts or tools.
    if (!message || message.role !== (index % 2 === 0 ? 'user' : 'assistant') ||
        typeof message.content !== 'string' || !message.content.trim() || message.content.length > 4000)
      throw new VoiceError('Invalid message. Keep each turn under 4,000 characters.');
    size += message.content.length;
    return { role: message.role, content: message.content.trim() };
  });
  if (messages.at(-1).role !== 'user' || size > 20000) throw new VoiceError('Conversation is too long or has no new question. Start a new chat.');
  return messages;
}
async function allowance(db, bucket, limit) {
  // Atomic and global to this personal deployment; rotating a key cannot reset quotas.
  const result = await db.prepare('INSERT INTO voice_limits (bucket, used) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used')
    .bind(bucket, limit).first();
  if (!result) throw new VoiceError('Chat limit reached. Please try later. (8 requests/minute, 100/day UTC.)', 429);
}
export function answerText(result) {
  const choice = result?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new VoiceError('The reply was too long. Please ask a shorter question.', 502);
  let text = typeof result?.response === 'string' ? result.response : choice?.message?.content;
  if (typeof text !== 'string') throw new VoiceError('The AI returned no spoken reply. Please try again.', 502);
  // Some reasoning models put private intermediate text in a separate field or tags.
  // Do not read reasoning_content, tool_calls, or unfinished <think> content aloud.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (/<\/?think>/i.test(text) || !text || text.length > 4000)
    throw new VoiceError('The AI could not finish a short reply. Please try again.', 502);
  return text;
}
export async function voiceChat(request, env) {
  try {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    let base;
    try { base = new URL(env.BASE_URL).origin; } catch { throw new VoiceError('Set BASE_URL in Cloudflare.', 503); }
    if (new URL(request.url).origin !== base ||
        (request.headers.has('Origin') && request.headers.get('Origin') !== base))
      throw new VoiceError('Use the production server address.', 403);
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer pv1_[a-f0-9]{64}$/.test(authorization)) throw new VoiceError('Pair this app with a voice key from calendar setup.', 401);
    if (!env.DB?.withSession) throw new VoiceError('The voice database is not configured.', 503);
    const db = env.DB.withSession('first-primary');
    let device;
    try { device = await db.prepare('SELECT token_hash FROM voice_device WHERE id = 1').first(); }
    catch { throw new VoiceError('Open calendar setup and create a voice key first.', 503); }
    const supplied = await hash(authorization.slice(7));
    let mismatch = 0;
    const expected = device?.token_hash || '0'.repeat(64);
    for (let i = 0; i < 64; i++) mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
    if (!device || mismatch) throw new VoiceError('Voice key expired or incorrect. Pair the app again.', 401);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new VoiceError('Expected JSON.', 415);
    const messages = validateMessages(await bodyJSON(request));
    if (typeof env.AI?.run !== 'function') throw new VoiceError('Add the Workers AI binding named AI in Cloudflare, then deploy.', 503);
    const now = new Date().toISOString();
    await allowance(db, 'minute:' + now.slice(0, 16), 8);
    await allowance(db, 'day:' + now.slice(0, 10), 100);
    await db.prepare('DELETE FROM voice_limits WHERE bucket < ? AND bucket LIKE \'minute:%\'').bind('minute:' + now.slice(0, 10)).run();
    await db.prepare('DELETE FROM voice_limits WHERE bucket < ? AND bucket LIKE \'day:%\'').bind('day:' + now.slice(0, 10)).run();
    const system = `You are Pocket Agent, a helpful voice conversation assistant. Default to natural Hong Kong Cantonese in Traditional Chinese; use English when asked. Keep each reply short (usually 2-4 sentences), conversational and suitable for speech; avoid markdown formatting. Ask one question if clarification is needed. You are a cloud language model, not the user's desktop assistant, and have no access to their other chats or files. This version is CHAT ONLY: you have NO tools, NO calendar access, NO Obsidian access, NO reminders, NO web search. You may help draft notes and suggest schedules, but never claim to have saved, scheduled, notified, read an account, or performed any external action. Explicitly explain that actions are not connected yet if the user asks you to do one. Only recent conversation turns are provided; do not claim long-term memory. Current UTC time: ${now}. User timezone: Europe/Copenhagen.`;
    let result;
    try {
      result = await env.AI.run(MODEL, {
        messages: [{ role: 'system', content: system }, ...messages],
        max_completion_tokens: 700, temperature: 0.6, stream: false,
        chat_template_kwargs: { enable_thinking: false },
      });
    } catch {
      throw new VoiceError('Cloud AI is unavailable or its free allowance is exhausted. Check Workers AI in Cloudflare and try later.', 503);
    }
    return json({ reply: answerText(result), model: MODEL, capabilities: ['chat'] });
  } catch (error) {
    // Never log text, phone keys, model errors, Google tokens or request headers.
    return json({ error: error instanceof VoiceError ? error.message : 'Voice service unavailable. Check the deployment and database.' },
      error instanceof VoiceError ? error.status : 503);
  }
}
