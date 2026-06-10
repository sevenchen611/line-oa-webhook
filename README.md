# LINE OA Webhook

Seven Jr. 的 LINE OA Webhook 服務，用來接收 LINE 群組/個人對話、寫入 Notion，並提供安全的主動推送入口與 Render Cron 定時報告。

## New Unit Onboarding

如果要把 SevenAM 分享給其他部門、公司或單位使用，請先讓對方填寫導入表單：

- Markdown 交接表：[docs/sevenam-onboarding-form.md](docs/sevenam-onboarding-form.md)
- HTML 填寫頁：[forms/sevenam-onboarding-form.html](forms/sevenam-onboarding-form.html)

HTML 表單只在瀏覽器本機整理資料，可產生 Render 環境變數草稿；請勿把敏感金鑰提交到 GitHub。

## Webhook

LINE Developers Console 的 Webhook URL：

```text
https://line-oa-webhook-nn5j.onrender.com/webhook/line
```

健康檢查：

```text
https://line-oa-webhook-nn5j.onrender.com/health
```

控制 API 健康檢查：

```text
https://line-oa-webhook-nn5j.onrender.com/control/health
```

## Render Environment

Web Service 必要設定：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `NOTION_TOKEN`
- `SEVEN_CONVERSATIONS_DATA_SOURCE_ID`
- `SEVEN_MESSAGES_DATA_SOURCE_ID`
- `SEVEN_ATTACHMENTS_DATA_SOURCE_ID`
- `SEVEN_CONTROL_API_KEY`: 控制 API 密鑰，請使用一組夠長的隨機字串。

可選設定：

- `SEVEN_REPORT_TARGET_ID`: 早報/晚報備用推送對象，可以是 userId、groupId 或 roomId。若不設定，系統會自動從 Seven LINE 對話主檔尋找最近的一對一個人對話，優先找名稱含 Seven 的對話。
- `SEVEN_REPORT_TARGET_IDS`: 多個早報/晚報主收件人，用逗號分隔；若設定此值，會和 CC 與 Notion 自動找到的對象合併去重。
- `SEVEN_REPORT_TARGET_TYPE`: `user`、`group` 或 `room`，主要作為紀錄辨識用。
- `SEVEN_REPORT_TARGET_NAME_KEYWORD`: 自動尋找個人對話時優先比對的關鍵字，預設為 `Seven`。
- `SEVEN_REPORT_CC_TARGET_IDS`: 早報/晚報副本收件人，用逗號分隔。此欄位只使用 SevenAM 自己的 LINE userId、groupId 或 roomId。
- `SEVEN_REPORT_CC_NAME_KEYWORDS`: 從 Seven LINE 對話主檔自動尋找副本收件人的關鍵字，可用逗號分隔。
- `SEVEN_DATA_SOURCE_PARENT_BLOCK_ID`: 可選的 Notion 資料隔離父層檢查。設定後，系統只允許指定父層底下的 SevenAM data source；若 SevenAM 資料庫分散在多個子頁，請先確認父層設定正確再啟用。
- `SEVEN_TASKS_DATA_SOURCE_ID`: SevenAM 總控任務庫。LINE 使用者可在群組或私訊詢問目前待辦，例如「Seven Junior 目前有哪些待辦」。
- `SEVEN_PUBLIC_BASE_URL`: 對外公開的 Render 服務網址，預設為 `https://line-oa-webhook-nn5j.onrender.com`。
- `MORNING_BRIEF_URL`: 早報網頁連結，可省略，省略時使用 Render 服務內建報告頁。
- `DAILY_REPORT_URL`: 晚報網頁連結，可省略，省略時使用 Render 服務內建報告頁。
- `FOLLOWUP_CONFIRMATION_URL`: 10 點 / 13 點 / 17 點追蹤確認頁連結，可省略，省略時使用 Render 服務內建報告頁。
- `SEVEN_DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID`: 20:30 每日總控總確認快照庫，預設為 `8f7f95a5-7428-4490-9327-7943499a0e22`。
- `SEVEN_RESPONSIBILITY_DATA_SOURCE_ID`: 權責定義表，預設為 `e8c2f582-edbe-42ab-9d7f-ba063bbf8b99`。
- `SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID`: LINE 群組選項表，預設為 `b6cfffbf-e7b2-4da4-b21d-d055bc68af69`。
- `SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID`: LINE 群組成員選項表，預設為 `979949aa-bac3-45ac-a4cc-a38585addb89`。

LINE 即時指令：

- `Seven Junior`、`seven Junior`、`7Junior`、`7 Junior` 開頭的 LINE 文字會被視為即時指令。
- 已支援即時查詢待辦，例如：`Seven Junior，目前有哪些待辦？`
- 查完待辦後，30 分鐘內可接續打開清單項目，例如：`Seven Junior，打開第 2 個任務`。
- 尚未支援的即時指令會立刻回覆已收到，並保留在 Codex command queue 等 Codex 後續處理。
- 涉及金流、合約、法律、稅務、HR 或外部承諾的內容不會直接執行，會先進待確認。

