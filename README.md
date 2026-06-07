# LINE OA Webhook

Seven Jr. 的 LINE OA Webhook 服務，用來接收 LINE 群組/個人對話、寫入 Notion，並提供安全的主動推送入口與 Render Cron 定時報告。

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
- `SEVEN_REPORT_TARGET_TYPE`: `user`、`group` 或 `room`，主要作為紀錄辨識用。
- `SEVEN_REPORT_TARGET_NAME_KEYWORD`: 自動尋找個人對話時優先比對的關鍵字，預設為 `Seven`。
- `MORNING_BRIEF_URL`: 早報網頁連結，可省略，省略時使用 GitHub 預設版。
- `DAILY_REPORT_URL`: 晚報網頁連結，可省略，省略時使用 GitHub 預設版。
- `FOLLOWUP_CONFIRMATION_URL`: 10 點 / 17 點跟催確認頁連結，可省略，省略時使用 GitHub 預設版。

Cron Jobs 會透過 Blueprint 從 `line-oa-webhook` Web Service 讀取同一組 `SEVEN_CONTROL_API_KEY`，不用把密鑰寫進 GitHub。

## Render Cron Jobs

`render.yaml` 會建立 4 個固定報告排程。Render Cron 使用 UTC 時間，以下已換算台北時間：

| Render Cron Job | 台北時間 | UTC cron | reportType |
| --- | --- | --- | --- |
| `seven-jr-morning-brief` | 08:00 | `0 0 * * *` | `morning` |
| `seven-jr-followup-morning` | 10:00 | `0 2 * * *` | `followup-morning` |
| `seven-jr-followup-afternoon` | 17:00 | `0 9 * * *` | `followup-afternoon` |
| `seven-jr-daily-report` | 20:30 | `30 12 * * *` | `daily` |

每個 Cron Job 執行：

```powershell
npm run cron:report -- <reportType>
```

實際會呼叫：

```text
POST https://line-oa-webhook-nn5j.onrender.com/control/reports/send
```

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
{ "reportType": "followup-afternoon" }
```

若 body 沒有指定 targets，系統會先看 `SEVEN_REPORT_TARGET_ID`。如果沒有設定，系統會自動從 Notion 的 Seven LINE 對話主檔找出你跟 Seven Jr. 的一對一對話，並推送到那裡。

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
## Codex Command Queue

Render can create a Codex command queue item when Seven Jr. receives a LINE text message containing `Eleven Junior`, `Eleven Jr.`, `Elven Jr.`, or `11 Jr.`. The raw LINE message is still stored normally. Queue creation is enabled only when this Render environment variable is set:

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

- `Eleven Junior`, `Eleven Jr.`, and `Elven Jr.` matching is case-insensitive.
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
