import { existsSync, readFileSync, writeFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY || '';
const pushUrl = process.env.CONTROL_LINE_PUSH_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/line/push';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '';
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const groupMembersDataSourceId = process.env.SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID || '';
const defaultTargetName = process.env.SEVEN_JUDGMENT_REVIEW_TARGET_NAME_KEYWORD || 'Seven 陳聖文';

const command = String(process.argv[2] || 'help').trim().toLowerCase();
const args = parseArgs(process.argv.slice(3));

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else if (command === 'create') {
  await requireNotion();
  const result = await createCalibrationDatabases();
  if (args['write-env']) updateEnvFile('.env', result.env);
  printSafeResult({
    ok: true,
    created: result.created,
    updatedEnv: Boolean(args['write-env']),
    nextStep: 'Run npm run judgment:calibration -- find-target, then npm run judgment:calibration -- send-test.',
  });
} else if (command === 'find-target') {
  await requireNotion();
  const target = await resolveReviewTarget();
  printSafeResult({
    ok: true,
    targetName: target.name,
    targetType: target.type,
    source: target.source,
    maskedTargetId: maskId(target.id),
  });
} else if (command === 'send-test') {
  await requireNotion();
  await requireLinePush();
  const target = await resolveReviewTarget();
  const text = [
    '【判斷校準測試】',
    '專案：SEVEN_AM',
    `接收人：${target.name}`,
    '',
    '這是 SevenAM 判斷校準流程測試訊息。',
    '之後我會把不確定的總控任務一條一條發到這裡，請你直接回覆方向、原因、可學習規則。',
  ].join('\n');
  await pushLine(target, text);
  printSafeResult({ ok: true, sent: true, targetName: target.name, targetType: target.type, maskedTargetId: maskId(target.id) });
} else if (command === 'send-next') {
  await requireNotion();
  await requireLinePush();
  const calibration = await requireCalibrationDatabases();
  const target = await resolveReviewTarget();
  const candidate = await findNextTaskCandidate(calibration.casesDataSourceId);
  if (!candidate) {
    printSafeResult({ ok: true, sent: false, reason: 'No eligible task candidate found.' });
  } else {
    const casePage = await createCalibrationCase(calibration.casesDataSourceId, candidate);
    const reviewId = pageTitle(casePage, 'Review ID');
    await pushLine(target, buildTaskReviewMessage(reviewId, candidate));
    printSafeResult({
      ok: true,
      sent: true,
      reviewId,
      taskTitle: candidate.title,
      targetName: target.name,
      targetType: target.type,
      maskedTargetId: maskId(target.id),
    });
  }
} else if (command === 'record-reply') {
  await requireNotion();
  const calibration = await requireCalibrationDatabases();
  const reviewId = requiredArg('review-id');
  const direction = requiredArg('direction');
  const reason = String(args.reason || '').trim();
  const rule = String(args.rule || '').trim();
  const exception = String(args.exception || '').trim();
  const result = await recordControllerReply(calibration, { reviewId, direction, reason, rule, exception });
  printSafeResult({ ok: true, reviewId, updatedCase: result.updatedCase, createdRule: result.createdRule });
} else {
  fail(`Unknown command: ${command}`);
}

async function createCalibrationDatabases() {
  const existingRulesDataSourceId = process.env.SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID || '';
  const existingCasesDataSourceId = process.env.SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID || '';
  let rulesDataSourceId = existingRulesDataSourceId;
  let casesDataSourceId = existingCasesDataSourceId;
  const created = [];

  const parentPageId = await resolveParentPageId();
  if (!rulesDataSourceId) {
    const rulesDatabase = await createDatabase({
      parentPageId,
      title: 'Seven 判斷規則庫',
      dataSourceTitle: 'Seven 判斷規則',
      properties: judgmentRuleProperties(),
    });
    rulesDataSourceId = dataSourceIdFromDatabase(rulesDatabase);
    created.push('judgment rules');
  } else {
    await assertSevenCalibrationDataSource(rulesDataSourceId);
  }

  if (!casesDataSourceId) {
    const casesDatabase = await createDatabase({
      parentPageId,
      title: 'Seven 判斷校準案例庫',
      dataSourceTitle: 'Seven 判斷校準案例',
      properties: judgmentCaseProperties({ rulesDataSourceId }),
    });
    casesDataSourceId = dataSourceIdFromDatabase(casesDatabase);
    created.push('judgment calibration cases');
  } else {
    await assertSevenCalibrationDataSource(casesDataSourceId);
  }

  return {
    created,
    env: {
      SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID: rulesDataSourceId,
      SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID: casesDataSourceId,
      SEVEN_JUDGMENT_REVIEW_TARGET_NAME_KEYWORD: defaultTargetName,
    },
  };
}

async function resolveParentPageId() {
  const explicit = normalizeId(args.parent || process.env.SEVEN_JUDGMENT_PARENT_PAGE_ID || process.env.SEVEN_DATA_SOURCE_PARENT_BLOCK_ID || '');
  if (explicit) return explicit;
  if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is required to infer a parent page.');

  const dataSource = await notionRequest(`/v1/data_sources/${tasksDataSourceId}`, { method: 'GET' });
  if (dataSource.parent?.type === 'page_id') return normalizeId(dataSource.parent.page_id);
  if (dataSource.parent?.type === 'database_id') {
    const database = await notionRequest(`/v1/databases/${dataSource.parent.database_id}`, { method: 'GET' });
    if (database.parent?.type === 'page_id') return normalizeId(database.parent.page_id);
  }

  fail('Unable to infer parent page. Set SEVEN_JUDGMENT_PARENT_PAGE_ID or SEVEN_DATA_SOURCE_PARENT_BLOCK_ID.');
}

async function resolveReviewTarget() {
  const targetName = String(args['target-name'] || defaultTargetName).trim();
  if (!targetName) fail('Missing --target-name or SEVEN_JUDGMENT_REVIEW_TARGET_NAME_KEYWORD.');

  const member = groupMembersDataSourceId ? await findTargetFromGroupMembers(targetName) : null;
  if (member) return member;

  const conversationTarget = conversationsDataSourceId ? await findTargetFromConversations(targetName) : null;
  if (conversationTarget) return conversationTarget;

  fail(`Unable to find LINE user target by name: ${targetName}`);
}

async function findTargetFromGroupMembers(targetName) {
  const pages = await queryAllPages(groupMembersDataSourceId, { page_size: 100 });
  const match = pages
    .map((page) => ({
      id: pageText(page, 'UserID'),
      name: pageText(page, '成員顯示名稱') || pageTitle(page, '成員選項名稱'),
      source: 'line group members',
      type: 'user',
    }))
    .find((item) => item.id && normalizedIncludes(item.name, targetName));
  return match || null;
}

async function findTargetFromConversations(targetName) {
  const pages = await queryAllPages(conversationsDataSourceId, {
    page_size: clampNumber(Number(args.limit || 100), 1, 100),
    sorts: [{ property: '最後訊息時間', direction: 'descending' }],
  });
  const match = pages
    .map((page) => ({
      id: pageText(page, 'User ID'),
      name: pageText(page, '自定義名稱') || pageText(page, 'LINE 對話名稱') || pageTitle(page, 'LINE 對話名稱'),
      source: 'line conversations',
      type: 'user',
    }))
    .find((item) => item.id && item.id.startsWith('U') && normalizedIncludes(item.name, targetName));
  return match || null;
}

async function findNextTaskCandidate(casesDataSourceId) {
  if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is not set.');
  const alreadySent = await reviewedTaskIds(casesDataSourceId);
  const pages = await queryAllPages(tasksDataSourceId, { page_size: clampNumber(Number(args.limit || 50), 1, 100) });
  const candidates = pages
    .map(normalizeTask)
    .filter((task) => task.id && task.title && !alreadySent.has(task.id))
    .filter((task) => !isClosedStatus(task.status))
    .filter((task) => shouldReviewTask(task));
  return candidates[0] || null;
}

async function reviewedTaskIds(casesDataSourceId) {
  const pages = await queryAllPages(casesDataSourceId, { page_size: 100 });
  const ids = new Set();
  for (const page of pages) {
    for (const id of relationIds(page.properties?.['Source Task'])) ids.add(id);
  }
  return ids;
}

function normalizeTask(page) {
  return {
    id: page.id,
    url: page.url,
    title: pageTitle(page, '任務名稱') || pageTitle(page, 'Name') || pageTitle(page, '名稱'),
    status: pageSelect(page, '狀態') || pageStatus(page, '狀態'),
    confirmation: pageSelect(page, '確認狀態'),
    confidence: pageSelect(page, '信心等級'),
    priority: pageSelect(page, '優先級'),
    owner: pageText(page, '負責人') || pageText(page, 'Owner'),
    summary: pageText(page, 'Codex 判斷摘要') || pageText(page, '下一步') || pageText(page, '來源原文'),
    project: pageSelect(page, '總控專案') || pageSelect(page, '第一層：總控專案'),
  };
}

function shouldReviewTask(task) {
  const haystack = `${task.title} ${task.summary} ${task.status} ${task.confirmation} ${task.confidence}`;
  if (/未確認|待確認|需補充|低|待負責人口述|Codex 待確認/.test(haystack)) return true;
  if (/部署|Render|LINE|Notion|金流|合約|法律|稅務|客戶|對外|承諾|跨專案/.test(haystack)) return true;
  return false;
}

async function createCalibrationCase(casesDataSourceId, task) {
  const reviewId = `SEVEN-JC-${formatDateKey(new Date())}`;
  const assistantJudgment = task.status === '待確認' || task.confirmation === '未確認'
    ? '此任務需要 controller 判斷是否成立、方向是否正確，以及是否需要拆分或補資料。'
    : '此任務具有風險或不確定性，建議先由 controller 校準處理方向。';
  const assistantReason = [
    task.status ? `狀態=${task.status}` : '',
    task.confirmation ? `確認狀態=${task.confirmation}` : '',
    task.confidence ? `信心等級=${task.confidence}` : '',
    task.priority ? `優先級=${task.priority}` : '',
  ].filter(Boolean).join('；') || '由 SevenAM 任務庫篩選為需核對項目。';

  return createPage(casesDataSourceId, {
    'Review ID': titleProperty(reviewId),
    Project: selectProperty('SEVEN_AM'),
    'Source Type': selectProperty('total-control task'),
    'Source Task': relationProperty([task.id]),
    'Source URL': urlProperty(task.url),
    'Task Type': selectProperty(inferTaskType(task)),
    'Assistant Judgment': richTextProperty(assistantJudgment),
    'Assistant Reason': richTextProperty(assistantReason),
    'Assistant Confidence': selectProperty(task.confidence === '高' ? 'high' : task.confidence === '中' ? 'medium' : 'low'),
    'Case Status': selectProperty('Sent to LINE'),
    'LINE Review Sent At': dateProperty(new Date()),
    'Data Boundary Check': checkboxProperty(true),
  });
}

function buildTaskReviewMessage(reviewId, task) {
  return clampLineText([
    `【判斷校準】${reviewId}`,
    '專案：SEVEN_AM',
    `任務：${task.title}`,
    '來源：total-control task',
    '',
    '我的判斷：',
    task.status === '待確認' || task.confirmation === '未確認'
      ? '這筆應先請你確認：是否成立為任務、方向是否正確、是否需要拆分或補資料。'
      : '這筆有不確定或高風險訊號，先送你校準處理方向。',
    '',
    '我判斷的理由：',
    [
      task.project ? `專案=${task.project}` : '',
      task.status ? `狀態=${task.status}` : '',
      task.confirmation ? `確認=${task.confirmation}` : '',
      task.confidence ? `信心=${task.confidence}` : '',
      task.priority ? `優先=${task.priority}` : '',
      task.owner ? `負責人=${task.owner}` : '',
    ].filter(Boolean).join('｜') || '任務庫標示為需確認。',
    '',
    '不確定點：',
    task.summary || '需要你指定正確處理方向。',
    '',
    '請回覆：',
    '方向：建立任務 / 不是任務 / 暫緩 / 拆任務 / 改專案 / 補資料 / 其他',
    '原因：...',
    '規則：...',
    '例外：...',
  ].join('\n'));
}

async function recordControllerReply(calibration, { reviewId, direction, reason, rule, exception }) {
  const casePage = await findCaseByReviewId(calibration.casesDataSourceId, reviewId);
  if (!casePage) fail(`Review ID not found: ${reviewId}`);

  const patch = {
    'Controller Judgment': richTextProperty(direction),
    'Controller Reason': richTextProperty(reason),
    'Reply Summary': richTextProperty([`方向：${direction}`, reason ? `原因：${reason}` : ''].filter(Boolean).join('\n')),
    'Case Status': selectProperty(rule ? 'Rule Extracted' : 'Updated'),
    'Controller Replied At': dateProperty(new Date()),
    'Generalized Rule': richTextProperty(rule),
  };

  let createdRule = false;
  if (rule) {
    const rulePage = await createPage(calibration.rulesDataSourceId, {
      'Rule Name': titleProperty(shortRuleName(rule)),
      'Trigger Pattern': richTextProperty(reason || direction),
      'Preferred Judgment': richTextProperty(direction),
      'Avoided Judgment': richTextProperty('Use assistant original judgment without controller calibration.'),
      Reason: richTextProperty(reason),
      'Applies To': multiSelectProperty(['SEVEN_AM']),
      Exceptions: richTextProperty(exception),
      'Source Case Count': numberProperty(1),
      Status: selectProperty('Needs review'),
      'Checklist Placement': selectProperty('task start'),
      'Last Verified': dateProperty(new Date()),
    });
    patch['Rule Link'] = relationProperty([rulePage.id]);
    createdRule = true;
  }

  await updatePage(casePage.id, patch);
  return { updatedCase: true, createdRule };
}

async function findCaseByReviewId(casesDataSourceId, reviewId) {
  const result = await notionRequest(`/v1/data_sources/${casesDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 1, filter: { property: 'Review ID', title: { equals: reviewId } } },
  });
  return result.results?.[0] || null;
}

async function requireCalibrationDatabases() {
  const casesDataSourceId = process.env.SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID || '';
  const rulesDataSourceId = process.env.SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID || '';
  if (!casesDataSourceId) fail('SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID is not set. Run create --write-env first.');
  if (!rulesDataSourceId) fail('SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID is not set. Run create --write-env first.');
  await assertSevenCalibrationDataSource(casesDataSourceId);
  await assertSevenCalibrationDataSource(rulesDataSourceId);
  return { casesDataSourceId, rulesDataSourceId };
}

async function assertSevenCalibrationDataSource(dataSourceId) {
  const dataSource = await notionRequest(`/v1/data_sources/${dataSourceId}`, { method: 'GET' });
  const title = plainText(dataSource.title || []);
  if (!/(Seven|7AM|判斷|校準|規則|Judgment|Calibration|Rule|Case)/i.test(title)) {
    fail(`Refusing to write to non-calibration data source: ${title || dataSourceId}`);
  }
  return dataSource;
}

function judgmentRuleProperties() {
  return {
    'Rule Name': { title: {} },
    'Trigger Pattern': { rich_text: {} },
    'Preferred Judgment': { rich_text: {} },
    'Avoided Judgment': { rich_text: {} },
    Reason: { rich_text: {} },
    'Applies To': { multi_select: { options: ['AMCore', 'HOZO_AM', 'SEVEN_AM', 'future AM projects'].map((name) => ({ name })) } },
    Exceptions: { rich_text: {} },
    'Source Case Count': { number: { format: 'number' } },
    Status: { select: { options: ['Draft', 'Needs review', 'Active', 'Deprecated'].map((name) => ({ name })) } },
    'Checklist Placement': { select: { options: ['task start', 'before LINE send', 'before Notion write', 'before deployment', 'before marking done', 'none'].map((name) => ({ name })) } },
    'Last Verified': { date: {} },
  };
}

function judgmentCaseProperties({ rulesDataSourceId }) {
  const properties = {
    'Review ID': { title: {} },
    Project: { select: { options: ['HOZO_AM', 'SEVEN_AM'].map((name) => ({ name })) } },
    'Source Type': { select: { options: ['total-control task', 'report candidate', 'LINE message', 'meeting action', 'manual review'].map((name) => ({ name })) } },
    'Source URL': { url: {} },
    'Task Type': { select: { options: ['task', 'note', 'report signal', 'responsibility item', 'goal', 'deployment', 'data governance', 'unknown'].map((name) => ({ name })) } },
    'Assistant Judgment': { rich_text: {} },
    'Assistant Reason': { rich_text: {} },
    'Assistant Confidence': { select: { options: ['low', 'medium', 'high'].map((name) => ({ name })) } },
    'Controller Judgment': { rich_text: {} },
    'Controller Reason': { rich_text: {} },
    'Difference Type': { multi_select: { options: ['scope', 'priority', 'risk', 'data boundary', 'project assignment', 'task classification', 'verification', 'communication', 'deployment status'].map((name) => ({ name })) } },
    Severity: { select: { options: ['low', 'medium', 'high'].map((name) => ({ name })) } },
    'Case Status': { select: { options: ['New', 'Sent to LINE', 'Replied', 'Updated', 'Rule Extracted', 'Archived'].map((name) => ({ name })) } },
    'LINE Review Sent At': { date: {} },
    'Controller Replied At': { date: {} },
    'Reply Summary': { rich_text: {} },
    'Generalized Rule': { rich_text: {} },
    'Rule Link': { relation: { data_source_id: rulesDataSourceId, single_property: {} } },
    'Source Task Updated': { checkbox: {} },
    'Data Boundary Check': { checkbox: {} },
  };

  if (tasksDataSourceId) {
    properties['Source Task'] = { relation: { data_source_id: tasksDataSourceId, single_property: {} } };
  }
  return properties;
}

async function createDatabase({ parentPageId, title, dataSourceTitle, properties }) {
  return notionRequest('/v1/databases', {
    method: 'POST',
    body: {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      is_inline: false,
      initial_data_source: {
        title: [{ type: 'text', text: { content: dataSourceTitle } }],
        properties,
      },
    },
  });
}

async function queryAllPages(dataSourceId, body = {}) {
  const results = [];
  let startCursor = null;
  do {
    const response = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: body.page_size || 100,
        start_cursor: startCursor || undefined,
        filter: body.filter,
        sorts: body.sorts,
      },
    });
    results.push(...(response.results || []));
    startCursor = response.has_more ? response.next_cursor : null;
  } while (startCursor);
  return results;
}

async function createPage(dataSourceId, properties) {
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: compactProperties(properties),
    },
  });
}

async function updatePage(pageId, properties) {
  return notionRequest(`/v1/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties: compactProperties(properties) },
  });
}

