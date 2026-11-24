// Shared Google helpers: base64url, AES-GCM storage encryption and token refresh.
const encoder = new TextEncoder();

export class SetupError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64(text) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
export async function digest(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function encryptionKey(env) {
  return crypto.subtle.importKey("raw", await digest(`pocket-agent-storage-v1:${env.ENCRYPTION_KEY}`),
    "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv },
    await encryptionKey(env), encoder.encode(value));
  return `${b64(iv)}.${b64(encrypted)}`;
}
export async function decrypt(env, value) {
  const [iv, encrypted] = value.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) }, await encryptionKey(env), unb64(encrypted)));
}
export async function googleJSON(url, options) {
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
export async function accessToken(env, link) {
  const data = await googleJSON("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await decrypt(env, link.refresh_cipher), grant_type: "refresh_token",
    }),
  });
  if (!data.access_token) throw new SetupError("Google did not return an access token.", 502);
  return data.access_token;
}

