import fs from 'node:fs';
import path from 'node:path';

loadEnv(path.resolve('.env'));

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const dryRun = !process.argv.includes('--write');

if (!notionToken) throw new Error('NOTION_TOKEN is not set.');
if (!tasksDataSourceId) throw new Error('SEVEN_TASKS_DATA_SOURCE_ID is not set.');

const tasks = await queryAllTasks();
const candidates = [];

for (const task of tasks) {
  const currentTitle = pageText(task, '任務名稱');
  if (!hasTechnicalCode(currentTitle)) continue;

  const sourceText = pageText(task, '來源原文');
  const sourceMessagePageId = extractNotionPageId(sourceText);
  const sourceMessage = sourceMessagePageId ? await safeGetPage(sourceMessagePageId) : null;
  const messageText = sourceMessage ? pageText(sourceMessage, '文字內容') || pageText(sourceMessage, '原始內容') : '';
  const conversation = sourceMessage ? await getSourceConversation(sourceMessage) : null;
  const project = pageSelect(task, '專案') || titleProject(currentTitle) || '未分類';
  const subject = deriveHumanSubject(messageText || sourceText || currentTitle);
  const conversationName = cleanHumanLabel(conversation?.name || '');
  const prefix = conversationName ? `${conversationName}：` : '';
  const newTitle = clampTitle(`${project}：${prefix}${subject}`);

  if (newTitle && newTitle !== currentTitle && !hasTechnicalCode(newTitle)) {
    candidates.push({
      id: task.id,
      url: task.url,
      currentTitle,
      newTitle,
    });
  }
}

for (const item of candidates) {
  if (!dryRun) {
    await notionRequest(`/v1/pages/${item.id}`, {
      method: 'PATCH',
      body: {
        properties: {
          任務名稱: titleProperty(item.newTitle),
        },
      },
    });
  }
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  scanned: tasks.length,
  matched: candidates.length,
  updated: dryRun ? 0 : candidates.length,
  candidates,
}, null, 2));

async function queryAllTasks() {
  const results = [];
  let startCursor = undefined;
  do {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, { method: 'POST', body });
    results.push(...(result.results || []));
    startCursor = result.has_more ? result.next_cursor : undefined;
  } while (startCursor);
  return results;
}

async function getSourceConversation(messagePage) {
  const relation = messagePage.properties?.['對話主檔'];
  const pageId = relation?.type === 'relation' ? relation.relation?.[0]?.id : '';
  if (!pageId) return null;
  const page = await safeGetPage(pageId);
  if (!page) return null;
  return {
    name: pageText(page, '自定義名稱') || pageText(page, 'LINE 對話名稱'),
  };
}

async function safeGetPage(pageId) {
  try {
    return await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
  } catch {
    return null;
  }
}

async function notionRequest(endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.notion.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': notionVersion,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${json.message || 'Notion request failed'}`);
  return json;
}

function deriveHumanSubject(value) {
  const text = cleanTechnicalCodes(value);
  const caseMatch = text.match(/關於「([^」]+)」.*?(資料|資訊|提供|評估)/s);
  if (caseMatch) return `${caseMatch[1]}案件：補充資料評估`;
  if (/餐廳|車位|平面圖|停車場|地下室|房間間數|各種房型/.test(text)) return '住宿案件：確認房間、車位、餐廳與平面圖資訊';
  if (/安排.*時間|現場|看房|看現場/.test(text)) return '安排現場查看時間';
  return shortSubject(text);
}

function shortSubject(value) {
  return cleanTechnicalCodes(value)
    .replace(/^.*?(請|麻煩|幫我|我要|需要|希望|是否|要不要|是不是|確認|安排)/, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 42)
    .replace(/[，。,.：:]+$/g, '') || 'LINE 訊息待判斷';
}

function hasTechnicalCode(value) {
  return /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(value)
    || /\b[0-9a-f]{32}\b/i.test(value)
    || /\b[CUR][0-9a-f]{32}\b/i.test(value)
    || /\bline:[^\s，。,.：:]+/i.test(value);
}

function cleanTechnicalCodes(value) {
  return String(value || '')
    .replace(/https:\/\/app\.notion\.com\/p\/\S+/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b[0-9a-f]{32}\b/gi, '')
    .replace(/\b[CUR][0-9a-f]{32}\b/gi, '')
    .replace(/\bline:[^\s，。,.：:]+/gi, '')
    .replace(/同步識別碼：\S+/g, '')
    .replace(/LINE 訊息：/g, '')
    .replace(/對話：\s*/g, '')
    .replace(/發話者：[^\n]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanHumanLabel(value) {
  return cleanTechnicalCodes(value).replace(/\s+/g, ' ').trim();
}

function clampTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function titleProject(title) {
  return String(title || '').split('：')[0]?.trim() || '';
}

function pageText(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return '';
  if (prop.type === 'title') return richText(prop.title);
  if (prop.type === 'rich_text') return richText(prop.rich_text);
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'url') return prop.url || '';
  return '';
}

function pageSelect(page, name) {
  const prop = page.properties?.[name];
  return prop?.type === 'select' ? prop.select?.name || '' : '';
}

function richText(value) {
  return (value || []).map((item) => item.plain_text || '').join('').trim();
}

function titleProperty(value) {
  return { title: [{ type: 'text', text: { content: String(value || '').slice(0, 2000) } }] };
}

function extractNotionPageId(value) {
  const match = String(value || '').match(/([0-9a-f]{32})(?!.*[0-9a-f]{32})/i);
  if (!match) return '';
  return match[1].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (!(key in process.env)) process.env[key] = match[2].trim();
  }
}
