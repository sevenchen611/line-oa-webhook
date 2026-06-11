# Codex x Seven Jr. x LINE OA x Notion Operating Guide

This file is the operating guide for the Seven Jr. control system. It records the agreed architecture, principles, schedules, data rules, and backup status so future Codex sessions can continue without reconstructing the whole conversation.

## System Goal

Build a personal and company control center that collects project conversations from LINE groups, stores them in Notion, extracts project progress and tasks, and sends daily reports or follow-up confirmations through Seven Jr., the LINE OA.

The system must answer two questions:

1. What is the current status of each project?
2. What should happen next, and who needs to be reminded?

## Core AM Work: Conversation To Tasks

SevenAM's most important job is to help Seven turn conversations into reliable
tasks and keep those tasks moving.

The system should treat LINE conversations, meeting records, daily reports, and
system-generated suggestions as intake sources for total-control work. The
default posture is not to wait for perfect wording. If a message or meeting
record reasonably indicates something that someone should do, track, confirm,
follow up, decide, or close, SevenAM should capture it as a task candidate or an
update to an existing task.

### 1. Core Task: Extract Action Items

SevenAM must continuously look for reasonable tasks in LINE conversations.

Rules:

- Extract tasks from LINE conversations when the conversation implies an action,
  follow-up, decision, unresolved issue, delivery promise, blocker, owner
  responsibility, or completion check.
- Do not extract Seven Jr. operation commands as total-control tasks. Messages
  such as "查待辦", "請給我看我的待辦任務", "列出今天的待辦",
  "打開第 2 個任務", or similar instructions in the Seven Junior conversation
  are command/query operations, not real-world tasks. In the Seven Junior
  two-person control conversation, phonetic or mistyped assistant addresses such
  as "謝孟娟" or "謝夢娟" should be treated as Seven Junior aliases, not as
  separate people or task owners.
- Each task should connect back to a project goal. A task without a project goal
  is incomplete context, not a fully understood control item.
- If a LINE conversation reveals a new project goal, first record or propose the
  project goal, then organize the related tasks underneath that goal.
- If a task is useful but the project goal is unclear, keep it as a candidate
  task and mark what needs clarification instead of ignoring it.
- When one conversation contains multiple tasks or multiple goals, split them
  into separate task records where practical.
- The task record should preserve source context: original LINE message,
  conversation, project guess, reason for extraction, and any inferred owner,
  due date, priority, or risk.

Project-goal linkage:

- A project goal explains why the task matters and what larger outcome it serves.
- A new project goal may appear as a stated objective, milestone, deadline,
  requested result, recurring concern, or repeated cluster of related tasks.
- When a new project goal is found, SevenAM should identify the goal, summarize
  the related background, and list the first tasks needed to move it forward.
- Existing project assignment from the LINE conversation master should override
  text guessing. If the conversation master has no project, use the content and
  responsibility table to infer cautiously.

### 2. Meeting Records As Task And Knowledge Sources

Meeting records are a first-class intake source, not a secondary note archive.

Task definition:

- In meeting records, every checkbox item is a task.
- The content immediately after the checkbox is the task content.
- Checkbox-derived meeting tasks do not need extra confirmation that they are
  "real tasks" because the meeting record already marked them as action items.
- This applies to Notion to-do blocks and Markdown-style checkbox lines such as
  `[ ] item`, `[x] item`, `□ item`, `☐ item`, `☑ item`, and `✅ item`.
- Checkbox tasks should enter `總控任務庫` with `來源 = 會議`. When the task
  schema has confirmation status, use `確認狀態 = 已確認`.
- Avoid duplicates by matching the meeting reference plus normalized task text.

Reference-document role:

- Meeting discussion, decisions, progress notes, blockers, and conclusions are
  important knowledge sources for task execution.
- Do not only extract the checkbox text and discard the rest of the meeting.
  Preserve or link the surrounding discussion so the executor can understand why
  the task exists, what was decided, what has already changed, and what risk or
  dependency was mentioned.
- Meeting decisions can explain project-goal changes, task priority changes,
  ownership changes, due-date changes, or completion criteria.
- Meeting records may also update project progress reports even when they do not
  create a new task.

### 3. Task Status Tracking And Updates

SevenAM must use later conversations and meeting records to detect whether a
task has been handled, blocked, changed, or completed.

