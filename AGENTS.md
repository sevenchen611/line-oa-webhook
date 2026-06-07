# Codex x Seven Jr. x LINE OA x Notion Operating Guide

This file is the operating guide for the Seven Jr. control system. It records the agreed architecture, principles, schedules, data rules, and backup status so future Codex sessions can continue without reconstructing the whole conversation.

## System Goal

Build a personal and company control center that collects project conversations from LINE groups, stores them in Notion, extracts project progress and tasks, and sends daily reports or follow-up confirmations through Seven Jr., the LINE OA.

The system must answer two questions:

1. What is the current status of each project?
2. What should happen next, and who needs to be reminded?

## Main Actors

- User: final decision maker, especially for sensitive, low-confidence, financial, contractual, legal, HR, tax, or external commitment matters.
- Codex: analyzes conversations, extracts tasks and risks, drafts reports, proposes next actions, and updates system logic.
- Seven Jr.: LINE OA that joins project groups, collects LINE conversations, and sends messages or reports.
- Render Webhook Server: receives LINE webhook events, writes to Notion, exposes control APIs, and runs scheduled report jobs.
- Notion: visible database layer for conversations, tasks, attachments, project status, risks, and decisions.

## User LINE Identity

The user is Seven 陳聖文.

When the user asks Codex or Seven Jr. to "send a message to me", "傳訊息給我", "通知我", or otherwise send a LINE message to the user personally, the default LINE target is:

- Notion conversation: `Seven陳聖文`
- Custom name: `Seven 的主要訊息`
- Target type: `user`
- User ID: `U09dc6553016c78d89c515522be9b74f6`

This target was tested successfully through the Render Control API on 2026-06-06. When sending Chinese text through PowerShell, encode the JSON request body as UTF-8 bytes and set `Content-Type: application/json; charset=utf-8`; otherwise LINE may receive garbled Chinese text.

## Current GitHub Backup

Repository: `sevenchen611/line-oa-webhook`

The following important artifacts are backed up in GitHub:

- `src/server.js`: LINE webhook receiver and Notion writer.
- `src/control-api.js`: secure control API for proactive LINE push and report sending.
- `scripts/render-cron-report.js`: Render Cron helper script.
- `render.yaml`: Render Blueprint for the web service and scheduled Cron Jobs.
- `reports/morning-brief-prototype.html`: 08:00 morning brief prototype.
- `reports/daily-control-report-prototype.html`: 20:30 daily control report prototype.
- `reports/followup-confirmation-prototype.html`: 10:00 / 17:00 follow-up confirmation prototype.
- `scripts/automation-run-log.js`: local + Notion automation execution logging helper.
- `README.md`: deployment, environment, API, and cron documentation.
- `AGENTS.md`: this operating guide.

Sensitive local files such as `env.txt` must not be committed to GitHub.

## Project Scope

This repository is the SevenAM project. SevenAM means "Seven Assistant Manager":
Seven's assistant-style control center.

SevenAM Notion automation is limited to the `Codex 總控中心` page and databases
that live under it. Do not scan, summarize, or synchronize unrelated Notion pages
or external project databases. In particular, do not use HOZO / HOGO / 好住寓好
databases as SevenAM task targets unless the user explicitly redefines the scope.

The total control center currently covers:

- 茲心園工程
- 包租代管
- HOZO 後臺
- SmartFront / AI Brain
- 財務
- 人資
- 營運
- 私人事務

Existing Notion project pages are not replaced or merged. The control center only summarizes and coordinates them.

## Notion Data Layers

### Codex 總控中心

Central dashboard for cross-project visibility.

It should contain:

- Project overview
- Daily and weekly reports
- Pending task confirmations
- Risks and decisions
- Attachment parsing confirmations
- New LINE group project assignment confirmations
- Automation run logs

Direct child pages:

