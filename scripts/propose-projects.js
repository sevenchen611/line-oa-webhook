// R2/R3 project proposal engine (daily): looks for workstreams forming
// outside the official project list — unclassified task clusters, unassigned
// LINE groups, and parent tasks that outgrew task scope — and creates
// candidate projects (狀態=候選, 啟用=false) for the user to approve in the
// review page. The AI never creates an official project directly.

import { existsSync, readFileSync } from 'node:fs';
import { createLlmBackend } from '../src/llm-backend.js';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const projectsDataSourceId = process.env.SEVEN_PROJECTS_DATA_SOURCE_ID || '2d4e4e80-09e6-447f-b2e2-36269ff1ac5c';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '';
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const controlLinePushUrl = process.env.CONTROL_LINE_PUSH_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/line/push';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY || '';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);

const llm = createLlmBackend();
if (!llm.available) {
  console.warn('LLM backend is not available. Project proposal run skipped.');
  process.exit(0);
}
if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is not set.');

const startedAt = new Date();
const projects = await loadProjects();
const officialNames = projects.filter((project) => !['候選', '封存'].includes(project.status)).map((project) => project.name);
const candidateNames = projects.filter((project) => project.status === '候選').map((project) => project.name);

const unclassifiedTasks = await loadUnclassifiedTasks();
const unassignedGroups = await loadUnassignedGroups();
const promotionParents = await loadPromotionParents();

if (unclassifiedTasks.length < 3 && unassignedGroups.length === 0 && promotionParents.length === 0) {
  console.log(JSON.stringify({ ok: true, skipped: 'no-signals', unclassifiedTasks: unclassifiedTasks.length }));
  process.exit(0);
}

const proposal = await proposeProjects();
const created = [];

for (const candidate of (proposal.proposals || []).slice(0, 3)) {
  const name = String(candidate.name || '').trim();
  if (!name) continue;
  if ([...officialNames, ...candidateNames, ...created.map((item) => item.name)].some((existing) => normalize(existing) === normalize(name))) {
    created.push({ name, action: 'skipped-duplicate' });
    continue;
  }
  if (dryRun) {
    created.push({ name, action: 'dry-run', reason: candidate.reason });
    continue;
  }
  const page = await createCandidateProject(candidate);
  created.push({ name, action: 'created', url: page.url, sourceKind: candidate.sourceKind });
}

const createdCount = created.filter((item) => item.action === 'created').length;
if (createdCount > 0 && !dryRun) {
  await notifyProposals(created.filter((item) => item.action === 'created'));
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  backend: llm.name,
  signals: {
    unclassifiedTasks: unclassifiedTasks.length,
    unassignedGroups: unassignedGroups.length,
    promotionParents: promotionParents.length,
  },
  analysisNote: proposal.analysisNote || '',
  proposals: created,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
}, null, 2));

// ---- signal loading ----

async function loadProjects() {
  const result = await notionRequest(`/v1/data_sources/${projectsDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 100 },
  });
  return (result.results || []).map((page) => ({
    name: (Object.values(page.properties || {}).find((property) => property.type === 'title')?.title || [])
      .map((item) => item.plain_text || '').join('').trim(),
    status: page.properties?.['狀態']?.select?.name || '',
  })).filter((project) => project.name);
}

async function loadUnclassifiedTasks() {
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 50,
      filter: {
        and: [
          { or: [
            { property: '專案', select: { equals: '未分類' } },
            { property: '專案', select: { is_empty: true } },
          ] },
          { property: '狀態', select: { does_not_equal: '封存' } },
          { property: '狀態', select: { does_not_equal: '已完成' } },
        ],
      },
    },
  });
  return (result.results || []).map((page) => ({
    title: textProperty(page.properties?.['任務名稱']),
    summary: clampText(textProperty(page.properties?.['Codex 判斷摘要']), 200),
  })).filter((task) => task.title);
}

async function loadUnassignedGroups() {
  if (!conversationsDataSourceId) return [];
  const result = await notionRequest(`/v1/data_sources/${conversationsDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 50,
      filter: {
        and: [
          { property: '對象類型', select: { equals: '群組' } },
          { property: '總控專案', select: { is_empty: true } },
        ],
      },
      sorts: [{ property: '最後訊息時間', direction: 'descending' }],
    },
  });
  return (result.results || []).map((page) => ({
    name: textProperty(page.properties?.['LINE 對話名稱']) || textProperty(page.properties?.['自定義名稱']),
    preview: clampText(textProperty(page.properties?.['最新訊息預覽']), 150),
  })).filter((group) => group.name);
}

async function loadPromotionParents() {
  // R3：母任務帶有多個進行中子任務時，可能已經長成一個專案。
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 100,
      filter: {
        and: [
          { property: '母任務', relation: { is_not_empty: true } },
          { property: '狀態', select: { does_not_equal: '封存' } },
          { property: '狀態', select: { does_not_equal: '已完成' } },
        ],
      },
    },
  });

  const childCounts = new Map();
  for (const page of result.results || []) {
    for (const relation of page.properties?.['母任務']?.relation || []) {
      childCounts.set(relation.id, (childCounts.get(relation.id) || 0) + 1);
    }
  }

  const parents = [];
  for (const [parentId, count] of childCounts.entries()) {
    if (count < 3) continue;
    try {
      const parent = await notionRequest(`/v1/pages/${parentId}`, { method: 'GET' });
      const status = parent.properties?.['狀態']?.select?.name || '';
      if (['封存', '已完成'].includes(status)) continue;
      parents.push({
        title: textProperty(parent.properties?.['任務名稱']),
        project: parent.properties?.['專案']?.select?.name || '未分類',
        activeChildren: count,
      });
    } catch {
      // parent page may be deleted; skip
    }
  }
  return parents.filter((parent) => parent.title);
}

