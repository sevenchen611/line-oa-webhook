import fs from 'node:fs';
import path from 'node:path';

loadEnv(path.resolve('.env'));

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const dryRun = !process.argv.includes('--write');
const anchor = '【總控任務資料補齊】';

if (!notionToken) throw new Error('NOTION_TOKEN is not set.');
if (!tasksDataSourceId) throw new Error('SEVEN_TASKS_DATA_SOURCE_ID is not set.');

const tasks = await queryAllTasks();
const activeTasks = tasks.map(normalizeTask).filter((task) => isActiveTask(task));
const results = [];

for (const task of activeTasks) {
  const children = await getBlockChildren(task.id);
  const existingText = children.map(blockText).join('\n');
  const sourceRecord = await buildSourceRecord(task);
  const propertiesPatch = {};

  if (!task.raw) {
    propertiesPatch.來源原文 = richTextProperty(sourceRecord.rawFallback, 1900);
  }

  const shouldAppendDetails = !existingText.includes(anchor);

  if (!dryRun && Object.keys(propertiesPatch).length) {
    await notionRequest(`/v1/pages/${task.id}`, {
      method: 'PATCH',
      body: { properties: propertiesPatch },
    });
  }

  if (!dryRun && shouldAppendDetails) {
    await appendTaskDetails(task, sourceRecord);
  }

  results.push({
    title: task.title,
    status: task.status,
    patchedProperties: Object.keys(propertiesPatch),
    appendedDetails: shouldAppendDetails,
  });
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  scanned: tasks.length,
  active: activeTasks.length,
  willPatchProperties: results.filter((item) => item.patchedProperties.length).length,
  willAppendDetails: results.filter((item) => item.appendedDetails).length,
  results,
}, null, 2));

async function appendTaskDetails(task, sourceRecord) {
  const blocks = [
    heading(anchor, 2),
    paragraph(`補齊時間：${formatTaipeiDateTime(new Date())}`),
    heading('一、任務基本資料', 3),
    bulleted(`專案：${task.project || '未分類'}`),
    bulleted(`狀態：${task.status || '未標示'}；優先級：${task.priority || '未標示'}；確認狀態：${task.confirmation || '未標示'}`),
    bulleted(`負責人：${task.owner || '待指定'}；截止日：${task.dueDate || '未設定'}`),
    heading('二、Codex 判斷摘要', 3),
    paragraph(task.summary || '目前沒有獨立摘要；請依來源紀錄與下一步判斷是否需要補充。'),
    heading('三、下一步', 3),
    paragraph(task.nextStep || '請確認此任務今天是否仍要追蹤，並指定下一步、負責人與完成條件。'),
    heading('四、來源與會議/對話紀錄', 3),
    paragraph(sourceRecord.displayText || '目前沒有可讀來源內容。'),
  ];

  if (task.link) {
    blocks.push(paragraph(`關聯頁面：${task.link}`));
  }

  await notionRequest(`/v1/blocks/${task.id}/children`, {
    method: 'PATCH',
    body: { children: blocks },
  });
}

async function buildSourceRecord(task) {
  const sourceText = task.raw || '';
  const sourcePageId = extractNotionPageId(sourceText);
  const sourcePage = sourcePageId ? await safeGetPage(sourcePageId) : null;
  const sourceMessageText = sourcePage ? pageText(sourcePage, '文字內容') || pageText(sourcePage, '原始內容') : '';
  const sourceSpeaker = sourcePage ? pageText(sourcePage, '發話者名稱') || pageText(sourcePage, '發話者類型') : '';
  const sourceTime = sourcePage ? pageDate(sourcePage, '排序時間') : '';
  const conversation = sourcePage ? await getConversation(sourcePage) : null;

  const lines = [
    sourcePage ? `來源訊息：${sourcePage.url}` : '',
    conversation?.name ? `對話：${conversation.name}` : '',
    sourceSpeaker ? `發話者：${sourceSpeaker}` : '',
    sourceTime ? `時間：${sourceTime}` : '',
    sourceMessageText ? sourceMessageText : '',
    !sourceMessageText && sourceText ? sourceText : '',
  ].filter(Boolean);

  const rawFallback = [
    task.raw || '',
    task.link ? `關聯頁面：${task.link}` : '',
    task.summary ? `Codex 判斷摘要：${task.summary}` : '',
    task.nextStep ? `下一步：${task.nextStep}` : '',
  ].filter(Boolean).join('\n');

  return {
    displayText: lines.join('\n'),
    rawFallback: rawFallback || `任務：${task.title}\n狀態：${task.status || ''}\n補齊來源：SevenAM 總控任務庫現有欄位`,
  };
}

