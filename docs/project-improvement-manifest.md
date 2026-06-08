# Project Improvement Manifest

Project: 7AM

This file records which shared improvement versions are installed in this project.

Do not copy production values from another project. Each project must use its own LINE, Notion, Render, and environment configuration.

| Version | Improvement | Status | Applied Date | Commit / Reference | Verification |
| --- | --- | --- | --- | --- | --- |
| `AM-IMP-2026.0608.01` | Project data isolation guard | Deployed | 2026-06-08 | Commit `Install shared AM improvements for SevenAM`; `docs/upgrades/UPGRADE-2026-06-08-AM-IMP-2026.0608.01.md` | `node --check` passed; local health passed; production daily preview read SevenAM Notion data without sending LINE. |
| `AM-IMP-2026.0608.02` | Scheduled report multi-recipient rule | Deployed | 2026-06-08 | Commit `Install shared AM improvements for SevenAM`; `docs/upgrades/UPGRADE-2026-06-08-AM-IMP-2026.0608.02.md` | `node --check` passed; production control health showed `multiRecipientReportEnabled=true`; no-send production daily preview passed. |
| `AM-IMP-2026.0608.03` | LINE task-query reply command | Installed | 2026-06-08 | Commit `Install shared AM improvements for SevenAM`; `docs/upgrades/UPGRADE-2026-06-08-AM-IMP-2026.0608.03.md` | `node --check` passed; production health showed `taskQueryReplyEnabled=true`; safe live LINE command test still needs user confirmation. |
| `AM-IMP-2026.0608.04` | Cron report deployment verification | Deployed | 2026-06-08 | AM_Core package + local `src/control-api.js` + production `/control/health` | 7AM production `/control/health` returned `dailyReportSnapshotsConfigured=true`; syntax checks passed. |
| `AM-IMP-2026.0608.05` | Improvement manifest and upgrade records | Installed | 2026-06-08 | Planning docs | This manifest exists. |
| `AM-IMP-2026.0608.06` | Event-conclusion daily report and follow-up task synthesis | Installed | 2026-06-08 | `8954062`, `f77bd36`, `3201ef7`, `cd47497`; Notion task writeback | Local syntax checks passed; preview/send tested; event-level follow-up tasks created in 7AM total task database. |
| `AM-IMP-2026.0608.07` | Five-slot goal recognition and confirmation workflow | Installed | 2026-06-08 | AM_Core package + local `src/control-api.js` | Added goal-recognition language to 08:00, 10:00, 13:00, 17:00, and 20:30 report paths; Render deploy still pending. |
| `AM-IMP-2026.0608.08` | Hierarchical responsibility owner narrowing workflow | Installed | 2026-06-08 | `5575e42`; Notion schema update; `docs/upgrades/UPGRADE-2026-06-08-AM-IMP-2026.0608.08.md` | Local syntax check passed; dry run and write run updated 10 responsibility rows from 52 group options and 23 member options. Production Render cron deploy pending verification. |
| `AM-IMP-2026.0608.09` | Immediate LINE command conversation mode | Deployed | 2026-06-08 | `58f7221`; `docs/upgrades/UPGRADE-2026-06-08-AM-IMP-2026.0608.09.md` | `node --check` passed; local and production health showed `immediateCommandEnabled=true`; live LINE detail command test pending. |
| `AM-IMP-2026.0608.10` | Notion database view layout registry | Installed | 2026-06-08 | AM_Core package + Notion view update | 7AM LINE group options Default view shows `總控專案`, `群組顯示名稱`, `LINE對話名稱`, `候選來源權責項目` in order. |
| `AM-IMP-2026.0608.11` | Report intervention action standard | Installed | 2026-06-08 | AM_Core package + `config/report-intervention-actions.json` + `scripts/generate-0800-daily-report-preview.js` | 08:00 report candidate UI renders all six canonical intervention actions and stores action keys; syntax and JSON checks passed. Render deploy still pending. |
| `AM-IMP-2026.0608.12` | Cron report reliability upgrade | Installed | 2026-06-08 | AM_Core package + local `scripts/render-cron-report.js` + `render.yaml` | Local syntax checks passed; Render Blueprint sync/deploy and next scheduled cron verification still pending. |
| `AM-IMP-2026.0608.13` | Judgment calibration knowledge base | Installed | 2026-06-08 | AM_Core package + local `scripts/judgment-calibration.js` + `src/server.js` | Created 7AM project-local calibration databases; resolved `Seven 陳聖文`; sent test and first review; added LINE commands for start/pause/status and progress labels; Render deploy still pending. |
| `AM-IMP-2026.0608.14` | Meeting checkbox task standard | Installed | 2026-06-08 | AM_Core package + `scripts/sync-meeting-actions.js` | Meeting checkbox items now bypass action-keyword filtering and write confirmed task evidence; syntax checks passed. Render cron deploy verification still pending. |
| `AM-IMP-2026.0608.15` | Total-control task title hygiene | Installed | 2026-06-08 | AM_Core package + local `scripts/sync-line-message-judgements.js` + cleanup script | Existing task cleanup updated 45 SevenAM task titles; final cleanup scan matched 0 titles containing Notion/LINE technical IDs. |
| `AM-IMP-2026.0608.16` | Project dossier and task relation architecture | Installed | 2026-06-08 | AM_Core package + 7AM Notion schema update | Added `總控專案` relation on 7AM task database and reciprocal `關聯任務` on project database;溪投 project dossier body and supporting task links were updated. |
| `AM-IMP-2026.0608.17` | Task dossier and subtask hierarchy architecture | Installed | 2026-06-08 | AM_Core package + 7AM Notion schema update | Added `母任務` / `子任務` self-relations on 7AM task database; updated溪投資料補齊 task and child tasks as task dossiers with conversation, file, and completion evidence. |
| `AM-IMP-2026.0608.18` | Hourly LINE task reconciliation | Installed | 2026-06-08 | AM_Core package + local `config/hourly-line-task-reconciliation.json` + `AGENTS.md` | SevenAM hourly LINE judgement is now documented as event/task reconciliation: new messages must be compared with same-group context and active total-control tasks before creating new event-level tasks. |
| `AM-IMP-2026.0608.19` | Total-control task table source text hide rule | Installed | 2026-06-08 | AM_Core package + Notion view update | 7AM total-control task Default view and 待確認 View no longer display `來源原文`; the property remains available for audit fallback and existing values were not erased. |
| `AM-IMP-2026.0608.20` | SevenAM 08:00 Google Calendar agenda section | Installed | 2026-06-08 | AM_Core package + local `scripts/generate-0800-daily-report-preview.js` | 08:00 report now includes `今天的行程安排`; Calendar events display when SevenAM receives Google Calendar event input, otherwise the report shows a clear not-connected state. HOZO AM is intentionally not installed. |

## Project-Specific Values

Keep these values project-local:

| Area | 7AM Value Source |
| --- | --- |
| LINE channel | 7AM LINE Developers channel |
| Notion data sources | 7AM Notion databases only |
| Render service | 7AM Render service only |
| Report recipients | 7AM LINE conversation records |
| Secrets | `.env` locally and Render Environment in production |
