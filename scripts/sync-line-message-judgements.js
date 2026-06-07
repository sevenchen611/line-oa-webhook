import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const messagesDataSourceId = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID || '';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '';
const progressReportsDataSourceId = process.env.SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID || '';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const includeOutgoing = Boolean(args['include-outgoing']);
const sinceHours = clampNumber(Number(args['since-hours'] || process.env.SEVEN_LINE_JUDGEMENT_SINCE_HOURS || 36), 1, 24 * 14);
const limit = clampNumber(Number(args.limit || 50), 1, 100);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!messagesDataSourceId) fail('SEVEN_MESSAGES_DATA_SOURCE_ID is not set.');
if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is not set.');
if (!progressReportsDataSourceId) fail('SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID is not set.');

try {
  const startedAt = new Date();
  const messages = await listUnjudgedMessages();
  const results = [];

  for (const message of messages) {
    results.push(await processMessage(message));
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    includeOutgoing,
    sinceHours,
    scannedMessages: messages.length,
    createdTasks: results.filter((item) => item.createdTask).length,
    createdProgressReports: results.filter((item) => item.createdProgressReport).length,
    markedJudged: results.filter((item) => item.markedJudged).length,
    skipped: results.filter((item) => item.action === 'ignored' || item.action === 'skipped').length,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    results,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function listUnjudgedMessages() {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const filters = [
    { property: '已進入判斷層', checkbox: { equals: false } },
    { property: '排序時間', date: { on_or_after: since } },
  ];

  if (!includeOutgoing) {
    filters.push({ property: '訊息來源', select: { equals: 'line' } });
  }

  const result = await notionRequest(`/v1/data_sources/${messagesDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: limit,
      filter: { and: filters },
      sorts: [{ property: '排序時間', direction: 'ascending' }],
    },
  });

  return (result.results || []).map(normalizeMessagePage);
}

async function processMessage(message) {
  const analysis = analyzeMessage(message);
  const result = {
    messageId: message.messageId,
    messagePageId: message.id,
    time: message.time,
    actor: message.actor,
    action: analysis.action,
    project: analysis.project,
    reason: analysis.reason,
    createdTask: null,
    createdProgressReport: null,
    markedJudged: false,
  };

  if (analysis.task) {
    const existing = await findExistingTask(analysis.task.name);
    if (existing) {
      result.createdTask = { action: 'skipped-duplicate', pageId: existing.id, url: existing.url, name: analysis.task.name };
    } else if (dryRun) {
      result.createdTask = { action: 'dry-run', name: analysis.task.name, properties: analysis.task.properties };
    } else {
      const created = await createTask(analysis.task);
      result.createdTask = { action: 'created', pageId: created.id, url: created.url, name: analysis.task.name };
    }
  }

  if (analysis.progressReport) {
    const existing = await findExistingProgressReport(analysis.progressReport.name);
    if (existing) {
      result.createdProgressReport = { action: 'skipped-duplicate', pageId: existing.id, url: existing.url, name: analysis.progressReport.name };
    } else if (dryRun) {
      result.createdProgressReport = { action: 'dry-run', name: analysis.progressReport.name, properties: analysis.progressReport.properties };
    } else {
      const created = await createProgressReport(analysis.progressReport);
      result.createdProgressReport = { action: 'created', pageId: created.id, url: created.url, name: analysis.progressReport.name };
    }
  }

  if (!dryRun) {
    await markMessageJudged(message, firstCreatedUrl(result));
    result.markedJudged = true;
  }

  return result;
}

function analyzeMessage(message) {
  const text = message.text.trim();

  if (!text || !isTextMessageType(message.type)) {
    return { action: 'ignored', project: inferProject(text), reason: 'non-text-or-empty' };
  }

  if (isLowSignal(text)) {
    return { action: 'ignored', project: inferProject(text), reason: 'low-signal-message' };
  }

  if (isCommandTriggerMessage(text)) {
    return { action: 'ignored', project: inferProject(text), reason: 'command-trigger-message' };
  }

  const project = inferProject(text);
  const category = inferCategory(text);
  const highRisk = inferRiskLevel(text) === 'High';
  const taskSignal = hasTaskSignal(text, category);
  const progressSignal = hasProgressSignal(text, category, project);
  const isTaskLike = taskSignal && (category === 'task' || category === 'followup' || category === 'blocked' || category === 'decision');
  const isProgressLike = progressSignal;
  const shouldCreate = isTaskLike || isProgressLike;

  if (!shouldCreate) {
    return { action: 'ignored', project, reason: 'no-actionable-signal' };
  }

  const summary = summarizeText(text);
  const action = category === 'progress' && !isTaskLike ? 'progress' : 'task';
  const dueDate = inferDueDate(text);
  const owner = inferOwner(text) || (message.actor && message.actor !== 'unknown' ? message.actor : '');
  const priority = highRisk || category === 'blocked' ? '高' : text.length >= 160 ? '中' : '低';
  const confidence = project === '未分類' ? '中' : '高';
  const status = highRisk || category === 'decision' ? '待確認' : '待確認';
  const confirmation = highRisk || category === 'decision' ? '未確認' : '未確認';

  const taskName = buildTaskName(project, category, text);
  const task = action === 'task' || isTaskLike ? {
    name: taskName,
    properties: compactProperties({
      任務名稱: titleProperty(taskName),
      專案: selectProperty(project),
      狀態: selectProperty(status),
      確認狀態: selectProperty(confirmation),
      優先級: selectProperty(priority),
      負責人: richTextProperty(owner),
      截止日: dueDate ? dateProperty(dueDate) : undefined,
      來源: selectProperty('LINE'),
      來源原文: richTextProperty(`LINE 訊息：${message.url}\n${text}`, 1900),
      'Codex 判斷摘要': richTextProperty(buildJudgementSummary({ category, summary, highRisk, confidence }), 1900),
      信心等級: selectProperty(confidence),
      下一步: richTextProperty(inferNextStep(text, category), 800),
      '關聯 Notion 頁面': urlProperty(message.url),
      最後更新: dateProperty(new Date()),
    }),
  } : null;

  const progressReport = isProgressLike && project !== '未分類' ? {
    name: buildProgressName(project, message.time),
    properties: compactProperties({
      報表名稱: titleProperty(buildProgressName(project, message.time)),
      專案: selectProperty(project),
      報表週期: dateProperty(message.time ? new Date(message.time) : new Date()),
      目前狀態: selectProperty(highRisk ? '需注意' : '更新'),
      負責人: richTextProperty(owner),
      本週進展: richTextProperty(summary, 1200),
      主要卡點: richTextProperty(inferBlockerText(text), 800),
      下一步: richTextProperty(inferNextStep(text, category), 800),
      '需要 Seven 決策': richTextProperty(highRisk || category === 'decision' ? '需要 Seven 確認後再推進。' : '暫無明確決策需求。', 800),
      關聯頁面: urlProperty(message.url),
    }),
  } : null;

  return {
    action,
    project,
    reason: `${category}${highRisk ? '-high-risk' : ''}`,
    task,
    progressReport,
  };
}

function normalizeMessagePage(page) {
  const properties = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    messageId: textProperty(properties['訊息 ID']),
    actor: textProperty(properties['發話者名稱']),
    source: selectName(properties['訊息來源']),
    type: selectName(properties['訊息類型']),
    time: dateValue(properties['排序時間']),
    text: textProperty(properties['文字內容']) || textProperty(properties['原始內容']),
  };
}

function isLowSignal(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 12) return true;
  if (/^\[[a-z]+\]\s*\d+$/i.test(text.trim())) return true;
  if (/^[()a-zA-Z\s]+$/.test(text.trim()) && compact.length < 30) return true;
  const lowSignalTerms = ['辛苦了', '謝謝', '感謝你', '是的，正確', '收到', '了解', 'OK', 'ok'];
  return lowSignalTerms.some((term) => compact === term.replace(/\s+/g, ''));
}

function isTextMessageType(value) {
  return ['text', '文字', '文字訊息'].includes(String(value || '').trim().toLowerCase())
    || ['文字', '文字訊息'].includes(String(value || '').trim());
}

function hasForcedTag(text) {
  return /#待辦|#todo|#完成|#done|#追蹤|#followup|#決策|#decision|#卡點|#blocked/i.test(text);
}

function isCommandTriggerMessage(text) {
  return /\b(Seven|Eleven|Elven)\s+(Junior|Jr\.?)\b|\b(7|11)\s*(Junior|Jr\.?)\b/i.test(text);
}

function hasTaskSignal(text, category) {
  if (hasForcedTag(text)) return true;
  if (/請幫我記錄|請.*記錄|備註以下|判斷是否需要列入|列入待辦|列入.*事項/.test(text)) return true;
  if (/請.*(提醒|通知|追蹤|確認|處理|回覆)|麻煩.*(提醒|通知|追蹤|確認|處理)|幫我.*(提醒|通知|追蹤|確認|處理)/.test(text)) return true;
  if (/房客|租客/.test(text) && /問題|反應|處理|發黴|漏水|燈|故障/.test(text)) return true;
  if (/保單|保險/.test(text) && /到期|續保|申請書|簽名/.test(text)) return true;
  if (category === 'blocked' && text.length >= 50) return true;
  if (category === 'decision' && text.length >= 80) return true;
  return false;
}

function hasProgressSignal(text, category, project) {
  if (project === '未分類') return false;
  if (/目前.*(進度|狀態)|本週.*進展|今天.*安排|我的看法如下|想法如下|策略|方向/.test(text)) return true;
  if (category === 'progress' && text.length >= 180) return true;
  return false;
}

function inferProject(text) {
  const rules = [
    ['茲心園工程', /茲心園|改建|營造|工程|工地/],
    ['包租代管', /包租代管|包租|代管|房客|租客|租屋|出租|招租|好住寓好|HOZO|後臺|後台/],
    ['HOZO 後臺', /HOZO\s*後|HOZO後|後臺|後台|登入頁|CRM/],
    ['SmartFront / AI Brain', /SmartFront|AI Brain|AI腦|智能前台/],
    ['財務', /財務|付款|匯款|發票|報稅|稅|保單|保險|續保|薪資/],
    ['人資', /人資|招募|面試|員工|同仁|資遣|解僱/],
    ['營運', /營運|月會|例會|流程|SOP|會議/],
    ['私人事務', /老婆|媽媽|媽，|家裡|私人/],
  ];

  for (const [project, pattern] of rules) {
    if (pattern.test(text)) return project;
  }
  return '未分類';
}

function inferCategory(text) {
  if (/#完成|#done|已處理|已完成|完成了|處理完/.test(text)) return 'done';
  if (/#卡點|#blocked|卡住|卡點|無法|不能|問題|發黴|漏水|故障/.test(text)) return 'blocked';
  if (/#決策|#decision|決定|批准|同意|是否|我的看法|原則上|不予|需要.*確認/.test(text)) return 'decision';
  if (/#追蹤|#followup|追蹤|提醒|通知|確認一下|再跟|回覆/.test(text)) return 'followup';
  if (/#待辦|#todo|請|麻煩|幫我|我要|需要|希望/.test(text)) return 'task';
  if (/進度|狀態|目前|本週|今天|看法|想法|策略|方向/.test(text)) return 'progress';
  return 'note';
}

function inferRiskLevel(text) {
  const highRiskTerms = ['合約', '法律', '稅', '薪資', '付款', '匯款', '發票', '解僱', '資遣', '報價', '保險', '續保', '對外承諾', '賠償'];
  return highRiskTerms.some((term) => text.includes(term)) ? 'High' : 'Normal';
}

function inferDueDate(text) {
  const now = new Date();
  if (/今天|今日/.test(text)) return now;
  if (/明天|明日/.test(text)) return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (/下週|下禮拜/.test(text)) return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(日|號)/);
  if (monthDay) {
    const year = now.getFullYear();
    return new Date(year, Number(monthDay[1]) - 1, Number(monthDay[2]));
  }
  return null;
}

function inferOwner(text) {
  const mention = text.match(/@([^\s，,。]+)/);
  if (mention) return mention[1];
  const named = text.match(/(昱晴|Seven|Bonnie|逸凡|宜穎|嘉娜|Maggie)/i);
  return named ? named[1] : '';
}

function summarizeText(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 900);
}

function inferNextStep(text, category) {
  if (/房客|租客/.test(text) && /燈|亮/.test(text) && /發黴|浴室/.test(text)) {
    return '整理回覆房客的口徑：燈光以委婉說明與立燈建議處理；浴室發黴需安排檢查與處理方式，待主管確認。';
  }
  if (category === 'decision') return '保留為待確認決策，請 Seven 確認是否採納與是否需要對外回覆。';
  if (category === 'followup') return '建立追蹤項目，確認對象、期限與是否需要由 Seven Jr. 發出提醒。';
  if (category === 'blocked') return '確認卡點原因、責任人與下一步處理方式。';
  return '請確認是否成立為正式任務，並補齊負責人與期限。';
}

function inferBlockerText(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matched = lines.filter((line) => /問題|卡點|無法|不能|發黴|故障|不足|不夠|逾期/.test(line));
  return matched.length ? matched.slice(0, 4).join('\n') : '暫無明確卡點。';
}

function buildTaskName(project, category, text) {
  if (/房客|租客/.test(text) && /燈|亮/.test(text) && /發黴|浴室/.test(text)) {
    return `${project}：確認房客燈光與浴室發黴處理口徑`;
  }

  const cleaned = text
    .replace(/#\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^.*?(請|麻煩|幫我|我要|需要|希望)/, '$1')
    .trim();
  const prefix = categoryLabel(category);
  const subject = cleaned.slice(0, 34).replace(/[，。,.：:]+$/g, '') || 'LINE 訊息待判斷';
  return `${project}：${prefix}${subject}`;
}

function categoryLabel(category) {
  const labels = {
    task: '',
    followup: '追蹤 ',
    blocked: '處理卡點 ',
    decision: '確認決策 ',
    done: '確認完成 ',
    progress: '更新進度 ',
    note: '判斷 ',
  };
  return labels[category] || '';
}

function buildProgressName(project, time) {
  const date = formatDateKey(time ? new Date(time) : new Date());
  return `${date} ${project} LINE 訊息更新`;
}

function buildJudgementSummary({ category, summary, highRisk, confidence }) {
  return [
    `分類：${categoryLabel(category).trim() || category}`,
    `信心：${confidence}`,
    highRisk ? '風險：高，需人工確認。' : '風險：一般。',
    `摘要：${summary}`,
  ].join('\n');
}

async function findExistingTask(taskName) {
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 1, filter: { property: '任務名稱', title: { equals: taskName } } },
  });
  return result.results?.[0] || null;
}

async function createTask(candidate) {
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: tasksDataSourceId },
      properties: candidate.properties,
    },
  });
}

async function findExistingProgressReport(name) {
  const result = await notionRequest(`/v1/data_sources/${progressReportsDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 1, filter: { property: '報表名稱', title: { equals: name } } },
  });
  return result.results?.[0] || null;
}

async function createProgressReport(candidate) {
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: progressReportsDataSourceId },
      properties: candidate.properties,
    },
  });
}

