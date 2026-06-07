import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const meetingsDataSourceId = process.env.SEVEN_MEETINGS_DATA_SOURCE_ID || 'fd551c68-6dac-830d-81bf-879f0a9582ba';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const progressReportsDataSourceId = process.env.SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID || 'fc5e4e21-6af6-4de2-9380-aa95126ee13e';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const includeIncomplete = Boolean(args['include-incomplete']);
const statusProperty = String(process.env.SEVEN_MEETINGS_STATUS_PROPERTY || args['status-property'] || '').trim();
const datePropertyName = String(process.env.SEVEN_MEETINGS_DATE_PROPERTY || args['date-property'] || '日期').trim();
const limit = clampNumber(Number(args.limit || 20), 1, 100);

if (!notionToken) {
  fail('NOTION_TOKEN is not set.');
}

try {
  const startedAt = new Date();
  const meetings = await listMeetings(limit, includeIncomplete);
  const results = [];

  for (const meeting of meetings) {
    results.push(await syncMeeting(meeting));
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    scannedMeetings: meetings.length,
    createdTasks: results.reduce((count, item) => count + item.createdTasks.length, 0),
    skippedTasks: results.reduce((count, item) => count + item.skippedTasks.length, 0),
    createdProgressReports: results.filter((item) => item.progressReport?.action === 'created').length,
    skippedProgressReports: results.filter((item) => item.progressReport?.action === 'skipped').length,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    results,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function syncMeeting(page) {
  const meeting = summarizeMeeting(page);
  const bodyText = await readPageText(page.id);
  const sourceText = [meeting.actionItems, meeting.meetingRecord, bodyText].filter(Boolean).join('\n');
  const extractedItems = extractActionItems(sourceText);
  const createdTasks = [];
  const skippedTasks = [];

  if (isExcludedScope(`${meeting.name}\n${meeting.summary}\n${sourceText}`)) {
    return {
      meeting: publicMeetingSummary(meeting),
      createdTasks,
      skippedTasks: [{ reason: 'excluded-scope' }],
      progressReport: { action: 'skipped', reason: 'excluded-scope' },
    };
  }

  for (const itemText of extractedItems) {
    const candidate = buildTaskCandidate(itemText, meeting);
    const existing = await findExistingTask(candidate.name, meeting.url);

    if (existing) {
      skippedTasks.push({ task: candidate.name, reason: 'duplicate', pageId: existing.id });
      continue;
    }

    if (dryRun) {
      createdTasks.push({ task: candidate.name, dryRun: true, properties: candidate.properties });
      continue;
    }

    const created = await createTask(candidate);
    createdTasks.push({ task: candidate.name, pageId: created.id, url: created.url });
  }

  const progressReport = await maybeCreateProgressReport(meeting, bodyText, extractedItems);

  return {
    meeting: publicMeetingSummary(meeting),
    extractedActionItems: extractedItems,
    createdTasks,
    skippedTasks,
    progressReport,
  };
}

async function listMeetings(pageSize, shouldIncludeIncomplete) {
  const body = {
    page_size: pageSize,
    sorts: [
      { property: datePropertyName, direction: 'descending' },
      { timestamp: 'created_time', direction: 'descending' },
    ],
  };

  if (!shouldIncludeIncomplete && statusProperty) {
    body.filter = {
      property: statusProperty,
      status: { equals: '已完成' },
    };
  }

  const result = await notionRequest(`/v1/data_sources/${meetingsDataSourceId}/query`, {
    method: 'POST',
    body,
  });

  return result.results || [];
}

function summarizeMeeting(page) {
  const properties = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    name: getTitle(properties['會議名稱']) || '未命名會議',
    summary: firstText(properties, ['摘要', '會議摘要']),
    actionItems: firstText(properties, ['行動項目', '待辦事項']),
    meetingRecord: firstText(properties, ['會議記錄', '會議紀錄']),
    department: getSelect(properties['部門']),
    selectedProject: getSelect(properties['選擇專案']),
    status: getStatus(properties['會議狀態']),
    type: firstSelectOrMultiSelect(properties, ['類別', '會議類型']),
    meetingDate: getDateStart(properties['日期']) || getDateStart(properties['會議日期']),
    nextFollowupDate: getDateStart(properties['下次追蹤日期']),
  };
}

function publicMeetingSummary(meeting) {
  return {
    name: meeting.name,
    url: meeting.url,
    status: meeting.status,
    type: meeting.type,
    meetingDate: meeting.meetingDate,
  };
}

async function readPageText(pageId) {
  const blocks = await getBlockChildren(pageId);
  const lines = [];

  for (const block of blocks) {
    const text = blockText(block);
    if (text) {
      lines.push(text);
    }
    if (block.has_children) {
      const childText = await readPageText(block.id);
      if (childText) {
        lines.push(childText);
      }
    }
  }

  return lines.join('\n');
}

async function getBlockChildren(blockId) {
  const blocks = [];
  let startCursor;
  do {
    const query = startCursor ? `?page_size=100&start_cursor=${encodeURIComponent(startCursor)}` : '?page_size=100';
    const result = await notionRequest(`/v1/blocks/${blockId}/children${query}`, { method: 'GET' });
    blocks.push(...(result.results || []));
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor);
  return blocks;
}

function extractActionItems(text) {
  const normalized = String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r/g, '\n')
    .replace(/[；;]/g, '\n');

  const seen = new Set();
  const items = [];

  for (const rawLine of normalized.split('\n')) {
    const item = normalizeActionLine(rawLine);
    if (!item || seen.has(item)) {
      continue;
    }
    if (!looksLikeActionItem(item)) {
      continue;
    }
    seen.add(item);
    items.push(item);
  }

  return items.slice(0, 30);
}

