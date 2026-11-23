# Pocket Agent on Discord (Gemini)

Version 0.3 adds an owner-only `/ask` command in Discord, answered by Google Gemini on its free tier. Pocket Agent answers only your Discord account. It cannot reach your calendar, Google account, notes or the phone voice key.

## 1. Discord server and app

1. In Discord: **+** → **Create My Own** → **For me and my friends**. Name it `Pocket Agent`.
2. On a computer, open https://discord.com/developers/applications → **New Application** → name it `Pocket Agent`.
3. **General Information**: note the **Application ID** and **Public Key**.
4. **Bot** → **Reset Token**. Save the token in your password manager. It is a password.
5. **Installation** → under **Guild Install**, add the scopes `applications.commands` and `bot`. Open the **Install Link** and add the app to your `Pocket Agent` server.
6. In Discord **Settings → Advanced**, turn on **Developer Mode**. Tap your own name → **Copy User ID**.

## 2. Gemini key

Create a key at https://aistudio.google.com/apikey. The free tier has per-minute and per-day limits, and Google may use free-tier prompts to improve its products. Don't send private information through `/ask`.

## 3. Cloudflare settings

Open https://dash.cloudflare.com → **Workers & Pages** → **pocket-agent-cloud** → **Settings** → **Variables and Secrets** → **+ Add**:

| Name | Type | Value |
| --- | --- | --- |
| `DISCORD_APPLICATION_ID` | Text | Application ID |
| `DISCORD_PUBLIC_KEY` | Text | Public Key |
| `DISCORD_BOT_TOKEN` | Secret | Bot token |
| `DISCORD_ALLOWED_USER_ID` | Secret | Your Discord user ID |
| `GEMINI_API_KEY` | Secret | Gemini key |
| `GEMINI_MODEL` | Text, optional | Defaults to `gemini-flash-latest` |
| `GEMINI_FALLBACK_MODEL` | Text, optional | Lighter model used when the main one is busy. Defaults to `gemini-flash-lite-latest` |

Deploy the settings. Keep your existing Google and voice settings unchanged.

## 4. Connect Discord to the Worker

Do this after the version with Discord support has deployed.

1. In the Developer Portal, open **General Information** → **Interactions Endpoint URL**. Enter `https://pocket-agent-cloud.enderscheng.workers.dev/discord` and save. Discord sends a signed test request; saving fails if the deployment or `DISCORD_PUBLIC_KEY` is wrong.
2. Open https://pocket-agent-cloud.enderscheng.workers.dev/admin, sign in, and check that the **Discord** section reports every setting present. Tap **Register Discord commands**.
3. In your server, type `/ask question: what's a good 20-minute dinner?`. Add `web: True` to let Gemini search Google first. The answer then lists its sources.

## Troubleshooting

- **Portal says the endpoint could not be verified:** wait for the deployment, then check `DISCORD_PUBLIC_KEY` (64 hex characters, no spaces).
- **`/ask` doesn't appear:** register commands again and restart Discord. Check that the app is installed on the server.
- **"only answers its owner":** `DISCORD_ALLOWED_USER_ID` must be your own user ID, not the server or app ID.
- **Busy Gemini (HTTP 503):** Pocket Agent retries once, then tries the lighter Gemini model, then answers with the free Cloudflare AI. That reply is labelled *Answered by Cloudflare AI* and can't search the web.
- **"Gemini free limit reached":** wait a minute, or until the next day for the daily limit.
- **"Gemini model not found":** set `GEMINI_MODEL` to a current Flash model name from Google AI Studio.
- **"Discord rejected DISCORD_BOT_TOKEN":** reset the bot token and update the secret.

## Validation

Tests in `tests/discord-tests.mjs` cover: signature checks (wrong key, modified body, stale timestamp, unsigned request), owner-only access, deferred replies, keeping the Gemini key out of URLs, hiding model reasoning, safe source links, blocked @mentions, error text that never echoes Gemini's reply, and message splitting. Discord and Gemini are mocked; the live endpoint check needs the deployed Worker.