Rules:

- Track task status from LINE conversations, meeting records, daily reports,
  follow-up confirmations, and system-generated suggestions.
- If a later source indicates a task has moved forward, changed owner, changed
  due date, become blocked, been partially handled, or been completed, update the
  task record.
- Status changes must be grounded in source clues. Do not silently mark a task
  complete based only on optimism or lack of recent discussion.
- Record the status-change evidence inside the task body or source/evidence
  field: where the clue came from, what it said, what status changed, and when it
  was detected.
- Keep the raw source message or meeting reference linked so Seven can audit why
  the status changed.

Valid evidence sources include:

- System suggestions that identify a likely status change or follow-up result.
- Daily report contents, including morning brief, follow-up reports, and the
  20:30 daily control report.
- A later LINE conversation where someone says the item was handled, answered,
  scheduled, sent, paid, reviewed, blocked, cancelled, or completed.
- A meeting record that records a decision, completion, blocker, reassignment,
  or next step for the same task.

Status update behavior:

- If evidence shows completion, move the task toward `已完成` or
  `待確認完成` depending on risk and confidence.
- If an earlier LINE thread raised a real operational check, such as whether
  staff, site operations, classes, delivery, service, or scheduling must change,
  and a later reply confirms "正常", "不需調整", "已處理", or equivalent,
  keep the item as a real task/status record and mark it `已完成` or
  `待確認完成`. Do not mark it `封存` just because the final reply is short.
- If evidence shows waiting on someone, use `等待回覆` and record who or what is
  being waited on.
- If evidence shows work started but not finished, use `進行中` and add the
  current next step.
- If evidence is plausible but uncertain, keep the task pending confirmation and
  write the evidence summary for Seven review.
- Sensitive, financial, contractual, legal, HR, tax, or external commitment
  items still require Seven confirmation before final closure or external action.

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
- `reports/morning-brief-prototype.html`: 08:30 morning brief prototype.
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
- `LINE 群組成員索引表`: data source ID from `SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID`

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
- Group member User IDs must come from `LINE 群組成員索引表`, not from
  `LINE 訊息紀錄`. The index table stores the durable relationship between a
  Group ID / Room ID and the member User IDs returned by LINE API.
- Use `代理人對話群組` and `代理人` the same way when a backup contact is needed.
- Run `npm run responsibility:sync` to refresh candidate groups, candidate
  members, candidate counts, selection status, and LINE target result fields.
- `LINE對象名稱（結果）`, `LINE對象類型（結果）`, and `LINE對象ID（結果）` are
  system-facing result fields for sending or logging. They should not replace
  the group/person selection flow above.
- `LINE 群組成員選項表` is derived from `LINE 群組成員索引表`. If LINE API cannot
  provide a full group roster for the current OA account type, keep missing
  members as unknown instead of reading `LINE 訊息紀錄` as a replacement source.
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
- New LINE-derived tasks are not official until confirmed, unless confidence is
  high and risk is low.
- Meeting-record checkbox tasks are explicit tasks and may enter as confirmed
  because the checkbox itself is the meeting action marker.
- Low-confidence or sensitive tasks must stay pending confirmation.
- Non-checkbox meeting action items should use `來源 = 會議`, `狀態 = 待確認`,
  and `確認狀態 = 未確認` by default.
- Checkbox meeting action items should use `來源 = 會議`; when supported by the
  task schema, set `確認狀態 = 已確認`.
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

Rules (replaced 2026-06-12 — automatic parsing policy):

- Attachments are parsed automatically by `scripts/parse-attachments.js`
  (every 15 minutes): images and PDF/Word/Excel/PPT files up to 5MB
  (images 4.5MB) are parsed without confirmation.
- Exceptions that require user approval in the review page (轉檔狀態=待確認):
  files over the size limit, and images from private conversations
  (no project or 私人事務).
- Images now also create attachment records (previously only files did), so
  the attachment database is the single parsing queue via 轉檔狀態:
  待轉檔 → 已解析 / 待確認 / 已核准解析 / 確定不解析 / 不支援 / 解析失敗.
- Parse results are written to the attachment page (解析摘要/解析時間 +
  full extracted text in the body) and a summary line is appended to the
  conversation master timeline so hourly task extraction can use attachment
  contents as judgment evidence.