function normalizeActionLine(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*+]|[0-9０-９]+[.)、．]|[一二三四五六七八九十]+[、.．]|□|☐|☑|✅)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeActionItem(value) {
  const text = String(value || '').trim();
  if (text.length < 4 || text.length > 220) {
    return false;
  }

  const ignoredPatterns = [
    /新增任何筆記/,
    /提供額外背景資訊與詳情/,
    /我注意到.*錄音轉錄內容/,
    /為了讓我能為你提供/,
    /歡迎再次使用/,
    /期待為你提供/,
    /若.*可透過.*聯繫.*協助/,
    /會有人員協助處理/,
  ];
  if (ignoredPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  const actionTerms = [
    '整理', '確認', '追蹤', '回覆', '提供', '準備', '建立', '更新', '修正',
    '安排', '評估', '聯絡', '發送', '提交', '補', '處理', '測試', '同步',
    'review', 'prepare', 'follow', 'send', 'update', 'create', 'fix',
  ];
  const actionPattern = /^(?:請|需|需要|待|要|應|必須|請.*協助|整理|確認|追蹤|回覆|提供|準備|建立|更新|修正|安排|評估|聯絡|發送|提交|補|處理|測試|同步)/i;
  return actionPattern.test(text) || actionTerms.some((term) => text.length <= 24 && text.toLowerCase().includes(term.toLowerCase()));
}

function buildTaskCandidate(itemText, meeting) {
  const analysisText = `${meeting.name}\n${meeting.summary}\n${itemText}`;
  const project = meeting.selectedProject || inferProject(analysisText);
  const riskLevel = inferRiskLevel(analysisText);
  const status = inferTaskStatus(itemText);
  const confidence = riskLevel === 'High' ? '低' : inferConfidence(itemText, project);
  const dueDate = inferDueDate(itemText) || meeting.nextFollowupDate || null;
  const syncId = buildSyncId(meeting.id, itemText);
  const summary = [
    `會議：${meeting.name}`,
    `同步識別碼：${syncId}`,
    `判斷：由會議行動項目轉入候選任務。`,
    riskLevel === 'High' ? '注意：內容可能涉及敏感或高風險事項，需 Seven 確認後再推進。' : '',
  ].filter(Boolean).join('\n');

  return {
    name: itemText,
    properties: compactProperties({
      任務名稱: titleProperty(itemText),
      狀態: selectProperty(status),
      確認狀態: selectProperty('未確認'),
      來源: selectProperty('會議'),
      信心等級: selectProperty(confidence),
      優先級: selectProperty(inferPriority(itemText, riskLevel)),
      專案: selectProperty(project),
      負責人: richTextProperty(inferOwner(itemText)),
      下一步: richTextProperty(itemText),
      來源原文: richTextProperty(`會議：${meeting.name}\n行動項目：${itemText}\n同步識別碼：${syncId}`),
      'Codex 判斷摘要': richTextProperty(summary),
      '關聯 Notion 頁面': urlProperty(meeting.url),
      截止日: dueDate ? dateProperty(dueDate) : undefined,
      最後更新: dateProperty(new Date()),
    }),
  };
}

async function findExistingTask(taskName, meetingUrl) {
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: {
        and: [
          { property: '任務名稱', title: { equals: taskName } },
          { property: '關聯 Notion 頁面', url: { equals: meetingUrl } },
        ],
      },
    },
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

async function maybeCreateProgressReport(meeting, bodyText, actionItems) {
  const sourceText = `${meeting.name}\n${meeting.summary}\n${bodyText}\n${actionItems.join('\n')}`;
  const project = meeting.selectedProject || inferProject(sourceText);

  if (project === '未分類' || isExcludedScope(sourceText)) {
    return { action: 'skipped', reason: 'no-confident-project' };
  }

  const existing = await findExistingProgressReport(project, meeting.url);
  if (existing) {
    return { action: 'skipped', reason: 'duplicate', pageId: existing.id };
  }

  const report = buildProgressReport(meeting, bodyText, actionItems, project);
  if (dryRun) {
    return { action: 'created', dryRun: true, properties: report.properties };
  }

  const created = await notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: progressReportsDataSourceId },
      properties: report.properties,
    },
  });

  return { action: 'created', pageId: created.id, url: created.url };
}

