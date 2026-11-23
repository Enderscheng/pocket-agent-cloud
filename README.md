# Pocket Agent cloud: calendar setup and voice chat

Version 0.3 adds an owner-only Discord `/ask` command answered by Google Gemini. See [DISCORD-SETUP.md](DISCORD-SETUP.md).

Version 0.2 adds Cantonese voice conversation through the updated iPhone app and Cloudflare Workers AI. Follow [VOICE-SETUP.md](VOICE-SETUP.md) to install and pair. Calendar event actions, reminders, and Obsidian delivery are not implemented yet. The cloud service works independently of your laptop. The original Google/calendar setup instructions follow.

## A. Deploy the service

1. Extract pocket-agent-cloud.zip on Ubuntu.
2. Create a separate GitHub repository named `pocket-agent-cloud`. Public or private is fine. Enable Add README to make the upload interface available.
3. From inside the extracted folder, upload these five FILES directly into the repository root: `worker.js`, `voice.js`, `package.json`, `wrangler.jsonc`, `schema.sql`. Do not upload an enclosing folder or the ZIP. The tests and this README are optional uploads.
4. Sign up or sign in at https://dash.cloudflare.com/ using the Workers Free plan.
5. Open Workers & Pages > Create application. Choose the GitHub import/connection option, authorize access to this repository, and select `pocket-agent-cloud`. Choose a Worker, not a Pages static site.
6. Set the Worker name to `pocket-agent-cloud`. Use the repository root as the root directory. Leave the build command empty and set the deploy command to `npx wrangler deploy`. Cloudflare installs the package.json dependencies during the build.
7. Deploy. Open the production address shown by Cloudflare. It should resemble `https://pocket-agent-cloud.YOUR-SUBDOMAIN.workers.dev` and display **Pocket Agent is online**.

The service can be deployed before adding credentials. Protected setup operations are disabled until configuration is complete. The public address is safe to share for setup assistance; never share your secrets or an OAuth callback URL containing a `code` query parameter.

## B. Create the database

1. In Cloudflare, find D1 SQL Database (under Storage & databases) and create `pocket-agent-db` on the free plan.
2. Open its Console. Paste and run the contents of `schema.sql`. If the console accepts only one statement at a time, run each CREATE TABLE statement separately.
3. Copy its Database ID (a UUID; it is not a password).
4. Edit `wrangler.jsonc` in GitHub. Add a comma after the `observability` entry and add this property, replacing the ID:

```json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "pocket-agent-db",
    "database_id": "REPLACE-WITH-YOUR-DATABASE-ID"
  }
]
```

5. Commit. Cloudflare's connected build should deploy the update. Keep this binding in the file for future deployments; a dashboard-only binding could be lost when deploying configuration from Git.

## C. Create the Google web client

Your Google project, Calendar API, consent screen, and personal test user should already be set up.

1. Open your Pocket Agent project in Google Cloud Console.
2. Open Google Auth Platform > Data Access > Add or remove scopes. Add `openid`, `https://www.googleapis.com/auth/userinfo.email`, and `https://www.googleapis.com/auth/calendar.app.created`. Save.
3. Open Google Auth Platform > Clients > Create client.
4. Choose Web application. Name it `Pocket Agent Cloud`.
5. Under Authorized redirect URIs, add your exact production Worker address followed by `/oauth/callback`, for example:

```text
https://pocket-agent-cloud.YOUR-SUBDOMAIN.workers.dev/oauth/callback
```

6. Create the client. Save its Client ID and Client secret privately. JavaScript origins can be left empty for this server-side flow. A Google API key or service account is not used.

## D. Configure the Worker

Open your Worker in Cloudflare > Settings > Variables and Secrets. Add the following. These are Worker runtime bindings, not the Git build environment.

| Name | Type | Value |
| --- | --- | --- |
| BASE_URL | Text | Your production HTTPS Worker address, without a path |
| GOOGLE_CLIENT_ID | Text | Client ID from Google |
| GOOGLE_CLIENT_SECRET | Secret | Client secret from Google |
| ALLOWED_EMAIL | Secret | The personal Gmail address you added as a test user |
| ADMIN_TOKEN | Secret | A random setup key generated below |
| ENCRYPTION_KEY | Secret | A different random key generated below |
| CALENDAR_TIME_ZONE | Text | `Europe/Copenhagen`, or your preferred IANA timezone |

Generate the two random keys in your Ubuntu terminal. This prints them locally; save them in your password manager and copy each to its matching Cloudflare Secret field:

```bash
python3 - <<'PY'
import secrets
print('ADMIN_TOKEN:', secrets.token_urlsafe(32))
print('ENCRYPTION_KEY:', secrets.token_urlsafe(32))
PY
```

Save/deploy the configuration. Do not put these secret values into GitHub source, the iPhone app, screenshots, or chat. Keep ENCRYPTION_KEY unchanged after connecting Google: it decrypts the stored refresh token. Changing it requires reconnecting Google.

Runtime text variables configured in the dashboard must also be preserved on future Git deployments. Once BASE_URL, GOOGLE_CLIENT_ID, and CALENDAR_TIME_ZONE are known, add them to a `vars` object in wrangler.jsonc (none is a secret). Keep the secret bindings in Cloudflare. Do not use `vars` for ALLOWED_EMAIL or any of the secret keys.

## E. Connect and create your calendar

1. Open the production Worker address in a normal browser tab, not the embedded Cloudflare preview.
2. Click Open calendar setup. Enter ADMIN_TOKEN as the setup key.
3. Click Connect Google. Sign in using the exact personal Gmail account configured in ALLOWED_EMAIL and approve the requested permissions.
4. You should return to setup with your connected email shown.
5. Click Create Agent calendar once. The page should report **Your Agent calendar is ready**.
6. In Google Calendar on the web, check for Agent. In iPhone Apple Calendar, open the Calendars list, refresh it, and look under Gmail. Select Agent. If it is missing after syncing, we will check Google's calendar sync selection.

The scope permits Google access to this integration's app-created calendars, including reading/modifying/deleting their events. This version exposes none of those event operations. The later locked-phone API must enforce its narrower allowed actions in code. Google authentication is separate from the phone's future limited credential: never use ADMIN_TOKEN in a shortcut or the app's locked-phone requests.

Google's External/Testing mode gives Calendar refresh tokens a seven-day lifetime. During the initial test, reconnect using this page when needed; reconnecting preserves the calendar ID. Before relying on the service long term, address the publishing status and any Google requirements for this personal app. Do not interpret the initial test connection as permanent authorization.

## Troubleshooting

- **Pocket Agent is online:** initial deployment worked. It does not yet mean Google is connected.
- **Server online; complete configuration:** add the DB binding, schema, and all required values.
- **redirect_uri_mismatch:** Google must list the exact production address plus `/oauth/callback`, with no extra slash.
- **Access blocked / tester restriction:** ensure the Gmail account is listed under Google Auth Platform > Audience > Test users.
- **Setup session expired:** log in again and restart Connect Google. Setup sessions last 30 minutes; individual OAuth attempts last 10 minutes.
- **Google HTTP 400 when creating a calendar:** access may have expired; reconnect Google. Never paste tokens into chat for diagnosis.
- **Calendar creation could not be confirmed:** check Google Calendar for an existing Agent calendar. The service deliberately pauses retries when a request might have succeeded but its response was lost. Keep the database intact; recover the existing calendar ID before resetting creation state. If Google clearly rejected creation and no calendar exists, an operator can reset `create_state` to `idle` after investigation.
- **Cloudflare build failed:** share the failing build step and error, with secret values omitted.

## Validation and scope

Validated JavaScript execution with 29 protocol checks using mocked Google and D1 services: incorrect credentials, origin and CSRF checks, signed sessions, OAuth state binding and replay, restricted scopes, email restriction, encrypted refresh tokens, reconnect preservation, and duplicate-calendar prevention. The eight SQL statements and single-use/claim behavior were separately checked against SQLite. A local headless Chrome test reproduced the original no-referrer form failure and verified that same-origin preserves the Origin header. The user subsequently verified live Google authorization and creation of the Agent calendar. See VOICE-SETUP.md for voice validation and its remaining device tests.

With Node.js 22 or later, run `npm test` for the protocol checks (no npm dependency installation needed for tests). A deployment requires Wrangler, installed through package.json. Voice chat is supported; action tools are not connected yet.

## References

- Cloudflare dashboard deployment: https://developers.cloudflare.com/workers/get-started/dashboard/
- Cloudflare D1 setup: https://developers.cloudflare.com/d1/get-started/
- Cloudflare secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Google web-server OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
- Calendar permissions: https://developers.google.com/workspace/calendar/api/auth
- Calendar creation: https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert
- Google Testing token expiry: https://developers.google.com/identity/protocols/oauth2#expiration
