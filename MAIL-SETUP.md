# Deadline 助手設定（Gmail、Outlook、Siri 記低、Apple Calendar）

Pocket Agent 會由以下途徑搵出 deadline 同要做嘅嘢，自動加入 **Agent 日曆**。Agent 日曆已經喺你嘅 Apple Calendar 入面，所以到時 iPhone 會提你。

AI 會幫每件事揀一個分類，放入對應嘅日曆，每個日曆有自己嘅顏色（第一次用到先會自動開）：

| 日曆 | 放咩 |
| --- | --- |
| 📚 Agent · 功課 | 功課、考試、上堂、選科 |
| 💼 Agent · 工作 | 工作、實習、面試、兼職 |
| 🏠 Agent · 家庭 | 屋企人同家庭活動 |
| 🎂 Agent · 生日 | 生日（每年自動重複） |
| 👤 Agent · 個人 | 其他 |

舊嘅黃色 **Agent** 日曆保留之前加嘅活動。想改顏色：iPhone 日曆 App → 最底 **日曆（Calendars）** → 撳分類旁邊嘅 ⓘ → **顏色（Color）**。

- 📧 **Gmail**：每 15 分鐘自動檢查新電郵
- 📧 **Outlook（學校帳戶）**：轉寄去 Gmail 之後一齊檢查
- 🎙️ **Siri「記低…」**：你講，AI 整理好再寫入日曆

每次加入新項目，Discord 都會發通知，下面有 **取消** 掣。AI 搞錯咗就撳佢，日曆入面嗰項會即刻刪除。每朝 7 點（夏天係 8 點），Discord 會發一個「未來 7 日要做嘅嘢」摘要。

```
Gmail ─────────────┐
Outlook → 轉寄 Gmail ┤→ Pocket Agent → Cloudflare AI 搵 deadline ─┐
Siri「記低…」───────┘                                            ├→ Agent 日曆 → Apple Calendar 🔔
                                                                 ├→ Discord 通知（有取消掣）
                                                                 └→ Siri 讀出確認
```

---

## 第 0 步：令 Google 連接唔會每星期失效（重要）

你嘅 Google 項目而家係「測試」模式，Google 每 7 日就會取消一次連接。到時 Pocket Agent 寫唔到入日曆，Siri 會話「加唔到入日曆」。

1. 喺電腦打開 https://console.cloud.google.com，揀你嘅 Pocket Agent 項目。
2. 去 **Google Auth Platform → Audience**（目標對象）。
3. 喺 **Publishing status**（發布狀態）撳 **Publish app**（發布應用程式），然後確認。
4. 打開 https://pocket-agent-cloud.enderscheng.workers.dev/admin，撳 **Reconnect Google**，再登入一次。
   - 如果見到「Google 尚未驗證這個應用程式」，撳 **進階 → 前往 Pocket Agent**。呢個係你自己嘅程式，冇問題。

> 只要 Google 唔要求額外驗證，連接就會一直有效。如果 Google 要求驗證或者唔畀你發布，就話我知。

---

## 第 1 步：更新 Discord

1. 喺 `/admin` 撳 **Register Discord commands**。呢步會加入 `/todo` 指令，同埋建立新嘅資料表。
2. 喺你想收通知嘅頻道（例如 `#siri`）打 `/panel`，撳 **Send Siri & deadline updates here**。之前設定過就唔使再撳。

---

## 第 2 步：Gmail（用 Google Apps Script）

Apps Script 係喺**你自己 Gmail 帳戶入面**運行嘅細程式，免費，亦唔使每星期重新登入。

**A. 攞程式碼**
1. 喺電腦打開 `/admin`，撳 **Create Gmail key and script**。
2. 畫面會顯示一大段程式碼，入面已經填好你嘅密鑰。撳入框入面，**全選再拷貝**。
   - 呢段程式碼只會顯示一次。

**B. 貼入 Apps Script**
1. 打開 https://script.google.com，用**同一個 Gmail 帳戶**登入。
2. 撳 **新專案**（New project）。
3. 刪除編輯器入面原本嘅 `function myFunction() {}`，貼上啱啱拷貝嘅程式碼。
4. 撳左上角「未命名的專案」，改名做 `Pocket Agent`。
5. 撳 💾 儲存。

**C. 第一次執行**
1. 喺上面嘅函式選單揀 **setup**，然後撳 **▶ 執行**（Run）。
2. Google 會問你權限：撳 **審查權限** → 揀你嘅帳戶。
   - 如果見到「Google 尚未驗證這個應用程式」，撳 **進階 → 前往 Pocket Agent（不安全）**。呢個程式係你自己嘅。
3. 撳 **允許**。程式需要讀取 Gmail 同埋連接外部網址。
4. 完成。之後佢會**每 15 分鐘自動檢查一次**，第一次會檢查過去 24 小時嘅電郵。

