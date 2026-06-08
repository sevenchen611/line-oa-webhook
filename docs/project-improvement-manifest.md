# Project Improvement Manifest

Project: 7AM

This file records which shared improvement versions are installed in this project.

Do not copy production values from another project. Each project must use its own LINE, Notion, Render, and environment configuration.

| Version | Improvement | Status | Applied Date | Commit / Reference | Verification |
| --- | --- | --- | --- | --- | --- |
| `AM-IMP-2026.0608.01` | Project data isolation guard | Needs review |  |  |  |
| `AM-IMP-2026.0608.02` | Scheduled report multi-recipient rule | Needs review |  |  |  |
| `AM-IMP-2026.0608.03` | LINE task-query reply command | Needs review |  |  |  |
| `AM-IMP-2026.0608.04` | Cron report deployment verification | Proposed |  |  |  |
| `AM-IMP-2026.0608.05` | Improvement manifest and upgrade records | Installed | 2026-06-08 | Planning docs | This manifest exists. |
| `AM-IMP-2026.0608.06` | Event-conclusion daily report and follow-up task synthesis | Installed | 2026-06-08 | `8954062`, `f77bd36`, `3201ef7`, `cd47497`; Notion task writeback | Local syntax checks passed; preview/send tested; event-level follow-up tasks created in 7AM total task database. |
| `AM-IMP-2026.0608.08` | Hierarchical responsibility owner narrowing workflow | Installed | 2026-06-08 | `5575e42`; Notion schema update; `docs/upgrades/UPGRADE-2026-06-08-AM-IMP-2026.0608.08.md` | Local syntax check passed; dry run and write run updated 10 responsibility rows from 52 group options and 23 member options. Production Render cron deploy pending verification. |

## Project-Specific Values

Keep these values project-local:

| Area | 7AM Value Source |
| --- | --- |
| LINE channel | 7AM LINE Developers channel |
| Notion data sources | 7AM Notion databases only |
| Render service | 7AM Render service only |
| Report recipients | 7AM LINE conversation records |
| Secrets | `.env` locally and Render Environment in production |
