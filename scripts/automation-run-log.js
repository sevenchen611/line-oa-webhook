import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(__dirname, '..');
const logsDir = path.join(workspaceRoot, 'logs');
const textLogPath = path.join(logsDir, 'automation-execution.log');
const jsonLogPath = path.join(logsDir, 'automation-execution.jsonl');
const configPath = path.join(repoRoot, 'config', 'automation-run-log.json');

loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(repoRoot, '..', 'env.txt'));

const [action, automationId, status, ...summaryParts] = process.argv.slice(2);
const summary = summaryParts.join(' ').trim() || null;
const notionToken = process.env.NOTION_TOKEN || null;
const notionVersion = process.env.NOTION_VERSION || '2026-03-11';
const runLogConfig = readRunLogConfig();

if (!action || !automationId || !status) {
  fail('Usage: node scripts/automation-run-log.js <action> <automationId> <status> [summary...]');
}

ensureDir(logsDir);

const now = new Date();
const taipeiFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const taipeiTimestamp = `${taipeiFormatter.format(now).replace(' ', ' ')} +08:00`;
const entry = {
  timestampUtc: now.toISOString(),
  timestampTaipei: taipeiTimestamp,
  action,
  automationId,
  status,
  summary,
  cwd: process.cwd(),
  source: resolveSource(action, automationId),
};

appendFileSync(textLogPath, `${formatTextLine(entry)}\n`, 'utf8');
appendFileSync(jsonLogPath, `${JSON.stringify(entry)}\n`, 'utf8');

const notionResult = await writeNotionEntry(entry);

console.log(JSON.stringify({ ok: true, textLogPath, jsonLogPath, notionResult, entry }, null, 2));

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function formatTextLine(logEntry) {
  const parts = [
    `[${logEntry.timestampTaipei}]`,
    `action=${logEntry.action}`,
    `automation_id=${logEntry.automationId}`,
    `status=${logEntry.status}`,
    `source=${logEntry.source}`,
  ];

  if (logEntry.summary) {
    parts.push(`summary=${sanitize(logEntry.summary)}`);
  }

  return parts.join(' | ');
}

function sanitize(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function resolveSource(currentAction, currentAutomationId) {
  if (currentAction === 'manual_verification' || currentAutomationId === 'config-check') {
    return 'manual';
  }
  return 'local-automation';
}

function readRunLogConfig() {
  if (!existsSync(configPath)) {
    return null;
  }

  return JSON.parse(readFileSync(configPath, 'utf8'));
}

async function writeNotionEntry(entry) {
  const dataSourceId = process.env.SEVEN_AUTOMATION_RUN_LOG_DATA_SOURCE_ID
    || runLogConfig?.notionDataSourceId
    || null;

  if (!notionToken || !dataSourceId) {
    return {
      ok: false,
      skipped: true,
      reason: !notionToken ? 'NOTION_TOKEN is not set.' : 'Automation run log data source is not configured.',
    };
  }

  const name = `${entry.action} | ${entry.automationId} | ${entry.status} | ${entry.timestampTaipei}`;
  const properties = {
    Name: {
      title: [{ type: 'text', text: { content: clampText(name, 200) } }],
    },
    Action: {
      rich_text: [{ type: 'text', text: { content: clampText(entry.action, 200) } }],
    },
    'Automation ID': {
      rich_text: [{ type: 'text', text: { content: clampText(entry.automationId, 200) } }],
    },
    Status: {
      select: { name: entry.status },
    },
    Summary: {
      rich_text: summaryRichText(entry.summary),
    },
    'Timestamp Taipei': {
      date: {
        start: toTaipeiIsoDateTime(entry.timestampUtc),
      },
    },
    'Timestamp UTC': {
      rich_text: [{ type: 'text', text: { content: entry.timestampUtc } }],
    },
    CWD: {
      rich_text: [{ type: 'text', text: { content: clampText(entry.cwd, 1900) } }],
    },
    Source: {
      select: { name: entry.source },
    },
  };

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': notionVersion,
    },
    body: JSON.stringify({
      parent: {
        type: 'data_source_id',
        data_source_id: dataSourceId,
      },
      properties,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      skipped: false,
      reason: `Notion write failed: ${response.status} ${responseText}`,
    };
  }

  const page = responseText ? JSON.parse(responseText) : {};
  return {
    ok: true,
    pageId: page.id || null,
    url: page.url || null,
    dataSourceId,
  };
}

function summaryRichText(value) {
  if (!value) {
    return [];
  }

  return [{ type: 'text', text: { content: clampText(value, 1900) } }];
}

function clampText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function toTaipeiIsoDateTime(utcTimestamp) {
  const date = new Date(utcTimestamp);
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(date).replace(' ', 'T') + '+08:00';
}

function loadEnvFile(pathname) {
  if (!existsSync(pathname)) {
    return;
  }

  const envFile = readFileSync(pathname, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