權責定義表的主要填寫邏輯：

- `權責項目名稱`: 這列要定義的專案、部門、LINE 群組對口或特殊權責項目。
- `第一層：總控專案`: 先選專案。系統會依這個專案自動帶出候選 LINE 群組。
- `候選對話群組（依專案自動帶出）`: 只顯示該專案底下的 LINE 群組，避免從全部群組裡找。
- `第二層：主要對話群組`: 從候選群組裡選主群組，選項顯示群組名稱，底層保留 Group ID。
- `候選負責人（依群組自動帶出）`: 選完主要群組後，系統自動帶出該群組已知成員。
- `第三層：主要負責人`: 從候選成員裡選主辦人，選項顯示「群組 / 人名」，底層保留 User ID。
- `代理人對話群組` / `代理人`: 代理人使用同樣的兩段式選法。
- `LINE對象名稱（結果）` / `LINE對象類型（結果）` / `LINE對象ID（結果）`: 系統送訊息與紀錄用的結果欄位，主要人工選擇仍以上述群組與人員關聯欄位為準。

刷新權責候選清單：

```powershell
npm run responsibility:sync
```

Cron Jobs 會透過 Blueprint 從 `line-oa-webhook` Web Service 讀取同一組 `SEVEN_CONTROL_API_KEY`，不用把密鑰寫進 GitHub。

## Render Cron Jobs

`render.yaml` 會建立固定報告排程與會議紀錄同步排程。Render Cron 使用 UTC 時間，以下已換算台北時間：

| Render Cron Job | 台北時間 | UTC cron | reportType |
| --- | --- | --- | --- |
| `seven-jr-line-message-judgement-sync` | 08:10-22:10 每小時 | `10 0-14 * * *` | LINE 訊息判斷同步 |
| `seven-jr-meeting-action-sync` | 08:00-22:00 每小時 | `0 0-14 * * *` | 會議紀錄同步 |
| `seven-jr-responsibility-candidate-sync` | 08:15-22:15 每小時 | `15 0-14 * * *` | 權責候選清單同步 |
| `seven-jr-morning-brief` | 08:30 | `30 0 * * *` | `morning` |
| `seven-jr-followup-morning` | 10:00 | `0 2 * * *` | `followup-morning` |
| `seven-jr-followup-midday` | 13:00 | `0 5 * * *` | `followup-midday` |
| `seven-jr-followup-afternoon` | 17:00 | `0 9 * * *` | `followup-afternoon` |
| `seven-jr-daily-report` | 20:30 | `30 12 * * *` | `daily` |

報告 Cron Job 執行：

```powershell
npm run cron:report -- <reportType>
```

實際會呼叫：

```text
POST https://line-oa-webhook-nn5j.onrender.com/control/reports/send
```

會議紀錄同步 Cron Job 執行：

```powershell
npm run meetings:sync -- --limit 50
```

LINE 訊息判斷同步 Cron Job 執行：

```powershell
npm run line:judgements -- --include-outgoing-groups --limit 50
```

每小時判斷採雙軌：

- `seven-jr-meeting-action-sync` 在整點掃描新的會議紀錄，萃取行動項目與專案進度。
- `seven-jr-line-message-judgement-sync` 在 10 分掃描新的 LINE 原始訊息，萃取待確認任務、決策、健康/家庭提醒、財務/保險、房客/客戶問題與進度更新。

LINE 判斷現在採 Assistant Manager 模式：只要訊息可能需要 Seven 留意、追蹤、關心、決策或負責處理，就會建立候選任務。低訊號訊息才只標記為已判斷，不建立任務。

若要本機一次跑完整小時判斷，可執行：

```powershell
npm run assistant:hourly
```

它只掃描 `Codex 總控中心` 底下的 `會議紀錄` data source，將 `行動項目`
轉成 `總控任務庫` 的候選任務，並在能判斷專案時寫入 `專案進度報表庫`。
HOZO / HOGO / 好住寓好資料庫不屬於 SevenAM 同步範圍。

### Cron tracing and failure alerts

Each cron run now emits structured JSON logs from `scripts/render-cron-report.js` with:

- `event`: `cron-report`
- `status`: `started`, `succeeded`, or `failed`
- `jobName`
- `reportType`
- `runId`
- `startedAt`
- `durationMs` on completion

On failure, the cron script also sends a LINE warning to the same default report target by calling:

```text
POST /control/line/push
```

with `useDefaultReportTarget: true`.

Recommended cron env vars:

