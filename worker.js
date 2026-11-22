// Calendar setup only. No public event-writing or AI endpoints are enabled.
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const SCOPES = `openid email ${CALENDAR_SCOPE}`;
const COOKIE = "__Host-pocket-admin";
const encoder = new TextEncoder();
const SESSION_SECONDS = 1800;

class SetupError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(text) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
function random() { return b64(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function equal(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function signingKey(env) {
  return crypto.subtle.importKey("raw", encoder.encode(env.ADMIN_TOKEN),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(env, payload) {
  const body = b64(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(body));
  return `${body}.${b64(signature)}`;
}
async function session(request, env) {
  const cookie = (request.headers.get("Cookie") || "").split(";").map(s => s.trim())
    .find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!cookie || cookie.length > 2048) return null;
  try {
    const parts = cookie.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    if (!await crypto.subtle.verify("HMAC", await signingKey(env), unb64(sig), encoder.encode(body))) return null;
    const value = JSON.parse(new TextDecoder().decode(unb64(body)));
    if (!Number.isInteger(value.exp) || value.exp <= Date.now() / 1000 ||
      typeof value.csrf !== "string" || typeof value.sid !== "string") return null;
    return value;
  } catch { return null; }
}
async function encryptionKey(env) {
  return crypto.subtle.importKey("raw", await digest(`pocket-agent-storage-v1:${env.ENCRYPTION_KEY}`),
    "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv },
    await encryptionKey(env), encoder.encode(value));
  return `${b64(iv)}.${b64(encrypted)}`;
}
async function decrypt(env, value) {
  const [iv, encrypted] = value.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) }, await encryptionKey(env), unb64(encrypted)));
}
function escape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function reply(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  } });
}
function page(title, body, status = 200) {
  return reply(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
    <style>body{font:17px/1.6 system-ui,sans-serif;max-width:680px;margin:60px auto;padding:0 22px;color:#14243b;background:#f6f8fc}main{background:white;padding:28px;border-radius:18px}h1{line-height:1.2}input,button{box-sizing:border-box;font:inherit;padding:12px;width:100%;margin:10px 0}button{background:#174ab9;color:white;border:0;border-radius:8px}code{overflow-wrap:anywhere}a{color:#174ab9}</style>
    <main><h1>${escape(title)}</h1>${body}</main></html>`, status);
}
function redirect(path, headers = {}) { return reply(null, 303, { Location: path, ...headers }); }
function origin(env) {
  try {
    const u = new URL(env.BASE_URL);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error();
    return u.origin;
  } catch { throw new SetupError("Set BASE_URL to the HTTPS address of this Worker, with no path.", 503); }
}
function requireConfig(env) {
  const problems = [];
  if (!env.DB) problems.push("DB: missing D1 database binding");
  else if (typeof env.DB.prepare !== "function" || typeof env.DB.withSession !== "function")
    problems.push("DB: must be a D1 database binding, not a text variable");
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAIL"]) {
    if (typeof env[name] !== "string" || !env[name].trim()) problems.push(`${name}: missing or empty`);
  }
  for (const name of ["ADMIN_TOKEN", "ENCRYPTION_KEY"]) {
    if (typeof env[name] !== "string" || !env[name].trim()) problems.push(`${name}: missing or empty`);
    else if (env[name].trim().length < 32) problems.push(`${name}: must contain at least 32 characters`);
  }
  if (problems.length) {
    // Only fixed setting names and validation reasons are shown, never values.
    throw new SetupError(`Configuration check: ${problems.join("; ")}. Update the production Worker's settings, then deploy and reload this page.`, 503);
  }
  origin(env);
  try { new Intl.DateTimeFormat("en", { timeZone: env.CALENDAR_TIME_ZONE || "Europe/Copenhagen" }); }
  catch { throw new SetupError("CALENDAR_TIME_ZONE must be an IANA timezone such as Europe/Copenhagen.", 503); }
}
async function form(request, env, admin = null) {
  if (request.headers.get("Origin") !== origin(env)) throw new SetupError("Request origin did not match this server.", 403);
  if (!(request.headers.get("Content-Type") || "").startsWith("application/x-www-form-urlencoded"))
    throw new SetupError("Expected a form submission.", 415);
  if (Number(request.headers.get("Content-Length")) > 4096) throw new SetupError("Form is too large.", 413);
  // Stream a bounded body; do not trust Content-Length supplied by the client.
  const reader = request.body?.getReader();
  let body = "", size = 0;
  const decoder = new TextDecoder();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new SetupError("Form is too large.", 413); }
      body += decoder.decode(value, { stream: true });
    }
  }
  body += decoder.decode();
  const data = new URLSearchParams(body);
  if (admin && !await equal(data.get("csrf") || "", admin.csrf)) throw new SetupError("Form expired. Reload the setup page.", 403);
  return data;
}
function csrf(admin) { return `<input type="hidden" name="csrf" value="${escape(admin.csrf)}">`; }
async function googleJSON(url, options) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) }); }
  catch { throw new SetupError("Google could not be reached. Return to setup and try again.", 502); }
  if (!response.ok) {
    const status = response.status;
    // Never include Google's body, tokens, or authorization headers in errors/logs.
    throw new SetupError(`Google returned HTTP ${status}. If access has expired, reconnect Google from setup.`, 502);
  }
  return response.json();
}
async function accessToken(env, link) {
  const data = await googleJSON("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await decrypt(env, link.refresh_cipher), grant_type: "refresh_token",
    }),
  });
  if (!data.access_token) throw new SetupError("Google did not return an access token.", 502);
  return data.access_token;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health")
    return reply(JSON.stringify({ service: "pocket-agent", stage: "calendar-setup", online: true }), 200,
      { "Content-Type": "application/json" });
  if (request.method === "GET" && url.pathname === "/") {
    return page("Pocket Agent is online", "<p>Your cloud service is running.</p><p><a href='/admin'>Open calendar setup</a></p><p>This version connects Google and creates your Agent calendar. Voice commands and notes are not connected yet.</p>");
  }
  const routes = { "/admin": "GET", "/admin/login": "POST", "/admin/logout": "POST",
    "/oauth/start": "POST", "/oauth/callback": "GET", "/admin/create-calendar": "POST" };
  if (!routes[url.pathname]) return page("Not found", "<p>This endpoint is not available.</p>", 404);
  if (request.method !== routes[url.pathname]) return reply("Method not allowed", 405, { Allow: routes[url.pathname] });
  requireConfig(env);
  if (url.origin !== origin(env)) throw new SetupError("Use the configured production Worker address.", 400);
  const admin = await session(request, env);
  if (url.pathname === "/admin/login") {
    const data = await form(request, env);
    if (!await equal(data.get("token") || "", env.ADMIN_TOKEN)) throw new SetupError("Setup key was incorrect.", 401);
    const value = await signSession(env, { sid: random(), csrf: random(), exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS });
    return redirect("/admin", { "Set-Cookie": `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}` });
  }
  if (!admin) {
    if (url.pathname !== "/admin") throw new SetupError("Setup session expired. Sign in again and restart the connection.", 401);
    return page("Calendar setup", "<p>Enter the setup key you saved as ADMIN_TOKEN in Cloudflare.</p><form method='post' action='/admin/login'><label>Setup key<input type='password' name='token' required autocomplete='current-password'></label><button>Continue</button></form>");
  }
  // Use the primary for the OAuth and calendar state, including read-after-write.
  const db = env.DB.withSession("first-primary");
  if (url.pathname === "/admin") {
    const link = await db.prepare("SELECT * FROM integration WHERE id = 1").first();
    let state = "<p>Google is not connected yet.</p>";
    if (link) {
      state = `<p>Connected account: <strong>${escape(link.email)}</strong></p>`;
      if (link.calendar_id) state += "<p><strong>Your Agent calendar is ready.</strong> Find it under your Gmail account in Apple Calendar. Event commands will be added in the next version.</p>";
      else if (link.create_state === "creating" || link.create_state === "uncertain")
        state += "<p>Calendar creation needs checking. Look in Google Calendar for an Agent calendar before retrying; this service will not create another automatically.</p>";
      else state += `<form method='post' action='/admin/create-calendar'>${csrf(admin)}<p>Create one empty calendar named <strong>Agent</strong>.</p><button>Create Agent calendar</button></form>`;
    }
    return page("Calendar setup", `${state}<form method='post' action='/oauth/start'>${csrf(admin)}<button>${link ? "Reconnect" : "Connect"} Google</button></form><p>Google access is limited to calendars created by this integration. No existing personal or university calendar access is requested.</p><form method='post' action='/admin/logout'>${csrf(admin)}<button>Sign out of setup</button></form>`);
  }
  if (url.pathname === "/admin/logout") {
    await form(request, env, admin);
    return redirect("/", { "Set-Cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
  }
  if (url.pathname === "/oauth/start") {
    await form(request, env, admin);
    const state = random(), verifier = random();
    await db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(Date.now()).run();
    await db.prepare("INSERT INTO oauth_states (state_hash, session_id, verifier_cipher, expires_at) VALUES (?, ?, ?, ?)")
      .bind(b64(await digest(state)), admin.sid, await encrypt(env, verifier), Date.now() + 600000).run();
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${origin(env)}/oauth/callback`, response_type: "code", scope: SCOPES,
      access_type: "offline", prompt: "consent", state, login_hint: env.ALLOWED_EMAIL,
      code_challenge: b64(await digest(verifier)), code_challenge_method: "S256",
    }).toString();
    return redirect(auth.toString());
  }
  if (url.pathname === "/oauth/callback") {
    const state = url.searchParams.get("state") || "";
    if (state.length < 32 || state.length > 128) throw new SetupError("Invalid Google connection state.", 403);
    const stored = await db.prepare("DELETE FROM oauth_states WHERE state_hash = ? AND session_id = ? AND expires_at > ? RETURNING verifier_cipher")
      .bind(b64(await digest(state)), admin.sid, Date.now()).first();
    if (!stored) throw new SetupError("This connection attempt expired or was already used. Restart from setup.", 403);
    if (url.searchParams.has("error")) throw new SetupError("Google connection was cancelled or denied. Restart from setup if desired.");
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096) throw new SetupError("Missing Google authorization code.");
    const tokens = await googleJSON("https://oauth2.googleapis.com/token", {
      method: "POST", body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET, code, grant_type: "authorization_code",
        redirect_uri: `${origin(env)}/oauth/callback`, code_verifier: await decrypt(env, stored.verifier_cipher),
      }),
    });
    if (!tokens.access_token || !tokens.scope?.split(" ").includes(CALENDAR_SCOPE))
      throw new SetupError("The required app-created-calendar permission was not granted.", 403);
    const identity = await googleJSON("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (identity.email_verified !== true || typeof identity.email !== "string" || !identity.sub ||
      identity.email.toLowerCase() !== env.ALLOWED_EMAIL.trim().toLowerCase())
      throw new SetupError("Sign in with the personal Gmail account configured for this service.", 403);
    const existing = await db.prepare("SELECT * FROM integration WHERE id = 1").first();
    if (existing && existing.google_sub !== identity.sub)
      throw new SetupError("A different Google account is already connected. Keep the original account.", 409);
    if (!tokens.refresh_token) throw new SetupError("Google did not grant offline access. Restart the connection and approve access.");
    await db.prepare("INSERT INTO integration (id, google_sub, email, refresh_cipher, create_state) VALUES (1, ?, ?, ?, 'idle') ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_cipher = excluded.refresh_cipher WHERE integration.google_sub = excluded.google_sub")
      .bind(identity.sub, identity.email, await encrypt(env, tokens.refresh_token)).run();
    return redirect("/admin");
  }
  if (url.pathname === "/admin/create-calendar") {
    await form(request, env, admin);
    const link = await db.prepare("SELECT * FROM integration WHERE id = 1").first();
    if (!link) throw new SetupError("Connect Google first.");
    if (link.calendar_id) return redirect("/admin");
    if (link.create_state !== "idle") throw new SetupError("Check Google Calendar for an existing Agent calendar before retrying creation.", 409);
    // Refresh before acquiring the creation claim: an expired token is safe to retry.
    const token = await accessToken(env, link);
    const claim = await db.prepare("UPDATE integration SET create_state = 'creating' WHERE id = 1 AND calendar_id IS NULL AND create_state = 'idle'").run();
    if (claim.meta.changes !== 1) throw new SetupError("Calendar creation is already in progress. Reload setup.", 409);
    let calendar;
    try {
      calendar = await googleJSON("https://www.googleapis.com/calendar/v3/calendars", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Agent", timeZone: env.CALENDAR_TIME_ZONE || "Europe/Copenhagen",
          description: "Calendar created by Pocket Agent for your voice requests." }),
      });
      if (!calendar.id) throw new Error("missing_id");
      await db.prepare("UPDATE integration SET calendar_id = ?, create_state = 'ready' WHERE id = 1")
        .bind(calendar.id).run();
    } catch {
      // POST calendars is not idempotent. A lost response can still mean success.
      await db.prepare("UPDATE integration SET create_state = 'uncertain' WHERE id = 1").run();
      throw new SetupError("Calendar creation could not be confirmed. Check Google Calendar for Agent before retrying; automatic retries are paused to prevent duplicates.", 502);
    }
    return redirect("/admin");
  }
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (error) {
      // Do not log requests, callback URLs, authorization codes, or secrets.
      if (error instanceof SetupError) return page("Setup needs attention", `<p>${escape(error.message)}</p><p><a href='/admin'>Return to setup</a></p>`, error.status);
      return page("Setup needs attention", "<p>Check the database binding, schema, and configuration against the setup guide. No secret details are included in this response.</p><p><a href='/admin'>Return to setup</a></p>", 500);
    }
  },
};
