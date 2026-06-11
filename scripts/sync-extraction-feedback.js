import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '';
const casesDataSourceId = process.env.SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID || '';
const rulesDataSourceId = process.env.SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID || '';
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const sinceDays = clampNumber(Number(args['since-days'] || 7), 1, 60);
const maxRuleSuggestions = clampNumber(Number(args['max-rule-suggestions'] || 3), 0, 10);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is not set.');
if (!casesDataSourceId) fail('SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID is not set.');
if (!rulesDataSourceId) fail('SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID is not set.');

const startedAt = new Date();
const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

const recentTasks = await queryRecentLineTasks();
const decidedTasks = recentTasks.filter((task) => task.verdict !== 'pending');
const recordedTaskIds = await listRecordedSourceTaskIds();
const newFeedbackTasks = decidedTasks.filter((task) => !recordedTaskIds.has(task.id));

const recordedCases = [];
for (const task of newFeedbackTasks) {
  if (dryRun) {
    recordedCases.push({ title: task.title, verdict: task.verdict, action: 'dry-run' });
    continue;
  }
  const casePage = await createFeedbackCase(task);
  recordedCases.push({ title: task.title, verdict: task.verdict, action: 'recorded', caseId: casePage.id, task });
}

const ruleSuggestions = await suggestRulesFromRejections(
  recordedCases.filter((item) => item.action === 'recorded' && item.verdict === 'rejected'),
);

const stats = await computeCalibrationStats();

console.log(JSON.stringify({
  ok: true,
  dryRun,
  sinceDays,
  scannedTasks: recentTasks.length,
  decidedTasks: decidedTasks.length,
  alreadyRecorded: decidedTasks.length - newFeedbackTasks.length,
  recordedCases: recordedCases.map(({ task, ...item }) => item),
  ruleSuggestions,
  calibrationStats: stats,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
}, null, 2));

// ---- feedback collection ----

async function queryRecentLineTasks() {
  const pages = [];
  let startCursor;
  do {
    const body = {
      page_size: 100,
      filter: {
        and: [
          { property: '來源', select: { equals: 'LINE' } },
          { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } },
        ],
      },
    };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, { method: 'POST', body });
    pages.push(...(result.results || []));
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor && pages.length < 500);

  return pages.map((page) => {
    const properties = page.properties || {};
    const status = selectName(properties['狀態']) || statusName(properties['狀態']);
    const confirmation = selectName(properties['確認狀態']);
    return {
      id: normalizeId(page.id),
      pageId: page.id,
      url: page.url,
      title: textProperty(properties['任務名稱']),
      status,
      confirmation,
      confidence: selectName(properties['信心等級']),
      project: selectName(properties['專案']) || selectName(properties['總控專案']),
      summary: textProperty(properties['Codex 判斷摘要']),
      sourceText: textProperty(properties['來源原文']),
      verdict: classifyVerdict(status, confirmation),
    };
  }).filter((task) => task.title);
}

function classifyVerdict(status, confirmation) {
  if (confirmation === '已確認') return 'confirmed';
  if (confirmation === '合併到既有任務') return 'merged';
  if (status === '封存' && confirmation !== '已確認') return 'rejected';
  return 'pending';
}

async function listRecordedSourceTaskIds() {
  const ids = new Set();
  let startCursor;
  do {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notionRequest(`/v1/data_sources/${casesDataSourceId}/query`, { method: 'POST', body });
    for (const page of result.results || []) {
      for (const relation of page.properties?.['Source Task']?.relation || []) {
        ids.add(normalizeId(relation.id));
      }
    }
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor);
  return ids;
}

async function createFeedbackCase(task) {
  const verdictText = {
    confirmed: '使用者已確認此任務成立。',
    merged: '使用者將此任務合併到既有任務（AI 重複建立或切分過細）。',
    rejected: '使用者封存／退回此任務（AI 誤判為任務）。',
  }[task.verdict];

  const reviewId = `SEVEN-FB-${formatDateKey(new Date())}-${task.id.slice(0, 6)}`;

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: casesDataSourceId },
      properties: compactProperties({
        'Review ID': titleProperty(reviewId),
        Project: selectProperty('SEVEN_AM'),
        'Source Type': selectProperty('total-control task'),
        'Source Task': { relation: [{ id: task.pageId }] },
        'Source URL': urlProperty(task.url),
        'Task Type': selectProperty('task'),
        'Assistant Judgment': richTextProperty(task.summary || 'AI 從 LINE 對話萃取此任務。'),
        'Assistant Reason': richTextProperty([
          task.confidence ? `信心等級=${task.confidence}` : '',
          task.project ? `專案=${task.project}` : '',
          task.sourceText ? `來源原文：${clampText(task.sourceText, 500)}` : '',
        ].filter(Boolean).join('\n') || '無紀錄'),
        'Assistant Confidence': selectProperty(mapConfidence(task.confidence)),
        'Controller Judgment': richTextProperty(verdictText),
        'Controller Reason': richTextProperty(`系統自動回饋：狀態=${task.status || '未設定'}；確認狀態=${task.confirmation || '未設定'}`),
        'Reply Summary': richTextProperty(`自動回饋（extraction feedback sync）：${verdictText}`),
        'Case Status': selectProperty('Replied'),
        'Controller Replied At': dateProperty(new Date()),
        'Data Boundary Check': { checkbox: true },
      }),
    },
  });
}

function mapConfidence(confidence) {
  if (confidence === '高') return 'high';
  if (confidence === '低') return 'low';
  return 'medium';
}

// ---- rule suggestions from rejections ----