- `CRON_JOB_NAME`: set this to the Render cron job name.
- `CONTROL_LINE_PUSH_URL`: defaults to `https://line-oa-webhook-nn5j.onrender.com/control/line/push`.
- `SEVEN_CRON_ALERTS_ENABLED`: `true` to send LINE failure alerts, `false` to disable them.

## 主動推送 API

所有控制 API 都需要帶其中一種授權：

```text
x-seven-control-key: <SEVEN_CONTROL_API_KEY>
```

或：

```text
Authorization: Bearer <SEVEN_CONTROL_API_KEY>
```

### 指定對象發訊息

```http
POST /control/line/push
```

範例 body：

```json
{
  "targetType": "group",
  "targetId": "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "text": "Seven Jr. 測試主動推送訊息。"
}
```

### 發送報告

```http
POST /control/reports/send
```

支援：

```json
{ "reportType": "morning" }
{ "reportType": "daily" }
{ "reportType": "followup-morning" }
{ "reportType": "followup-midday" }
{ "reportType": "followup-afternoon" }
```

若 body 沒有指定 targets，系統會先看 `SEVEN_REPORT_TARGET_ID`。如果沒有設定，系統會自動從 Notion 的 Seven LINE 對話主檔找出你跟 Seven Jr. 的一對一對話，並推送到那裡。

### User UI 任務編輯

```http
GET /user-ui/user-ui-connected-preview.html
```

SevenAM User UI 可以由後端直接服務，使用 `SEVEN_USER_UI_USERNAME` / `SEVEN_USER_UI_PASSWORD` 做瀏覽器登入。使用者從 `/user-ui/...` 開啟任務頁時，不需要輸入 `SEVEN_CONTROL_API_KEY`；任務儲存會使用同一個登入授權，並把編輯者寫入任務頁正文紀錄。

```http
POST /control/tasks/update
```

SevenAM User UI 的單一任務頁可透過此端點更新 Notion 總控任務庫。此端點接受 `SEVEN_CONTROL_API_KEY` 或已登入的 User UI 使用者，且後端會先確認目標頁面屬於 `SEVEN_TASKS_DATA_SOURCE_ID`，才允許寫入。

支援欄位：

```json
{
  "pageId": "<Notion task page id>",
  "updates": {
    "status": "進行中",
    "confirmation": "已確認",
    "owner": "Seven",
    "priority": "中",
    "next": "下一步內容",
    "judgment": "AM 判斷摘要",
    "rawSource": "來源原文",
    "pageContent": "要追加到 Notion 任務頁正文的內容",
    "editedBy": "Seven",
    "editNote": "本次編輯備註"
  }
}
```

`editNote` 與 `pageContent` 會追加到任務頁正文，其他欄位會依 Notion 屬性型別寫回任務資料庫。

### 報告確認回應

```http
POST /control/reports/approve
```

早報、10:00 追蹤確認與新任務確認、13:00 追蹤確認與新任務確認、17:00 追蹤確認與新任務確認、20:30 每日總控總確認的確認頁都會送到這個端點。Render 會先把確認結果寫入 Notion；寫入成功後，Seven Jr. 會再推一則 LINE 確認訊息給預設報告對象，讓使用者明確知道系統已收到決策。

標準行為：

- Notion 寫入成功後才送 LINE 確認。
- 若 LINE 確認推送失敗，不回滾已寫入的 Notion 決策，但 API 回傳會包含 `acknowledgement.ok=false`。
- 可用 `sendAcknowledgement:false` 關閉單次確認回覆。
- 可用 `ackTargets` / `ackTargetId` / `ackTargetType` 指定確認訊息推送目標；未指定時使用預設報告對象。

### 每日總控報告快照

20:30 每日總控總確認發送成功後，Render 會在 `每日總控報告快照庫` 建立一筆快照，保存報告日期、發送時間、報告連結、LINE 訊息內容、Cron job、run id、發送目標與確認狀態。

使用者在報告頁按「確認並寫回」後，系統會把最新一筆日報快照標記為 `已確認`，並寫入 `確認紀錄連結`，指向風險與決策庫中的確認頁。

建立或檢查快照庫：

```powershell
npm run setup:daily-snapshots
```

## LINE 指令回覆

一般訊息只會收集到 Notion，不會自動回覆。以下指令例外：

- `早報`、`#早報`、`今日早報`、`#今日早報`、`行程`、`#行程`
- `報告`、`#報告`、`每日報告`、`#每日報告`

這些指令會回覆對應的報告網頁連結。

## 啟動

```powershell
npm start
```

`npm start` 會同時啟動 Webhook 與控制 API。

## 會議紀錄同步

本機乾跑，不寫入 Notion：

```powershell
npm run meetings:sync -- --dry-run --limit 10
```

正式同步：

```powershell
npm run meetings:sync -- --limit 50
```

同步邏輯：