async function getConversation(messagePage) {
  const relation = messagePage.properties?.['對話主檔'];
  const pageId = relation?.type === 'relation' ? relation.relation?.[0]?.id : '';
  if (!pageId) return null;
  const page = await safeGetPage(pageId);
  if (!page) return null;
  return {
    name: pageText(page, '自定義名稱') || pageText(page, 'LINE 對話名稱'),
  };
}

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

function normalizeTask(page) {
  return {
    id: page.id,
    page,
    title: pageText(page, '任務名稱') || '(未命名任務)',
    project: pageSelect(page, '專案'),
    status: pageSelect(page, '狀態'),
    priority: pageSelect(page, '優先級'),
    confirmation: pageSelect(page, '確認狀態'),
    source: pageSelect(page, '來源'),
    summary: pageText(page, 'Codex 判斷摘要'),
    raw: pageText(page, '來源原文'),
    nextStep: pageText(page, '下一步'),
    owner: pageText(page, '負責人'),
    dueDate: pageDate(page, '截止日'),
    link: pageUrl(page, '關聯 Notion 頁面') || page.url,
  };
}

function isActiveTask(task) {
  return !['完成', '已完成', '封存', '取消'].includes(task.status);
}

async function getBlockChildren(blockId) {
  const results = [];
  let startCursor = undefined;
  do {
    const cursor = startCursor ? `&start_cursor=${startCursor}` : '';
    const result = await notionRequest(`/v1/blocks/${blockId}/children?page_size=100${cursor}`);
    results.push(...(result.results || []));
    startCursor = result.has_more ? result.next_cursor : undefined;
  } while (startCursor);
  return results;
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

function heading(text, level) {
  const type = `heading_${level}`;
  return { object: 'block', type, [type]: { rich_text: richText(text) } };
}

function paragraph(text) {
  const chunks = splitText(String(text || ''), 1900);
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richText(chunks[0] || '') },
  };
}

function bulleted(text) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText(String(text || '').slice(0, 1900)) },
  };
}

function richText(value) {
  return [{ type: 'text', text: { content: String(value || '').slice(0, 2000) } }];
}

function richTextProperty(value, limit = 1900) {
  return { rich_text: [{ type: 'text', text: { content: String(value || '').slice(0, limit) } }] };
}

function splitText(value, size) {
  const text = String(value || '');
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

function blockText(block) {
  const value = block[block.type]?.rich_text || [];
  return (value || []).map((item) => item.plain_text || '').join('');
}

function pageText(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return '';
  if (prop.type === 'title') return plainText(prop.title);
  if (prop.type === 'rich_text') return plainText(prop.rich_text);
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'url') return prop.url || '';
  return '';
}

function pageSelect(page, name) {
  const prop = page.properties?.[name];
  return prop?.type === 'select' ? prop.select?.name || '' : '';
}

function pageDate(page, name) {
  const prop = page.properties?.[name];
  return prop?.type === 'date' ? prop.date?.start || '' : '';
}

function pageUrl(page, name) {
  const prop = page.properties?.[name];
  return prop?.type === 'url' ? prop.url || '' : '';
}

function plainText(value) {
  return (value || []).map((item) => item.plain_text || '').join('').trim();
}

function extractNotionPageId(value) {
  const match = String(value || '').match(/([0-9a-f]{32})(?!.*[0-9a-f]{32})/i);
  if (!match) return '';
  return match[1].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function formatTaipeiDateTime(date) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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
