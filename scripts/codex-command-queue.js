import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const commandsDataSourceId = process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';

const command = String(process.argv[2] || 'pending').trim().toLowerCase();

if (!notionToken) {
  fail('NOTION_TOKEN is not set.');
}

if (!commandsDataSourceId) {
  fail('SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID is not set.');
}

if (command === 'pending') {
  const limit = Number(process.argv[3] || 10);
  const pages = await listPendingCommands(limit);
  console.log(JSON.stringify({ ok: true, count: pages.length, commands: pages.map(summarizeCommandPage) }, null, 2));
} else if (command === 'mark') {
  const pageId = String(process.argv[3] || '').trim();
  const status = String(process.argv[4] || '').trim();
  const result = await markCommandStatus(pageId, status, process.argv.slice(5).join(' '));
  console.log(JSON.stringify({ ok: true, pageId: result.id, status }, null, 2));
} else {
  fail('Usage: npm run codex:commands -- pending [limit] OR npm run codex:commands -- mark <pageId> <Status> [result]');
}

async function listPendingCommands(limit) {
  const body = {
    page_size: Math.min(Math.max(limit || 10, 1), 100),
    filter: { property: 'Status', select: { equals: 'Pending' } },
    sorts: [{ property: 'Received At', direction: 'ascending' }],
  };
  const result = await notionRequest(`/v1/data_sources/${commandsDataSourceId}/query`, { method: 'POST', body });
  return result.results || [];
}

async function markCommandStatus(pageId, status, resultText) {
  if (!pageId) {
    fail('Missing pageId.');
  }
  if (!['Pending', 'Processing', 'Done', 'Needs Confirmation', 'Failed', 'Archived'].includes(status)) {
    fail('Invalid status.');
  }

  const properties = { Status: { select: { name: status } } };
  if (resultText) {
    properties.Result = { rich_text: [{ type: 'text', text: { content: clampText(resultText, 1900) } }] };
  }

  return notionRequest(`/v1/pages/${pageId}`, { method: 'PATCH', body: { properties } });
}

function summarizeCommandPage(page) {
  const properties = page.properties || {};
  return {
    pageId: page.id,
    url: page.url,
    name: getTitle(properties.Name),
    status: getSelect(properties.Status),
    riskLevel: getSelect(properties['Risk Level']),
    trigger: getText(properties.Trigger),
    command: getText(properties.Command),
    originalText: getText(properties['Original Text']),
    sourceType: getSelect(properties['Source Type']),
    sourceId: getText(properties['Source ID']),
    userId: getText(properties['User ID']),
    conversationName: getText(properties['Conversation Name']),
    actorName: getText(properties['Actor Name']),
    lineMessageId: getText(properties['LINE Message ID']),
    receivedAt: properties['Received At']?.date?.start || null,
    messagePageUrl: properties['Message Page URL']?.url || null,
    conversationPageUrl: properties['Conversation Page URL']?.url || null,
  };
}

async function notionRequest(pathname, { method, body }) {
  const response = await fetch(`https://api.notion.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': notionVersion,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Notion API failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : {};
}

function getTitle(property) {
  return (property?.title || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function getText(property) {
  return (property?.rich_text || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function getSelect(property) {
  return property?.select?.name || null;
}

function clampText(value, maxLength) {
  const text = value == null ? '' : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
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