- 只處理 `Codex 總控中心` 內的 `會議紀錄`。
- `會議紀錄`、`總控任務庫`、`專案進度報表庫` 都必須分享給
  `NOTION_TOKEN` 對應的 Notion integration。
- 會議有 `選擇專案` 時，任務與進度報表會優先使用該欄位分配專案。
- 目前會議記錄資料庫沒有狀態欄位，預設依 `日期` 掃描最近會議。
- 從 `行動項目` 與頁面內文擷取明確待辦。
- 用「任務名稱 + 會議頁 URL」去重。
- 新任務寫入 `總控任務庫`，預設 `來源 = 會議`、`狀態 = 待確認`、`確認狀態 = 未確認`。
- 可判斷專案時，同步建立一筆專案層級進度報表。
- 合約、付款、法律、人資、稅務等敏感內容維持待確認。

## LINE 訊息判斷同步

本機乾跑，不寫入 Notion：

```powershell
npm run line:judgements -- --dry-run --limit 20
```

正式同步：

```powershell
npm run line:judgements -- --limit 50
```

重新判斷最近訊息，適合規則更新後補漏：

```powershell
npm run line:judgements -- --reprocess --since-hours 24 --limit 100
```

同步邏輯：

- 預設排程處理 `訊息來源 = line`，以及 Seven Jr. 透過正式管道送到群組/聊天室的 `ai-engine` 訊息；發給 Seven 個人的系統報告不進入任務判斷。
- 若 LINE 對話主檔已填 `總控專案`，任務、進度與日報分類會優先採用該專案，不再只靠文字猜測。
- 加上 `--reprocess` 時，會重新掃描已判斷過的近期訊息，並用任務名稱去重避免重複建立。
- 預設只掃最近 36 小時，可用 `--since-hours 72` 調整。
- 低訊號訊息，例如簡短寒暄、貼圖、純圖片紀錄，不建立任務。
- 明確含 `#待辦`、`#追蹤`、`#決策`、`#卡點`，或文字中有請求、交辦、健康、家庭、財務、保險、房客/客戶問題、關係/客訴事件、追蹤、決策、卡點、會議或進度訊號時，會建立候選任務或進度報表。
- 處理後會把原訊息改為 `已進入判斷層 = true`，並盡量把 `關聯總控事件` 指到新建任務或進度報表。

## Report Preview

可用控制 API 預覽報告內容，不推送 LINE：

```text
POST /control/reports/preview
```

此端點需要 `SEVEN_CONTROL_API_KEY`。20:30 每日報告會動態整理今天的 LINE 原始訊息、判斷層任務與進度報表；如果 Notion 暫時無法讀取，才會退回固定報告連結文字。
## Codex Command Queue

Render can create a Codex command queue item when Seven Jr. receives a LINE text message containing `Eleven Junior`, `Eleven Jr.`, `Elven Jr.`, `Seven Junior`, `7 Junior`, or `11 Jr.`. The raw LINE message is still stored normally. Queue creation uses this Render environment variable when set:

```text
SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID=<Notion data source id>
```

Recommended Notion data source properties:

| Property | Type |
| --- | --- |
| `Name` | Title |
| `Status` | Select: `Pending`, `Processing`, `Done`, `Needs Confirmation`, `Failed`, `Archived` |
| `Trigger` | Rich text |
| `Command` | Rich text |
| `Original Text` | Rich text |
| `Source Type` | Select: `user`, `group`, `room`, `unknown` |
| `Source ID` | Rich text |
| `User ID` | Rich text |
| `Conversation Name` | Rich text |
| `Actor Name` | Rich text |
| `Conversation Key` | Rich text |
| `LINE Message ID` | Rich text |
| `LINE Event ID` | Rich text |
| `Message Page URL` | URL |
| `Conversation Page URL` | URL |
| `Received At` | Date |
| `Risk Level` | Select: `Normal`, `High` |
| `Result` | Rich text |
| `Raw Event` | Rich text |

Behavior:

- `Eleven Junior`, `Eleven Jr.`, `Elven Jr.`, `Seven Junior`, and `7 Junior` matching is case-insensitive.
- `11 Jr`, `11 Jr.`, and spacing variants like `11Jr.` are supported.
- Queue creation is non-blocking. If the queue database is not configured or its schema is wrong, normal LINE message collection continues.
- High-risk command text containing finance, contract, HR, legal, or tax keywords is marked `High` so Codex can require confirmation before any external action.

Local queue helper:

```powershell
npm run codex:commands -- pending 10
npm run codex:commands -- mark <pageId> Processing
npm run codex:commands -- mark <pageId> Done "Handled by Codex"
npm run line:push -- user <targetUserId> "Reply text"
```

Codex queue processing should send LINE replies for completed low-risk commands. High-risk requests, including finance, contract, HR, legal, tax, or external-commitment requests, should be acknowledged but held for confirmation before action.
