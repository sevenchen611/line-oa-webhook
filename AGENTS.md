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
- `README.md`: deployment, environment, API, and cron documentation.
- `AGENTS.md`: this operating guide.

Sensitive local files such as `env.txt` must not be committed to GitHub.

## Project Scope

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

### 總控專案庫

Defines all available projects. New projects should be added here instead of hard-coded in application logic.

### 總控任務庫

Cross-project task database.

Rules:

- LINE-created tasks first enter this database.
- New tasks are not official until confirmed, unless confidence is high and risk is low.
- Low-confidence or sensitive tasks must stay pending confirmation.

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

## LINE OA Collection Rules

When Seven Jr. receives LINE messages:

1. Store/update the conversation master.
2. Store the raw message/event.
3. If the message is an image, embed it in the conversation master.
4. If the message is a file, store the file in the attachment database.
5. Codex later classifies whether the message is a task, progress update, completion report, blocker, or decision.

General messages should not trigger automatic replies.

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
| `seven-jr-morning-brief` | 08:00 | `0 0 * * *` | `morning` |
| `seven-jr-followup-morning` | 10:00 | `0 2 * * *` | `followup-morning` |
| `seven-jr-followup-afternoon` | 17:00 | `0 9 * * *` | `followup-afternoon` |
| `seven-jr-daily-report` | 20:30 | `30 12 * * *` | `daily` |

Each Cron Job runs:

```bash
npm run cron:report -- <reportType>
```

This calls:

```text
POST https://line-oa-webhook-nn5j.onrender.com/control/reports/send
```

Render has already been confirmed to build these jobs through Blueprint, and the user successfully triggered one run and received the LINE message.

## Report Pages

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

- Sent at 10:00 and 17:00.
- Lists messages Seven Jr. may send to project groups or owners.
- User reviews before any external message is sent.

Current layout rule:

- Use vertical cards, not a horizontal table.
- First row: send checkbox + action select.
- Then target.
- Then reason.
- Then editable suggested message.
- Textarea must be large enough for mobile and Windows editing.

## Render Control API

Control endpoints:

- `GET /control/health`
- `POST /control/reports/send`
- `POST /control/line/push`

Supported report types:

- `morning`
- `daily`
- `followup-morning`
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