- Video/audio are not parsed (不支援). Old attachments are not backfilled.

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
- Any checkbox item in the meeting record is a task. Use the text after the
  checkbox as the task content and do not require extra confirmation that it is
  a real task.
- Each extracted action item must include at least an action and a subject.
- Create candidate tasks in `總控任務庫` with `來源 = 會議`.
- For checkbox-derived tasks, set confirmation status to `已確認` when the task
  database supports it. For non-checkbox meeting items, keep the existing
  confidence and risk checks.
- `選擇專案` is the primary project assignment. If it is filled, meeting-derived
  tasks and progress reports must use it instead of guessing from text.
- Reading club, academic discussion, knowledge sharing, course notes, and pure
  discussion meetings are not operational meetings. If `類別` includes `讀書會`,
  `學術討論`, or `不產生任務`, do not create tasks or progress reports from that
  meeting.
- Low-confidence, sensitive, financial, contractual, legal, HR, tax, or external
  commitment items must remain pending confirmation.
- Meeting progress statements, blockers, and next steps may update
  `專案進度報表庫`, but only inside `Codex 總控中心`.
- Meeting discussions and decisions should be preserved or linked as execution
  background for related tasks because they explain progress history, decisions,
  blockers, dependencies, and completion criteria.

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
- Every task should be connected to a project goal where possible. If the
  conversation reveals a new project goal, summarize that goal and organize the
  related tasks under it.
- If project, owner, or due date is missing, the task can still be created but must be marked incomplete/insufficient.
- Sensitive or high-risk tasks are not auto-confirmed.
- High-risk topics include money, contracts, HR discipline, legal, tax, and external commitments.
- Assistant Manager mode is intentionally broad: health, family, insurance, fire insurance, mortgage insurance, tax, tenant issues, customer complaints, delegated responsibility, uncertainty, decisions, meetings, and progress signals should be captured when there is any reasonable chance Seven should notice them.
- Important but low-confidence LINE items should become `待確認` tasks instead of being silently ignored.
- When one LINE message contains multiple concerns, split it into multiple candidate tasks where practical.
- Relationship or complaint escalation signals such as dissatisfaction, lack of progress updates, apology, stakeholder discomfort, or promised follow-up must be treated as important `關係/客訴事件` items, not as generic low-signal chat.
- If a LINE conversation master has `總控專案` filled, that project assignment overrides text-based project guessing for tasks, progress reports, and daily report grouping.
- Later LINE messages, meeting notes, daily reports, or system suggestions may
  update an existing task's status. Record the source clue and the detected
  status change in the task body or evidence field.
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
| `seven-jr-line-message-judgement-sync` | 08:10-22:10 hourly | `10 0-14 * * *` | LINE conversation LLM task extraction |
| `seven-jr-codex-command-triage` | every 15 minutes | `*/15 * * * *` | Codex command queue LLM triage |
| `seven-jr-extraction-feedback-sync` | 22:45 daily | `45 14 * * *` | extraction feedback calibration sync |
| `seven-jr-meeting-action-sync` | 08:00-22:00 hourly | `0 0-14 * * *` | meeting action sync |
| `seven-jr-responsibility-candidate-sync` | 08:15-22:15 hourly | `15 0-14 * * *` | responsibility candidate sync |
| `seven-jr-morning-brief` | 08:30 | `30 0 * * *` | `morning` |
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

LINE conversation judgement sync runs:

```bash
npm run llm:extract -- --include-outgoing-groups --limit 20
```

This is the LLM extraction engine (`scripts/llm-task-extraction.js`). It calls the
Claude API (`ANTHROPIC_API_KEY`, model from `ANTHROPIC_MODEL`, default
`claude-opus-4-8`) with the shared hierarchy master prompt from
`config/conversation-task-hierarchy-prompt.json` and a strict JSON output schema.
If `ANTHROPIC_API_KEY` is not configured, it automatically falls back to the
legacy rule-based engine:

```bash
npm run line:conversation-judgements -- --include-outgoing-groups --limit 50
```

