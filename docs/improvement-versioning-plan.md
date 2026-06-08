# Improvement Versioning Plan

This project should manage reusable improvements as versioned capabilities, not as shared production data.

HOZO AM and 7AM may use the same improvement specification, but each project must keep its own LINE channel, Notion data sources, Render services, environment variables, recipients, and logs.

## Files

Use these files in each project:

| File | Purpose | Required in each project |
| --- | --- | --- |
| `docs/improvement-registry.md` | Shared catalog of available improvement versions. | Yes |
| `docs/project-improvement-manifest.md` | Project-local checklist of which improvement versions are installed. | Yes |
| `docs/upgrades/UPGRADE-YYYY-MM-DD-vX.Y.Z.md` | One upgrade report per applied improvement version. | Recommended |

Rule: if a project contains `docs/project-improvement-manifest.md` and marks a version as `Installed`, that project is treated as having that improvement.

## Version Model

Use one version per improvement.

Version format:

```text
AM-IMP-YYYY.MMDD.NN
```

Example:

```text
AM-IMP-2026.0608.01
```

## Separation Rule

Reusable improvements may share behavior, code patterns, documentation structure, test checklists, and upgrade steps.

Reusable improvements must not share LINE secrets, Notion tokens, Notion data source IDs across business entities, Render service IDs, customer messages, task records, report data, or automation logs.

## Upgrade Flow

1. Add or update the version in `docs/improvement-registry.md`.
2. Create an upgrade report from `docs/templates/upgrade-version-template.md`.
3. Apply the improvement to one project.
4. Verify local behavior.
5. Deploy or sync production.
6. Mark the version in `docs/project-improvement-manifest.md`.
7. Repeat the same version for the other project, using that project's own env vars and data sources.