**檢查有冇運作：**
- 喺 Apps Script 左邊撳 **⏰ 觸發條件**，應該見到一個 `checkMail`，每 15 分鐘執行一次。
- 有 deadline 嘅電郵入嚟之後，Discord 會出現「📬 喺 Gmail 搵到 deadline」。
- 有錯誤嘅話，撳左邊 **執行項目**（Executions）就睇到。

**私隱：**
- 電郵內容只會交畀 **Cloudflare AI** 分析，唔會交畀 Gemini。
- Pocket Agent **唔會儲存電郵內容**，只會記住電郵編號（避免重複處理）同搵到嘅 deadline。
- Discord 通知只會顯示**標題同寄件人**。
- 推廣（Promotions）同社交（Social）類別嘅電郵會自動略過。

---

## 第 3 步：Outlook（學校帳戶）

學校帳戶通常唔畀外部程式直接讀取。最簡單嘅方法係**將學校電郵轉寄去 Gmail**，之後由第 2 步一齊處理。

1. 用電腦打開 https://outlook.office.com，登入學校帳戶。
2. 撳右上角 ⚙️ **設定** → **郵件** → **轉寄**（Forwarding）。
3. 剔 **啟用轉寄**，填你嘅 Gmail 地址，再剔 **保留轉寄郵件的副本**。
4. 撳 **儲存**。
5. 用另一個電郵寄一封測試信去學校地址，睇吓 Gmail 收唔收到。

**如果學校唔畀轉寄**（例如設定入面冇呢個選項，或者顯示錯誤），話我知你見到咩訊息，我再搵其他方法。

---

## 第 4 步：Siri「記低」捷徑

做法同你之前整嘅「問助手」差唔多，**只係將 JSON 欄位名由 `question` 改做 `note`**。

1. 打開 **捷徑** app，長按「問助手」→ **複製**。
2. 打開複製出嚟嘅捷徑，改名做 **記低**。
3. 喺「取得 URL 內容」入面，將欄位名 `question` 改做 **`note`**。右邊保持 🎙️ **已聽寫的文字**。
4. 其他設定唔使改。

**用法：**「喂 Siri，記低」→ 講「下星期五下晝三點前要交 FYP 報告」。
- Siri 會讀出確認，例如：「已經記低：交 FYP 報告，11月28日（星期五）下午3:00，會喺前一日同前兩個鐘提你。」
- Apple Calendar 入面嘅 **Agent · 功課** 日曆會出現 ⏰ 交 FYP 報告。
- Discord 會收到通知，下面有取消掣。

---

## 第 5 步：Siri「我有咩要做」捷徑（唔使聽寫）

1. 喺捷徑撳 **＋** 開一個新捷徑，改名做 **我有咩要做**。
2. 加入 **取得 URL 內容**：
   - URL：`https://pocket-agent-cloud.enderscheng.workers.dev/api/siri`
   - 方式：**POST**
   - 標題：`Authorization` = `Bearer ps1_...`（同「問助手」用同一條 Siri 密鑰）
   - 要求內文：**JSON** → 加入新欄位 → 揀 **布林值**（Boolean），鍵 `agenda`，值 **是**（True）
3. 加入 **取得辭典值**：鍵 `answer`，來源係 **URL 的內容**。
4. 加入 **朗讀** → **辭典值**。

**用法：**「喂 Siri，我有咩要做」→ Siri 讀出未來 7 日嘅 deadline。

---

## Apple Calendar 提醒

- 有時間嘅 deadline：前一日同前兩個鐘提你。
- 冇時間嘅 deadline：前一日朝早 9 點提你。
- 如果 iPhone 冇彈提醒：
  1. 去 **設定 → App → 日曆 → 預設提示時間**，檢查設定。
  2. 喺日曆 app 入面，確認 **Agent** 日曆有剔選。

## Discord 指令

| 指令 | 作用 |
|---|---|
| `/todo` | 列出未來 14 日要做嘅嘢 |
| 通知下面嘅「取消」掣 | 取消嗰項，並由日曆刪除 |
| `/panel` | 揀模型、睇用量、設定通知頻道 |

## 問題排解

| 情況 | 解決方法 |
|---|---|
| Siri 話「加唔到入日曆」 | 做第 0 步，然後喺 `/admin` 撳 Reconnect Google |
| Gmail 冇反應 | Apps Script → **執行項目**睇錯誤；確認觸發條件存在 |
| Apps Script 顯示 HTTP 401 | Gmail 密鑰錯咗或者已更換：喺 `/admin` 再撳一次 Create Gmail key and script，然後重新貼過 |
| Apps Script 顯示 HTTP 503 | Cloudflare AI 今日免費額度用完，聽日會自動再試 |
| AI 加錯咗嘢 | 撳 Discord 通知下面嘅「取消」 |
| 太多唔重要嘅電郵 | 話我知，我可以收緊電郵篩選條件 |