// ---- proposal ----

async function proposeProjects() {
  return llm.completeJson({
    maxTokens: 8000,
    system: [
      '你是 SevenAM 控制中心的專案治理分析師。你的工作：從零散訊號中辨識「正在形成但還沒有專案容器的工作流」，提出專案候選。',
      '',
      '## 原則',
      '- 專案是長期容器：有目標、有負責人、有生命週期。零星雜事不是專案。',
      '- 非常保守：只有當訊號明確指向一個持續性的工作流、且現有專案清單涵蓋不了時才提案。沒有好提案就回空陣列。',
      '- 一次最多提 3 個。',
      '- 升級型提案（母任務長成專案）在 reason 開頭註明「升級候選：來自母任務〈名稱〉」。',
      '- 提案名稱用簡潔的繁體中文，風格對齊現有專案命名。',
      '- projectType 從這些選擇：工程、業務、系統、公司管理、財務、人資、營運、私人事務。',
    ].join('\n'),
    userContent: [
      {
        type: 'text',
        text: [
          '## 現有正式專案（這些已涵蓋的範圍不要重複提案）',
          officialNames.map((name) => `- ${name}`).join('\n') || '（無）',
          '',
          '## 已在等待核准的候選（不要重複提）',
          candidateNames.map((name) => `- ${name}`).join('\n') || '（無）',
          '',
          '## 訊號一：未分類的進行中任務',
          unclassifiedTasks.map((task) => `- ${task.title}${task.summary ? `（${task.summary}）` : ''}`).join('\n') || '（無）',
          '',
          '## 訊號二：沒有專案歸屬的 LINE 群組',
          unassignedGroups.map((group) => `- ${group.name}${group.preview ? `：${group.preview}` : ''}`).join('\n') || '（無）',
          '',
          '## 訊號三：子任務數量多的母任務（可能該升級成專案）',
          promotionParents.map((parent) => `- ${parent.title}（${parent.activeChildren} 個進行中子任務，目前屬於 ${parent.project}）`).join('\n') || '（無）',
        ].join('\n'),
      },
    ],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['proposals', 'analysisNote'],
      properties: {
        analysisNote: { type: 'string', description: '一句話說明這次的判斷（包括為什麼不提案）。' },
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'projectType', 'goal', 'reason', 'relatedItems', 'sourceKind'],
            properties: {
              name: { type: 'string' },
              projectType: { type: 'string', enum: ['工程', '業務', '系統', '公司管理', '財務', '人資', '營運', '私人事務'] },
              goal: { type: 'string', description: '這個專案要達成什麼。' },
              reason: { type: 'string', description: '為什麼這些訊號構成一個專案。' },
              relatedItems: { type: 'array', items: { type: 'string' }, description: '支持這個提案的任務或群組名稱。' },
              sourceKind: { type: 'string', enum: ['cluster', 'group', 'promotion'] },
            },
          },
        },
      },
    },
  });
}

async function createCandidateProject(candidate) {
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: projectsDataSourceId },
      properties: {
        專案名稱: { title: [{ type: 'text', text: { content: clampText(candidate.name, 100) } }] },
        狀態: { select: { name: '候選' } },
        啟用: { checkbox: false },
        建立來源: { select: { name: 'Codex' } },
        專案類型: { select: { name: candidate.projectType || '營運' } },
        優先級: { select: { name: '中' } },
        目標: { rich_text: [{ type: 'text', text: { content: clampText(candidate.goal || '', 1900) } }] },
        目前進度摘要: { rich_text: [{ type: 'text', text: { content: clampText(`提案理由：${candidate.reason || ''}`, 1900) } }] },
      },
      children: [
        { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '專案提案' } }] } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `提案時間：${formatTaipeiDateTime(new Date())}（AI 自動提案，待使用者核准）` } }] } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `提案理由：${clampText(candidate.reason || '', 1800)}` } }] } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `相關項目：${(candidate.relatedItems || []).join('、') || '（無）'}` } }] } },
      ],
    },
  });
}

async function notifyProposals(items) {
  if (!controlApiKey) return;
  try {
    const text = [
      'Seven Jr. 專案提案 📁',
      `AI 發現 ${items.length} 個可能正在形成的工作流，已建立專案候選等你核准：`,
      ...items.map((item) => `- ${item.name}`),
      '',
      '請到報告頁「六、專案提案」核准或退回。核准後 AI 判讀才會開始使用這個專案。',
    ].join('\n');
    await fetch(controlLinePushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-seven-control-key': controlApiKey },
      body: Buffer.from(JSON.stringify({ useDefaultReportTarget: true, text }), 'utf8'),
    });
  } catch (error) {
    console.warn(`Proposal notification failed: ${error.message}`);
  }
}

// ---- helpers ----

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

    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 400)}`);
    if (![409, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
      throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError;
}

function textProperty(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
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