async function markMessageJudged(message, relatedUrl) {
  await notionRequest(`/v1/pages/${message.id}`, {
    method: 'PATCH',
    body: {
      properties: compactProperties({
        已進入判斷層: checkboxProperty(true),
        關聯總控事件: relatedUrl ? urlProperty(relatedUrl) : undefined,
      }),
    },
  });
}

function firstCreatedUrl(result) {
  if (result.createdTask?.url) return result.createdTask.url;
  if (result.createdProgressReport?.url) return result.createdProgressReport.url;
  return '';
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
    throw new Error(`Notion API ${method} ${pathname} failed: ${response.status} ${responseText}`);
  }

  return responseText ? JSON.parse(responseText) : {};
}

function textProperty(property) {
  if (!property) return '';
  if (property.type === 'title') return (property.title || []).map((item) => item.plain_text || '').join('');
  if (property.type === 'rich_text') return (property.rich_text || []).map((item) => item.plain_text || '').join('');
  return '';
}

function selectName(property) {
  return property?.type === 'select' ? property.select?.name || '' : '';
}

function dateValue(property) {
  return property?.type === 'date' ? property.date?.start || '' : '';
}

function titleProperty(value) {
  return { title: [{ type: 'text', text: { content: String(value || '').slice(0, 2000) } }] };
}

function richTextProperty(value, maxLength = 1900) {
  return { rich_text: [{ type: 'text', text: { content: String(value || '').slice(0, maxLength) } }] };
}

function selectProperty(value) {
  const name = String(value || '').trim();
  return name ? { select: { name } } : undefined;
}

function dateProperty(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : { date: { start: date.toISOString() } };
}

function urlProperty(value) {
  return value ? { url: String(value) } : undefined;
}

function checkboxProperty(value) {
  return { checkbox: Boolean(value) };
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
}

function formatDateKey(value) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(value);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
