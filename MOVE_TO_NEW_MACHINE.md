# Move To A New Machine

This package contains the LINE OA webhook service for Seven Jr.

## What To Copy

Use the normal project package for code and documentation:

```text
line-oa-webhook-transfer-YYYYMMDD-HHMMSS.zip
```

Secrets are packaged separately:

```text
line-oa-webhook-secrets-YYYYMMDD-HHMMSS.zip
```

Keep the secrets package private. It contains local environment values such as LINE, Notion, and control API keys.

## Requirements

- Node.js 20 or newer
- npm
- Network access to LINE, Notion, and Render if testing remote APIs

## Install

1. Extract the normal project package on the new machine.
2. Open a terminal in the extracted `line-oa-webhook` folder.
3. Install dependencies:

```powershell
npm install
```

At the time this guide was written, the project has no external npm dependencies in `package.json`, but running `npm install` is still harmless and prepares the project if dependencies are added later.

## Environment Variables

The app reads settings from environment variables. It does not automatically load `env.txt`.

On a local Windows machine, set the variables for the current PowerShell session before starting:

```powershell
$env:LINE_CHANNEL_ACCESS_TOKEN="..."
$env:LINE_CHANNEL_SECRET="..."
$env:NOTION_TOKEN="..."
$env:SEVEN_CONVERSATIONS_DATA_SOURCE_ID="..."
$env:SEVEN_MESSAGES_DATA_SOURCE_ID="..."
$env:SEVEN_ATTACHMENTS_DATA_SOURCE_ID="..."
$env:SEVEN_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID="..."
$env:SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID="..."
$env:SEVEN_CONTROL_API_KEY="..."
```

Use the separate secrets package as the source of the real values. Do not paste secrets into chat, commits, screenshots, or public docs.

## Run Locally

Start the webhook/control server:

```powershell
npm start
```

By default the server listens on:

```text
http://localhost:3000
```

Health checks:

```text
GET http://localhost:3000/health
GET http://localhost:3000/control/health
```

## Test A Report Push

After setting `SEVEN_CONTROL_API_KEY`, test from PowerShell:

```powershell
$headers = @{ "x-seven-control-key" = $env:SEVEN_CONTROL_API_KEY }
$body = @{ reportType = "morning" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/control/reports/send" -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

## Deploy To Render

If moving by GitHub/Render instead of running locally:

1. Push or upload the project contents to the target repository.
2. In Render, create or update the service from `render.yaml`.
3. Add the environment variables from the secrets package in the Render Dashboard.
4. Confirm:

```text
GET https://<render-service>/health
GET https://<render-service>/control/health
```

## Important Notes

- The Notion location for the raw LINE CRM layer is now:

```text
Codex 總控中心 / Seven LINE CRM 原始紀錄層
```

- Render and the webhook code access Notion by database/data source IDs, not by the visual page path.
- `env.txt` and other secret files must not be committed to GitHub.
- If this server runs on a new public URL, update the LINE Developers webhook URL to:

```text
https://<new-host>/webhook/line
```