async function suggestRulesFromRejections(rejectedCases) {
  if (rejectedCases.length === 0) return [];
  if (!anthropicApiKey) {
    console.warn('ANTHROPIC_API_KEY is not set. Skipping rule suggestions; rejection cases are still recorded.');
    return [];
  }

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
  const suggestions = [];

  for (const item of rejectedCases.slice(0, maxRuleSuggestions)) {
    try {
      const suggestion = await suggestRule(anthropic, item.task);
      if (!suggestion.worthCreatingRule) {
        suggestions.push({ task: item.title, action: 'skipped', reason: suggestion.skipReason });
        continue;
      }

      const rulePage = await notionRequest('/v1/pages', {
        method: 'POST',
        body: {
          parent: { type: 'data_source_id', data_source_id: rulesDataSourceId },
          properties: compactProperties({
            'Rule Name': titleProperty(suggestion.ruleName),
            'Trigger Pattern': richTextProperty(suggestion.triggerPattern),
            'Preferred Judgment': richTextProperty(suggestion.preferredJudgment),
            'Avoided Judgment': richTextProperty(suggestion.avoidedJudgment),
            Reason: richTextProperty(suggestion.reason),
            'Applies To': { multi_select: [{ name: 'SEVEN_AM' }] },
            Exceptions: richTextProperty(suggestion.exceptions),
            'Source Case Count': { number: 1 },
            // Needs review: 規則必須由使用者在 Notion 改成 Active 才會生效。
            Status: selectProperty('Needs review'),
            'Checklist Placement': selectProperty('task start'),
            'Last Verified': dateProperty(new Date()),
          }),
        },
      });

      await notionRequest(`/v1/pages/${item.caseId}`, {
        method: 'PATCH',
        body: {
          properties: compactProperties({
            'Rule Link': { relation: [{ id: rulePage.id }] },
            'Generalized Rule': richTextProperty(`${suggestion.triggerPattern} → ${suggestion.preferredJudgment}`),
            'Case Status': selectProperty('Rule Extracted'),
          }),
        },
      });

      suggestions.push({ task: item.title, action: 'rule-suggested', ruleName: suggestion.ruleName, ruleUrl: rulePage.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Rule suggestion failed for ${item.title}: ${message}`);
      suggestions.push({ task: item.title, action: 'failed', error: message });
    }
  }

  return suggestions;
}

async function suggestRule(anthropic, task) {
  const response = await anthropic.messages.create({
    model: anthropicModel,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: [
      '你是 SevenAM 任務判讀系統的校準分析師。AI 從 LINE 對話萃取了一個任務，但使用者退回了它（不是任務）。',
      '你的工作：判斷這次誤判是否值得歸納成一條「可泛化的判讀規則」，讓未來的萃取避免同類錯誤。',
      '只有當錯誤模式明確、可泛化、不只是單一特例時，才建議建立規則（worthCreatingRule = true）。',
      '規則描述用繁體中文，Trigger Pattern 描述什麼樣的訊息模式會觸發這條規則。',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `被退回的任務：${task.title}`,
          `AI 的判斷摘要：${task.summary || '無'}`,
          `來源原文：${clampText(task.sourceText || '無', 800)}`,
          `AI 信心等級：${task.confidence || '未標'}`,
          `專案：${task.project || '未分類'}`,
        ].join('\n'),
      },
    ],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['worthCreatingRule', 'skipReason', 'ruleName', 'triggerPattern', 'preferredJudgment', 'avoidedJudgment', 'reason', 'exceptions'],
          properties: {
            worthCreatingRule: { type: 'boolean' },
            skipReason: { type: 'string', description: '不建立規則時的原因，否則填空字串。' },
            ruleName: { type: 'string', description: '規則簡短名稱（20 字內）。' },
            triggerPattern: { type: 'string', description: '什麼樣的訊息模式會觸發這條規則。' },
            preferredJudgment: { type: 'string', description: '遇到此模式時應該怎麼判斷。' },
            avoidedJudgment: { type: 'string', description: '應該避免的錯誤判斷。' },
            reason: { type: 'string' },
            exceptions: { type: 'string', description: '例外情況，沒有就填空字串。' },
          },
        },
      },
    },
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error(`Claude response has no text block (stop_reason: ${response.stop_reason}).`);
  }
  return JSON.parse(textBlock.text);
}

// ---- calibration stats ----

async function computeCalibrationStats() {
  const stats = {};
  let startCursor;
  do {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notionRequest(`/v1/data_sources/${casesDataSourceId}/query`, { method: 'POST', body });
    for (const page of result.results || []) {
      const properties = page.properties || {};
      const confidence = selectName(properties['Assistant Confidence']) || 'unknown';
      const judgment = textProperty(properties['Controller Judgment']);
      if (!judgment) continue;

      if (!stats[confidence]) stats[confidence] = { total: 0, confirmed: 0, rejected: 0, other: 0 };
      stats[confidence].total += 1;
      if (/已確認|成立|建立任務/.test(judgment)) stats[confidence].confirmed += 1;
      else if (/封存|退回|不是任務/.test(judgment)) stats[confidence].rejected += 1;
      else stats[confidence].other += 1;
    }
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor);

  for (const level of Object.values(stats)) {
    level.confirmRate = level.total > 0 ? Math.round((level.confirmed / level.total) * 100) / 100 : null;
  }
  return stats;
}

// ---- Notion helpers ----

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

    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 500)}`);
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

function textProperty(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

function selectName(property) {
  return property?.select?.name || '';
}

function statusName(property) {
  return property?.status?.name || '';
}

// ---- utilities ----

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

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clampText(value, maxLength) {
  const text = value == null ? '' : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeId(value) {
  return String(value || '').replace(/-/g, '');
}

function formatDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
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
