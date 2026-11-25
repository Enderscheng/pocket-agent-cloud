# Ask Pocket Agent with Siri (answers in Discord too)

Say "Hey Siri, Ask Pocket Agent", speak your question, and Siri reads Gemini's answer back. The question and the full answer, with formatting and sources, are also posted to a Discord channel you choose, so you keep a history.

```
Siri → Shortcut (dictation) → Worker /api/siri → Gemini (backup: Cloudflare AI)
                                   ├─→ spoken answer back to Siri
                                   └─→ copy posted in your Discord channel
```

It uses the model chosen in `/panel` or `/model`, and counts toward `/usage`.

## 1. Update Discord (once)

1. Open https://pocket-agent-cloud.enderscheng.workers.dev/admin and sign in.
2. Tap **Register Discord commands**. This adds `/panel`.
3. In Discord, go to the channel where Siri conversations should appear, for example a new `#siri` channel. Type `/panel` and press **🎙️ Send Siri answers here**. The bot posts a confirmation message in the channel.
   - If the panel says the bot couldn't post: open the channel's settings → **Permissions**, add the **Pocket Agent** bot, and allow **View Channel** and **Send Messages**.

## 2. Create a Siri key

1. On the same `/admin` page, tap **Create Siri key**.
2. Copy the `ps1_...` key. It is shown only once. Creating another key cancels the old one.

The Siri key can only ask questions. It can't open setup, change models, read your calendar or use the voice-chat key. Shortcuts keeps it in plain text and may sync it through iCloud. If your phone is lost, create a new key to cancel the old one.

## 3. Build the shortcut on your iPhone

Open **Shortcuts** → **+**. Rename the shortcut **Ask Pocket Agent**, or a Cantonese name such as **問助手** if Siri is set to Cantonese. Don't reuse 同助手傾偈, which opens the voice-chat app.

Add these actions in order:

1. **Dictate Text**
   - Tap the arrow to show options. Set **Language** to the one you'll speak, for example Chinese (Cantonese) or English. Set **Stop Listening** to **After Pause**.
2. **Get Contents of URL**
   - URL: `https://pocket-agent-cloud.enderscheng.workers.dev/api/siri`
   - Tap the arrow to show more options. Set **Method** to **POST**.
   - **Headers** → **Add new header**: key `Authorization`, value `Bearer ` followed by your key. There's one space after Bearer: `Bearer ps1_...`
   - **Request Body**: **JSON** → **Add new field** → **Text**. Key `question`; for the value, tap and choose the **Dictated Text** variable.
3. **Get Dictionary Value**: Get **Value** for key `answer` in **Contents of URL**.
4. **Speak Text**: speak the **Dictionary Value**. Tap the arrow to pick a Cantonese or English voice, to match your language.

Tap ▶︎ once inside Shortcuts. Allow the microphone and the connection to `pocket-agent-cloud.enderscheng.workers.dev` when asked.

**Optional web-search version:** duplicate the shortcut and name it **Search with Pocket Agent**. In **Request Body**, add a **Boolean** field with key `web` set to **True**.

## 4. Use it

- "Hey Siri, Ask Pocket Agent" → speak → pause. Siri reads the answer, and the full version appears in your Discord channel.
- Ask about your own to-dos, for example 「我最近有乜嘢要做？」, 「今個星期有咩功課要交？」 or "What's due this week?": Pocket Agent reads the deadlines for the next 7 days (from 記低 notes and email) instead of asking Gemini, and posts the list in Discord. It reads only items Pocket Agent added, not your other calendars.
- **While the phone is locked:** turn on **Settings → Siri → Allow Siri When Locked**. Shortcuts that dictate and use the internet usually run from the lock screen, but iOS may ask you to unlock for some actions. Test it on your phone.

## Troubleshooting

Siri reads out these messages:

| Siri says | Fix |
| --- | --- |
| "Add your Siri key to the shortcut" | Check the `Authorization` header: `Bearer ps1_...` with one space. |
| "Siri key expired or incorrect" | Create a new key on `/admin` and update the header. |
| "invalid JSON" / "must send JSON" | **Request Body** must be **JSON** with a `question` field. |
| "I did not catch a question" | The dictation was empty. Speak after the listening sound. |
| "Siri limit reached" | 6 questions a minute, 150 a day. Wait and try again. |
| A Gemini limit or busy message | The same as in Discord. `/panel` shows usage. |

If nothing appears in Discord, set the channel with `/panel` → **Send Siri answers here**, and check the bot's permissions in that channel.
