import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2026-03-11';
const parentPageId = String(process.argv[2] || '37751c68-6dac-81b9-8496-dc98585dbf7b').trim();

if (!notionToken) {
  throw new Error('NOTION_TOKEN is not set.');
}

const existing = await findExistingSnapshotDataSource();
if (existing) {
  console.log(JSON.stringify({
    ok: true,
    created: false,
    databaseId: existing.parent?.database_id || null,
    dataSourceId: existing.id,
    title: textArray(existing.title),
    url: existing.url,
    renderEnvVar: `SEVEN_DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID=${existing.id}`,
  }, null, 2));
  process.exit(0);
}

const database = await notionRequest('/v1/databases', {
  method: 'POST',
  body: {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: '每日總控報告快照庫' } }],
    is_inline: false,
    initial_data_source: {
      title: [{ type: 'text', text: { content: '每日總控報告快照庫' } }],
      properties: snapshotProperties(),
    },
  },
});

const dataSourceId = database.data_sources?.[0]?.id || database.data_sources?.[0]?.data_source_id || null;
console.log(JSON.stringify({
  ok: true,
  created: true,
  databaseId: database.id,
  dataSourceId,
  url: database.url,
  renderEnvVar: dataSourceId ? `SEVEN_DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID=${dataSourceId}` : null,
}, null, 2));

async function findExistingSnapshotDataSource() {
  const response = await notionRequest('/v1/search', {
    method: 'POST',
    body: { query: '每日總控報告快照庫', page_size: 10 },
  });
  return (response.results || []).find((item) => item.object === 'data_source' && textArray(item.title) === '每日總控報告快照庫') || null;
}

function snapshotProperties() {
  return {
    報告名稱: { title: {} },
    報告日期: { date: {} },
    報告類型: {
      select: { options: [
        { name: '每日總控總確認', color: 'green' },
        { name: '早報', color: 'blue' },
        { name: '追蹤確認', color: 'yellow' },
      ] },
    },
    狀態: {
      select: { options: [
        { name: '已建立快照', color: 'blue' },
        { name: '已發送', color: 'green' },
        { name: '已確認', color: 'purple' },
        { name: '發送失敗', color: 'red' },
      ] },
    },
    報告連結: { url: {} },
    LINE訊息內容: { rich_text: {} },
    發送時間: { date: {} },
    確認時間: { date: {} },
    確認紀錄連結: { url: {} },
    CronJob: { rich_text: {} },
    RunID: { rich_text: {} },
    目標: { rich_text: {} },
    摘要: { rich_text: {} },
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
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Notion API failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function textArray(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
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