It scans `Seven LINE 對話主檔`, not `Seven LINE 訊息紀錄`. The judgement source must be `SEVEN_CONVERSATIONS_DATA_SOURCE_ID`; do not use `SEVEN_MESSAGES_DATA_SOURCE_ID` as task judgement input. For each updated LINE conversation, the hourly job reads the latest 20 conversation messages from the conversation master page, orders them from older to newer, then checks the active `總控任務庫` for related tasks. If the conversation segment extends, answers, completes, blocks, changes, or clarifies an existing task, update that task and record the evidence. Only when no existing task can reasonably absorb the conversation segment should the job decide whether it is a genuinely new event and create one event-level task.

Conversation judgement state is tracked on `Seven LINE 對話主檔` with these fields:

- `最後任務判斷時間`
- `最後任務判斷訊息時間`
- `任務判斷狀態`

Do not use the message-record field `已進入判斷層` for hourly LINE task judgement.

The 08:00-22:00 hourly LINE judgement contract is defined in:

```text
config/hourly-line-task-reconciliation.json
```

Scheduled judgement includes normal `line` source messages and Seven Jr. outgoing `ai-engine` messages sent to groups/rooms through the control API; personal report notifications to Seven are excluded. Background, acknowledgement, duplicate, test, pure knowledge-sharing, or non-actionable record messages should be marked judged without creating tasks.

Responsibility candidate sync runs:

```bash
npm run responsibility:sync
```

It refreshes the `權責定義表` candidate lists so each project row shows only
LINE groups assigned to that project, and each selected group shows only known
members from that group.

Hourly assistant maintenance has three lanes:

- Meeting lane: `npm run meetings:sync -- --limit 50`
- LINE lane: `npm run line:conversation-judgements -- --include-outgoing-groups --limit 50`
- Responsibility lane: `npm run responsibility:sync`

Local full hourly run:

```bash
npm run assistant:hourly
```

Rule-update backfill:

```bash
npm run line:conversation-judgements -- --reprocess --since-hours 24 --limit 100
```

Same-day group-only task status reconciliation:

```bash
npm run line:conversation-judgements -- --reprocess --groups-only --include-outgoing-groups --update-existing-only --skip-progress --since-iso <UTC midnight for Taipei> --limit 100
```

Use this when the user asks to reread today's LINE group messages and update the
current task list without creating new task pages or progress reports. For
Taipei midnight, pass the previous UTC date at 16:00, for example
`2026-06-08T16:00:00.000Z` for 2026-06-09.

The 20:30 daily report is dynamic. It reads today's updated `Seven LINE 對話主檔`
conversation content, judgement-created tasks, and progress reports. It must
not use `Seven LINE 訊息紀錄` as the report clue source. To inspect the generated
report without sending LINE:

```text
POST /control/reports/preview
```

Render has already been confirmed to build these jobs through Blueprint, and the user successfully triggered one run and received the LINE message.

## Report Pages

Production report links should be served by the Render web service, not by GitHub HTML preview.

### Dynamic task review pages (2026-06-11)

`GET /reports/daily-control-report` and `GET /reports/followup-confirmation?slot=10|13|17`
are now **server-rendered from live Notion data** (`src/report-pages.js`), not
static prototypes. Each page lists every task with `確認狀態 = 未確認`
(excluding 封存/已完成), grouped by project, with a per-task verdict dropdown:

- 保留未確認（下次再裁決）
- 確認成立：未開始 / 進行中 / 等待回覆（writes 確認狀態=已確認 + 狀態）
- 已做完：待確認完成
- 合併到既有任務（MERGE_INTO_EXISTING；target picked from an active-task datalist）
- 不成立（誤判）：封存（writes 狀態=封存 and **leaves 確認狀態=未確認** so the
  calibration feedback correctly records a rejection）

Submissions POST to `/control/reports/approve`; after success the page reloads
and decided tasks disappear. The static prototypes remain available at the
`-prototype.html` paths and serve as automatic fallback if Notion rendering
fails. `?key=<approval key>` on the page URL is stored to localStorage and sent
with every submission.

### Waiting-reply chase and in-progress sections (2026-06-11)

The review pages have three sections:

1. **新任務裁決** — extraction verdicts as above (tasks with 狀態=等待回覆 are
   excluded here; they live in section 2).
2. **等待回覆：要不要追問？** — every task with `狀態 = 等待回覆` whose
   `追蹤暫緩至` is empty or past. Per task: send a system-drafted chase message
   (editable textarea; browser confirm before sending), snooze 1/3/5/7 days,
   mark 待確認完成 / 進行中, or archive. Sending pushes the message to the
   task's source conversation (resolved from `關聯 Notion 頁面` → conversation
   master Group ID/Room ID/User ID), logs the outgoing message, appends a
   「追問已發送」 record to the task body, and auto-snoozes the task 2 days.
