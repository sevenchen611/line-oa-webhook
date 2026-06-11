import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const casesDataSourceId = process.env.SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID || '';
const rulesDataSourceId = process.env.SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID || '';
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

const args = parseArgs(process.argv.slice(2));
const limit = clampNumber(Number(args.limit || 40), 4, 200);
const savePath = String(args.save || '').trim();

if (!anthropicApiKey) fail('ANTHROPIC_API_KEY is not set. The eval harness needs the Claude API.');
if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!casesDataSourceId) fail('SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID is not set.');

const anthropic = new Anthropic({ apiKey: anthropicApiKey });
const startedAt = new Date();

const goldenCases = await buildGoldenSet();
if (goldenCases.length < 4) {
  fail(`Only ${goldenCases.length} labeled cases with source text found. Run the feedback sync first to accumulate ground truth.`);
}

const activeRules = await loadActiveJudgmentRules();
const systemPrompt = buildJudgeSystemPrompt(activeRules);

const results = [];
for (const goldenCase of goldenCases) {
  try {
    const judged = await judgeCase(goldenCase);
    results.push({ ...goldenCase, predicted: judged.isTask, predictedConfidence: judged.confidence, predictedReason: judged.reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Eval case failed (${goldenCase.title}): ${message}`);
    results.push({ ...goldenCase, error: message });
  }
}

const report = buildReport(results, activeRules.length);
console.log(JSON.stringify(report, null, 2));

if (savePath) {
  writeFileSync(savePath, JSON.stringify({ ...report, results }, null, 2));
  console.error(`Saved full eval results to ${savePath}`);
}

// ---- golden set ----

async function buildGoldenSet() {
  const cases = [];
  let startCursor;
  do {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notionRequest(`/v1/data_sources/${casesDataSourceId}/query`, { method: 'POST', body });

    for (const page of result.results || []) {
      const properties = page.properties || {};
      const judgment = textProperty(properties['Controller Judgment']);
      if (!judgment) continue;

      let label = null;
      if (/已確認|成立|建立任務/.test(judgment)) label = true;
      else if (/封存|退回|不是任務/.test(judgment)) label = false;
      if (label === null) continue;

      const reason = textProperty(properties['Assistant Reason']);
      const sourceText = extractSourceExcerpt(reason);
      if (!sourceText) continue;

      cases.push({
        caseId: page.id,
        title: textProperty(properties['Assistant Judgment']).slice(0, 80),
        sourceText,
        label,
        labeledConfidence: properties['Assistant Confidence']?.select?.name || '',
      });
    }
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor && cases.length < limit * 3);

  // Balance the two classes as far as the data allows, then cap at limit.
  const positives = cases.filter((item) => item.label);
  const negatives = cases.filter((item) => !item.label);
  const half = Math.ceil(limit / 2);
  const selected = [
    ...positives.slice(0, Math.max(half, limit - negatives.length)),
    ...negatives.slice(0, Math.max(half, limit - positives.length)),
  ].slice(0, limit);
  return selected;
}

function extractSourceExcerpt(assistantReason) {
  const match = String(assistantReason || '').match(/來源原文：([\s\S]+)/);
  if (!match) return '';
  return match[1].trim();
}

// ---- judging ----

async function loadActiveJudgmentRules() {
  if (!rulesDataSourceId) return [];
  try {
    const result = await notionRequest(`/v1/data_sources/${rulesDataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: 20,
        filter: {
          and: [
            { property: 'Status', select: { equals: 'Active' } },
            { property: 'Applies To', multi_select: { contains: 'SEVEN_AM' } },
          ],
        },
      },
    });
    return (result.results || []).map((page) => ({
      name: textProperty(page.properties?.['Rule Name']),
      trigger: textProperty(page.properties?.['Trigger Pattern']),
      preferred: textProperty(page.properties?.['Preferred Judgment']),
    })).filter((rule) => rule.name);
  } catch {
    return [];
  }
}

function buildJudgeSystemPrompt(rules) {
  const ruleSection = rules.length === 0 ? '' : [
    '',
    '## 校準規則（來自使用者的歷史修正，優先遵守）',
    ...rules.map((rule) => `- ${rule.name}：${rule.trigger} → ${rule.preferred}`),
  ].join('\n');

  return [
    '你是 SevenAM 的任務判讀引擎。以下是從 LINE 群組對話萃取的訊息節錄。',
    '判斷它是否構成一個需要追蹤的「真實任務」——有具體行動、有主詞、是真實世界的工作，而不是問候、知識分享、純粹討論、或對助理下的操作指令（查待辦、開任務、做校準等）。',
    '涉及金錢、合約、追蹤、確認、交付、聯絡對象的具體行動通常是任務。',
    ruleSection,
  ].filter(Boolean).join('\n');
}

async function judgeCase(goldenCase) {
  const response = await anthropic.messages.create({
    model: anthropicModel,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `LINE 訊息節錄：\n\n${clampText(goldenCase.sourceText, 1500)}` }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['isTask', 'confidence', 'reason'],
          properties: {
            isTask: { type: 'boolean' },
            confidence: { type: 'string', enum: ['高', '中', '低'] },
            reason: { type: 'string' },
          },
        },
      },
    },
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) throw new Error(`No text block (stop_reason: ${response.stop_reason}).`);
  return JSON.parse(textBlock.text);
}

// ---- report ----

function buildReport(allResults, activeRuleCount) {
  const judged = allResults.filter((item) => !item.error);
  const errors = allResults.length - judged.length;

  let tp = 0; let fp = 0; let tn = 0; let fn = 0;
  const byConfidence = {};
  const mismatches = [];

  for (const item of judged) {
    if (item.predicted && item.label) tp += 1;
    else if (item.predicted && !item.label) fp += 1;
    else if (!item.predicted && !item.label) tn += 1;
    else fn += 1;

    const confidence = item.predictedConfidence || '未標';
    if (!byConfidence[confidence]) byConfidence[confidence] = { total: 0, correct: 0 };
    byConfidence[confidence].total += 1;
    if (item.predicted === item.label) byConfidence[confidence].correct += 1;

    if (item.predicted !== item.label && mismatches.length < 10) {
      mismatches.push({
        title: item.title,
        userVerdict: item.label ? '是任務（已確認）' : '不是任務（已退回）',
        modelSaid: item.predicted ? '是任務' : '不是任務',
        modelConfidence: item.predictedConfidence,
        modelReason: clampText(item.predictedReason || '', 200),
      });
    }
  }

  for (const level of Object.values(byConfidence)) {
    level.accuracy = level.total > 0 ? Math.round((level.correct / level.total) * 100) / 100 : null;
  }

  const total = tp + fp + tn + fn;
  return {
    ok: true,
    model: anthropicModel,
    activeJudgmentRules: activeRuleCount,
    cases: total,
    errors,
    positives: tp + fn,
    negatives: tn + fp,
    accuracy: total > 0 ? Math.round(((tp + tn) / total) * 100) / 100 : null,
    precision: (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 100) / 100 : null,
    recall: (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 100) / 100 : null,
    confusion: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
    accuracyByModelConfidence: byConfidence,
    mismatches,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
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

function textProperty(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
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
