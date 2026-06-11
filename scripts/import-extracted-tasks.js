import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '';

const args = parseArgs(process.argv.slice(2));
const inputPath = String(args.input || '');
const engineLabel = String(args.engine || 'Claude session 手動判讀');
const dryRun = Boolean(args['dry-run']);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is not set.');
if (!inputPath || !existsSync(inputPath)) fail('Provide --input <path-to-extraction-json>.');

const conversations = JSON.parse(readFileSync(inputPath, 'utf8'));
const createdByTitle = new Map();
const results = [];
let created = 0;
let linked = 0;
let judgedConversations = 0;

for (const conversation of conversations) {
  for (const task of conversation.tasks || []) {
    if (dryRun) {
      results.push({ title: task.title, action: 'dry-run' });
      continue;
    }
    try {
      const page = await createTaskPage(conversation, task);
      createdByTitle.set(task.title, page.id);
      created += 1;

      if (task.taskLevel === 'child_task' && task.parentTaskTitle && createdByTitle.has(task.parentTaskTitle)) {
        try {
          await notionRequest(`/v1/pages/${page.id}`, {
            method: 'PATCH',
            body: { properties: { 母任務: { relation: [{ id: createdByTitle.get(task.parentTaskTitle) }] } } },
          });
          linked += 1;
        } catch (error) {
          if (!String(error.message || '').includes('is not a property')) throw error;
          console.warn('母任務 relation not installed; parent recorded in body only.');
        }
      }
      results.push({ title: task.title, action: 'created', url: page.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to create ${task.title}: ${message}`);
      results.push({ title: task.title, action: 'failed', error: message });
    }
  }

  if (!dryRun && conversation.markJudged) {
    try {
      await notionRequest(`/v1/pages/${conversation.id}`, {
        method: 'PATCH',
        body: {
          properties: compactProperties({
            最後任務判斷時間: dateProperty(new Date()),
            最後任務判斷訊息時間: conversation.lastMessageTime ? dateProperty(conversation.lastMessageTime) : undefined,
            任務判斷狀態: selectProperty('已判斷'),
          }),
        },
      });
      judgedConversations += 1;
    } catch (error) {
      if (!String(error.message || '').includes('is not a property')) {
        console.warn(`Failed to mark ${conversation.name} judged: ${error.message}`);
      }
    }
  }
}

console.log(JSON.stringify({
  ok: results.every((item) => item.action !== 'failed'),
  dryRun,
  createdTasks: created,
  parentLinks: linked,
  judgedConversations,
  failed: results.filter((item) => item.action === 'failed').length,
}, null, 2));

async function createTaskPage(conversation, candidate) {
  const now = new Date();
  const judgementSummary = [
    `AI 判斷：${candidate.taskLevel === 'child_task' ? '子任務' : candidate.taskLevel === 'side_task' ? '副任務' : '母任務'}`,
    candidate.parentTaskTitle ? `母任務：${candidate.parentTaskTitle}` : '',
    `判斷理由：${candidate.reason || ''}`,
    `信心程度：${candidate.confidence || '中'}`,
    candidate.sensitive ? '敏感項目：是（不可自動確認）' : '',
    `判斷引擎：${engineLabel}`,
  ].filter(Boolean).join('\n');

  const properties = compactProperties({
    任務名稱: titleProperty(candidate.title),
    專案: selectProperty(candidate.project || '未分類'),
    狀態: selectProperty('待確認'),
    確認狀態: selectProperty('未確認'),
    優先級: selectProperty(candidate.sensitive ? '高' : (candidate.priority || '中')),
    負責人: candidate.owner ? richTextProperty(candidate.owner) : undefined,
    截止日: candidate.dueDate ? dateProperty(candidate.dueDate) : undefined,
    來源: selectProperty('LINE'),
    來源原文: richTextProperty(candidate.sourceExcerpt || '', 1900),
    'Codex 判斷摘要': richTextProperty(judgementSummary, 1900),
    信心等級: selectProperty(candidate.confidence || '中'),
    下一步: candidate.nextStep ? richTextProperty(candidate.nextStep, 900) : undefined,
    '關聯 Notion 頁面': urlProperty(conversation.url),
    最後更新: dateProperty(now),
  });

  const children = [
    heading2('任務控制紀錄'),
    paragraph(`任務：${candidate.title}`),
    paragraph(`專案目標：${candidate.project || '未分類'}`),
    paragraph(`任務層級：${candidate.taskLevel}${candidate.parentTaskTitle ? `（母任務：${candidate.parentTaskTitle}）` : ''}`),
    paragraph('目前狀態：待確認（需要人工確認）'),
    paragraph(`負責人：${candidate.owner || '未設定'}`),
    paragraph(`下一步：${candidate.nextStep || '未設定'}`),
    heading3('最新判斷'),
    paragraph(`判斷時間：${formatTaipeiDateTime(now)}`),
    paragraph(`判斷來源：${engineLabel}`),
    paragraph(`判斷理由：${candidate.reason || '未提供'}`),
    paragraph(`信心程度：${candidate.confidence || '中'}`),
    paragraph(`敏感項目：${candidate.sensitive ? '是，必須由使用者確認後才能執行。' : '否'}`),
    heading3('來源證據'),
    paragraph(`來源對話：${conversation.name}`),
    paragraph(`來源位置：${conversation.url}`),
    paragraph(candidate.sourceExcerpt || '未取得來源原文。'),
  ];

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: tasksDataSourceId },
      properties,
      children,
    },
  });
}

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

function titleProperty(content) {
  return { title: [{ type: 'text', text: { content: clampText(content, 1900) } }] };
}

function richTextProperty(content, maxLength = 1900) {
  return { rich_text: [{ type: 'text', text: { content: clampText(content, maxLength) } }] };
}

function selectProperty(name) {
  return name ? { select: { name: clampText(name, 90) } } : undefined;
}

function dateProperty(value) {
  const date = value instanceof Date ? value.toISOString() : String(value);
  return { date: { start: date } };
}

function urlProperty(value) {
  return value ? { url: value } : undefined;
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
}

function heading2(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: clampText(text, 1900) } }] } };
}

function heading3(text) {
  return { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: clampText(text, 1900) } }] } };
}

function paragraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampText(text, 1900) } }] } };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function clampText(value, maxLength) {
  const text = value == null ? '' : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatTaipeiDateTime(value) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
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