3. **進行中／未開始提醒** — tasks with `狀態 ∈ {進行中, 未開始}` and
   `確認狀態 ≠ 未確認`. Per task: status change select and a note textarea.
   Notes are appended to the task body as 「補充備註（time）」 with a source
   label naming the report and submitter, and copied into the `最新備註`
   property. The hourly extraction includes `下一步` and `最新備註` in the
   active-task context, so user notes directly inform AI judgment.

`/control/reports/approve` accepts three additional lists: `followupSends`
(`{task, message, conversationUrl}`), `snoozes` (`{task, days}` 1–30), and
`taskNotes` (`{task, note}`). Two task-database properties are auto-created on
first use: `追蹤暫緩至` (date) and `最新備註` (rich_text). The LINE
acknowledgement reports sent/failed chase messages, snoozes, and notes.

Approval write-back fix (2026-06-11): dismissals (狀態=封存) from report pages
no longer set 確認狀態=已確認 (previously they did, which made the feedback
loop record rejections as confirmations), and dismissing a task name that no
longer exists does not create a new task page.

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

- 08:30 morning brief
- 10:00 follow-up and new task confirmation
- 13:00 follow-up and new task confirmation
- 17:00 follow-up and new task confirmation
- 20:30 daily control confirmation

If the LINE acknowledgement fails, the Notion write remains valid. The API response should include `acknowledgement.ok=false` for troubleshooting.

### Follow-up Dispatch After Approval

Approved follow-up messages use a protected two-step dispatch flow:

1. The approval page records the user's selected follow-up target, action, and
   edited message.
2. Render resolves the target from explicit `targetId` first. If no ID is
   provided, it searches `Seven LINE 對話主檔` by LINE conversation name,
   custom name, project, and notes.
3. If exactly one LINE target is resolved, the item is dispatchable.
4. If no target or multiple possible targets are found, the item is marked
   `pending-target`; Seven Jr. must not guess or send.
5. Private/internal targets such as `私人事務` are always treated as internal-only
   and are not sent externally.

Safe test endpoint:

```text
POST /control/followups/dispatch
```

By default this endpoint runs as dry-run. It returns `dryRunResolved` and
`pending` counts without sending LINE. To actually send, the request must set
both `dryRun=false` and `sendApprovedFollowups=true` or `confirmSend=true`.

Current 2026-06-09 test result:

- `台翰營造&茲心園改建` resolves to the `台翰營造` LINE group.
- `包租代管 / 昱晴` has no configured LINE target yet and remains pending.
- `私人事務` is internal-only and is not sent externally.

### LINE Group Mention Notifications

When AM needs to notify a specific responsible person inside a LINE group, use
LINE `textV2` with `substitution` mention. Do not send a plain text message that
only contains `@Name`; LINE will display that as ordinary text and may not notify
the person.

Correct outbound mention pattern:

```json
{
  "type": "textV2",
  "text": "{owner} 提醒：請協助確認這項任務的下一步。",
  "substitution": {
    "owner": {
      "type": "mention",
      "mentionee": {
        "type": "user",
        "userId": "TARGET_LINE_USER_ID"
      }
    }
  }
}
```

Rules:

- The destination must be a LINE group or room. LINE mentions do not work in
  one-on-one user chats.
- The mentioned user must be a member of the destination group or room.
- The target must be the real LINE user ID, not a display name.
- If the user or group cannot be resolved uniquely, keep the item pending target
  confirmation and do not guess.
- Use this for approved follow-ups to group owners, project owners, task owners,
  or responsible people.

Reference doc: `docs/line-group-mention-notification.md`.

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

## Durable Event Queue (2026-06-11)

The webhook server now stores LINE events in a Postgres queue before writing to
Notion, so messages survive Notion outages, rate limits, and server restarts.

- `src/event-queue.js` owns the queue. Table: `line_event_queue` with statuses
  `pending` / `processing` / `done` / `dead`.
- Webhook flow with `DATABASE_URL` set: validate signature, insert events,
  reply 200 to LINE immediately, then a background worker writes to Notion with
  retry (30s, 1m, 5m, 15m, 30m, 1h, 2h backoff; max 8 attempts).