- `Seven LINE CRM 原始紀錄層` lives directly under `Codex 總控中心`.
- `Automation Run Log` database lives directly under `Codex 總控中心`.
- Do not recreate a `Seven AI` wrapper layer for the LINE CRM raw record layer unless it later contains real analysis dashboards or AI operation records.
- The LINE CRM child databases are accessed by Notion database/data source IDs, not by their visual page path, so moving this page under the control center does not change the Render API configuration.

### 總控專案庫

Defines all available projects. New projects should be added here instead of hard-coded in application logic.

### 權責定義表

Defines department heads, project owners, default assignees, notification targets,
and LINE target mappings for SevenAM.

Current data source ID:

- `e8c2f582-edbe-42ab-9d7f-ba063bbf8b99`

Related option tables:

- `LINE 群組選項表`: data source ID `b6cfffbf-e7b2-4da4-b21d-d055bc68af69`
- `LINE 群組成員選項表`: data source ID `979949aa-bac3-45ac-a4cc-a38585addb89`

Rules:

- Use this table before guessing who should own, follow up, or receive notices for
  a task.
- `權責定義表` is primarily a project / responsibility mapping table. Task
  ownership should normally be derived from the task's project first; only use a
  task-level override when the task explicitly needs a different owner.
- Use `第一層：總控專案` as the first narrowing layer. The responsibility sync
  script reads `LINE 群組選項表` and fills
  `候選對話群組（依專案自動帶出）` with only the LINE groups whose `總控專案`
  matches this project.
- Use `第二層：主要對話群組` to select the main LINE group from the candidate
  groups. The selected group's Group ID is retained in the option row.
- After a main group is selected, the responsibility sync script fills
  `候選負責人（依群組自動帶出）` with only known members of that group. Use
  `第三層：主要負責人` to select the responsible person. The selected person's
  User ID is retained in the option row.
- Use `代理人對話群組` and `代理人` the same way when a backup contact is needed.
- Run `npm run responsibility:sync` to refresh candidate groups, candidate
  members, candidate counts, selection status, and LINE target result fields.
- `LINE對象名稱（結果）`, `LINE對象類型（結果）`, and `LINE對象ID（結果）` are
  system-facing result fields for sending or logging. They should not replace
  the group/person selection flow above.
- `LINE 群組成員選項表` can only include people who have appeared in webhook
  records or LINE membership events. LINE OA cannot fetch a complete historical
  group roster for members who have never appeared in captured events.
- If a LINE conversation master has `總控專案`, project assignment still comes
  from the conversation first; this table decides the owner / supervisor /
  default tracking target for that project.
- If a department or project row is `待填寫` or missing owner fields, keep the
  task pending Seven confirmation instead of assigning it to a guessed person.
- Sensitive projects such as finance, HR, legal/tax, external commitments, or
  customer complaints should default to Seven confirmation unless the table says
  otherwise.

Important fields:

- 權責項目名稱
- 類型
- 定義層級
- 第一層：總控專案
- 狀態
- 第二層：主要對話群組
- 候選對話群組（依專案自動帶出）
- 候選群組數
- 第三層：主要負責人
- 候選負責人（依群組自動帶出）
- 候選負責人數
- 代理人對話群組
- 代理人
- 選擇狀態
- 主管或主負責人（文字備註）
- 代理人（文字備註）
- 預設任務負責人
- 預設追蹤對象
- LINE對象名稱（結果）
- LINE對象類型（結果）
- LINE對象ID（結果）
- 選擇說明
- 通知規則
- 敏感等級
- 外部承諾需Seven核可

### 總控任務庫

Cross-project task database.

Rules:

- LINE-created and meeting-created tasks first enter this database.
- New tasks are not official until confirmed, unless confidence is high and risk is low.
- Low-confidence or sensitive tasks must stay pending confirmation.
- Meeting action items should use `來源 = 會議`, `狀態 = 待確認`,
  and `確認狀態 = 未確認` by default.
- Avoid duplicates by matching the meeting page URL and normalized task name before
  creating a new task.

Recommended fields:

- Task name
- Project
- Status
- Confirmation status
- Priority
- Owner
- Due date
- Source
- Source original text
- Codex summary
- Confidence level
- Related Notion page

Recommended statuses:

- 待確認
- 未開始
- 進行中
- 等待回覆
- 待確認完成
- 已完成
- 封存

### Automation Run Log

Tracks whether scheduled automations truly started and completed.

Current location:

- Notion database: `Automation Run Log`
- Data source ID: `25036a0e-84a7-4590-8f5c-10914207b16b`
- Local config file: `line-oa-webhook/config/automation-run-log.json`
- Local append-only mirrors:
  - `D:\Codex\LineNotion\logs\automation-execution.log`
  - `D:\Codex\LineNotion\logs\automation-execution.jsonl`

Rules:

- Every scheduled automation should write one `started` record before work begins.
- It should then write one terminal record: `completed`, `skipped`, or `failed`.
- If a timeslot has no run log record at all, treat it as not successfully triggered.
- The local files are the fallback audit trail if Notion writing is temporarily unavailable.

### Seven LINE 對話主檔

One record per LINE user, group, or room.

Important fields:

- LINE 對話名稱
- 自定義名稱
- 對象類型
- Group ID
- Room ID
- User ID
- 對話統一鍵
- 總控專案
- 最後訊息時間
- 最新訊息預覽
- 訊息數（總）
- 監控狀態
- 備註

Rules:

- When Seven Jr. joins a new LINE group, a conversation master record is created.
- If the group has no project assignment, it should be listed in the 20:30 report for user assignment.
- Example: `台翰營造&茲心園改建` belongs to `茲心園工程`.

### Seven LINE 訊息紀錄

Stores every raw LINE event/message.

Rules:

- Every LINE message is stored first as a raw event/message.
- Codex extracts tasks, progress, completion reports, blockers, and decisions from this layer.
- Raw records must not be overwritten by later interpretation.

### Seven LINE 附件紀錄

Stores LINE file attachments.

Rules:

- Images may be embedded directly as blocks in the conversation master page.
- File bodies should live in the attachment database, not inside the conversation master page.
- Conversation master pages should only show file name and attachment database page link.
- Notion `file.notion.com` URLs are temporary signed URLs and should not be treated as stable permanent file URLs.

### Seven LINE 附件轉檔資料庫

Used only for attachments that need OCR, text extraction, or AI parsing.

Rules:

- Do not OCR every attachment automatically.
- The 20:30 report should list received attachments and let the user choose which ones to parse.
- Only confirmed attachments enter the conversion/parsing workflow.

### 會議紀錄

Meeting notes database under `Codex 總控中心`.

Current data source ID:

- `fd551c68-6dac-830d-81bf-879f0a9582ba`

Important fields:

- 會議名稱
- 日期
- 摘要
- 會議記錄
- 選擇專案
- 部門
- 類別
- 影片

Rules:

- Only meeting records inside `Codex 總控中心` are in SevenAM scope.
- Do not read or synchronize HOZO / HOGO / 好住寓好 meeting databases.
- Treat meeting records as another raw/intake layer, similar to LINE messages.
- Extract action items from `會議記錄` and page body text. If a future meeting
  database has `行動項目`, use it first.
- Each extracted action item must include at least an action and a subject.
- Create candidate tasks in `總控任務庫` with `來源 = 會議`.
- `選擇專案` is the primary project assignment. If it is filled, meeting-derived
  tasks and progress reports must use it instead of guessing from text.
- Low-confidence, sensitive, financial, contractual, legal, HR, tax, or external
  commitment items must remain pending confirmation.
- Meeting progress statements, blockers, and next steps may update
  `專案進度報表庫`, but only inside `Codex 總控中心`.

### 專案進度報表庫

Cross-project progress database under `Codex 總控中心`.

Current data source ID:

- `fc5e4e21-6af6-4de2-9380-aa95126ee13e`

Rules:

- Use this database for project-level progress summaries, not every individual task.
- Meeting-derived updates should summarize:
  - 本週進展
  - 主要卡點
  - 下一步
  - 需要 Seven 決策
- If the project cannot be inferred confidently, do not create a progress report;
  keep the extracted tasks in `總控任務庫` as `未分類`.

### 每日總控報告快照庫

Daily 20:30 report snapshot database under `Codex 總控中心`.

Current data source ID:

- `8f7f95a5-7428-4490-9327-7943499a0e22`

Rules:

- When the 20:30 daily control report is sent successfully, Render should create one snapshot page.
- Snapshot pages store the report date, send time, report URL, LINE message text, cron job name, run id, target summary, and confirmation status.
- When the user submits the daily report confirmation page, Render should mark the latest daily snapshot as `已確認` and write the related decision page URL.
- The snapshot database is for historical report archive. Confirmation details still live in `風險與決策庫`.

## LINE OA Collection Rules

When Seven Jr. receives LINE messages:

1. Store/update the conversation master.
2. Store the raw message/event.
3. If the message is an image, embed it in the conversation master.
4. If the message is a file, store the file in the attachment database.
5. Codex later classifies whether the message is a task, progress update, completion report, blocker, or decision.

General messages should not trigger automatic replies.

Codex command trigger:

- If a text message contains `Eleven Junior`, `Eleven Jr.`, `Elven Jr.`, `Seven Junior`, `7 Junior`, or `11 Jr.`, Render should treat it as a Codex command request.
- Render must still store the raw LINE message first.
- If `SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID` is configured, Render should create a Codex command queue item with status `Pending`.
- Current Codex command queue data source ID: `c4eee8de-e596-4d64-906b-1405d79e721c`.
- Codex checks this queue every 15 minutes.
- Low-risk analysis, sorting, summarizing, and internal task creation may be processed by Codex.
- Financial, contractual, legal, HR, tax, or external commitment commands must require user confirmation before action.
- Queue creation failure must not block normal LINE message storage.

Allowed command replies:

- `早報`, `#早報`, `今日早報`, `#今日早報`, `行程`, `#行程`
- `報告`, `#報告`, `每日報告`, `#每日報告`

These return the corresponding report page links.

## Task Extraction Rules

Codex may create candidate tasks from LINE conversations.

Rules:

- A task should include at least an action and a subject.
- If project, owner, or due date is missing, the task can still be created but must be marked incomplete/insufficient.
- Sensitive or high-risk tasks are not auto-confirmed.
- High-risk topics include money, contracts, HR discipline, legal, tax, and external commitments.
- Assistant Manager mode is intentionally broad: health, family, insurance, fire insurance, mortgage insurance, tax, tenant issues, customer complaints, delegated responsibility, uncertainty, decisions, meetings, and progress signals should be captured when there is any reasonable chance Seven should notice them.
- Important but low-confidence LINE items should become `待確認` tasks instead of being silently ignored.
- When one LINE message contains multiple concerns, split it into multiple candidate tasks where practical.
- Relationship or complaint escalation signals such as dissatisfaction, lack of progress updates, apology, stakeholder discomfort, or promised follow-up must be treated as important `關係/客訴事件` items, not as generic low-signal chat.
- If a LINE conversation master has `總控專案` filled, that project assignment overrides text-based project guessing for tasks, progress reports, and daily report grouping.
- Use `--reprocess` after changing judgement rules so already-judged recent messages can be rescanned and deduped.

Suggested forced LINE tags:

- `#待辦` / `#todo`
- `#完成` / `#done`
- `#追蹤` / `#followup`
- `#決策` / `#decision`
- `#卡點` / `#blocked`
- `#忽略` / `#ignore`

## Scheduled Reports

Fixed schedules are handled by Render Cron Jobs, not by Codex local network calls.

Render Cron uses UTC. Taipei time is UTC+8.