async function pushLine(target, text) {
  const response = await fetch(pushUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'x-seven-control-key': controlApiKey,
    },
    body: JSON.stringify({ targetType: target.type, targetId: target.id, text }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${responseText}`);
  }
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
    throw new Error(`Notion API failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : {};
}

async function requireNotion() {
  if (!notionToken) fail('NOTION_TOKEN is not set.');
}

async function requireLinePush() {
  if (!controlApiKey) fail('SEVEN_CONTROL_API_KEY is not set.');
}

function updateEnvFile(pathname, values) {
  const existing = existsSync(pathname) ? readFileSync(pathname, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const keys = new Set(Object.keys(values));
  const output = [];
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && keys.has(match[1])) {
      output.push(`${match[1]}=${values[match[1]]}`);
      keys.delete(match[1]);
    } else if (line || output.length) {
      output.push(line);
    }
  }
  for (const key of keys) output.push(`${key}=${values[key]}`);
  writeFileSync(pathname, `${output.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');
}

function inferTaskType(task) {
  const text = `${task.title} ${task.summary}`;
  if (/Render|部署|production|deploy/i.test(text)) return 'deployment';
  if (/資料|Notion|LINE|權限|token|secret|database/i.test(text)) return 'data governance';
  if (/目標|完成標準|驗收|口述/.test(text)) return 'goal';
  if (/責任|負責人|權責/.test(text)) return 'responsibility item';
  return 'task';
}

function isClosedStatus(status) {
  return /完成|已完成|Done|Closed|取消|封存/i.test(String(status || ''));
}

function shortRuleName(rule) {
  return clampText(String(rule || '').replace(/\s+/g, ' ').trim(), 80) || 'Judgment rule';
}

function normalizedIncludes(value, targetName) {
  const left = normalizeSearchText(value);
  const right = normalizeSearchText(targetName);
  return left.includes(right) || right.includes(left);
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function formatDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function dataSourceIdFromDatabase(database) {
  return database.data_sources?.[0]?.id || database.data_sources?.[0]?.data_source_id || null;
}

function pageTitle(page, propertyName) {
  return plainText(page?.properties?.[propertyName]?.title || []);
}

function pageText(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return plainText(property?.title || property?.rich_text || []);
}

function pageSelect(page, propertyName) {
  return page?.properties?.[propertyName]?.select?.name || '';
}

function pageStatus(page, propertyName) {
  return page?.properties?.[propertyName]?.status?.name || '';
}

function relationIds(property) {
  return (property?.relation || []).map((item) => item.id).filter(Boolean);
}

function plainText(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function titleProperty(content) {
  return { title: [{ type: 'text', text: { content: clampText(content) } }] };
}

function richTextProperty(content) {
  return { rich_text: content ? [{ type: 'text', text: { content: clampText(content) } }] : [] };
}

function selectProperty(name) {
  return name ? { select: { name } } : undefined;
}

function multiSelectProperty(names) {
  return { multi_select: names.filter(Boolean).map((name) => ({ name })) };
}

function numberProperty(value) {
  return Number.isFinite(value) ? { number: value } : undefined;
}

function dateProperty(value) {
  return { date: { start: value instanceof Date ? value.toISOString() : new Date(value).toISOString() } };
}

function checkboxProperty(value) {
  return { checkbox: Boolean(value) };
}

function relationProperty(ids) {
  return { relation: ids.filter(Boolean).map((id) => ({ id })) };
}

function urlProperty(value) {
  return value ? { url: value } : undefined;
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function normalizeId(value) {
  return String(value || '').replace(/-/g, '').trim();
}

function clampText(value, limit = 1900) {
  return String(value || '').slice(0, limit);
}

function clampLineText(value) {
  return clampText(value, 4900);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function maskId(value) {
  const text = String(value || '');
  if (text.length <= 8) return '***';
  return `${text.slice(0, 2)}***${text.slice(-4)}`;
}

function requiredArg(name) {
  const value = String(args[name] || '').trim();
  if (!value) fail(`Missing --${name}.`);
  return value;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
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

function printSafeResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function printHelp() {
  console.log([
    'Usage:',
    '  npm run judgment:calibration -- create --write-env',
    '  npm run judgment:calibration -- find-target [--target-name "Seven 陳聖文"]',
    '  npm run judgment:calibration -- send-test [--target-name "Seven 陳聖文"]',
    '  npm run judgment:calibration -- send-next [--target-name "Seven 陳聖文"]',
    '  npm run judgment:calibration -- record-reply --review-id <id> --direction <direction> [--reason <reason>] [--rule <rule>]',
  ].join('\n'));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