- Events that exhaust retries move to `dead` status and trigger a LINE alert to
  `SEVEN_ALERT_TARGET_ID` (if set). The raw event stays in Postgres for manual
  reprocessing.
- Without `DATABASE_URL`, the webhook falls back to the previous synchronous
  Notion write behavior. Nothing breaks; there is just no durability layer.
- `GET /health` reports queue status under `eventQueue`.
- `render.yaml` defines the `sevenam-queue-db` Postgres database. The Render
  free Postgres plan expires after 30 days; production should use a paid plan.

## LLM Extraction and Command Triage (2026-06-11)

Task extraction and Codex command processing are now Render-side services that
call the Claude API directly. They no longer depend on a human-driven Codex
session being online.

- `scripts/llm-task-extraction.js` (hourly): reads conversation timelines from
  `Seven LINE 對話主檔`, judges them with the shared hierarchy master prompt,
  creates candidate tasks in `總控任務庫` (`狀態 = 待確認`,
  `確認狀態 = 未確認`), appends evidence to existing active tasks, and marks
  conversations judged. It never sets `已完成`; completion reports become
  `待確認完成`. Falls back to the legacy rule engine when `ANTHROPIC_API_KEY`
  is missing.
- `scripts/llm-codex-command-triage.js` (every 15 minutes): processes Pending
  items in the Codex command queue. Pure analysis/summary commands are answered
  directly and marked `Done`. Anything sensitive (money, contract, legal, HR,
  tax, external commitment) or requiring real-world action is marked
  `Needs Confirmation` with a proposed plan in `Result`. The triage service
  never sends LINE messages itself. When `ANTHROPIC_API_KEY` is missing it
  exits cleanly and commands stay `Pending` for a manual session.
- Required env: `ANTHROPIC_API_KEY` (secret, set on the Render web service and
  shared to crons), optional `ANTHROPIC_MODEL` (default `claude-opus-4-8`).

## Extraction Feedback Calibration Loop (2026-06-11)

`scripts/sync-extraction-feedback.js` (daily 22:45 Taipei) closes the judgment
calibration loop automatically:

1. **Collect feedback**: scans `總控任務庫` for LINE-sourced tasks the user has
   decided on — `確認狀態 = 已確認` (confirmed), `確認狀態 = 合併到既有任務`
   (merged), or `狀態 = 封存` without confirmation (rejected) — and records each
   as a case in `Seven 判斷校準案例庫` (`Case Status = Replied`). Tasks already
   linked from a case are skipped, so reruns are idempotent.
2. **Suggest rules**: for rejected tasks, Claude analyzes whether the
   misjudgment generalizes. If yes, it creates a rule in `Seven 判斷規則庫` with
   `Status = Needs review`. **Rules never activate themselves** — the user must
   flip Status to `Active` in Notion for a rule to take effect.
3. **Apply rules**: `scripts/llm-task-extraction.js` loads rules with
   `Status = Active` and `Applies To` containing `SEVEN_AM` at the start of each
   run and injects them into the extraction system prompt as
   「校準規則（優先遵守）」.
4. **Stats**: each run logs per-confidence confirm/reject rates
   (`calibrationStats` in the cron output) so confidence calibration drift is
   visible in Render logs.

This pipeline coexists with the manual LINE calibration flow
(`開始做任務校準` commands); both write to the same case and rule databases.

### Project governance baseline (2026-06-12)

- **Controlled project vocabulary (R1)**: the extraction service loads the
  official project list from `總控專案庫`
  (`SEVEN_PROJECTS_DATA_SOURCE_ID`, default `2d4e4e80-09e6-447f-b2e2-36269ff1ac5c`)
  on every run, injects it into the system prompt, and enforces it through the
  JSON schema enum (`project` must be an official name or `未分類`). The AI can
  never invent a project name. Projects are born only by the user (or, later,
  through the approved proposal flow).
- **Unclassified hygiene (R4)**: review pages have a fourth section
  「未分類任務待歸屬」 listing confirmed tasks whose 專案 is 未分類/empty, with
  a project picker fed from the official list. Submissions use the
  `projectAssigns` list (`{task, project}`) on `/control/reports/approve`.