async function findExistingProgressReport(project, meetingUrl) {
  const result = await notionRequest(`/v1/data_sources/${progressReportsDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: {
        and: [
          { property: '專案', select: { equals: project } },
          { property: '關聯頁面', url: { equals: meetingUrl } },
        ],
      },
    },
  });

  return result.results?.[0] || null;
}

function buildProgressReport(meeting, bodyText, actionItems, project) {
  const status = inferProgressStatus(`${meeting.summary}\n${bodyText}`);
  const blockers = extractBlockers(`${meeting.summary}\n${bodyText}`);
  const decisions = extractDecisionNeeds(`${meeting.summary}\n${bodyText}\n${actionItems.join('\n')}`);
  const nextSteps = actionItems.slice(0, 5).join('\n');
  const title = `${project} 會議進度 - ${meeting.name}`;

  return {
    properties: compactProperties({
      報表名稱: titleProperty(title),
      專案: selectProperty(project),
      '目前狀態': selectProperty(status),
      完成度: { number: inferCompletion(status) },
      '本週進展': richTextProperty(meeting.summary || `由會議「${meeting.name}」同步。`),
      '主要卡點': richTextProperty(blockers || '尚未從會議紀錄辨識出明確卡點。'),
      下一步: richTextProperty(nextSteps || '待補充下一步。'),
      '需要 Seven 決策': richTextProperty(decisions || '暫無明確決策需求。'),
      關聯頁面: urlProperty(meeting.url),
      報表週期: dateProperty(meeting.meetingDate || new Date()),
    }),
  };
}

function inferProject(text) {
  const value = String(text || '').toLowerCase();
  const projectRules = [
    ['茲心園工程', ['茲心園', '台翰', '改建', '工程']],
    ['包租代管', ['包租', '代管', '租賃管理']],
    ['SmartFront / AI Brain', ['smartfront', 'ai brain', 'codex', '自動化', 'line oa', 'seven jr', 'sevenam']],
    ['財務', ['財務', '付款', '匯款', '發票', '報價', '預算']],
    ['人資', ['人資', '薪資', '招募', '面談', '到職']],
    ['營運', ['營運', '流程', '客服', '行政']],
    ['私人事務', ['私人', '個人']],
  ];

  for (const [project, keywords] of projectRules) {
    if (keywords.some((keyword) => value.includes(keyword.toLowerCase()))) {
      return project;
    }
  }

  return '未分類';
}

function isExcludedScope(text) {
  return /hozo|hogo|好住|寓好/i.test(String(text || ''));
}

function inferTaskStatus(text) {
  if (/完成|已處理|done|ok/i.test(text)) {
    return '待確認完成';
  }
  if (/等待|回覆|追蹤|follow/i.test(text)) {
    return '等待回覆';
  }
  if (/進行中|處理中/i.test(text)) {
    return '進行中';
  }
  return '待確認';
}

function inferRiskLevel(text) {
  const highRiskTerms = [
    'contract', 'legal', 'tax', 'salary', 'payment', 'invoice', 'terminate',
    '合約', '法律', '稅', '薪資', '付款', '匯款', '發票', '解僱', '資遣', '報價', '預算',
  ];
  const value = String(text || '').toLowerCase();
  return highRiskTerms.some((term) => value.includes(term)) ? 'High' : 'Normal';
}

function inferConfidence(text, project) {
  if (project === '未分類') {
    return '中';
  }
  if (inferDueDate(text) || inferOwner(text)) {
    return '高';
  }
  return '中';
}

function inferPriority(text, riskLevel) {
  if (riskLevel === 'High') {
    return '高';
  }
  if (/急|今天|明天|本週|盡快|asap|urgent/i.test(text)) {
    return '高';
  }
  return '中';
}

function inferOwner(text) {
  const patterns = [
    /負責人[:：]\s*([^，,。;\n]+)/,
    /由\s*([^，,。;\n]{2,12})\s*(?:負責|處理|確認|整理|追蹤)/,
    /請\s*([^，,。;\n]{2,12})\s*(?:負責|處理|確認|整理|追蹤|提供)/,
  ];

  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return '';
}

function inferDueDate(text) {
  const value = String(text || '');
  const isoMatch = value.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  const monthDayMatch = value.match(/(\d{1,2})[/-](\d{1,2})/);
  if (monthDayMatch) {
    const now = new Date();
    return `${now.getFullYear()}-${monthDayMatch[1].padStart(2, '0')}-${monthDayMatch[2].padStart(2, '0')}`;
  }

  return null;
}

function inferProgressStatus(text) {
  if (/卡住|阻塞|無法|風險|延誤|逾期|blocked/i.test(text)) {
    return '卡住';
  }
  if (/注意|待確認|等待|風險|需確認/i.test(text)) {
    return '需注意';
  }
  if (/暫停|hold|pause/i.test(text)) {
    return '暫停';
  }
  return '正常';
}

function inferCompletion(status) {
  if (status === '正常') return 50;
  if (status === '需注意') return 35;
  if (status === '卡住') return 20;
  return 0;
}

function extractBlockers(text) {
  return extractMatchingLines(text, /卡住|阻塞|無法|等待|延誤|風險|問題|缺/i).join('\n');
}

function extractDecisionNeeds(text) {
  return extractMatchingLines(text, /決定|決策|確認|批准|同意|是否|需 Seven|需要 Seven/i).join('\n');
}

function extractMatchingLines(text, pattern) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && pattern.test(line))
    .slice(0, 5);
}

function buildSyncId(meetingId, itemText) {
  const hash = createHash('sha256')
    .update(`${meetingId}:${itemText}`)
    .digest('hex')
    .slice(0, 16);
  return `meeting:${meetingId}:${hash}`;
}

function blockText(block) {
  const value = block?.[block.type];
  if (!value) {
    return '';
  }
  if (Array.isArray(value.rich_text)) {
    return richTextPlain(value.rich_text);
  }
  return '';
}

function getTitle(property) {
  return richTextPlain(property?.title);
}

function getRichText(property) {
  return richTextPlain(property?.rich_text);
}

function getSelect(property) {
  return property?.select?.name || '';
}

function getStatus(property) {
  return property?.status?.name || '';
}

function firstText(properties, names) {
  for (const name of names) {
    const text = getRichText(properties[name]);
    if (text) {
      return text;
    }
  }
  return '';
}

function firstSelectOrMultiSelect(properties, names) {
  for (const name of names) {
    const property = properties[name];
    const select = getSelect(property);
    if (select) {
      return select;
    }

    const multiSelect = getMultiSelect(property);
    if (multiSelect) {
      return multiSelect;
    }
  }
  return '';
}

function getDateStart(property) {
  return property?.date?.start || null;
}

function getMultiSelect(property) {
  return (property?.multi_select || []).map((item) => item.name).join(', ');
}

function richTextPlain(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
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
    if (response.status === 404 && pathname.includes('/data_sources/')) {
      throw new Error([
        `Notion data source is not accessible: ${pathname}`,
        'Please confirm the database is inside Codex 總控中心 and shared with the Notion integration used by NOTION_TOKEN.',
        `Notion response: ${responseText}`,
      ].join('\n'));
    }
    throw new Error(`Notion API failed: ${response.status} ${responseText}`);
  }

  return responseText ? JSON.parse(responseText) : {};
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function titleProperty(value) {
  return { title: [{ type: 'text', text: { content: clampNotionText(value) } }] };
}

function richTextProperty(value) {
  const text = clampNotionText(value);
  return text ? { rich_text: [{ type: 'text', text: { content: text } }] } : { rich_text: [] };
}

function selectProperty(name) {
  return { select: { name } };
}

function dateProperty(value) {
  const date = value instanceof Date ? value.toISOString() : String(value);
  return { date: { start: date } };
}

function urlProperty(value) {
  return { url: value || null };
}

function clampNotionText(value) {
  const text = String(value || '').trim();
  return text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
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
