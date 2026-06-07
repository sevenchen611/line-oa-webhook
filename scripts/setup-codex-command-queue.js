import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2026-03-11';
const command = String(process.argv[2] || 'create').trim().toLowerCase();

if (!notionToken) {
  fail('NOTION_TOKEN is not set.');
}

if (command === 'create') {
  const parentPageId = String(process.argv[3] || '').trim();
  const database = await createCommandQueueDatabase(parentPageId || null);
  const databaseId = database.id;
  const dataSourceId = database.data_sources?.[0]?.id || database.data_sources?.[0]?.data_source_id || null;

  console.log(JSON.stringify({
    ok: true,
    databaseId,
    dataSourceId,
    url: database.url,
    renderEnvVar: dataSourceId ? `SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID=${dataSourceId}` : null,
    note: dataSourceId ? 'Add renderEnvVar to Render, then redeploy the web service.' : 'Database created, but no data source id was returned. Retrieve the database in Notion to copy its data source id.',
  }, null, 2));
} else if (command === 'inspect') {
  const dataSourceId = String(process.argv[3] || process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID || '').trim();
  if (!dataSourceId) {
    fail('Missing data source id.');
  }
  const dataSource = await notionRequest(`/v1/data_sources/${dataSourceId}`, { method: 'GET' });
  console.log(JSON.stringify({
    ok: true,
    id: dataSource.id,
    title: getTextArray(dataSource.title),
    properties: Object.fromEntries(Object.entries(dataSource.properties || {}).map(([name, schema]) => [name, schema.type])),
  }, null, 2));
} else {
  fail('Usage: npm run setup:codex-commands -- create [parentPageId] OR npm run setup:codex-commands -- inspect <dataSourceId>');
}

async function createCommandQueueDatabase(parentPageId) {
  const body = {
    parent: parentPageId
      ? { type: 'page_id', page_id: parentPageId }
      : { type: 'workspace', workspace: true },
    title: [{ type: 'text', text: { content: 'Codex Command Queue' } }],
    is_inline: false,
    initial_data_source: {
      title: [{ type: 'text', text: { content: 'LINE Commands' } }],
      properties: commandQueueProperties(),
    },
  };

  return notionRequest('/v1/databases', { method: 'POST', body });
}

function commandQueueProperties() {
  return {
    Name: { title: {} },
    Status: {
      select: {
        options: [
          { name: 'Pending', color: 'yellow' },
          { name: 'Processing', color: 'blue' },
          { name: 'Done', color: 'green' },
          { name: 'Needs Confirmation', color: 'orange' },
          { name: 'Failed', color: 'red' },
          { name: 'Archived', color: 'gray' },
        ],
      },
    },
    Trigger: { rich_text: {} },
    Command: { rich_text: {} },
    'Original Text': { rich_text: {} },
    'Source Type': {
      select: {
        options: [
          { name: 'user', color: 'green' },
          { name: 'group', color: 'blue' },
          { name: 'room', color: 'purple' },
          { name: 'unknown', color: 'gray' },
        ],
      },
    },
    'Source ID': { rich_text: {} },
    'User ID': { rich_text: {} },
    'Conversation Name': { rich_text: {} },
    'Actor Name': { rich_text: {} },
    'Conversation Key': { rich_text: {} },
    'LINE Message ID': { rich_text: {} },
    'LINE Event ID': { rich_text: {} },
    'Message Page URL': { url: {} },
    'Conversation Page URL': { url: {} },
    'Received At': { date: {} },
    'Risk Level': {
      select: {
        options: [
          { name: 'Normal', color: 'green' },
          { name: 'High', color: 'red' },
        ],
      },
    },
    Result: { rich_text: {} },
    'Raw Event': { rich_text: {} },
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

function getTextArray(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
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
