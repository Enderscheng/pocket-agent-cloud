// /api/mail: a Google Apps Script in the user's Gmail sends one new email per request.
// Uses its own "mail key" (pm1_...), which can only submit emails for deadline scanning.
import { ingestMail, TaskError } from './tasks.js';

const encoder = new TextEncoder();
const PER_MINUTE = 30;
const PER_DAY = 400;
class MailError extends Error {
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
export async function pairMail(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS mail_device (id INTEGER PRIMARY KEY CHECK (id = 1), token_hash TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS mail_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL)').run();
  const key = 'pm1_' + Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  await db.prepare('INSERT INTO mail_device (id, token_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash')
    .bind(await hash(key)).run();
  return key;
}

// The Apps Script the setup page shows, with the address and key filled in.
export function appsScript(base, key) {
  return `// Pocket Agent: sends new Gmail messages to your Pocket Agent to find deadlines.
// Paste into https://script.google.com, run setup() once, and allow access.
const POCKET_AGENT_URL = '${base}/api/mail';
const POCKET_AGENT_KEY = '${key}';
// Which emails to check. Promotions and social mail are skipped.
const SEARCH = 'in:inbox newer_than:2d -category:promotions -category:social';

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkMail').timeBased().everyMinutes(15).create();
  PropertiesService.getScriptProperties().setProperty('since', String(Date.now() - 24 * 3600 * 1000));
  checkMail();
}

function checkMail() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('since') || Date.now() - 24 * 3600 * 1000);
  const started = Date.now();
  let sent = 0;
  for (const thread of GmailApp.search(SEARCH, 0, 30)) {
    for (const message of thread.getMessages()) {
      if (message.getDate().getTime() <= since || sent >= 25) continue;
      const response = UrlFetchApp.fetch(POCKET_AGENT_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + POCKET_AGENT_KEY },
        payload: JSON.stringify({ source: 'gmail', id: message.getId(), from: message.getFrom(),
          subject: message.getSubject(), date: message.getDate().toISOString(), body: message.getPlainBody().slice(0, 6000) }),
      });
      if (response.getResponseCode() !== 200) {
        // Stop and retry these emails next time.
        console.log('Pocket Agent: HTTP ' + response.getResponseCode() + ' ' + response.getContentText().slice(0, 200));
        return;
      }
      sent++;
    }
  }
  props.setProperty('since', String(started));
}
`;
}

async function bodyJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new MailError('Missing email.');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new MailError('Email is too large.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); } catch { throw new MailError('Invalid JSON.'); }
}
async function allowance(db, bucket, limit) {
  const result = await db.prepare('INSERT INTO mail_limits (bucket, used) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used')
    .bind(bucket, limit).first();
  if (!result) throw new MailError(`Mail limit reached (${PER_MINUTE} a minute, ${PER_DAY} a day).`, 429);
}

export async function mailIngest(request, env, ctx) {
  try {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer pm1_[a-f0-9]{64}$/.test(authorization)) throw new MailError('Missing or malformed mail key.', 401);
    if (request.headers.has('Origin')) throw new MailError('Browser requests are not accepted.', 403);
    if (!env.DB?.withSession) throw new MailError('The database is not configured.', 503);
    const db = env.DB.withSession('first-primary');
    let device;
    try { device = await db.prepare('SELECT token_hash FROM mail_device WHERE id = 1').first(); }
    catch { throw new MailError('Create a Gmail key on the setup page first.', 503); }
    const supplied = await hash(authorization.slice(7));
    const expected = device?.token_hash || '0'.repeat(64);
    let mismatch = 0;
    for (let i = 0; i < 64; i++) mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
    if (!device || mismatch) throw new MailError('Mail key expired or incorrect. Create a new one on the setup page.', 401);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new MailError('Expected JSON.', 415);
    const mail = await bodyJSON(request);
    if (typeof mail?.id !== 'string' || !mail.id.trim() || mail.id.length > 200) throw new MailError('Each email needs an id.');
    const now = new Date().toISOString();
    await allowance(db, 'minute:' + now.slice(0, 16), PER_MINUTE);
    await allowance(db, 'day:' + now.slice(0, 10), PER_DAY);
    await db.prepare("DELETE FROM mail_limits WHERE bucket < ? AND bucket LIKE 'minute:%'").bind('minute:' + now.slice(0, 10)).run();
    await db.prepare("DELETE FROM mail_limits WHERE bucket < ? AND bucket LIKE 'day:%'").bind('day:' + now.slice(0, 10)).run();
    return json(await ingestMail(env, ctx, mail));
  } catch (error) {
    // Never log email content, addresses or keys.
    const known = error instanceof MailError || error instanceof TaskError;
    return json({ error: known ? error.message : 'Mail service unavailable.' }, known ? error.status : 503);
  }
}
