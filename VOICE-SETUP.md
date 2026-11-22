# Pocket Agent voice chat 0.2

This update adds Cantonese spoken conversations to the sideloaded iPhone app. Siri opens the app, Apple speech recognition transcribes your words, Cloudflare Workers AI responds, and the iPhone reads the reply aloud. It is turn-by-turn speech, with a two-second pause ending your turn. It is not a connection to an existing ChatGPT/Codex conversation and does not use an OpenAI account.

## Install and pair

1. In the `pocket-agent` GitHub repository, open Actions and the successful **Add Siri-launched Cantonese voice chat with secure phone pairing** run. Download **PocketAgent-IPA**, extract the outer ZIP, and install `PocketAgent.ipa` using SideStore's + button. Keep the existing bundle identity; install as an update. SideStore's usual refresh requirement remains.
2. Wait for the connected `pocket-agent-cloud` deployment to complete. The repository now supplies the Workers AI binding named `AI`. Keep your existing runtime secrets and Google setup.
3. On your iPhone, open https://pocket-agent-cloud.enderscheng.workers.dev/admin. Sign in using your saved ADMIN_TOKEN if requested. Tap **Create voice key**. This creates the two voice tables automatically; there is no SQL to paste.
4. Copy the new `pv1_...` voice key privately. Creating another key revokes the previous phone key. This key permits chat only; do not put ADMIN_TOKEN in the phone app.
5. Open Pocket Agent → **設定**. Paste the voice key and tap **儲存連線密鑰**.
6. Tap **開始傾偈**. Allow microphone and speech recognition access when iOS asks. Say **你好，我想用廣東話傾偈**. Pause for two seconds, or tap **講完，傳送**.
7. Expect a visible answer and a spoken reply. With **回答後自動再聆聽** enabled, the app listens for another turn when the reply ends. **到我講** interrupts playback. **停止** ends listening and cancels an outstanding request.

## Trigger with Cantonese Siri

1. Open **捷徑 / Shortcuts** → **+** → **Add Action**.
2. Find **Pocket Agent** and select **Start Voice Chat**. Do not use the old test capture action.
3. Name the shortcut **同助手傾偈**.
4. Say **Siri，同助手傾偈**. The app opens and starts listening after permission/setup are complete.

This action requires authentication. Unlock if prompted. The conversation pauses when the app goes into the background or the phone locks; it is not an always-listening locked-phone agent. Existing Siri test actions are retained.

## Scope and data

- Chat only: discuss plans, ask questions, and draft text. It cannot create events, save notes into Obsidian, send messages, or schedule notifications yet. No tools or Google credentials are passed to the model.
- Recent five complete exchanges are included in the next turn, with a smaller history if needed to meet input limits. The screen retains at most 25 exchanges. The conversation is in app memory, not saved in D1; it disappears when the app process ends or you choose a new chat.
- Speech recognition may send audio to Apple. Conversation text goes to your Worker and Cloudflare-hosted AI. The phone key is stored in the device's Keychain and is accessible only while unlocked. D1 stores its SHA-256 hash and usage counts, not chat text.
- Model: `@cf/zai-org/glm-4.7-flash`. This is a multilingual cloud model, not ChatGPT or Codex. Cantonese quality and latency need testing with your actual speech.
- App limits: 8 requests/minute and 100/day (UTC), including failed model attempts. Cloudflare's account-wide free allowance can run out sooner. Keep the Workers Free plan if you require a hard free-plan ceiling; paid plans can incur overage charges. No automatic upgrade or paid model fallback is implemented.

## Troubleshooting

- **No Start Voice Chat action:** install the new IPA, open it once, then use **設定 → 重新註冊 Siri 動作** and recreate the shortcut.
- **Voice key incorrect:** create a new key in the web setup and replace the phone key. Never share either key in chat or screenshots.
- **Workers AI binding missing:** confirm the latest deployment succeeded and the production Worker has an AI binding named `AI`.
- **AI unavailable/free allowance exhausted:** check Workers AI usage and availability in Cloudflare. The app preserves your last question for retry. It does not silently choose a paid service.
- **Speech not available:** check the network and microphone/speech permissions in iPhone Settings. You can still type and send.
- **Reply text but no Cantonese audio:** check the phone's audio route/volume and install a Cantonese voice in iOS spoken-content/accessibility voice settings if needed.
- **Long silence:** listening pauses after 50 seconds. Partial text remains for editing; it is not submitted automatically on recognition errors.

## Validation

Xcode 16.4 / GitHub macOS build passed for version 0.2.0. The previous 29 calendar/OAuth protocol checks passed, along with new voice tests covering authentication, admin isolation, key rotation, invalid messages, bounded request bodies, model error redaction, reasoning-text suppression, preserved context, and per-minute/day limits. Voice SQL was separately validated against SQLite, including the atomic usage cap. Google, D1 and model calls in protocol tests were mocked. Live microphone, Siri handoff, speaker routing and model inference require an iPhone/account test after pairing.

References:
- https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
- https://developers.cloudflare.com/workers-ai/configuration/bindings/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developer.apple.com/documentation/appintents/intentauthenticationpolicy/requiresauthentication
- https://developer.apple.com/documentation/speech/sfspeechrecognizer