- Tasks never require a project to be created — 未分類 is the intake area.
- `查待辦` LINE replies now read 截止日 (falling back to 期限/Due Date).

### Trustworthiness instruments (2026-06-11)

Three additional instruments make extraction quality measurable and
self-correcting:

1. **Confidence calibration injection**: at the start of each extraction run,
   `llm-task-extraction.js` computes the historical confirm rate per
   confidence level from the calibration case database. Once a level has at
   least 5 labeled cases, the stats are injected into the system prompt with
   an instruction to tighten or loosen confidence labels accordingly. Target:
   「高」 confidence should correspond to a 90%+ confirm rate.
2. **Borderline suppression sampling (false-negative guard)**: when the model
   seriously considers creating a task but decides to suppress it, it must
   mark the item `borderline: true`. Up to 2 borderline items per conversation
   are written to the calibration case database (`Case Status = New`,
   `Source Type = LINE message`) so the user can cheaply spot-check what the
   AI almost caught. This is the only feedback signal for missed tasks.
3. **Prompt hardening (2026-06-11)**: the conversation timeline is wrapped in
   `<<<對話時間軸開始>>>` / `<<<對話時間軸結束>>>` delimiters and declared as
   data-not-instructions, so text inside LINE messages cannot redirect the
   extraction engine (prompt injection guard). Timeline entries are annotated
   【新訊息】/【背景】 against `最後任務判斷訊息時間`; only new messages may
   create tasks or change status (duplicate-task guard). Status suggestions
   without a source-evidence excerpt are dropped in code. Child tasks link to
   their parent through the `母任務` relation when the property exists.
   Sensitive tasks are forced to 優先級=高. Max 5 new tasks per conversation
   per run. Inspect the assembled prompt with
   `node scripts/llm-task-extraction.js --print-system-prompt`.
4. **Eval harness**: `npm run eval:extraction -- --limit 40 [--save out.json]`
   replays the judgment core against the labeled golden set (user verdicts
   from the calibration case database) and reports accuracy, precision,
   recall, per-confidence accuracy, and mismatch samples. Run it before and
   after any prompt or rule change; do not ship a change that drops recall.
   Requires `ANTHROPIC_API_KEY` and at least a few labeled cases (run the
   feedback sync first).

## Dual-Mode Processing: Local Worker + Render Fallback (2026-06-12)

The judgment brain can run on two interchangeable backends via `LLM_BACKEND`:

- `api` (default): Anthropic API with metered billing — used by Render crons.
- `claude-code`: local Claude Code CLI in headless mode (`claude -p`) — uses
  the user's subscription quota. Implemented in `src/llm-backend.js`; the
  prompts, schemas, calibration rules, and Notion writes are identical.

**Local worker** (`npm run worker`, wrapper `scripts/start-local-worker.ps1`)
runs on the 24/7 machine: every ~90 seconds it runs task extraction and
command triage with `LLM_BACKEND=claude-code`, and triage gets `--reply` so
7 Junior commands receive near-instant LINE answers. After each healthy cycle
the worker POSTs `/worker/heartbeat` (control-key auth, stored in Postgres).

**Automatic mode switching**: the extraction and triage Render crons run
through `run-cron-with-alert.js` with `AM_SKIP_IF_WORKER_ACTIVE=true`; they
check `GET /worker/status` first and exit quietly when a heartbeat is fresher
than `SEVEN_WORKER_HEARTBEAT_MAX_AGE_SECONDS` (default 600). If the worker
machine dies, loses CLI auth, or exhausts subscription quota, heartbeats stop
and the API-billed crons take over automatically — no manual switch.

Worker self-protection: a Claude Code auth self-test runs at startup (exit
code 2 with login instructions on failure), and 3 consecutive failed cycles
suspend heartbeats so Render reclaims the work. The CLI must be logged in
interactively once (`claude` → `/login`) — its OAuth credential is separate
from the desktop app login. Report crons, attachment parsing, feedback sync,
and meeting/responsibility syncs stay on Render regardless of worker state.

## Cron Failure Alerts (2026-06-11)

- Report crons already alert through `scripts/render-cron-report.js`.
- All other crons (judgement sync, meeting sync, responsibility sync, command
  triage) run through `scripts/run-cron-with-alert.js`, which pushes a LINE
  alert to the default report target via the Control API when the wrapped
  script exits non-zero.

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