| Render Cron Job | Taipei Time | UTC Cron | reportType |
| --- | --- | --- | --- |
| `seven-jr-line-message-judgement-sync` | 08:10-22:10 hourly | `10 0-14 * * *` | LINE message judgement sync |
| `seven-jr-meeting-action-sync` | 08:00-22:00 hourly | `0 0-14 * * *` | meeting action sync |
| `seven-jr-responsibility-candidate-sync` | 08:15-22:15 hourly | `15 0-14 * * *` | responsibility candidate sync |
| `seven-jr-morning-brief` | 08:00 | `0 0 * * *` | `morning` |
| `seven-jr-followup-morning` | 10:00 | `0 2 * * *` | `followup-morning` |
| `seven-jr-followup-midday` | 13:00 | `0 5 * * *` | `followup-midday` |
| `seven-jr-followup-afternoon` | 17:00 | `0 9 * * *` | `followup-afternoon` |
| `seven-jr-daily-report` | 20:30 | `30 12 * * *` | `daily` |

Report Cron Jobs run:

```bash
npm run cron:report -- <reportType>
```

This calls:

```text
POST https://line-oa-webhook-nn5j.onrender.com/control/reports/send
```

Meeting action sync runs:

```bash
npm run meetings:sync -- --limit 50
```

LINE message judgement sync runs:

```bash
npm run line:judgements -- --include-outgoing-groups --limit 50
```

It scans `Seven LINE 訊息紀錄` records with `已進入判斷層 = false`, classifies LINE text in Assistant Manager mode, creates candidate tasks and project progress reports when appropriate, then marks the original message as judged. Scheduled judgement includes normal `line` source messages and Seven Jr. outgoing `ai-engine` messages sent to groups/rooms through the control API; personal report notifications to Seven are excluded. Low-signal messages are marked judged without creating tasks.

Responsibility candidate sync runs:

```bash
npm run responsibility:sync
```

It refreshes the `權責定義表` candidate lists so each project row shows only
LINE groups assigned to that project, and each selected group shows only known
members from that group.

Hourly assistant maintenance has three lanes:

- Meeting lane: `npm run meetings:sync -- --limit 50`
- LINE lane: `npm run line:judgements -- --include-outgoing-groups --limit 50`
- Responsibility lane: `npm run responsibility:sync`

Local full hourly run:

```bash
npm run assistant:hourly
```

Rule-update backfill:

```bash
npm run line:judgements -- --reprocess --since-hours 24 --limit 100
```

The 20:30 daily report is dynamic. It reads today's LINE raw messages, judgement-created tasks, and progress reports. To inspect the generated report without sending LINE:

```text
POST /control/reports/preview
```

Render has already been confirmed to build these jobs through Blueprint, and the user successfully triggered one run and received the LINE message.

## Report Pages

Production report links should be served by the Render web service, not by GitHub HTML preview.

Default public routes:

- `GET /reports/morning-brief`
- `GET /reports/daily-control-report`
- `GET /reports/followup-confirmation?slot=10`
- `GET /reports/followup-confirmation?slot=13`
- `GET /reports/followup-confirmation?slot=17`

`htmlpreview.github.io` is acceptable only as a temporary manual preview. It should not be used for scheduled LINE report messages because extra query parameters such as `slot=17` may be interpreted as part of the GitHub source URL instead of the report page.

### Morning Brief

File: `reports/morning-brief-prototype.html`

Purpose:

- Today calendar
- Yesterday unfinished items
- Today priority work
- Decisions needed
- Suggested work blocks

### Daily Control Report

File: `reports/daily-control-report-prototype.html`

Purpose:

- Project progress summary
- Pending tasks
- Low-confidence decisions
- Attachment parsing confirmation
- Risks and blockers
- Tomorrow priorities

### Follow-up Confirmation

File: `reports/followup-confirmation-prototype.html`

Purpose:

- Sent at 10:00, 13:00, and 17:00.
- Lists messages Seven Jr. may send to project groups or owners, plus new
  candidate tasks that need confirmation.
- User reviews before any external message is sent.

Current layout rule:

- Use vertical cards, not a horizontal table.
- First row: send checkbox + action select.
- Then target.
- Then reason.
- Then editable suggested message.
- Textarea must be large enough for mobile and Windows editing.

### Report Approval Acknowledgement

After any report confirmation page submits to `POST /control/reports/approve`, Render should first write the confirmation result to Notion. Only after the Notion write succeeds, Seven Jr. should send a LINE acknowledgement to the default report target so the user knows the decision was received.

This applies to:

- 08:00 morning brief
- 10:00 follow-up and new task confirmation
- 13:00 follow-up and new task confirmation
- 17:00 follow-up and new task confirmation
- 20:30 daily control confirmation

If the LINE acknowledgement fails, the Notion write remains valid. The API response should include `acknowledgement.ok=false` for troubleshooting.

## Render Control API

Control endpoints:

- `GET /control/health`
- `POST /control/reports/send`
- `POST /control/line/push`

Supported report types:

- `morning`
- `daily`
- `followup-morning`
- `followup-midday`
- `followup-afternoon`

Authorization:

- `x-seven-control-key: <SEVEN_CONTROL_API_KEY>`
- or `Authorization: Bearer <SEVEN_CONTROL_API_KEY>`

`SEVEN_CONTROL_API_KEY` is an internal system lock, not a LINE or Notion token. It prevents unauthorized callers from asking Seven Jr. to push messages.

`SEVEN_REPORT_TARGET_ID` is optional. If omitted, Render resolves the default report target from Notion by finding the latest personal Seven conversation, preferably one whose name includes `Seven`.

## Notification Queue Plan

Future flexible notifications should not require new Cron Jobs.

Correct model:

1. Codex creates a notification candidate.
2. The notification is stored in a queue.
3. User confirms in an HTML confirmation page.
4. Render sends approved messages through Seven Jr.
5. Render records delivery result.

Recommended queue fields:

- Notification title
- Target type
- Target ID
- Target name
- Project
- Related task
- Suggested message
- Reason
- Risk level
- Status
- User decision
- Sent time
- Send result

Recommended statuses:

- 待確認
- 已批准
- 已退回
- 已發送
- 發送失敗
- 封存

## Current Limitations

This Codex workspace may not have direct external network access. Even if the user grants permission verbally, the sandbox may still block direct HTTPS calls to Render.

Therefore:

- Fixed scheduled reports are handled by Render Cron Jobs.
- Immediate manual tests may need to be run from Render or another full-access Codex environment.
- Long-term automation should rely on Render, Notion, and the notification queue, not on a local Codex session being online.

## Sensitive Data Rules

Local `env.txt` contains sensitive values such as LINE tokens, Notion token, and `SEVEN_CONTROL_API_KEY`.

Rules:

- Never commit `env.txt` to GitHub.
- Never paste secrets into public messages.
- When checking secrets, confirm existence/format only.
- Do not print secret values back to the user.

## Daily Report Approval Write-back

The 20:30 daily report page now posts confirmed page choices back to Render:

```text
POST /control/reports/approve
```

This endpoint writes internal records to Notion only. It does not send external LINE messages.

Current write-back behavior:

- Creates a decision record in the risk and decision database.
- Updates matching task records in the total control task database, or creates them if no exact task name exists.
- Creates attachment conversion queue records for checked attachments.
- Supports optional `SEVEN_REPORT_APPROVAL_KEY`; when set on Render, the page must send `approvalKey` by query string, local storage, body, or `x-seven-approval-key`.
- Uses CORS headers so static report pages can call the Render Control API.

## Next Steps

1. Turn follow-up confirmation HTML from prototype into a real approval UI.
2. Create a notification queue database or Render-side persistence.
3. Add an approval API so selected messages can be sent to specific LINE group IDs.
4. Connect task status dropdowns to the total control task database.
5. Connect attachment checkboxes to the attachment conversion database.
6. Replace static prototype report content with dynamic Notion / Calendar / LINE data.
