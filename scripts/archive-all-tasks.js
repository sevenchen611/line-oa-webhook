import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '';

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is not set.');

const pages = [];
let startCursor;
do {
  const body = { page_size: 100 };
  if (startCursor) body.start_cursor = startCursor;
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, { method: 'POST', body });
  pages.push(...(result.results || []));
  startCursor = result.has_more ? result.next_cursor : null;
} while (startCursor);

console.log(`Found ${pages.length} task page(s) in the total control task database.`);

if (!confirmed) {
  console.log('Dry run. Re-run with --yes to archive all of them (recoverable from Notion trash).');
  process.exit(0);
}

let archived = 0;
let failed = 0;
for (const page of pages) {
  try {
    await notionRequest(`/v1/pages/${page.id}`, { method: 'PATCH', body: { archived: true } });
    archived += 1;
  } catch (error) {
    failed += 1;
    console.error(`Failed to archive ${page.id}: ${error.message}`);
  }
}

console.log(JSON.stringify({ ok: failed === 0, total: pages.length, archived, failed }));

async function notionRequest(pathname, { method, body }) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
    if (response.ok) {
      return responseText ? JSON.parse(responseText) : {};
    }

    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 300)}`);
    if (![409, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
      throw lastError;
    }
    await delay(attempt * 1000);
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvFile(pathname) {
  if (!existsSync(pathname)) return;
  const envFile = readFileSync(pathname, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
