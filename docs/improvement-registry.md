# Improvement Registry

This registry lists reusable Assistant Manager improvements that can be applied independently to HOZO AM, 7AM, or future similar projects.

Each improvement version must be applied project-by-project. Installing a version in one project does not mean another project has it.

| Version | Improvement | Capability File | Portable | Current HOZO AM Status | Current 7AM Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `AM-IMP-2026.0608.01` | Project data isolation guard | `docs/upgrades/UPGRADE-YYYY-MM-DD-AM-IMP-2026.0608.01.md` | Yes | Installed | Needs review | Prevent Notion writes to another business unit's databases. |
| `AM-IMP-2026.0608.02` | Scheduled report multi-recipient rule | `docs/upgrades/UPGRADE-YYYY-MM-DD-AM-IMP-2026.0608.02.md` | Yes | Installed | Needs review | Reports can be sent to owner plus CC recipient using project-local LINE conversations. |
| `AM-IMP-2026.0608.03` | LINE task-query reply command | `docs/upgrades/UPGRADE-YYYY-MM-DD-AM-IMP-2026.0608.03.md` | Yes | Installed locally; deploy pending | Needs review | User can ask the assistant in LINE for current tasks and receive a direct reply. |
| `AM-IMP-2026.0608.04` | Cron report deployment verification | `docs/upgrades/UPGRADE-YYYY-MM-DD-AM-IMP-2026.0608.04.md` | Yes | Proposed | Proposed | Each scheduled report must leave a verifiable send/log record. |
| `AM-IMP-2026.0608.05` | Improvement manifest and upgrade records | `docs/upgrades/UPGRADE-YYYY-MM-DD-AM-IMP-2026.0608.05.md` | Yes | Proposed | Proposed | Each project tracks installed improvement versions through a manifest. |

## How To Read This Table

- `Portable = Yes` means the idea can be reused, not that data or secrets can be reused.
- `Current HOZO AM Status` and `Current 7AM Status` must be updated separately.
- A project is considered to have an improvement only when its own `docs/project-improvement-manifest.md` marks that version as `Installed` or `Deployed`.

