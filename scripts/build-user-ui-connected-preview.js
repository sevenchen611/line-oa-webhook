import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(args.projectRoot || args.project || process.cwd());
const projectName = args.name || 'AM Project';
const outputPath = path.resolve(args.output || path.join(projectRoot, 'docs', 'user-ui-connected-preview.html'));
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const projectPrefix = resolveProjectPrefix(projectRoot, projectName, args.prefix);
const userUiBasePath = normalizeUserUiBasePath(args.userUiBasePath || process.env.USER_UI_BASE_PATH || '');

loadEnvFile(path.join(projectRoot, '.env'));
loadEnvFile(path.resolve(projectRoot, '..', 'env.txt'));

const notionToken = process.env.NOTION_TOKEN;
if (!notionToken) {
  throw new Error('NOTION_TOKEN is required in the project .env to build a connected User UI preview.');
}
const lineChannelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || projectEnv('LINE_CHANNEL_ACCESS_TOKEN') || '';
const userUiMediaDir = path.join(path.dirname(outputPath), 'user-ui-media');

const dataSources = {
  projectMaster: projectEnv('PROJECTS_DATA_SOURCE_ID') || args.projectDataSourceId || '',
  tasks: projectEnv('TASKS_DATA_SOURCE_ID') || '',
  conversations: projectEnv('CONVERSATIONS_DATA_SOURCE_ID') || '',
  messages: projectEnv('MESSAGES_DATA_SOURCE_ID') || '',
  attachments: projectEnv('ATTACHMENTS_DATA_SOURCE_ID') || '',
  meetings: projectEnv('MEETINGS_DATA_SOURCE_ID') || '',
  progressReports: projectEnv('PROGRESS_REPORTS_DATA_SOURCE_ID') || '',
  dailyReportSnapshots: projectEnv('DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID') || '',
  judgmentRules: projectEnv('JUDGMENT_RULES_DATA_SOURCE_ID') || '',
  judgmentCases: projectEnv('JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID') || '',
  commands: projectEnv('CODEX_COMMANDS_DATA_SOURCE_ID') || '',
};

const envRows = buildUnifiedEnvironmentRows();

const schemas = {};
const data = {};

for (const [key, id] of Object.entries(dataSources)) {
  if (!id) {
    schemas[key] = { title: '(not configured)', id: '', url: '', properties: [] };
    data[key] = [];
    continue;
  }
  try {
    const schema = await notion(`/v1/data_sources/${id}`);
    schemas[key] = {
      id,
      title: plain(schema.title),
      url: `https://app.notion.com/p/${normalizeId(id)}`,
      properties: Object.entries(schema.properties || {}).map(([name, prop]) => `${name}:${prop.type}`),
    };
    data[key] = await queryPages(id, pageLimitFor(key));
  } catch (error) {
    schemas[key] = { title: `(error) ${id}`, id, url: '', properties: [error.message] };
    data[key] = [];
  }
}

const conversations = mapConversations(data.conversations);
const conversationById = new Map(conversations.map((item) => [item.id, item]));
const lineTargetNameById = buildLineTargetNameMap(conversations);
const messages = (await mapMessages(data.messages)).map((message) => {
  const conversation = message.conversationIds.map((id) => conversationById.get(id)).find(Boolean);
  return {
    ...message,
    conversationName: conversation?.name || '',
    conversationUrl: conversation?.url || '',
    conversationUiUrl: conversation?.uiUrl || '',
  };
});
const messageById = new Map(messages.map((item) => [item.id, item]));
const mappedJudgmentRules = mapJudgmentRules(data.judgmentRules);

const viewModel = {
  generatedAt: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
  projectName,
  projectKind: inferTaskJudgmentProjectKind(projectRoot, projectName),
  projectRoot,
  outputPath,
  controlApiBaseUrl: args.controlApiBaseUrl || projectEnv('PUBLIC_BASE_URL') || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000',
  envRows,
  schemas,
  projects: await mapProjects(data.projectMaster),
  tasks: excludeArchivedTasks(await mapTasks(data.tasks)),
  conversations,
  messages,
  attachments: mapAttachments(data.attachments, { conversationById, messageById }),
  meetings: await mapMeetings(data.meetings),
  progressReports: mapProgressReports(data.progressReports),
  dailyReportSnapshots: await mapDailyReportSnapshots(data.dailyReportSnapshots, { lineTargetNameById }),
  judgmentRules: mappedJudgmentRules,
  taskJudgmentRules: buildTaskJudgmentRules(projectRoot, projectName, mappedJudgmentRules),
  judgmentCases: mapJudgmentCases(data.judgmentCases),
  commands: mapCommands(data.commands),
};
viewModel.dataCounts = {
  projectMaster: viewModel.projects.length,
  tasks: viewModel.tasks.length,
  conversations: viewModel.conversations.length,
  messages: viewModel.messages.length,
  attachments: viewModel.attachments.length,
  meetings: viewModel.meetings.length,
  progressReports: viewModel.progressReports.length,
  dailyReportSnapshots: viewModel.dailyReportSnapshots.length,
  judgmentRules: viewModel.judgmentRules.length,
  judgmentCases: viewModel.judgmentCases.length,
  commands: viewModel.commands.length,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, renderHtml(viewModel), 'utf8');
for (const [index, project] of viewModel.projects.entries()) {
  const projectOutputPath = path.join(path.dirname(outputPath), `user-ui-project-${index}.html`);
  writeFileSync(projectOutputPath, renderProjectOnlyHtml(viewModel, project, index), 'utf8');
}
for (const [index, task] of viewModel.tasks.entries()) {
  const taskOutputPath = path.join(path.dirname(outputPath), `user-ui-task-${index}.html`);
  writeFileSync(taskOutputPath, renderTaskOnlyHtml(viewModel, task, index), 'utf8');
}
for (const [index, conversation] of viewModel.conversations.entries()) {
  const conversationOutputPath = path.join(path.dirname(outputPath), `user-ui-line-${index}.html`);
  writeFileSync(conversationOutputPath, renderConversationOnlyHtml(viewModel, conversation, index), 'utf8');
}
console.log(JSON.stringify({
  outputPath,
  generatedAt: viewModel.generatedAt,
  counts: {
    projects: viewModel.projects.length,
    tasks: viewModel.tasks.length,
    conversations: viewModel.conversations.length,
    messages: viewModel.messages.length,
    attachments: viewModel.attachments.length,
    meetings: viewModel.meetings.length,
    progressReports: viewModel.progressReports.length,
    dailyReportSnapshots: viewModel.dailyReportSnapshots.length,
    judgmentRules: viewModel.judgmentRules.length,
    judgmentCases: viewModel.judgmentCases.length,
    commands: viewModel.commands.length,
    envRows: viewModel.envRows.length,
  },
}, null, 2));

function parseArgs(items) {
  const out = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = items[index + 1] && !items[index + 1].startsWith('--') ? items[++index] : true;
  }
  return out;
}

function resolveProjectPrefix(root, name, explicitPrefix) {
  const value = String(explicitPrefix || '').trim().toUpperCase();
  if (['HOZO', 'SEVEN'].includes(value)) return value;
  const signature = `${root}\n${name}`;
  if (/HOZO|HOZO_AM|好住|寓好/i.test(signature)) return 'HOZO';
  if (/Seven|SevenAM|7AM/i.test(signature)) return 'SEVEN';
  return '';
}

function projectEnv(key) {
  const prefixes = projectPrefix
    ? [projectPrefix, projectPrefix === 'HOZO' ? 'SEVEN' : 'HOZO']
    : ['SEVEN', 'HOZO'];
  for (const prefix of prefixes) {
    const value = process.env[`${prefix}_${key}`];
    if (value) return value;
  }
  return '';
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

async function notion(pathname, { method = 'GET', body } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
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
    if (response.ok) return text ? JSON.parse(text) : {};
    lastError = new Error(`Notion ${response.status}: ${text.slice(0, 240)}`);
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    await sleep(500 * (attempt + 1));
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryPages(id, limit) {
  const pages = [];
  let cursor = null;
  do {
    const body = { page_size: Math.min(100, limit - pages.length), sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
    if (cursor) body.start_cursor = cursor;
    const result = await notion(`/v1/data_sources/${id}/query`, { method: 'POST', body });
    pages.push(...(result.results || []));
    cursor = result.has_more && pages.length < limit ? result.next_cursor : null;
  } while (cursor && pages.length < limit);
  return pages;
}

async function pageContentPreview(pageId) {
  try {
    const blocks = await listBlocks(pageId, 80);
    const lines = blocks.map(blockToLine).filter(Boolean);
    return lines.slice(0, 36);
  } catch (error) {
    return [`Unable to load page content: ${error.message}`];
  }
}

async function pageMediaFiles(pageId) {
  try {
    const blocks = await listBlocks(pageId, 80);
    return blocks.map(blockToMedia).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

async function listBlocks(blockId, limit) {
  const blocks = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ page_size: String(Math.min(100, limit - blocks.length)) });
    if (cursor) qs.set('start_cursor', cursor);
    const result = await notion(`/v1/blocks/${blockId}/children?${qs.toString()}`);
    blocks.push(...(result.results || []));
    cursor = result.has_more && blocks.length < limit ? result.next_cursor : null;
  } while (cursor && blocks.length < limit);
  return blocks;
}

function blockToMedia(block) {
  const data = block?.[block.type];
  if (!data) return null;
  if (!['image', 'file', 'pdf', 'video'].includes(block.type)) return null;
  const url = data.file?.url || data.external?.url || '';
  if (!url) return null;
  const caption = plain(data.caption || []);
  return {
    type: block.type,
    name: data.name || caption || block.type,
    url,
  };
}

function blockToLine(block) {
  const data = block?.[block.type];
  const text = plain(data?.rich_text || data?.caption || []);
  if (!text) return '';
  if (/heading_/.test(block.type)) return `## ${text}`;
  if (block.type === 'bulleted_list_item') return `- ${text}`;
  if (block.type === 'numbered_list_item') return `1. ${text}`;
  if (block.type === 'to_do') return `${data.checked ? '[x]' : '[ ]'} ${text}`;
  return text;
}

function shouldLoadPageMedia(type, content) {
  const text = `${type || ''} ${content || ''}`.toLowerCase();
  return /\b(image|file|pdf|video)\b|\"type\"\s*:\s*\"(image|file|video)\"/.test(text);
}

function extractLineMessageId(content) {
  const text = String(content || '');
  try {
    const parsed = JSON.parse(text);
    const id = parsed?.message?.id || parsed?.id || '';
    if (id) return String(id);
  } catch {
    // Fall through to lightweight extraction for truncated or embedded payloads.
  }
  return text.match(/"message"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/)?.[1]
    || text.match(/"LINE 訊息 ID"\s*:\s*"([^"]+)"/)?.[1]
    || text.match(/\[(?:image|file|video|audio)\]\s*([0-9]{10,})/i)?.[1]
    || extractLikelyLineMessageId(text)
    || '';
}

function extractLikelyLineMessageId(value) {
  return String(value || '').trim().match(/^[0-9]{10,}$/)?.[0] || '';
}

async function downloadLineMessageMedia(lineMessageId, type, nameHint = '') {
  if (!lineChannelAccessToken || !lineMessageId) return [];
  if (!/^(image|file|video|audio)$/i.test(String(type || ''))) return [];
  try {
    mkdirSync(userUiMediaDir, { recursive: true });
    const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(lineMessageId)}/content`, {
      headers: { Authorization: `Bearer ${lineChannelAccessToken}` },
    });
    if (!response.ok) return [];
    const contentType = response.headers.get('content-type') || '';
    const extension = mediaExtension(contentType, nameHint, type);
    const fileName = `${safeFileName(lineMessageId)}${extension}`;
    const absolutePath = path.join(userUiMediaDir, fileName);
    writeFileSync(absolutePath, Buffer.from(await response.arrayBuffer()));
    return [{
      type: contentType.startsWith('image/') ? 'image' : String(type || 'file'),
      name: nameHint || fileName,
      url: `user-ui-media/${fileName}`,
    }];
  } catch {
    return [];
  }
}

function mediaExtension(contentType, nameHint, type) {
  const fromName = String(nameHint || '').match(/\.(png|jpe?g|gif|webp|bmp|heic|pdf|xlsx?|docx?|pptx?|txt)(?:$|\s|\?)/i)?.[0]?.trim();
  if (fromName) return fromName.startsWith('.') ? fromName : `.${fromName}`;
  const lowerType = String(contentType || '').toLowerCase();
  if (lowerType.includes('jpeg')) return '.jpg';
  if (lowerType.includes('png')) return '.png';
  if (lowerType.includes('gif')) return '.gif';
  if (lowerType.includes('webp')) return '.webp';
  if (lowerType.includes('pdf')) return '.pdf';
  if (String(type || '').toLowerCase() === 'image') return '.jpg';
  return '.bin';
}

function safeFileName(value) {
  return String(value || 'media').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function plain(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function pageText(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property) return '';
  if (property.type === 'title') return plain(property.title);
  if (property.type === 'rich_text') return plain(property.rich_text);
  if (property.type === 'select') return property.select?.name || '';
  if (property.type === 'multi_select') return (property.multi_select || []).map((item) => item.name).join(', ');
  if (property.type === 'status') return property.status?.name || '';
  if (property.type === 'date') return property.date?.start || '';
  if (property.type === 'url') return property.url || '';
  if (property.type === 'number') return property.number === null || property.number === undefined ? '' : String(property.number);
  if (property.type === 'checkbox') return property.checkbox ? 'Yes' : 'No';
  if (property.type === 'created_time') return property.created_time || '';
  if (property.type === 'last_edited_time') return property.last_edited_time || '';
  if (property.type === 'files') return (property.files || []).map((file) => file.name || file.file?.url || file.external?.url || 'file').join(', ');
  if (property.type === 'relation') return `${property.relation?.length || 0} relation`;
  return '';
}

function pageFiles(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property || property.type !== 'files') return [];
  return (property.files || []).map((file) => ({
    name: file.name || 'file',
    url: file.file?.url || file.external?.url || '',
  })).filter((file) => file.name || file.url);
}

function relationIds(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property || property.type !== 'relation') return [];
  return (property.relation || []).map((item) => item.id).filter(Boolean);
}

function firstPageText(page, propertyNames) {
  for (const propertyName of propertyNames) {
    const value = pageText(page, propertyName);
    if (value) return value;
  }
  return '';
}

function pageTitle(page, fallback = 'Untitled') {
  const titleProperty = Object.keys(page?.properties || {}).find((key) => page.properties[key].type === 'title');
  return titleProperty ? pageText(page, titleProperty) || fallback : fallback;
}

function pageUrl(page) {
  return page?.url || '';
}

function normalizeId(value) {
  return String(value || '').replace(/-/g, '');
}

function isSensitiveKey(key) {
  return /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_TOKEN|CHANNEL_SECRET/i.test(key);
}

function buildUnifiedEnvironmentRows() {
  const existingKeys = Object.keys(process.env)
    .filter((key) => /^(SEVEN|HOZO|LINE|NOTION|CONTROL|DAILY|MORNING|FOLLOWUP|PORT|CRON|RENDER)/.test(key))
    .map(canonicalEnvironmentField);
  const fields = uniqueValues([...standardEnvironmentFields(), ...existingKeys]);
  return fields.map((field) => {
    const key = projectEnvironmentKey(field);
    const exists = key ? Object.prototype.hasOwnProperty.call(process.env, key) : false;
    const rawValue = exists ? String(process.env[key] || '') : '';
    const type = inferEnvType(key || field, rawValue);
    const required = isRequiredEnvironmentField(field);
    return {
      key: key || field,
      amField: field,
      value: exists ? (isSensitiveKey(key) ? '••••••••••••••••' : rawValue) : '',
      type,
      group: inferEnvGroup(key || field, rawValue),
      required,
      status: exists ? (rawValue ? '有值' : '空值') : '缺欄位',
    };
  }).sort(compareEnvRows);
}

function standardEnvironmentFields() {
  return [
    'PROJECT_USER_UI_USERNAME',
    'PROJECT_USER_UI_PASSWORD',
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CHANNEL_SECRET',
    'NOTION_TOKEN',
    'PROJECT_CONTROL_API_KEY',
    'PROJECT_REPORT_APPROVAL_KEY',
    'PROJECT_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID',
    'PROJECT_ATTACHMENTS_DATA_SOURCE_ID',
    'PROJECT_CODEX_COMMANDS_DATA_SOURCE_ID',
    'PROJECT_CONVERSATIONS_DATA_SOURCE_ID',
    'PROJECT_DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID',
    'PROJECT_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID',
    'PROJECT_JUDGMENT_RULES_DATA_SOURCE_ID',
    'PROJECT_LINE_GROUP_MEMBERS_DATA_SOURCE_ID',
    'PROJECT_LINE_GROUP_OPTIONS_DATA_SOURCE_ID',
    'PROJECT_MEETINGS_DATA_SOURCE_ID',
    'PROJECT_MESSAGES_DATA_SOURCE_ID',
    'PROJECT_PROGRESS_REPORTS_DATA_SOURCE_ID',
    'PROJECT_PROJECTS_DATA_SOURCE_ID',
    'PROJECT_RESPONSIBILITY_DATA_SOURCE_ID',
    'PROJECT_TASKS_DATA_SOURCE_ID',
    'NOTION_CONTAINER_PAGE_ID',
    'PROJECT_AUTOMATION_RUN_LOG_DATA_SOURCE_ID',
    'PROJECT_DATA_SOURCE_PARENT_BLOCK_ID',
    'PROJECT_DATA_SOURCE_PARENT_PAGE_ID',
    'PROJECT_RISK_DECISIONS_DATA_SOURCE_ID',
    'CONTROL_LINE_EVENTS_DATABASE_ID',
    'LINE_CHANNEL_ID',
    'CONTROL_LINE_PUSH_URL',
    'PROJECT_REPORT_TARGET_ID',
    'PROJECT_REPORT_TARGET_NAME_KEYWORD',
    'PROJECT_REPORT_TARGET_TYPE',
    'CRON_JOB_NAME',
    'DAILY_REPORT_URL',
    'FOLLOWUP_CONFIRMATION_URL',
    'MORNING_BRIEF_URL',
    'PROJECT_CRON_ALERTS_ENABLED',
    'PROJECT_REPORT_CC_NAME_KEYWORDS',
    'PROJECT_PUBLIC_BASE_URL',
    'CONTROL_API_URL',
    'PORT',
    'NOTION_VERSION',
    'PROJECT_JUDGMENT_REVIEW_TARGET_NAME_KEYWORD',
    'PROJECT_CODEX_COMMAND_TRIGGERS',
    'PROJECT_OUTGOING_ACTOR_NAME',
  ];
}

function requiredEnvironmentFields() {
  return new Set([
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CHANNEL_SECRET',
    'LINE_CHANNEL_ID',
    'NOTION_TOKEN',
    'NOTION_VERSION',
    'PORT',
    'PROJECT_PUBLIC_BASE_URL',
    'PROJECT_CONTROL_API_KEY',
    'PROJECT_CONVERSATIONS_DATA_SOURCE_ID',
    'PROJECT_MESSAGES_DATA_SOURCE_ID',
    'PROJECT_ATTACHMENTS_DATA_SOURCE_ID',
    'PROJECT_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID',
    'PROJECT_CODEX_COMMANDS_DATA_SOURCE_ID',
    'PROJECT_MEETINGS_DATA_SOURCE_ID',
    'PROJECT_TASKS_DATA_SOURCE_ID',
    'PROJECT_PROJECTS_DATA_SOURCE_ID',
    'PROJECT_PROGRESS_REPORTS_DATA_SOURCE_ID',
    'PROJECT_DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID',
    'PROJECT_RESPONSIBILITY_DATA_SOURCE_ID',
    'PROJECT_LINE_GROUP_OPTIONS_DATA_SOURCE_ID',
    'PROJECT_LINE_GROUP_MEMBERS_DATA_SOURCE_ID',
    'PROJECT_JUDGMENT_RULES_DATA_SOURCE_ID',
    'PROJECT_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID',
    'PROJECT_REPORT_TARGET_ID',
    'PROJECT_REPORT_TARGET_TYPE',
    'PROJECT_REPORT_TARGET_NAME_KEYWORD',
    'PROJECT_JUDGMENT_REVIEW_TARGET_NAME_KEYWORD',
    'PROJECT_USER_UI_USERNAME',
    'PROJECT_USER_UI_PASSWORD',
  ]);
}

function isRequiredEnvironmentField(field) {
  return requiredEnvironmentFields().has(field);
}

function canonicalEnvironmentField(key) {
  if (/^(SEVEN|HOZO)_(.+)$/.test(key)) {
    return `PROJECT_${key.replace(/^(SEVEN|HOZO)_/, '')}`;
  }
  return key;
}

function projectEnvironmentKey(field) {
  if (/^PROJECT_/.test(field) && projectPrefix) {
    return `${projectPrefix}_${field.replace(/^PROJECT_/, '')}`;
  }
  return field;
}

function inferEnvType(key, value) {
  if (/USER_UI_(USERNAME|PASSWORD)/.test(key)) return 'Credential';
  if (isSensitiveKey(key)) return 'Secret';
  if (/DATABASE/.test(key)) return 'Database ID';
  if (/DATA_SOURCE|NOTION.*PAGE|CONTAINER_PAGE|PARENT_(BLOCK|PAGE)/.test(key)) return 'Notion ID';
  if (/LINE/.test(key)) return 'LINE';
  if (/REPORT|MORNING|FOLLOWUP|DAILY|CRON/.test(key)) return 'Report';
  if (/URL/.test(key) || /^https?:\/\//.test(String(value || ''))) return 'URL';
  if (/PORT/.test(key)) return 'Runtime';
  return 'Config';
}

function inferEnvGroup(key, value) {
  if (/USER_UI_(USERNAME|PASSWORD)/.test(key)) return 'Credential';
  if (isSensitiveKey(key)) return 'Secret';
  if (/DATABASE/.test(key)) return 'Database ID';
  if (/DATA_SOURCE|NOTION/.test(key)) return 'Notion ID';
  if (/LINE/.test(key)) return 'LINE';
  if (/REPORT|MORNING|FOLLOWUP|DAILY|CRON/.test(key)) return 'Report';
  if (/URL/.test(key) || /^https?:\/\//.test(String(value || ''))) return 'URL';
  if (/PORT|RENDER/.test(key)) return 'Runtime';
  return 'Config';
}

function compareEnvRows(a, b) {
  const groupOrder = ['Credential', 'Secret', 'Notion ID', 'Database ID', 'LINE', 'Report', 'URL', 'Runtime', 'Config'];
  const aGroup = groupOrder.includes(a.group) ? groupOrder.indexOf(a.group) : 999;
  const bGroup = groupOrder.includes(b.group) ? groupOrder.indexOf(b.group) : 999;
  if (aGroup !== bGroup) return aGroup - bGroup;
  const aCredentialRank = envCredentialRank(a.key);
  const bCredentialRank = envCredentialRank(b.key);
  if (aCredentialRank !== bCredentialRank) return aCredentialRank - bCredentialRank;
  if (a.type !== b.type) return String(a.type).localeCompare(String(b.type), 'en');
  return String(a.key).localeCompare(String(b.key), 'en');
}

function envCredentialRank(key) {
  if (/USER_UI_USERNAME/.test(key)) return 0;
  if (/USER_UI_PASSWORD/.test(key)) return 1;
  return 99;
}

function pageLimitFor(key) {
  const limits = {
    projectMaster: 250,
    tasks: 600,
    conversations: 300,
    messages: 600,
    attachments: 250,
    meetings: 250,
    progressReports: 250,
    dailyReportSnapshots: 250,
    judgmentRules: 250,
    judgmentCases: 250,
    commands: 250,
  };
  return limits[key] || 100;
}

async function mapProjects(pages) {
  const mapped = [];
  for (const [index, page] of pages.entries()) {
    mapped.push({
      id: page.id,
      index,
      uiUrl: userUiPageHref(`user-ui-project-${index}.html`),
      name: pageText(page, '專案名稱') || pageTitle(page),
      status: pageText(page, '狀態') || pageText(page, '目前狀態') || 'Unknown',
      owner: pageText(page, '負責人') || '',
      goal: pageText(page, '目標') || pageText(page, '目前進度摘要') || '',
      next: pageText(page, '下一步') || '',
      summary: pageText(page, '目前進度摘要') || '',
      risk: pageText(page, '主要風險') || '',
      success: pageText(page, '成功條件') || '',
      lineUrl: pageText(page, '關聯 LINE 對話') || '',
      content: await pageContentPreview(page.id),
      url: pageUrl(page),
    });
  }
  return mapped;
}

async function mapTasks(pages) {
  const mapped = [];
  for (const [index, page] of pages.entries()) {
    mapped.push({
      id: page.id,
      index,
      name: pageText(page, '任務名稱') || pageTitle(page),
      status: pageText(page, '狀態') || 'Unknown',
      confirmation: pageText(page, '確認狀態') || '',
      project: pageText(page, '專案') || '',
      owner: pageText(page, '負責人') || '',
      next: pageText(page, '下一步') || '',
      source: pageText(page, '來源') || '',
      priority: firstPageText(page, ['優先順序', '優先級', 'Priority']) || '',
      confidence: firstPageText(page, ['信心分數', '判斷信心', 'Confidence']) || '',
      dueDate: firstPageText(page, ['截止日', '期限', 'Due Date', 'Deadline']) || '',
      deadlineBasis: firstPageText(page, ['期限依據', '截止日依據', 'Deadline Basis']) || '',
      nextFollowupDate: firstPageText(page, ['下次追蹤日', '下次追蹤日期', 'Next Follow-up Date']) || '',
      overdueStatus: firstPageText(page, ['逾期狀態', 'Deadline Status', 'Overdue Status']) || '',
      judgment: firstPageText(page, ['Codex 判斷摘要', '判斷摘要', 'AM 判斷摘要', '判斷原因']) || '',
      rawSource: firstPageText(page, ['來源原文', '原始內容', '線索訊息', '來源訊息']) || '',
      messageIds: relationIds(page, '訊息紀錄'),
      conversationIds: relationIds(page, '對話主檔'),
      updatedAt: firstPageText(page, ['最後更新', '最後更新時間', 'Last updated', 'Last Updated']) || pageText(page, '最後編輯時間') || page.last_edited_time || '',
      createdAt: firstPageText(page, ['建立時間', '建立日期', 'Created time', 'Created Time']) || page.created_time || '',
      content: await pageContentPreview(page.id),
      uiUrl: userUiPageHref(`user-ui-task-${index}.html`),
      notionUrl: pageUrl(page),
      url: pageUrl(page),
    });
  }
  return mapped;
}

function excludeArchivedTasks(tasks) {
  return tasks.filter((task) => !isArchivedTaskStatus(task.status));
}

function isArchivedTaskStatus(status) {
  return /封存|Archived/i.test(String(status || ''));
}

function mapConversations(pages) {
  return pages.map((page, index) => ({
    id: page.id,
    index,
    uiUrl: userUiPageHref(`user-ui-line-${index}.html`),
    name: pageText(page, '自定義名稱') || pageTitle(page),
    userId: pageText(page, 'User ID') || '',
    groupId: pageText(page, 'Group ID') || '',
    roomId: pageText(page, 'Room ID') || '',
    conversationKey: pageText(page, '對話統一鍵') || '',
    type: pageText(page, '對象類型') || '',
    project: pageText(page, '關聯專案') || pageText(page, '總控專案') || pageText(page, '專案') || '',
    status: pageText(page, '監控狀態') || '',
    latestAt: pageText(page, '最後訊息時間') || '',
    count: pageText(page, '訊息數（總）') || '',
    preview: pageText(page, '最新訊息預覽') || pageText(page, '備註') || '',
    url: pageUrl(page),
  }));
}

async function mapMessages(pages) {
  const mapped = [];
  for (const page of pages) {
    const type = pageText(page, '訊息類型') || '';
    const rawPayload = pageText(page, '原始 payload') || '';
    const content = pageText(page, '原始內容') || rawPayload || pageText(page, '文字內容') || pageTitle(page);
    const lineMessageId = pageText(page, 'LINE 訊息 ID')
      || extractLineMessageId(rawPayload)
      || extractLineMessageId(content)
      || extractLikelyLineMessageId(pageTitle(page));
    const pageMedia = shouldLoadPageMedia(type, content) ? await pageMediaFiles(page.id) : [];
    const lineMedia = pageMedia.length ? [] : await downloadLineMessageMedia(lineMessageId, type, pageText(page, '文字內容') || pageTitle(page));
    mapped.push({
      id: page.id,
      lineMessageId,
      conversationIds: relationIds(page, '對話主檔'),
      speaker: pageText(page, '發話者名稱') || pageText(page, '發話者類型') || '',
      speakerType: pageText(page, '發話者類型') || '',
      userId: pageText(page, '發話者 ID') || pageText(page, 'User ID') || '',
      type,
      source: pageText(page, '訊息來源') || '',
      sentAt: firstPageText(page, ['排序時間', '建立時間', '訊息時間', '最後更新時間']) || page.created_time || '',
      content,
      media: [...pageMedia, ...lineMedia],
      judged: pageText(page, '已進入判斷層') || '',
      related: pageText(page, '關聯總控事件') || '',
      url: pageUrl(page),
    });
  }
  return mapped;
}

function mapAttachments(pages, context = {}) {
  return pages.map((page) => ({
    id: page.id,
    name: pageText(page, '檔案名稱') || pageTitle(page),
    type: pageText(page, '附件類型') || pageText(page, 'Content-Type') || '',
    status: pageText(page, '轉檔狀態') || '',
    size: pageText(page, '檔案大小') || '',
    source: pageText(page, '來源連結') || '',
    files: pageText(page, '附件檔案') || '',
    fileLinks: pageFiles(page, '附件檔案'),
    project: pageText(page, '關聯專案') || '',
    conversionUrl: pageText(page, '關聯轉檔頁') || '',
    url: pageUrl(page),
    lineMessageId: pageText(page, 'LINE 訊息 ID') || '',
    messageIds: relationIds(page, '訊息紀錄'),
    conversationIds: relationIds(page, '對話主檔'),
  })).map((item) => {
    const message = item.messageIds.map((id) => context.messageById?.get(id)).find(Boolean);
    const conversation = item.conversationIds.map((id) => context.conversationById?.get(id)).find(Boolean)
      || message?.conversationIds?.map((id) => context.conversationById?.get(id)).find(Boolean);
    return {
      ...item,
      project: item.project || conversation?.project || '',
      conversationName: conversation?.name || '',
      conversationUrl: conversation?.url || '',
      speaker: message?.speaker || '',
      messageContent: message?.content || '',
      messageUrl: message?.url || '',
    };
  });
}

async function mapMeetings(pages) {
  const mapped = [];
  for (const [index, page] of pages.entries()) {
    mapped.push({
      id: page.id,
      index,
      name: pageText(page, '會議名稱') || pageTitle(page),
      date: pageText(page, '日期') || '',
      department: pageText(page, '部門') || '',
      category: pageText(page, '類別') || '',
      summary: pageText(page, '摘要') || pageText(page, '會議記錄') || '',
      content: await pageContentPreview(page.id),
      url: pageUrl(page),
    });
  }
  return mapped;
}

function mapProgressReports(pages) {
  return pages.map((page) => ({
    name: pageText(page, '報表名稱') || pageTitle(page),
    project: pageText(page, '專案') || '',
    status: pageText(page, '目前狀態') || '',
    progress: pageText(page, '完成度') || '',
    blocker: pageText(page, '主要卡點') || '',
    next: pageText(page, '下一步') || '',
    url: pageUrl(page),
  }));
}

async function mapDailyReportSnapshots(pages, context = {}) {
  return Promise.all(pages.map(async (page) => {
    const confirmationUrl = pageText(page, '確認紀錄連結') || '';
    return {
      name: pageText(page, '報告名稱') || pageTitle(page),
      date: pageText(page, '報告日期') || '',
      type: pageText(page, '報告類型') || '',
      status: pageText(page, '狀態') || '',
      reportUrl: pageText(page, '報告連結') || '',
      lineText: pageText(page, 'LINE訊息內容') || '',
      sentAt: pageText(page, '發送時間') || '',
      confirmedAt: pageText(page, '確認時間') || '',
      confirmationUrl,
      confirmationResult: await dailyReportConfirmationResult(page, confirmationUrl),
      cronJob: pageText(page, 'CronJob') || '',
      runId: pageText(page, 'RunID') || '',
      target: pageText(page, '目標') || '',
      targetDisplay: displayLineTarget(pageText(page, '目標') || '', context.lineTargetNameById),
      summary: pageText(page, '摘要') || '',
      url: pageUrl(page),
    };
  }));
}

function mapJudgmentRules(pages) {
  return pages.map((page) => ({
    name: pageText(page, 'Rule Name') || pageTitle(page),
    status: pageText(page, 'Status') || '',
    appliesTo: pageText(page, 'Applies To') || '',
    preferred: pageText(page, 'Preferred Judgment') || '',
    avoided: pageText(page, 'Avoided Judgment') || '',
    reason: pageText(page, 'Reason') || '',
    url: pageUrl(page),
  }));
}

function buildTaskJudgmentRules(projectRoot, projectName, learnedRules = []) {
  const projectKind = inferTaskJudgmentProjectKind(projectRoot, projectName);
  return [
    ...amCoreTaskJudgmentRules(),
    ...projectTaskJudgmentRules(projectKind),
    ...learnedRules.map((rule) => ({
      ...rule,
      source: '校準學習規則',
      scope: rule.appliesTo || projectKind,
      category: 'Project calibration',
    })),
  ];
}

function inferTaskJudgmentProjectKind(projectRoot, projectName) {
  const text = `${projectRoot || ''} ${projectName || ''}`.toUpperCase();
  if (text.includes('SEVEN')) return 'SEVEN_AM';
  if (text.includes('HOZO')) return 'HOZO_AM';
  return 'AMCore';
}

function amCoreTaskJudgmentRules() {
  return [
    {
      name: '以主題串判斷任務，不以單一訊息判斷',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Task extraction',
      status: 'Active',
      preferred: '先把同一 LINE 群組中的訊息依主題、回覆、時間連續性與明確換題切成主題串，再判斷是否成立任務。',
      avoided: '不要把每一則訊息直接轉成一筆任務。',
      reason: '真實任務的原因、答案、完成證據常常分散在同一段對話中。',
      url: '',
    },
    {
      name: '後續訊息能吸收時，更新既有任務',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Task reconciliation',
      status: 'Active',
      preferred: '如果後續訊息回答、補資料、確認移交、改負責人、顯示卡點或關閉迴圈，更新既有任務並保存證據。',
      avoided: '不要為同一件事新增重複任務。',
      reason: 'AM 是事件控制系統，不是訊息轉任務的堆疊表。',
      url: '',
    },
    {
      name: '只有真實行動或控制需求才成立任務',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Task extraction',
      status: 'Active',
      preferred: '任務需包含行動、追蹤、決策、未解問題、交付承諾、阻塞、責任人或完成檢查。',
      avoided: '不要把背景聊天、寒暄、純知識分享、測試文字、重複內容列為任務。',
      reason: '任務清單應該保留需要控制與推進的事項。',
      url: '',
    },
    {
      name: '助理操作指令不是現實任務',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Assistant command',
      status: 'Active',
      preferred: '查待辦、列出今天待辦、打開第幾個任務、開始校準、暫停校準等給 AM/Junior 的操作指令，只記錄為命令或來源訊息。',
      avoided: '不要建立總控任務，除非同一句同時包含外部承諾、交付、期限或具體現實行動。',
      reason: '操作系統的指令和現實世界待辦要分開。',
      url: '',
    },
    {
      name: '任務必須連回專案目標',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Project goal',
      status: 'Active',
      preferred: '每筆任務都應指向專案目標；若目標不明，標成候選或待釐清，而不是假裝已完整理解。',
      avoided: '不要只用文字猜測專案歸屬而忽略專案主檔。',
      reason: '任務存在的價值來自它服務的較大結果。',
      url: '',
    },
    {
      name: '會議 checkbox 是已確認任務',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Meeting intake',
      status: 'Active',
      preferred: '會議紀錄中的 checkbox/to-do 項目直接進入專案任務庫，來源為 meeting，確認狀態為已確認。',
      avoided: '不要再要求額外判斷它是不是任務。',
      reason: '會議紀錄已經用 checkbox 表示這是行動項目。',
      url: '',
    },
    {
      name: '狀態改變必須有來源證據',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Status tracking',
      status: 'Active',
      preferred: '完成、等待、進行中、卡住、改期、改負責人都要記錄來源訊息、會議或報告證據。',
      avoided: '不要因為沒有新討論就樂觀標成完成。',
      reason: '使用者需要能回頭稽核任務狀態為什麼改變。',
      url: '',
    },
    {
      name: '已確認報告時間以收到確認為準',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Daily report',
      status: 'Active',
      preferred: '每日報告或進度檢查報告若已收到使用者確認，User UI 的時間欄應顯示確認收到或回覆結果寫入的時間；尚未確認時才顯示報告發送時間。',
      avoided: '不要在已確認報告中仍只顯示原始發送時間，否則使用者會誤以為那是收到回覆的時間。',
      reason: '報告中心的時間應對應目前狀態：已確認代表回覆結果已回來，稽核時最重要的是確認發生時間。',
      url: '',
    },
    {
      name: '高風險事項需要人工確認',
      source: 'AMCore 共用規則',
      scope: 'AMCore',
      category: 'Risk',
      status: 'Active',
      preferred: '財務、契約、法律、人資、稅務、對外承諾等高風險事項可先標示進度，但最終關閉或外部動作要等專案負責人確認。',
      avoided: '不要自動結案或自動對外承諾。',
      reason: '這類事項錯誤成本高，需要人工把關。',
      url: '',
    },
  ];
}

function projectTaskJudgmentRules(projectKind) {
  if (projectKind === 'SEVEN_AM') {
    return [
      {
        name: 'Seven Junior 指令與音譯別名不是任務',
        source: 'SEVEN_AM 專案規則',
        scope: 'SEVEN_AM',
        category: 'Assistant command',
        status: 'Active',
        preferred: 'Seven Junior、7-Jr.、謝孟娟、謝夢娟等在 Seven Junior 對話中視為助理稱呼；查待辦或打開任務是操作指令。',
        avoided: '不要把稱呼誤判成人名，也不要建立現實任務。',
        reason: 'Seven Junior 的一對一或小群組對話常用這些稱呼操作系統。',
        url: '',
      },
      {
        name: '讀書會相關會議不進任務清單',
        source: 'SEVEN_AM 專案規則',
        scope: 'SEVEN_AM',
        category: 'Meeting intake',
        status: 'Active',
        preferred: '只要是讀書會相關會議產生的任務或待辦，不列入 SevenAM 總控任務清單。',
        avoided: '不要把讀書會討論、心得、導讀安排或相關會議項目轉成總控任務。',
        reason: 'SevenAM 總控任務庫目前只追蹤需要營運或私人事務控制的任務。',
        url: '',
      },
      {
        name: '正常回覆是完成證據，不是封存理由',
        source: 'SEVEN_AM 專案規則',
        scope: 'SEVEN_AM',
        category: 'Status tracking',
        status: 'Active',
        preferred: '若前段對話提出營運檢查，後續回覆正常、不需調整、已處理，應把既有任務推向完成或待確認完成。',
        avoided: '不要因為不需要再處理就封存。',
        reason: '這類對話是有意義的狀態紀錄，應保留完成證據。',
        url: '',
      },
      {
        name: '重複個人待辦要合併到主任務',
        source: 'SEVEN_AM 專案規則',
        scope: 'SEVEN_AM',
        category: 'Task reconciliation',
        status: 'Active',
        preferred: '例如報稅今天完成這類重複提醒，應合併到既有報稅主任務，並更新主任務優先級、下一步與提醒紀錄。',
        avoided: '不要另開多筆同一事件的稅務任務。',
        reason: '重要性要保留在主任務上，任務清單不能被重複提醒洗版。',
        url: '',
      },
    ];
  }
  if (projectKind === 'HOZO_AM') {
    return [
      {
        name: 'HOZO 只處理 HOZO 專案資料',
        source: 'HOZO_AM 專案規則',
        scope: 'HOZO_AM',
        category: 'Data boundary',
        status: 'Active',
        preferred: '任務來源限 HOZO 好住寓好範圍內的 LINE、會議、專案與任務資料。',
        avoided: '不要掃描、同步或引用 SevenAM、私人頁面或非 HOZO 專案資料。',
        reason: 'HOZO_AM 是獨立專案，資料邊界必須清楚。',
        url: '',
      },
      {
        name: 'HOZO LINE 訊息先對照既有任務',
        source: 'HOZO_AM 專案規則',
        scope: 'HOZO_AM',
        category: 'Task reconciliation',
        status: 'Active',
        preferred: '每則新 HOZO LINE 訊息先讀同群組上下文並搜尋 HOZO 總控任務庫；能吸收就更新既有任務。',
        avoided: '不要直接把單一訊息變成新任務。',
        reason: 'HOZO 的營運、工程、客服與後臺任務常在同一群組連續推進。',
        url: '',
      },
      {
        name: '直接通知負責人使用 HOZO 報告目標',
        source: 'HOZO_AM 專案規則',
        scope: 'HOZO_AM',
        category: 'Notification',
        status: 'Active',
        preferred: '需要直接通知主要負責人時，使用 HOZO_REPORT_TARGET_ID 對應的 HOZO 本地 LINE 目標。',
        avoided: '不要使用 SevenAM 的 LINE 目標或其他專案目標。',
        reason: '通知路徑也屬於專案資料邊界。',
        url: '',
      },
    ];
  }
  return [];
}

function mapJudgmentCases(pages) {
  return pages.map((page) => ({
    name: pageText(page, 'Review ID') || pageTitle(page),
    status: pageText(page, 'Case Status') || '',
    project: pageText(page, 'Project') || '',
    judgment: pageText(page, 'Controller Judgment') || '',
    reason: pageText(page, 'Controller Reason') || '',
    severity: pageText(page, 'Severity') || '',
    url: pageUrl(page),
  }));
}

function mapCommands(pages) {
  return pages.map((page) => ({
    name: pageText(page, 'Name') || pageTitle(page),
    status: pageText(page, 'Status') || pageText(page, '狀態') || '',
    command: pageText(page, 'Command') || pageText(page, '指令') || '',
    risk: pageText(page, 'Risk Level') || '',
    url: pageUrl(page),
  }));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function short(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function link(url, label) {
  if (!url) return escapeHtml(label || '');
  const isExternal = /^https?:\/\//i.test(String(url));
  const attrs = isExternal ? ' target="_blank" rel="noopener"' : '';
  return `<a href="${escapeHtml(url)}"${attrs}>${escapeHtml(label || url)}</a>`;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
    return match ? `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}` : String(value);
  }
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatDailyReportSnapshotTime(item) {
  const isConfirmed = /已確認|已決策|confirmed/i.test(String(item.status || ''));
  return formatDateTime((isConfirmed && item.confirmedAt) || item.sentAt || item.date);
}

function buildLineTargetNameMap(conversations) {
  const map = new Map();
  for (const conversation of conversations) {
    const name = conversation.name || conversation.conversationKey || '';
    for (const id of [conversation.userId, conversation.groupId, conversation.roomId]) {
      if (id && name) map.set(id, name);
    }
  }
  return map;
}

function displayLineTarget(value, lookup = new Map()) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (lookup.has(text)) return lookup.get(text);
  if (/^[UCR][0-9a-f]{20,}$/i.test(text)) return 'Seven 的主要訊息';
  return text;
}

async function dailyReportConfirmationResult(snapshotPage, confirmationUrl) {
  const directResult = firstPageText(snapshotPage, [
    '回覆結果',
    '確認結果',
    '使用者回覆',
    '回覆內容',
    '確認內容',
  ]);
  if (directResult) return summarizeConfirmationResult(directResult);

  const pageId = notionPageIdFromUrl(confirmationUrl);
  if (!pageId) return '';
  try {
    const page = await notion(`/v1/pages/${pageId}`);
    const pageResult = firstPageText(page, [
      '回覆結果',
      '確認結果',
      '使用者回覆',
      '回覆內容',
      '確認內容',
      '說明',
      '後續行動',
    ]);
    if (pageResult) return summarizeConfirmationResult(pageResult);

    const preview = await pageContentPreview(pageId);
    return summarizeConfirmationResult(preview.join('\n'));
  } catch {
    return '有確認紀錄，但目前無法讀取確認頁內容。';
  }
}

function notionPageIdFromUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/([0-9a-f]{32})(?:[?#/].*)?$/i);
  return match ? match[1] : '';
}

function summarizeConfirmationResult(value) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (!text) return '';

  const taskBlock = extractNamedBlock(text, '任務');
  const decisionBlock = extractNamedBlock(text, '決策');
  const followupBlock = extractNamedBlock(text, '追蹤訊息');
  const actionBlock = extractNamedBlock(text, '後續行動');

  const parts = [];
  if (decisionBlock && !/沒有額外決策/.test(decisionBlock)) parts.push(`決策：${decisionBlock}`);
  if (followupBlock && !/沒有追蹤訊息/.test(followupBlock)) parts.push(`追蹤：${followupBlock}`);
  if (taskBlock) parts.push(`任務更新：${taskBlock}`);
  if (actionBlock) parts.push(`後續：${actionBlock}`);

  return (parts.length ? parts.join(' / ') : text).replace(/\s+/g, ' ').trim();
}

function extractNamedBlock(text, label) {
  const pattern = new RegExp(`${escapeRegExp(label)}：\\n([\\s\\S]*?)(?=\\n\\S[^\\n]{0,16}：\\n|$)`);
  const match = text.match(pattern);
  return match ? match[1].trim() : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUserUiBasePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

function userUiPageHref(fileName, hash = '') {
  return userUiBasePath ? `${userUiBasePath}/${fileName}${hash}` : `${fileName}${hash}`;
}

function userUiHomeHref(hash = '') {
  return userUiBasePath ? `${userUiBasePath}${hash}` : `user-ui-connected-preview.html${hash}`;
}

function jsString(value) {
  return JSON.stringify(String(value || ''));
}

function statusClass(value) {
  if (/完成|Installed|Active|啟用|已確認/.test(value)) return 'ok';
  if (/等待|待確認|Ready|未開始|Paused/.test(value)) return 'wait';
  if (/封存|Blocked|退回|Error/.test(value)) return 'bad';
  return 'neutral';
}

function environmentStatusClass(value) {
  if (value === '有值') return 'ok';
  if (value === '空值') return 'wait';
  if (value === '缺欄位') return 'bad';
  return 'neutral';
}

function rows(items, columns) {
  if (!items.length) return '<tr><td colspan="8" class="muted">No records.</td></tr>';
  return items.map((item) => `<tr>${columns.map((column) => {
    const raw = typeof column.value === 'function' ? column.value(item) : item[column.value];
    return `<td>${column.html ? raw : escapeHtml(raw)}</td>`;
  }).join('')}</tr>`).join('');
}

function cards(items, renderer) {
  if (!items.length) return '<div class="empty">No records.</div>';
  return items.map(renderer).join('');
}

function taskJudgmentRuleGroups(items) {
  if (!items.length) return '<div class="empty">No task judgment rules.</div>';
  const groups = [];
  for (const item of items) {
    const source = item.source || '其他規則';
    let group = groups.find((entry) => entry.source === source);
    if (!group) {
      group = { source, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.map((group) => `
        <h3>${escapeHtml(group.source)}</h3>
        <table>
          <thead><tr><th>規則</th><th>應該怎麼判斷</th><th>避免</th><th>原因</th><th>範圍／類別／狀態</th></tr></thead>
          <tbody>${group.items.map((item) => `<tr>
            <td>${link(item.url, item.name)}</td>
            <td>${escapeHtml(item.preferred || '')}</td>
            <td>${escapeHtml(item.avoided || '')}</td>
            <td>${escapeHtml(item.reason || '')}</td>
            <td><div class="rule-meta"><span class="badge neutral">${escapeHtml(item.scope || item.appliesTo || 'Project')}</span>${item.category ? `<span class="badge neutral">${escapeHtml(item.category)}</span>` : ''}<span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'Rule')}</span></div></td>
          </tr>`).join('')}</tbody>
        </table>`).join('');
}

function manualTaskJudgmentRuleForm(model) {
  const projectKind = model.projectKind || 'AMCore';
  const scopeOptions = ['AMCore', 'SEVEN_AM', 'HOZO_AM', 'future AM projects']
    .map((value) => `<option value="${escapeHtml(value)}"${value === projectKind ? ' selected' : ''}>${escapeHtml(value)}</option>`)
    .join('');
  return `
        <div class="manual-rule-panel">
          <h3>手動加入任務判斷規則</h3>
          <form id="manualJudgmentRuleForm" class="manual-rule-form" data-default-applies-to="${escapeHtml(projectKind)}">
            <div class="manual-rule-grid">
              <label>規則名稱
                <input name="name" required placeholder="例如：停班停課回覆正常時標記完成">
              </label>
              <label>適用範圍
                <select name="appliesTo">${scopeOptions}</select>
              </label>
              <label>類別
                <select name="category">
                  <option value="Task extraction">Task extraction</option>
                  <option value="Task reconciliation">Task reconciliation</option>
                  <option value="Status update">Status update</option>
                  <option value="Assistant command">Assistant command</option>
                  <option value="Project goal">Project goal</option>
                  <option value="Meeting record">Meeting record</option>
                </select>
              </label>
              <label>狀態
                <select name="status">
                  <option value="Needs review">Needs review</option>
                  <option value="Active">Active</option>
                </select>
              </label>
            </div>
            <label>觸發條件
              <textarea name="triggerPattern" rows="2" placeholder="看到什麼訊息、情境或關鍵字時要套用這條規則"></textarea>
            </label>
            <label>應該怎麼判斷
              <textarea name="preferred" rows="3" required placeholder="請寫出正確處理方式"></textarea>
            </label>
            <label>避免
              <textarea name="avoided" rows="2" placeholder="請寫出不該怎麼判斷"></textarea>
            </label>
            <label>原因
              <textarea name="reason" rows="2" placeholder="為什麼這條規則成立"></textarea>
            </label>
            <div class="manual-rule-grid">
              <label>例外
                <textarea name="exceptions" rows="2" placeholder="哪些情況不適用"></textarea>
              </label>
              <label>檢查位置
                <select name="checklistPlacement">
                  <option value="Manual task judgment rules">Manual task judgment rules</option>
                  <option value="Hourly LINE reconciliation">Hourly LINE reconciliation</option>
                  <option value="Daily report review">Daily report review</option>
                  <option value="Meeting extraction">Meeting extraction</option>
                </select>
              </label>
            </div>
            <div class="manual-rule-actions">
              <button type="submit">儲存任務判斷規則</button>
              <span id="manualJudgmentRuleResult" class="manual-rule-result"></span>
            </div>
          </form>
        </div>`;
}

function renderSideNav(basePath = '') {
  const base = String(basePath || userUiHomeHref());
  return `<nav class="nav">
        <a href="${base}#overview" data-view="overview">檔案總覽</a>
        <a href="${base}#projects" data-view="projects">所有專案</a>
        <a href="${base}#tasks" data-view="tasks">所有任務</a>
        <a href="${base}#line" data-view="line">LINE 群組與訊息</a>
        <a href="${base}#attachments" data-view="attachments">附件與檔案</a>
        <a href="${base}#meetings" data-view="meetings">會議紀錄</a>
        <a href="${base}#reports" data-view="reports">每日報告中心</a>
        <a href="${base}#rules" data-view="rules">任務判斷規則</a>
        <a href="${base}#env" data-view="env">Environment data</a>
        <a href="${base}#databases" data-view="databases">Database map</a>
      </nav>`;
}

function renderHtml(model) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(model.projectName)} User UI Connected Preview</title>
  <style>
    :root { --bg:#f6f8fb; --panel:#fff; --ink:#17202a; --muted:#617080; --line:#d8dee8; --blue:#2563eb; --green:#12805c; --amber:#a15c00; --red:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--bg); font-family:"Segoe UI","Noto Sans TC",Arial,sans-serif; letter-spacing:0; }
    a { color:#1d4ed8; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .shell { display:grid; grid-template-columns:260px 1fr; min-height:100vh; }
    aside { background:#fff; border-right:1px solid var(--line); padding:22px 18px; position:sticky; top:0; height:100vh; overflow:auto; }
    main { padding:26px 30px 48px; min-width:0; }
    h1 { margin:0 0 6px; font-size:28px; }
    h2 { margin:0 0 10px; font-size:21px; }
    h3 { margin:0 0 8px; font-size:16px; }
    p { margin:0 0 10px; }
    .muted { color:var(--muted); }
    .brand { font-weight:850; margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--line); }
    .nav a { display:block; padding:9px 10px; border-radius:6px; color:#2f3a48; margin-bottom:4px; }
    .nav a:hover { background:#e8f0ff; text-decoration:none; }
    .nav a.active { background:#e8f0ff; color:#123e9c; font-weight:850; }
    .top { display:flex; justify-content:space-between; gap:18px; align-items:flex-start; margin-bottom:18px; }
    .badge { display:inline-flex; min-height:24px; align-items:center; padding:3px 8px; border:1px solid var(--line); border-radius:999px; background:#fff; font-size:12px; font-weight:800; white-space:nowrap; }
    .ok { color:var(--green); background:#e8f6ef; border-color:#b9d5c4; }
    .wait { color:var(--amber); background:#fff2d8; border-color:#f4d49d; }
    .bad { color:var(--red); background:#fff0ee; border-color:#f0c5bd; }
    .neutral { color:#334155; background:#f8fafc; }
    .grid { display:grid; grid-template-columns:repeat(4,minmax(160px,1fr)); gap:12px; margin-bottom:18px; }
    .metric,.section,.card { background:#fff; border:1px solid var(--line); border-radius:8px; }
    .metric { padding:14px; min-height:86px; }
    .metric .label { color:var(--muted); font-size:13px; font-weight:800; }
    .metric .value { font-size:24px; font-weight:850; margin-top:6px; }
    .section { padding:18px; margin:18px 0; }
    .cards { display:grid; grid-template-columns:repeat(3,minmax(220px,1fr)); gap:12px; }
    .card { padding:14px; }
    table { width:100%; border-collapse:collapse; background:#fff; }
    th,td { padding:10px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:14px; }
    th { background:#f9fbfd; color:#344253; font-size:13px; font-weight:850; }
    .mono { font-family:Consolas,"SFMono-Regular",Menlo,monospace; font-size:13px; word-break:break-all; }
    .empty { padding:20px; border:1px dashed var(--line); border-radius:8px; color:var(--muted); text-align:center; background:#fbfcfe; }
    .note { padding:12px 14px; border:1px solid #bdd4ff; border-left:5px solid var(--blue); border-radius:6px; background:#f1f6ff; color:#173d7a; margin:12px 0; }
    .hidden { display:none !important; }
    .view-panel.hidden { display:none !important; }
    .link-list { display:flex; flex-direction:column; gap:6px; }
    .task-toolbar { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start; justify-content:space-between; padding:12px; border:1px solid var(--line); border-radius:8px; background:#fbfcfe; margin:12px 0 16px; }
    .filter-group { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .filter-label { color:var(--muted); font-size:13px; font-weight:850; margin-right:2px; }
    .filter-button { min-height:32px; border:1px solid var(--line); border-radius:999px; background:#fff; color:#334155; padding:6px 10px; font-weight:800; font-size:13px; cursor:pointer; }
    .filter-button.ok.active { color:var(--green); background:#e8f6ef; border-color:#b9d5c4; }
    .filter-button.wait.active { color:var(--amber); background:#fff2d8; border-color:#f4d49d; }
    .filter-button.bad.active { color:var(--red); background:#fff0ee; border-color:#f0c5bd; }
    .filter-button.neutral.active { color:#334155; background:#f8fafc; border-color:var(--line); }
    .filter-button.off { opacity:.42; text-decoration:line-through; }
    .filter-button.ok.off { color:var(--green); background:#e8f6ef; border-color:#b9d5c4; }
    .filter-button.wait.off { color:var(--amber); background:#fff2d8; border-color:#f4d49d; }
    .filter-button.bad.off { color:var(--red); background:#fff0ee; border-color:#f0c5bd; }
    .filter-button.neutral.off { color:#334155; background:#f8fafc; border-color:var(--line); }
    .rule-meta { display:flex; flex-direction:column; align-items:flex-start; gap:6px; min-width:130px; }
    .task-group { margin-top:14px; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fff; }
    .task-group h3 { margin:0; padding:12px 14px; background:#f9fbfd; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .project-detail-panel.hidden { display:none !important; }
    .attachment-actions { display:grid; gap:7px; min-width:260px; }
    .attachment-actions input,.attachment-actions select { width:100%; min-height:32px; border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; font-size:13px; background:#fff; color:var(--ink); }
    .attachment-buttons { display:flex; flex-wrap:wrap; gap:6px; }
    .attachment-buttons button { min-height:30px; border:1px solid #1d4ed8; border-radius:6px; background:#2563eb; color:#fff; padding:5px 8px; font-weight:850; cursor:pointer; font-size:12px; }
    .attachment-buttons button.secondary { background:#fff; color:#1d4ed8; }
    .attachment-buttons button.danger { border-color:#b42318; background:#fff; color:#b42318; }
    .attachment-result { color:var(--muted); font-size:12px; min-height:16px; }
    .manual-rule-panel { margin-top:18px; padding:16px; border:1px solid var(--line); border-radius:8px; background:#fbfcfe; }
    .manual-rule-form { display:grid; gap:12px; }
    .manual-rule-grid { display:grid; grid-template-columns:repeat(2,minmax(220px,1fr)); gap:12px; }
    .manual-rule-form label { display:grid; gap:6px; color:#344253; font-weight:850; font-size:13px; }
    .manual-rule-form input,.manual-rule-form select,.manual-rule-form textarea { width:100%; min-height:36px; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font:inherit; font-size:14px; background:#fff; color:var(--ink); }
    .manual-rule-form textarea { resize:vertical; line-height:1.5; }
    .manual-rule-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .manual-rule-actions button { min-height:34px; border:1px solid #1d4ed8; border-radius:6px; background:#2563eb; color:#fff; padding:7px 12px; font-weight:850; cursor:pointer; }
    .manual-rule-result { color:var(--muted); font-size:13px; min-height:18px; }
    @media (max-width:980px) { .shell { grid-template-columns:1fr; } aside { position:static; height:auto; } .grid,.cards { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">AM User UI<br><span class="muted">${escapeHtml(model.projectName)}</span></div>
      ${renderSideNav('')}
    </aside>
    <main>
      <div class="top">
        <div>
          <h1>${escapeHtml(model.projectName)} User UI</h1>
          <p class="muted">Connected preview generated at ${escapeHtml(model.generatedAt)} from ${escapeHtml(model.projectRoot)}</p>
        </div>
        <span class="badge ok">Actual Notion data</span>
      </div>
      <div class="note">目前頁籤：<strong id="currentViewLabel">檔案總覽</strong>。請使用左側選單切換；每次只會顯示一個主要資料頁。</div>
      <div class="note">Secret values are masked. This preview is generated inside the project folder so AMCore does not store project data or tokens.</div>

      <section id="overview" class="grid view-panel">
        ${metric('Projects', model.projects.length)}
        ${metric('Tasks', model.tasks.length)}
        ${metric('LINE messages', model.messages.length)}
        ${metric('Meetings', model.meetings.length)}
      </section>

      <section id="projects" class="section view-panel hidden">
        <h2>所有專案</h2>
        <div class="cards">
          ${cards(model.projects, (item, index) => {
            const taskCount = tasksForProject(item, model.tasks).length;
            return `<article class="card">
            <h3>${link(item.uiUrl, item.name)}</h3>
            <p class="muted">${escapeHtml(short(item.goal || item.next, 160))}</p>
            <p><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'No status')}</span> ${item.owner ? `<span class="badge neutral">${escapeHtml(item.owner)}</span>` : ''} <span class="badge neutral">任務 ${taskCount}</span></p>
          </article>`;
          })}
        </div>
      </section>

      <section id="project-detail" class="section view-panel hidden">
        <p><a href="#projects" data-back-projects>← 回到所有專案</a></p>
        ${model.projects.map((item, index) => renderProjectDetailSection(item, index, model.tasks, model.conversations)).join('')}
      </section>

      <section id="tasks" class="section view-panel hidden">
        <h2>所有任務清單</h2>
        <div class="task-toolbar">
          <div class="filter-group" id="taskStatusFilters">
            <span class="filter-label">Status</span>
            ${taskStatusButtons(model.tasks)}
          </div>
          <div class="filter-group" id="taskModeFilters">
            <span class="filter-label">Project</span>
            <button class="filter-button active" type="button" data-task-mode="list">一般清單</button>
            <button class="filter-button" type="button" data-task-mode="project">By Project</button>
          </div>
        </div>
        <p id="taskFilterSummary" class="muted"></p>
        <table id="taskTable">
          <thead><tr><th>Task</th><th>Status</th><th>Project</th><th>Owner</th><th>Next step</th></tr></thead>
          <tbody>${taskTableRows(model.tasks)}</tbody>
        </table>
        <div id="taskProjectGroups" class="hidden">${taskProjectGroups(model.tasks)}</div>
      </section>

      <section id="line" class="section view-panel hidden">
        <h2>LINE 群組與最新訊息</h2>
        <div class="cards">
          ${cards(model.conversations, (item, index) => `<article class="card" id="line-conversation-${index}">
            <h3>${link(item.uiUrl, item.name || '(unnamed conversation)')}</h3>
            <p class="muted">${escapeHtml(short(item.preview, 130))}</p>
            <p>
              ${(item.project || '未綁定專案').split(',').map((projectName) => `<span class="badge ${item.project ? 'ok' : 'wait'}">Project: ${escapeHtml(projectName.trim())}</span>`).join(' ')}
              <span class="badge neutral">${escapeHtml(item.type || 'LINE')}</span>
              <span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'Status')}</span>
              <span class="badge neutral">${escapeHtml(item.count || '0')} messages</span>
            </p>
          </article>`)}
        </div>
        <h3>最新訊息</h3>
        <table>
          <thead><tr><th>Speaker</th><th>Type</th><th>Content</th><th>Judged</th><th>Link</th></tr></thead>
          <tbody>${rows(model.messages, [
            { value: 'speaker' },
            { value: 'type' },
            { value: (item) => short(item.content, 180) },
            { value: (item) => `<span class="badge ${item.judged === 'Yes' ? 'ok' : 'wait'}">${escapeHtml(item.judged || 'No')}</span>`, html: true },
            { value: (item) => link(item.url, 'Open'), html: true },
          ])}</tbody>
        </table>
      </section>

      <section id="attachments" class="section view-panel hidden">
        <h2>附件與檔案</h2>
        <p class="muted">可以直接開啟附件、調整關聯專案、改轉檔狀態、標記不保存，或先建立待轉檔請求。實際 OCR/PDF 文字抽取會等 worker 接上後執行。</p>
        <div class="attachment-actions" style="max-width:520px;margin:10px 0 14px;">
          <input id="attachmentApiBaseUrl" value="${escapeHtml(model.controlApiBaseUrl)}" placeholder="API Base URL">
          <div class="attachment-buttons">
            <button class="secondary" type="button" id="rememberAttachmentApiButton">記住 API 位置</button>
          </div>
          <div class="attachment-result" id="attachmentGlobalResult">若從 /user-ui 登入後使用，會自動使用目前網站位置。</div>
        </div>
        <table>
          <thead><tr><th>File</th><th>Project</th><th>LINE group</th><th>Sender</th><th>Message</th><th>Status</th><th>Source</th><th>Manage</th></tr></thead>
          <tbody>${attachmentTableRows(model.attachments)}</tbody>
        </table>
      </section>

      <section id="meetings" class="section view-panel hidden">
        <h2>會議紀錄</h2>
        <div class="cards">
          ${cards(model.meetings, (item) => `<article class="card">
            <h3>${link(item.url, item.name)}</h3>
            <p class="muted">${escapeHtml(short(item.summary, 160))}</p>
            <p><span class="badge neutral">${escapeHtml(item.date || 'No date')}</span> <span class="badge neutral">${escapeHtml(item.department || item.category || 'Meeting')}</span></p>
          </article>`)}
        </div>
      </section>

      <section id="reports" class="section view-panel hidden">
        <h2>每日報告中心</h2>
        <p class="muted">這裡只放每天固定節奏的報告：08:30 晨報、10:00 / 13:00 / 17:00 進度檢查、20:00 晚報。</p>
        <div class="cards">
          ${dailyReportCards(model)}
        </div>
        <h3>最近報告快照</h3>
        <table>
          <thead><tr><th>報告</th><th>時間</th><th>狀態</th><th>對象</th><th>回覆結果</th><th>摘要</th></tr></thead>
          <tbody>${dailyReportSnapshotRows(model.dailyReportSnapshots)}</tbody>
        </table>
      </section>

      <section id="rules" class="section view-panel hidden">
        <h2>任務判斷規則</h2>
        <p class="muted">這裡列出 AMCore 共用任務判斷規則，以及目前專案自己的補充規則。校準學到的規則會接在後面，方便使用者理解 AM 為什麼建立、合併、封存或更新任務。</p>
        ${taskJudgmentRuleGroups(model.taskJudgmentRules)}
        ${manualTaskJudgmentRuleForm(model)}
      </section>

      <section id="env" class="section view-panel hidden">
        <h2>Environment data</h2>
        <p class="muted">此表由 AMCore 統一 EnvironmentData 欄位模板產出。標示 <strong>**必填**</strong> 的欄位必須有值；Secret 仍會遮蔽。</p>
        <table>
          <thead><tr><th>Type</th><th>Required</th><th>AM field</th><th>Project key</th><th>Status</th><th>Value</th></tr></thead>
          <tbody>${rows(model.envRows, [
            { value: (item) => `<span class="badge ${item.type === 'Secret' ? 'wait' : 'neutral'}">${escapeHtml(item.type)}</span>`, html: true },
            { value: (item) => item.required ? '<strong>**必填**</strong>' : '選用', html: true },
            { value: (item) => `<span class="mono">${item.required ? '<strong>**' : ''}${escapeHtml(item.amField || item.key)}${item.required ? '**</strong>' : ''}</span>`, html: true },
            { value: (item) => `<span class="mono">${escapeHtml(item.key)}</span>`, html: true },
            { value: (item) => `<span class="badge ${environmentStatusClass(item.status)}">${escapeHtml(item.status)}</span>`, html: true },
            { value: (item) => `<span class="mono">${escapeHtml(short(item.value, 220))}</span>`, html: true },
          ])}</tbody>
        </table>
      </section>

      <section id="databases" class="section view-panel hidden">
        <h2>Database map</h2>
        <table>
          <thead><tr><th>Module</th><th>Data source</th><th>Rows loaded</th><th>Properties</th></tr></thead>
          <tbody>${rows(Object.entries(model.schemas).map(([key, schema]) => ({ key, ...schema, rows: model.dataCounts[key] || 0 })), [
            { value: 'key' },
            { value: (item) => item.url ? link(item.url, item.title || item.id) : escapeHtml(item.title || item.id), html: true },
            { value: 'rows' },
            { value: (item) => short((item.properties || []).join(', '), 220) },
          ])}</tbody>
        </table>
      </section>
    </main>
  </div>
  <script>
    const panels = Array.from(document.querySelectorAll('.view-panel'));
    const navLinks = Array.from(document.querySelectorAll('.nav [data-view]'));
    const storagePrefix = 'sevenam-user-ui:';
    let attachmentBasicAuth = sessionStorage.getItem(storagePrefix + 'basicAuth') || '';
    const viewLabels = {
      overview: '檔案總覽',
      projects: '所有專案',
      tasks: '所有任務',
      line: 'LINE 群組與訊息',
      attachments: '附件與檔案',
      meetings: '會議紀錄',
      reports: '每日報告中心',
      rules: '任務判斷規則',
      env: 'Environment data',
      databases: 'Database map',
      'project-detail': '專案詳細'
    };
    function viewForHash(hash) {
      if ((hash || '').startsWith('project-detail-')) return 'project-detail';
      if ((hash || '').startsWith('line-conversation-')) return 'line';
      return hash || 'overview';
    }
    function updateProjectDetail(hash) {
      const match = String(hash || '').match(/^project-detail-(\\d+)$/);
      const selected = match ? match[1] : '0';
      document.querySelectorAll('[data-project-detail-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.projectDetailPanel !== selected);
      });
    }
    function showView(view, options = {}) {
      const nextView = panels.some((panel) => panel.id === view) ? view : 'overview';
      panels.forEach((panel) => panel.classList.toggle('hidden', panel.id !== nextView));
      navLinks.forEach((link) => link.classList.toggle('active', link.dataset.view === nextView));
      document.getElementById('currentViewLabel').textContent = viewLabels[nextView] || nextView;
      if (!options.keepHash && location.hash !== '#' + nextView) history.replaceState(null, '', '#' + nextView);
    }
    function updateTaskFilters() {
      const activeStatuses = new Set(Array.from(document.querySelectorAll('[data-status-filter].active')).map((button) => button.dataset.statusFilter));
      const mode = document.querySelector('[data-task-mode].active')?.dataset.taskMode || 'list';
      let visibleCount = 0;
      document.querySelectorAll('[data-task-row]').forEach((row) => {
        const visible = activeStatuses.has(row.dataset.status);
        row.style.display = visible ? '' : 'none';
        if (visible) visibleCount += 1;
      });
      document.querySelectorAll('[data-task-card]').forEach((card) => {
        card.style.display = activeStatuses.has(card.dataset.status) ? '' : 'none';
      });
      document.querySelectorAll('[data-task-group]').forEach((group) => {
        const visibleCards = Array.from(group.querySelectorAll('[data-task-card]')).filter((card) => card.style.display !== 'none').length;
        group.style.display = visibleCards ? '' : 'none';
        const countNode = group.querySelector('[data-group-count]');
        if (countNode) countNode.textContent = visibleCards + ' tasks';
      });
      document.getElementById('taskTable').classList.toggle('hidden', mode !== 'list');
      document.getElementById('taskProjectGroups').classList.toggle('hidden', mode !== 'project');
      const summary = document.getElementById('taskFilterSummary');
      if (summary) summary.textContent = '目前顯示 ' + visibleCount + ' / ' + document.querySelectorAll('[data-task-row]').length + ' 筆任務。';
    }
    document.querySelectorAll('[data-status-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        button.classList.toggle('active');
        button.classList.toggle('off', !button.classList.contains('active'));
        updateTaskFilters();
      });
    });
    document.querySelectorAll('[data-task-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-task-mode]').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        updateTaskFilters();
      });
    });
    const attachmentApiInput = document.getElementById('attachmentApiBaseUrl');
    const savedAttachmentApiBase = localStorage.getItem(storagePrefix + 'apiBaseUrl');
    if (attachmentApiInput && location.protocol.startsWith('http') && location.pathname.startsWith('/user-ui')) {
      attachmentApiInput.value = location.origin;
    } else if (attachmentApiInput && savedAttachmentApiBase) {
      attachmentApiInput.value = savedAttachmentApiBase;
    }
    document.getElementById('rememberAttachmentApiButton')?.addEventListener('click', () => {
      const value = attachmentApiInput?.value.trim() || '';
      if (value) localStorage.setItem(storagePrefix + 'apiBaseUrl', value);
      const globalResult = document.getElementById('attachmentGlobalResult');
      if (globalResult) globalResult.textContent = value ? 'API 位置已記住在此瀏覽器。' : '請先填入 API Base URL。';
    });
    function currentApiBaseUrl() {
      if (location.protocol.startsWith('http') && location.pathname.startsWith('/user-ui')) return location.origin;
      const visibleInputValue = attachmentApiInput?.value.trim();
      if (visibleInputValue) return visibleInputValue.replace(/\\/+$/, '');
      return (localStorage.getItem(storagePrefix + 'apiBaseUrl') || ${jsString(model.controlApiBaseUrl)}).replace(/\\/+$/, '');
    }
    function getAttachmentAuthHeader() {
      if (attachmentBasicAuth) return 'Basic ' + attachmentBasicAuth;
      const username = window.prompt('請輸入 User UI username');
      if (!username) return '';
      const password = window.prompt('請輸入 User UI password');
      if (password === null) return '';
      attachmentBasicAuth = btoa(username + ':' + password);
      sessionStorage.setItem(storagePrefix + 'basicAuth', attachmentBasicAuth);
      return 'Basic ' + attachmentBasicAuth;
    }
    async function updateAttachment(control, action) {
      const apiBaseUrl = currentApiBaseUrl();
      const resultNode = control.querySelector('[data-attachment-result]');
      const pageId = control.dataset.attachmentId;
      const projects = control.querySelector('[data-attachment-projects]')?.value || '';
      const status = control.querySelector('[data-attachment-status]')?.value || '';
      const editNote = control.querySelector('[data-attachment-note]')?.value || '';
      if (!apiBaseUrl) {
        resultNode.textContent = '請先設定 API Base URL。';
        return;
      }
      if (action === 'archive' && !window.confirm('確定要把這個附件標記為不保存並封存嗎？')) {
        return;
      }
      const authHeader = getAttachmentAuthHeader();
      if (!authHeader) {
        resultNode.textContent = '尚未登入，無法儲存。';
        return;
      }
      resultNode.textContent = '正在處理...';
      control.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        const response = await fetch(apiBaseUrl + '/control/attachments/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          body: JSON.stringify({
            pageId,
            updates: {
              action,
              projects,
              status,
              editNote,
            },
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) {
          throw new Error(result.error || '操作失敗');
        }
        if (action === 'archive') {
          control.closest('tr')?.remove();
          return;
        }
        resultNode.textContent = action === 'convert'
          ? '已建立待轉檔請求。重新產生 User UI 後會看到轉檔頁連結。'
          : '已儲存到 Notion。重新產生 User UI 後會看到最新資料。';
      } catch (error) {
        if (/Unauthorized/i.test(error.message || '')) {
          attachmentBasicAuth = '';
          sessionStorage.removeItem(storagePrefix + 'basicAuth');
        }
        resultNode.textContent = '操作失敗：' + (error.message || error);
      } finally {
        control.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    }
    document.querySelectorAll('[data-attachment-action]').forEach((button) => {
      button.addEventListener('click', () => updateAttachment(button.closest('[data-attachment-id]'), button.dataset.attachmentAction));
    });
    document.getElementById('manualJudgmentRuleForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const resultNode = document.getElementById('manualJudgmentRuleResult');
      const apiBaseUrl = currentApiBaseUrl();
      if (!apiBaseUrl) {
        resultNode.textContent = '請先設定 API Base URL。';
        return;
      }
      const authHeader = getAttachmentAuthHeader();
      if (!authHeader) {
        resultNode.textContent = '尚未登入，無法儲存。';
        return;
      }
      const formData = new FormData(form);
      resultNode.textContent = '正在儲存...';
      form.querySelectorAll('button,input,select,textarea').forEach((node) => { node.disabled = true; });
      try {
        const response = await fetch(apiBaseUrl + '/control/judgment-rules/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          body: JSON.stringify(Object.fromEntries(formData.entries())),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) {
          throw new Error(result.error || '儲存失敗');
        }
        form.reset();
        if (form.dataset.defaultAppliesTo && form.elements.appliesTo) form.elements.appliesTo.value = form.dataset.defaultAppliesTo;
        resultNode.textContent = '已儲存。重新產生 User UI 後會出現在校準學習規則。';
      } catch (error) {
        if (/Unauthorized/i.test(error.message || '')) {
          attachmentBasicAuth = '';
          sessionStorage.removeItem(storagePrefix + 'basicAuth');
        }
        resultNode.textContent = '儲存失敗：' + (error.message || error);
      } finally {
        form.querySelectorAll('button,input,select,textarea').forEach((node) => { node.disabled = false; });
      }
    });
    navLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        showView(link.dataset.view);
      });
    });
    document.querySelectorAll('[data-project-detail-link]').forEach((link) => {
      link.addEventListener('click', () => {
        updateProjectDetail(link.getAttribute('href').slice(1));
        showView('project-detail', { keepHash: true });
        setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 0);
      });
    });
    window.addEventListener('hashchange', () => {
      const hash = location.hash.slice(1);
      if (hash.startsWith('project-detail-')) updateProjectDetail(hash);
      showView(viewForHash(hash), { keepHash: true });
      if (!hash.startsWith('project-detail-') && hash) document.getElementById(hash)?.scrollIntoView({ block: 'start' });
    });
    const initialHash = location.hash.slice(1);
    if (initialHash.startsWith('project-detail-')) updateProjectDetail(initialHash);
    else updateProjectDetail('project-detail-0');
    showView(viewForHash(initialHash), { keepHash: Boolean(initialHash) });
    if (initialHash && !initialHash.startsWith('project-detail-')) setTimeout(() => document.getElementById(initialHash)?.scrollIntoView({ block: 'start' }), 0);
    updateTaskFilters();
  </script>
</body>
</html>`;
}

function metric(label, value) {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function renderProjectOnlyHtml(model, project, index) {
  const projectTasks = tasksForProject(project, model.tasks);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.name)} - ${escapeHtml(model.projectName)} User UI</title>
  <style>
    :root { --bg:#f6f8fb; --panel:#fff; --ink:#17202a; --muted:#617080; --line:#d8dee8; --blue:#2563eb; --green:#12805c; --amber:#a15c00; --red:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--bg); font-family:"Segoe UI","Noto Sans TC",Arial,sans-serif; letter-spacing:0; }
    a { color:#1d4ed8; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .shell { display:grid; grid-template-columns:260px 1fr; min-height:100vh; }
    aside { background:#fff; border-right:1px solid var(--line); padding:22px 18px; position:sticky; top:0; height:100vh; overflow:auto; }
    main { padding:26px 30px 48px; min-width:0; }
    h1 { margin:0 0 6px; font-size:28px; }
    h2 { margin:22px 0 10px; font-size:21px; }
    h3 { margin:18px 0 8px; font-size:16px; }
    p { margin:0 0 10px; }
    .muted { color:var(--muted); }
    .brand { font-weight:850; margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--line); }
    .nav a { display:block; padding:9px 10px; border-radius:6px; color:#2f3a48; margin-bottom:4px; }
    .nav a:hover { background:#e8f0ff; text-decoration:none; }
    .badge { display:inline-flex; min-height:24px; align-items:center; padding:3px 8px; border:1px solid var(--line); border-radius:999px; background:#fff; font-size:12px; font-weight:800; white-space:nowrap; }
    .ok { color:var(--green); background:#e8f6ef; border-color:#b9d5c4; }
    .wait { color:var(--amber); background:#fff2d8; border-color:#f4d49d; }
    .bad { color:var(--red); background:#fff0ee; border-color:#f0c5bd; }
    .neutral { color:#334155; background:#f8fafc; }
    .section,.card { background:#fff; border:1px solid var(--line); border-radius:8px; }
    .section { padding:18px; margin:18px 0; }
    .card { padding:14px; }
    .edit-grid { display:grid; grid-template-columns:repeat(2,minmax(220px,1fr)); gap:12px; }
    .field { display:flex; flex-direction:column; gap:6px; }
    .field.full { grid-column:1 / -1; }
    label { color:#344253; font-size:13px; font-weight:850; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--ink); padding:9px 10px; font:inherit; font-size:14px; }
    textarea { min-height:86px; resize:vertical; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:14px; }
    button { min-height:36px; border:1px solid #1d4ed8; border-radius:6px; background:#2563eb; color:#fff; padding:8px 12px; font-weight:850; cursor:pointer; }
    button.secondary { background:#fff; color:#1d4ed8; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .save-status { color:var(--muted); font-size:13px; }
    .project-task-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:12px; border:1px solid var(--line); border-radius:8px; background:#fbfcfe; margin:12px 0 14px; }
    .filter-label { color:var(--muted); font-size:13px; font-weight:850; margin-right:2px; }
    .status-check { display:inline-flex; gap:6px; align-items:center; min-height:32px; cursor:pointer; user-select:none; }
    .status-check input { width:16px; min-height:16px; accent-color:#2563eb; cursor:pointer; }
    table { width:100%; border-collapse:collapse; background:#fff; }
    th,td { padding:10px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:14px; }
    th { background:#f9fbfd; color:#344253; font-size:13px; font-weight:850; width:140px; }
    .note { padding:12px 14px; border:1px solid #bdd4ff; border-left:5px solid var(--blue); border-radius:6px; background:#f1f6ff; color:#173d7a; margin:12px 0; }
    .link-list { display:flex; flex-direction:column; gap:6px; }
    @media (max-width:980px) { .shell { grid-template-columns:1fr; } aside { position:static; height:auto; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">AM User UI<br><span class="muted">${escapeHtml(model.projectName)}</span></div>
      ${renderSideNav()}
    </aside>
    <main>
      <p><a href="${escapeHtml(userUiHomeHref('#projects'))}" data-back-link>← 回到上一頁</a></p>
      <h1>${escapeHtml(project.name)}</h1>
      <p>
        <span class="badge ${statusClass(project.status)}">${escapeHtml(project.status || 'No status')}</span>
        ${project.owner ? `<span class="badge neutral">${escapeHtml(project.owner)}</span>` : ''}
      </p>
      <div class="note">這是單一專案頁。此頁只顯示「${escapeHtml(project.name)}」的資料，不顯示其他專案。</div>
      <section class="section">
        <h2>專案資訊</h2>
        <table>
          <tbody>
            <tr><th>目標</th><td>${escapeHtml(project.goal || '')}</td></tr>
            <tr><th>目前進度</th><td>${escapeHtml(project.summary || '')}</td></tr>
            <tr><th>下一步</th><td>${escapeHtml(project.next || '')}</td></tr>
            <tr><th>主要風險</th><td>${escapeHtml(project.risk || '')}</td></tr>
            <tr><th>成功條件</th><td>${escapeHtml(project.success || '')}</td></tr>
            <tr><th>LINE 對話</th><td>${renderProjectConversationLinks(project, model.conversations)}</td></tr>
          </tbody>
        </table>
      </section>
      <section class="section">
        <h2>Notion 頁面內容</h2>
        <div class="card">${project.content?.length ? project.content.map((line) => renderContentLine(line)).join('') : '<p class="muted">No page content loaded.</p>'}</div>
      </section>
      <section class="section">
        <h2>這個專案下面的任務</h2>
        <p class="muted">${escapeHtml(projectTasks.length ? `共 ${projectTasks.length} 筆任務。` : '目前沒有找到直接歸屬於這個專案的任務。')}</p>
        <div class="project-task-toolbar" id="projectTaskStatusFilters">
          <span class="filter-label">Status</span>
          ${projectTaskStatusCheckboxes(projectTasks)}
        </div>
        <p id="projectTaskFilterSummary" class="muted"></p>
        <table>
          <thead><tr><th>Task</th><th>Status</th><th>Owner</th><th>Next step</th></tr></thead>
          <tbody>${projectTaskRows(projectTasks)}</tbody>
        </table>
      </section>
    </main>
  </div>
  <script>
    function updateProjectTaskFilters() {
      const checkedStatuses = new Set(Array.from(document.querySelectorAll('[data-project-status-checkbox]:checked')).map((input) => input.dataset.projectStatusCheckbox));
      let visibleCount = 0;
      document.querySelectorAll('[data-project-task-row]').forEach((row) => {
        const visible = checkedStatuses.has(row.dataset.status);
        row.style.display = visible ? '' : 'none';
        if (visible) visibleCount += 1;
      });
      const summary = document.getElementById('projectTaskFilterSummary');
      if (summary) summary.textContent = '目前顯示 ' + visibleCount + ' / ' + document.querySelectorAll('[data-project-task-row]').length + ' 筆任務。';
    }
    document.querySelectorAll('[data-project-status-checkbox]').forEach((input) => {
      input.addEventListener('change', updateProjectTaskFilters);
    });
    updateProjectTaskFilters();
    document.querySelector('[data-back-link]')?.addEventListener('click', (event) => {
      if (window.history.length > 1) {
        event.preventDefault();
        window.history.back();
      }
    });
  </script>
</body>
</html>`;
}

function renderTaskOnlyHtml(model, task) {
  const project = projectForTask(model.projects, task);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(task.name)} - ${escapeHtml(model.projectName)} User UI</title>
  <style>
    :root { --bg:#f6f8fb; --panel:#fff; --ink:#17202a; --muted:#617080; --line:#d8dee8; --blue:#2563eb; --green:#12805c; --amber:#a15c00; --red:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--bg); font-family:"Segoe UI","Noto Sans TC",Arial,sans-serif; letter-spacing:0; }
    a { color:#1d4ed8; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .shell { display:grid; grid-template-columns:260px 1fr; min-height:100vh; }
    aside { background:#fff; border-right:1px solid var(--line); padding:22px 18px; position:sticky; top:0; height:100vh; overflow:auto; }
    main { padding:26px 30px 48px; min-width:0; }
    h1 { margin:0 0 6px; font-size:28px; }
    h2 { margin:22px 0 10px; font-size:21px; }
    h3 { margin:18px 0 8px; font-size:16px; }
    p { margin:0 0 10px; }
    .muted { color:var(--muted); }
    .brand { font-weight:850; margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--line); }
    .nav a { display:block; padding:9px 10px; border-radius:6px; color:#2f3a48; margin-bottom:4px; }
    .nav a:hover { background:#e8f0ff; text-decoration:none; }
    .badge { display:inline-flex; min-height:24px; align-items:center; padding:3px 8px; border:1px solid var(--line); border-radius:999px; background:#fff; font-size:12px; font-weight:800; white-space:nowrap; }
    .ok { color:var(--green); background:#e8f6ef; border-color:#b9d5c4; }
    .wait { color:var(--amber); background:#fff2d8; border-color:#f4d49d; }
    .bad { color:var(--red); background:#fff0ee; border-color:#f0c5bd; }
    .neutral { color:#334155; background:#f8fafc; }
    .section,.card { background:#fff; border:1px solid var(--line); border-radius:8px; }
    .section { padding:18px; margin:18px 0; }
    .card { padding:14px; }
    table { width:100%; border-collapse:collapse; background:#fff; }
    th,td { padding:10px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:14px; }
    th { background:#f9fbfd; color:#344253; font-size:13px; font-weight:850; width:150px; }
    .note { padding:12px 14px; border:1px solid #bdd4ff; border-left:5px solid var(--blue); border-radius:6px; background:#f1f6ff; color:#173d7a; margin:12px 0; }
    .preline { white-space:pre-wrap; }
    .message-media { display:flex; flex-wrap:wrap; gap:10px; margin:8px 0; }
    .message-media a { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; background:#f8fafc; }
    .message-media img { display:block; width:180px; max-width:100%; max-height:180px; object-fit:cover; }
    .message-file { padding:8px 10px; font-weight:800; }
    .line-archive-message { margin:0 0 14px; }
    .line-archive-head { color:#1d4ed8; font-weight:800; }
    .line-archive-head.assistant { color:#c2410c; }
    .line-archive-body { margin-top:6px; color:var(--ink); white-space:pre-wrap; }
    @media (max-width:980px) { .shell { grid-template-columns:1fr; } aside { position:static; height:auto; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">AM User UI<br><span class="muted">${escapeHtml(model.projectName)}</span></div>
      ${renderSideNav()}
    </aside>
    <main>
      <p><a href="${project ? escapeHtml(project.uiUrl) : escapeHtml(userUiHomeHref('#tasks'))}" data-back-link>← 回到上一頁</a></p>
      <h1>${escapeHtml(task.name)}</h1>
      <p>
        <span class="badge ${statusClass(task.status)}">${escapeHtml(task.status || 'No status')}</span>
        ${task.confirmation ? `<span class="badge neutral">${escapeHtml(task.confirmation)}</span>` : ''}
        ${task.owner ? `<span class="badge neutral">${escapeHtml(task.owner)}</span>` : ''}
      </p>
      <div class="note">這是單一任務頁。此頁只顯示「${escapeHtml(task.name)}」的資料，不顯示其他任務。</div>
      <section class="section">
        <h2>編輯任務</h2>
        <div class="note">儲存會透過 ${escapeHtml(model.projectName)} 後端寫回 Notion。請從 /user-ui 網址登入後使用；系統會記錄編輯者與編輯內容。</div>
        <form id="taskEditForm">
          <div class="edit-grid">
            <div class="field">
              <label for="apiBaseUrl">API Base URL</label>
              <input id="apiBaseUrl" name="apiBaseUrl" value="${escapeHtml(model.controlApiBaseUrl)}" autocomplete="url">
            </div>
            <div class="field">
              <label for="editedBy">編輯者</label>
              <input id="editedBy" name="editedBy" value="" placeholder="例如：Seven">
            </div>
            <div class="field">
              <label for="taskStatus">狀態</label>
              <select id="taskStatus" name="status">
                ${taskStatusSelectOptions(task.status)}
              </select>
            </div>
            <div class="field">
              <label for="taskConfirmation">確認狀態</label>
              <input id="taskConfirmation" name="confirmation" value="${escapeHtml(task.confirmation || '')}">
            </div>
            <div class="field">
              <label for="taskOwner">負責人</label>
              <input id="taskOwner" name="owner" value="${escapeHtml(task.owner || '')}">
            </div>
            <div class="field">
              <label for="taskPriority">優先順序</label>
              <input id="taskPriority" name="priority" value="${escapeHtml(task.priority || '')}">
            </div>
            <div class="field">
              <label for="taskDueDate">截止日</label>
              <input id="taskDueDate" name="dueDate" type="date" value="${escapeHtml(dateInputValue(task.dueDate))}">
            </div>
            <div class="field">
              <label for="taskNextFollowupDate">下次追蹤日</label>
              <input id="taskNextFollowupDate" name="nextFollowupDate" type="date" value="${escapeHtml(dateInputValue(task.nextFollowupDate))}">
            </div>
            <div class="field">
              <label for="taskOverdueStatus">逾期狀態</label>
              <select id="taskOverdueStatus" name="overdueStatus">
                ${deadlineStatusSelectOptions(task.overdueStatus)}
              </select>
            </div>
            <div class="field">
              <label for="taskDeadlineBasis">期限依據</label>
              <input id="taskDeadlineBasis" name="deadlineBasis" value="${escapeHtml(task.deadlineBasis || '')}">
            </div>
            <div class="field full">
              <label for="taskNext">下一步</label>
              <textarea id="taskNext" name="next">${escapeHtml(task.next || '')}</textarea>
            </div>
            <div class="field full">
              <label for="taskJudgment">Codex 判斷摘要</label>
              <textarea id="taskJudgment" name="judgment">${escapeHtml(task.judgment || '')}</textarea>
            </div>
            <div class="field full">
              <label for="taskEditNote">本次編輯備註</label>
              <textarea id="taskEditNote" name="editNote" placeholder="例如：由 User UI 手動確認狀態，下一步改為..."></textarea>
            </div>
            <div class="field full">
              <label for="taskPageContent">Notion 頁面內容更新</label>
              <textarea id="taskPageContent" name="pageContent" placeholder="在這裡填入要新增到 Notion 任務頁正文的內容。">${escapeHtml(normalizeTaskContentSourceReferences(task, model).join('\n'))}</textarea>
            </div>
          </div>
          <div class="actions">
            <button id="saveTaskButton" type="submit">儲存到 Notion</button>
            <button class="secondary" type="button" id="rememberApiButton">記住設定</button>
            <span id="saveStatus" class="save-status"></span>
          </div>
        </form>
      </section>
      <section class="section">
        <h2>任務資訊</h2>
        <table>
          <tbody>
            <tr><th>所屬專案</th><td>${project ? link(project.uiUrl, project.name) : escapeHtml(task.project || '')}</td></tr>
            <tr><th>負責人</th><td>${escapeHtml(task.owner || '')}</td></tr>
            <tr><th>確認狀態</th><td>${escapeHtml(task.confirmation || '')}</td></tr>
            <tr><th>來源</th><td>${escapeHtml(task.source || '')}</td></tr>
            <tr><th>優先順序</th><td>${escapeHtml(task.priority || '')}</td></tr>
            <tr><th>截止日</th><td>${escapeHtml(displayDateValue(task.dueDate) || '')}</td></tr>
            <tr><th>期限依據</th><td>${escapeHtml(task.deadlineBasis || '')}</td></tr>
            <tr><th>下次追蹤日</th><td>${escapeHtml(displayDateValue(task.nextFollowupDate) || '')}</td></tr>
            <tr><th>逾期狀態</th><td><span class="badge ${statusClass(task.overdueStatus)}">${escapeHtml(task.overdueStatus || '')}</span></td></tr>
            <tr><th>判斷信心</th><td>${escapeHtml(task.confidence || '')}</td></tr>
            <tr><th>下一步</th><td>${escapeHtml(task.next || '')}</td></tr>
          </tbody>
        </table>
      </section>
      <section class="section">
        <h2>AM 判斷</h2>
        <table>
          <tbody>
            <tr><th>Codex 判斷摘要</th><td class="preline">${escapeHtml(task.judgment || '')}</td></tr>
          </tbody>
        </table>
      </section>
      <section class="section">
        <h2>原始來源證據</h2>
        ${renderTaskEvidence(task, model)}
      </section>
      <section class="section">
        <h2>Notion 頁面內容（工作卷宗/摘要）</h2>
        <div class="card">${renderTaskContent(task, model)}</div>
      </section>
    </main>
  </div>
  <script>
    const taskPageId = ${jsString(task.id)};
    const backLink = document.querySelector('[data-back-link]');
    const storagePrefix = 'sevenam-user-ui:';
    const apiInput = document.getElementById('apiBaseUrl');
    const editorInput = document.getElementById('editedBy');
    const statusNode = document.getElementById('saveStatus');
    const saveButton = document.getElementById('saveTaskButton');
    const savedApiBase = localStorage.getItem(storagePrefix + 'apiBaseUrl');
    const savedEditor = localStorage.getItem(storagePrefix + 'editedBy');
    if (location.protocol.startsWith('http') && location.pathname.startsWith('/user-ui')) {
      apiInput.value = location.origin;
    }
    if (savedApiBase) apiInput.value = savedApiBase;
    if (savedEditor) editorInput.value = savedEditor;
    backLink?.addEventListener('click', (event) => {
      if (window.history.length > 1) {
        event.preventDefault();
        window.history.back();
      }
    });
    document.getElementById('rememberApiButton').addEventListener('click', () => {
      localStorage.setItem(storagePrefix + 'apiBaseUrl', apiInput.value.trim());
      localStorage.setItem(storagePrefix + 'editedBy', editorInput.value.trim());
      statusNode.textContent = '設定已記住在此瀏覽器。';
    });
    document.getElementById('taskEditForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const apiBaseUrl = apiInput.value.trim().replace(/\\/+$/, '');
      if (!apiBaseUrl) {
        statusNode.textContent = '請先填 API Base URL。';
        return;
      }
      const form = new FormData(event.currentTarget);
      const updates = Object.fromEntries(['status', 'confirmation', 'owner', 'priority', 'dueDate', 'deadlineBasis', 'nextFollowupDate', 'overdueStatus', 'next', 'judgment', 'editNote', 'pageContent', 'editedBy'].map((key) => [key, String(form.get(key) || '').trim()]));
      saveButton.disabled = true;
      statusNode.textContent = '正在儲存...';
      try {
        const response = await fetch(apiBaseUrl + '/control/tasks/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ pageId: taskPageId, updates }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) {
          throw new Error(result.error || '儲存失敗');
        }
        localStorage.setItem(storagePrefix + 'apiBaseUrl', apiBaseUrl);
        localStorage.setItem(storagePrefix + 'editedBy', updates.editedBy);
        statusNode.textContent = '已儲存到 Notion。重新產生 User UI 後會看到最新資料。';
      } catch (error) {
        statusNode.textContent = '儲存失敗：' + (error.message || error);
      } finally {
        saveButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function renderConversationOnlyHtml(model, conversation) {
  const conversationMessages = messagesForConversation(conversation, model.messages);
  const conversationAttachments = attachmentsForConversation(conversation, model.attachments);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(conversation.name)} - ${escapeHtml(model.projectName)} User UI</title>
  <style>
    :root { --bg:#f6f8fb; --panel:#fff; --ink:#17202a; --muted:#617080; --line:#d8dee8; --blue:#2563eb; --green:#12805c; --amber:#a15c00; --red:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--bg); font-family:"Segoe UI","Noto Sans TC",Arial,sans-serif; letter-spacing:0; }
    a { color:#1d4ed8; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .shell { display:grid; grid-template-columns:260px 1fr; min-height:100vh; }
    aside { background:#fff; border-right:1px solid var(--line); padding:22px 18px; position:sticky; top:0; height:100vh; overflow:auto; }
    main { padding:26px 30px 48px; min-width:0; }
    h1 { margin:0 0 6px; font-size:28px; }
    h2 { margin:22px 0 10px; font-size:21px; }
    p { margin:0 0 10px; }
    .muted { color:var(--muted); }
    .brand { font-weight:850; margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--line); }
    .nav a { display:block; padding:9px 10px; border-radius:6px; color:#2f3a48; margin-bottom:4px; }
    .nav a:hover { background:#e8f0ff; text-decoration:none; }
    .badge { display:inline-flex; min-height:24px; align-items:center; padding:3px 8px; border:1px solid var(--line); border-radius:999px; background:#fff; font-size:12px; font-weight:800; white-space:nowrap; }
    .ok { color:var(--green); background:#e8f6ef; border-color:#b9d5c4; }
    .wait { color:var(--amber); background:#fff2d8; border-color:#f4d49d; }
    .bad { color:var(--red); background:#fff0ee; border-color:#f0c5bd; }
    .neutral { color:#334155; background:#f8fafc; }
    .section,.card { background:#fff; border:1px solid var(--line); border-radius:8px; }
    .section { padding:18px; margin:18px 0; }
    table { width:100%; border-collapse:collapse; background:#fff; }
    th,td { padding:10px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:14px; }
    th { background:#f9fbfd; color:#344253; font-size:13px; font-weight:850; }
    .preline { white-space:pre-wrap; }
    .message-media { display:flex; flex-wrap:wrap; gap:10px; margin:8px 0; }
    .message-media a { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; background:#f8fafc; }
    .message-media img { display:block; width:180px; max-width:100%; max-height:180px; object-fit:cover; }
    .message-file { padding:8px 10px; font-weight:800; }
    .line-archive-message { margin:0 0 14px; }
    .line-archive-head { color:#1d4ed8; font-weight:800; }
    .line-archive-head.assistant { color:#c2410c; }
    .line-archive-body { margin-top:6px; color:var(--ink); white-space:pre-wrap; }
    @media (max-width:980px) { .shell { grid-template-columns:1fr; } aside { position:static; height:auto; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">AM User UI<br><span class="muted">${escapeHtml(model.projectName)}</span></div>
      ${renderSideNav()}
    </aside>
    <main>
      <p><a href="${escapeHtml(userUiHomeHref('#line'))}" data-back-link>← 回到上一頁</a></p>
      <h1>${escapeHtml(conversation.name || '(unnamed conversation)')}</h1>
      <p>
        ${(conversation.project || '未綁定專案').split(',').map((projectName) => `<span class="badge ${conversation.project ? 'ok' : 'wait'}">Project: ${escapeHtml(projectName.trim())}</span>`).join(' ')}
        <span class="badge neutral">${escapeHtml(conversation.type || 'LINE')}</span>
        <span class="badge ${statusClass(conversation.status)}">${escapeHtml(conversation.status || 'Status')}</span>
        <span class="badge neutral">${escapeHtml(conversation.count || String(conversationMessages.length))} messages</span>
      </p>
      <section class="section">
        <h2>群組資訊</h2>
        <table>
          <tbody>
            <tr><th>最新訊息預覽</th><td>${escapeHtml(conversation.preview || '')}</td></tr>
            <tr><th>最後訊息時間</th><td>${escapeHtml(conversation.latestAt || '')}</td></tr>
            <tr><th>訊息數</th><td>${escapeHtml(conversation.count || String(conversationMessages.length))}</td></tr>
          </tbody>
        </table>
      </section>
      <section class="section">
        <h2>對話訊息</h2>
        <p class="muted">共 ${conversationMessages.length} 筆訊息。</p>
        <table>
          <thead><tr><th>Speaker</th><th>Type</th><th>Content</th><th>Judged</th></tr></thead>
          <tbody>${rows(conversationMessages, [
            { value: 'speaker' },
            { value: 'type' },
            { value: (item) => renderLineConversationMessage(item, attachmentsForMessage(item, conversationAttachments)), html: true },
            { value: (item) => `<span class="badge ${item.judged === 'Yes' ? 'ok' : 'wait'}">${escapeHtml(item.judged || 'No')}</span>`, html: true },
          ])}</tbody>
        </table>
      </section>
      <section class="section">
        <h2>附件與檔案</h2>
        <p class="muted">${escapeHtml(conversationAttachments.length ? `共 ${conversationAttachments.length} 個附件。` : '目前沒有找到這個群組的附件。')}</p>
        <table>
          <thead><tr><th>File</th><th>Sender</th><th>Message</th><th>Status</th></tr></thead>
          <tbody>${rows(conversationAttachments, [
            { value: (item) => link(item.url, item.name), html: true },
            { value: 'speaker' },
            { value: (item) => short(item.messageContent, 140) },
            { value: (item) => `<span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || '')}</span>`, html: true },
          ])}</tbody>
        </table>
      </section>
    </main>
  </div>
  <script>
    document.querySelector('[data-back-link]')?.addEventListener('click', (event) => {
      if (window.history.length > 1) {
        event.preventDefault();
        window.history.back();
      }
    });
  </script>
</body>
</html>`;
}

function taskStatusButtons(tasks) {
  const statuses = sortStatuses(uniqueValues(tasks.map((task) => task.status || 'No status')));
  return statuses.map((status) => {
    const count = tasks.filter((task) => (task.status || 'No status') === status).length;
    return `<button class="filter-button ${statusClass(status)} active" type="button" data-status-filter="${escapeHtml(status)}">${escapeHtml(statusLabel(status))} (${count})</button>`;
  }).join('');
}

function taskStatusSelectOptions(currentStatus) {
  const statuses = ['待確認', '未開始', '進行中', '等待回覆', '待確認完成', '已完成', '封存'];
  const current = currentStatus || '待確認';
  return statuses.map((status) => `<option value="${escapeHtml(status)}"${status === current ? ' selected' : ''}>${escapeHtml(status)}</option>`).join('');
}

function deadlineStatusSelectOptions(currentStatus) {
  const statuses = ['需補期限', '未逾期', '今天到期', '已逾期', '已完成'];
  const current = currentStatus || '需補期限';
  return statuses.map((status) => `<option value="${escapeHtml(status)}"${status === current ? ' selected' : ''}>${escapeHtml(status)}</option>`).join('');
}

function dateInputValue(value) {
  const text = String(value || '').trim();
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function displayDateValue(value) {
  return dateInputValue(value) || String(value || '').trim();
}

function sortStatuses(statuses) {
  const order = ['未開始', '待確認', '待確認完成', '等待回覆', '待回覆', '進行中', '已完成', '封存'];
  return [...statuses].sort((a, b) => {
    const aIndex = order.includes(a) ? order.indexOf(a) : 999;
    const bIndex = order.includes(b) ? order.indexOf(b) : 999;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return String(a).localeCompare(String(b), 'zh-Hant');
  });
}

function statusLabel(status) {
  return status === '等待回覆' ? '待回覆' : status;
}

function taskTableRows(tasks) {
  if (!tasks.length) return '<tr><td colspan="5" class="muted">No records.</td></tr>';
  return sortTasksByRecentActivity(tasks).map((item) => `
    <tr data-task-row data-status="${escapeHtml(item.status || 'No status')}" data-project="${escapeHtml(item.project || 'No project')}">
      <td>${link(item.uiUrl, item.name)}</td>
      <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'No status')}</span></td>
      <td>${escapeHtml(item.project || 'No project')}</td>
      <td>${escapeHtml(item.owner || '')}</td>
      <td>${escapeHtml(short(item.next, 140))}</td>
    </tr>
  `).join('');
}

function projectTaskStatusCheckboxes(tasks) {
  if (!tasks.length) return '<span class="muted">No status.</span>';
  const statuses = sortStatuses(uniqueValues(tasks.map((task) => task.status || 'No status')));
  return statuses.map((status) => {
    const count = tasks.filter((task) => (task.status || 'No status') === status).length;
    return `<label class="status-check">
      <input type="checkbox" checked data-project-status-checkbox="${escapeHtml(status)}">
      <span class="badge ${statusClass(status)}">${escapeHtml(statusLabel(status))} (${count})</span>
    </label>`;
  }).join('');
}

function projectTaskRows(tasks) {
  if (!tasks.length) return '<tr><td colspan="4" class="muted">No records.</td></tr>';
  return sortTasksByRecentActivity(tasks).map((item) => `
    <tr data-project-task-row data-status="${escapeHtml(item.status || 'No status')}">
      <td>${link(item.uiUrl, item.name)}</td>
      <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'No status')}</span></td>
      <td>${escapeHtml(item.owner || '')}</td>
      <td>${escapeHtml(short(item.next, 150))}</td>
    </tr>
  `).join('');
}

function sortTasksByRecentActivity(tasks) {
  return [...tasks].sort((a, b) => {
    const timeDiff = taskActivityTimestamp(b) - taskActivityTimestamp(a);
    if (timeDiff !== 0) return timeDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant');
  });
}

function taskActivityTimestamp(task) {
  const value = task.updatedAt || task.createdAt || '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function attachmentTableRows(attachments) {
  if (!attachments.length) return '<tr><td colspan="8" class="muted">No records.</td></tr>';
  return attachments.map((item) => {
    const fileUrl = item.fileLinks?.[0]?.url || item.source || item.url;
    const sourceLinks = [
      item.source ? link(item.source, 'Source') : '',
      item.conversionUrl ? link(item.conversionUrl, '轉檔頁') : '',
      item.url ? link(item.url, '附件紀錄') : '',
    ].filter(Boolean).join('<br>');
    return `
    <tr data-attachment-row="${escapeHtml(item.id)}">
      <td>
        ${link(fileUrl, item.name || 'Open file')}
        <div class="muted">${escapeHtml(short(item.type || item.files || '', 70))}</div>
      </td>
      <td>${attachmentProjectBadges(item.project)}</td>
      <td>${item.conversationUrl ? link(item.conversationUrl, item.conversationName || 'Open group') : escapeHtml(item.conversationName || '未連結對話')}</td>
      <td>${escapeHtml(item.speaker || '')}</td>
      <td>${item.messageUrl ? link(item.messageUrl, short(item.messageContent, 90) || 'Open message') : escapeHtml(short(item.messageContent, 90))}</td>
      <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'No status')}</span></td>
      <td>${sourceLinks || escapeHtml(short(item.files, 80))}</td>
      <td>${renderAttachmentActions(item)}</td>
    </tr>`;
  }).join('');
}

function attachmentProjectBadges(projectValue) {
  const projects = String(projectValue || '').split(',').map((projectName) => projectName.trim()).filter(Boolean);
  if (!projects.length) return '<span class="badge wait">未綁定專案</span>';
  return projects.map((projectName) => `<span class="badge ok">${escapeHtml(projectName)}</span>`).join(' ');
}

function renderAttachmentActions(item) {
  return `<div class="attachment-actions" data-attachment-id="${escapeHtml(item.id)}">
    <input data-attachment-projects value="${escapeHtml(item.project || '')}" placeholder="關聯專案，多個用逗號分隔">
    <select data-attachment-status>
      ${attachmentStatusSelectOptions(item.status)}
    </select>
    <input data-attachment-note value="" placeholder="本次操作備註">
    <div class="attachment-buttons">
      <button type="button" data-attachment-action="save">儲存</button>
      <button class="secondary" type="button" data-attachment-action="convert">轉檔</button>
      <button class="danger" type="button" data-attachment-action="archive">不保存</button>
    </div>
    <div class="attachment-result" data-attachment-result></div>
  </div>`;
}

function attachmentStatusSelectOptions(currentStatus) {
  const statuses = ['待轉檔', '轉檔中', '已完成', '失敗', '不需轉檔'];
  const current = currentStatus || '待轉檔';
  return statuses.map((status) => `<option value="${escapeHtml(status)}"${status === current ? ' selected' : ''}>${escapeHtml(status)}</option>`).join('');
}

function taskProjectGroups(tasks) {
  if (!tasks.length) return '<div class="empty">No records.</div>';
  return uniqueValues(tasks.map((task) => task.project || 'No project')).map((project) => {
    const projectTasks = sortTasksByRecentActivity(tasks.filter((task) => (task.project || 'No project') === project));
    return `<section class="task-group" data-task-group="${escapeHtml(project)}">
      <h3>${escapeHtml(project)} <span class="badge neutral" data-group-count>${projectTasks.length} tasks</span></h3>
      <table>
        <thead><tr><th>Task</th><th>Status</th><th>Owner</th><th>Next step</th></tr></thead>
        <tbody>${projectTasks.map((item) => `
          <tr data-task-card data-status="${escapeHtml(item.status || 'No status')}">
            <td>${link(item.uiUrl, item.name)}</td>
            <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'No status')}</span></td>
            <td>${escapeHtml(item.owner || '')}</td>
            <td>${escapeHtml(short(item.next, 140))}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    </section>`;
  }).join('');
}

function dailyReportCards(model) {
  const baseUrl = String(model.controlApiBaseUrl || '').replace(/\/+$/, '');
  const slots = [
    {
      time: '08:30',
      title: '晨報',
      type: '早報',
      reportType: 'morning',
      purpose: '整理今天的行程、昨日未完成事項、今日優先任務與需要先提醒的風險。',
      href: `${baseUrl}/reports/morning-brief`,
    },
    {
      time: '10:00',
      title: '進度檢查報告',
      type: '追蹤確認',
      reportType: 'followup-morning',
      purpose: '檢查上午第一段進度，確認是否有新任務、狀態變更、等待回覆或需要補資料。',
      href: `${baseUrl}/reports/followup-confirmation?slot=10`,
    },
    {
      time: '13:00',
      title: '進度檢查報告',
      type: '追蹤確認',
      reportType: 'followup-midday',
      purpose: '午間整理上午處理結果，確認下午要推進的任務與需要追蹤的對象。',
      href: `${baseUrl}/reports/followup-confirmation?slot=13`,
    },
    {
      time: '17:00',
      title: '進度檢查報告',
      type: '追蹤確認',
      reportType: 'followup-afternoon',
      purpose: '下班前檢查當日任務進度，收斂未完成事項、待確認事項與明日銜接。',
      href: `${baseUrl}/reports/followup-confirmation?slot=17`,
    },
    {
      time: '20:00',
      title: '晚報',
      type: '每日總控總確認',
      reportType: 'daily',
      purpose: '整理全天總控狀態，確認已完成、待追蹤、需封存、需明日接續的任務與專案。',
      href: `${baseUrl}/reports/daily-control-report`,
    },
  ];

  return slots.map((slot) => {
    const snapshot = latestDailyReportSnapshot(model.dailyReportSnapshots, slot);
    const reportLink = snapshot?.reportUrl || slot.href;
    return `<article class="card">
      <h3>${escapeHtml(slot.time)} ${escapeHtml(slot.title)}</h3>
      <p class="muted">${escapeHtml(slot.purpose)}</p>
      <p>
        <span class="badge neutral">${escapeHtml(slot.reportType)}</span>
        <span class="badge ${statusClass(snapshot?.status || '未產生')}">${escapeHtml(snapshot?.status || '未產生')}</span>
      </p>
      <p>${link(reportLink, 'Open report')}</p>
      ${snapshot ? `<p class="muted">${escapeHtml(short(snapshot.summary || snapshot.lineText || snapshot.name, 140))}</p>` : '<p class="muted">尚未找到此時段的最新快照。</p>'}
    </article>`;
  }).join('');
}

function latestDailyReportSnapshot(snapshots, slot) {
  const matched = snapshots.filter((snapshot) => {
    const haystack = `${snapshot.type} ${snapshot.name} ${snapshot.cronJob} ${snapshot.lineText}`.toLowerCase();
    if (slot.reportType === 'morning') return /早報|morning/.test(haystack);
    if (slot.reportType === 'daily') return /每日總控|每日報告|晚報|daily|evening|night/.test(haystack);
    if (slot.reportType === 'followup-morning') return /10:00|10：00|slot=10|followup-morning|followup-10/.test(haystack);
    if (slot.reportType === 'followup-midday') return /13:00|13：00|slot=13|followup-midday|followup-13/.test(haystack);
    if (slot.reportType === 'followup-afternoon') return /17:00|17：00|slot=17|followup-afternoon|followup-17/.test(haystack);
    return false;
  });
  return matched.sort((a, b) => String(b.sentAt || b.date || '').localeCompare(String(a.sentAt || a.date || '')))[0] || null;
}

function dailyReportSnapshotRows(snapshots) {
  if (!snapshots.length) return '<tr><td colspan="6" class="muted">目前尚未載入每日報告快照。</td></tr>';
  return rows(snapshots.slice(0, 20), [
    { value: (item) => link(item.confirmationUrl || item.reportUrl || item.url, item.name), html: true },
    { value: (item) => formatDailyReportSnapshotTime(item) },
    { value: (item) => `<span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'No status')}</span>`, html: true },
    { value: (item) => short(item.targetDisplay || item.target, 80) },
    { value: (item) => short(item.confirmationResult || '尚未收到確認回覆', 180) },
    { value: (item) => short(item.summary || item.lineText, 140) },
  ]);
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

function renderProjectDetailSection(project, index, taskItems, conversationItems = []) {
  const projectTasks = tasksForProject(project, taskItems);
  return `<section id="project-detail-${index}" class="project-detail-panel hidden" data-project-detail-panel="${index}">
    <h2>${escapeHtml(project.name)}</h2>
    <p>
      <span class="badge ${statusClass(project.status)}">${escapeHtml(project.status || 'No status')}</span>
      ${project.owner ? `<span class="badge neutral">${escapeHtml(project.owner)}</span>` : ''}
    </p>
    <table>
      <tbody>
        <tr><th>目標</th><td>${escapeHtml(project.goal || '')}</td></tr>
        <tr><th>目前進度</th><td>${escapeHtml(project.summary || '')}</td></tr>
        <tr><th>下一步</th><td>${escapeHtml(project.next || '')}</td></tr>
        <tr><th>主要風險</th><td>${escapeHtml(project.risk || '')}</td></tr>
        <tr><th>成功條件</th><td>${escapeHtml(project.success || '')}</td></tr>
        <tr><th>LINE 對話</th><td>${renderProjectConversationLinks(project, conversationItems)}</td></tr>
      </tbody>
    </table>
    <h3>Notion 頁面內容</h3>
    <div class="card">
      ${project.content?.length ? project.content.map((line) => renderContentLine(line)).join('') : '<p class="muted">No page content loaded.</p>'}
    </div>
    <h3>這個專案下面的任務</h3>
    <p class="muted">${escapeHtml(projectTasks.length ? `共 ${projectTasks.length} 筆任務。` : '目前沒有找到直接歸屬於這個專案的任務。')}</p>
    <table>
      <thead><tr><th>Task</th><th>Status</th><th>Owner</th><th>Next step</th></tr></thead>
      <tbody>${rows(projectTasks, [
        { value: (item) => link(item.uiUrl, item.name), html: true },
        { value: (item) => `<span class="badge ${statusClass(item.status)}">${escapeHtml(item.status)}</span>`, html: true },
        { value: 'owner' },
        { value: (item) => short(item.next, 150) },
      ])}</tbody>
    </table>
  </section>`;
}

function renderTaskEvidence(task, model) {
  const rawSource = String(task.rawSource || '').trim();
  const taskText = [rawSource, task.source, task.judgment, ...(task.content || [])].filter(Boolean).join('\n');
  const messageMap = new Map(model.messages.map((message) => [normalizeId(message.id), message]));
  for (const message of model.messages) {
    if (message.url) messageMap.set(normalizeId(message.url), message);
    if (message.lineMessageId) messageMap.set(normalizeId(message.lineMessageId), message);
  }
  const ids = [
    ...extractNotionPageIds(taskText),
    ...(task.messageIds || []),
  ];
  const matchedMessages = ids.map((id) => messageMap.get(normalizeId(id))).filter(Boolean);
  const matchedConversations = findEvidenceConversations(task, taskText, model);
  const expandedMessages = expandEvidenceMessages(taskText, matchedMessages, model.messages, matchedConversations);
  const seen = new Set();
  const uniqueMessages = expandedMessages.filter((message) => {
    const key = message.id || message.url || message.lineMessageId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const meetingEvidence = renderMeetingEvidence(task, taskText, model);
  const attachmentEvidence = renderAttachmentEvidence(taskText, model);
  if (!uniqueMessages.length && !rawSource && !meetingEvidence && !attachmentEvidence) return '<p class="muted">目前沒有可驗證的原始來源證據。若任務內文只有摘要，請補上 LINE 訊息、會議記錄或附件引用。</p>';
  const cards = uniqueMessages.map((message) => renderEvidenceMessageCard(message, model.attachments)).join('');
  const remainingRaw = renderRemainingRawEvidence(rawSource, uniqueMessages, model);
  return `<div class="evidence-list">${cards}${meetingEvidence}${attachmentEvidence}${remainingRaw}</div>`;
}

function extractNotionPageIds(text) {
  const ids = [];
  for (const match of String(text || '').matchAll(/https:\/\/app\.notion\.com\/p\/([A-Za-z0-9_-]+)/g)) {
    ids.push(match[1]);
  }
  return ids;
}

function expandEvidenceMessages(rawSource, matchedMessages, allMessages, matchedConversations = []) {
  const messages = [...matchedMessages];
  const raw = normalizeEvidenceText(rawSource);
  const conversationIds = new Set([
    ...matchedMessages.flatMap((message) => message.conversationIds || []),
    ...matchedConversations.map((conversation) => conversation.id),
  ].filter(Boolean));
  const dateTokens = extractDateTokens(rawSource);
  for (const message of allMessages) {
    if (conversationIds.size && !(message.conversationIds || []).some((id) => conversationIds.has(id))) continue;
    const content = normalizeEvidenceText(message.content);
    if (content && raw.includes(content.slice(0, Math.min(40, content.length)))) messages.push(message);
    if (message.lineMessageId && raw.includes(message.lineMessageId)) messages.push(message);
    if (conversationIds.size && messageMatchesEvidenceText(message, raw, dateTokens)) messages.push(message);
  }
  return sortMessagesByTime(messages);
}

function findEvidenceConversations(task, taskText, model) {
  const matches = [];
  const text = normalizeName(taskText);
  const ids = new Set((task.conversationIds || []).map(normalizeId));
  for (const conversation of model.conversations || []) {
    const idMatch = ids.has(normalizeId(conversation.id));
    const name = normalizeName(conversation.name);
    const nameMatch = name && text.includes(name);
    const urlMatch = conversation.url && taskText.includes(conversation.url);
    if (idMatch || nameMatch || urlMatch) matches.push(conversation);
  }
  return matches;
}

function messageMatchesEvidenceText(message, raw, dateTokens) {
  const content = normalizeEvidenceText(message.content);
  if (!content) return false;
  if (content.length >= 6 && raw.includes(content.slice(0, Math.min(24, content.length)))) return true;
  const messageDate = messageDateToken(message.sentAt);
  if (messageDate && dateTokens.has(messageDate)) {
    const speaker = normalizeEvidenceText(message.speaker);
    if (speaker && raw.includes(speaker)) return true;
    const keywords = evidenceKeywords(content);
    if (keywords.some((word) => raw.includes(word))) return true;
  }
  return false;
}

function extractDateTokens(text) {
  const tokens = new Set();
  for (const match of String(text || '').matchAll(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/g)) {
    tokens.add(match[0].replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1'));
  }
  return tokens;
}

function messageDateToken(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(date);
}

function evidenceKeywords(text) {
  return String(text || '')
    .replace(/[，。！？、；：「」『』（）()【】\s]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4)
    .slice(0, 16);
}

function sortMessagesByTime(messages) {
  return [...messages].sort((a, b) => {
    const diff = messageTimestamp(a) - messageTimestamp(b);
    if (diff !== 0) return diff;
    return String(a.lineMessageId || a.id).localeCompare(String(b.lineMessageId || b.id));
  });
}

function messageTimestamp(message) {
  const timestamp = Date.parse(message.sentAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeEvidenceText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function renderEvidenceMessageCard(message, attachments) {
  const messageAttachments = attachmentsForMessage(message, attachments);
  const sourceLink = message.url ? link(message.url, '開啟 Notion 訊息') : '';
  return `<article class="line-evidence-item">
    ${renderLineConversationMessage(message, messageAttachments)}
    ${sourceLink ? `<p class="muted">${sourceLink}</p>` : ''}
  </article>`;
}

function renderRemainingRawEvidence(rawSource, messages, model) {
  const raw = String(rawSource || '').trim();
  if (!raw) return '';
  const matchedUrls = new Set(messages.map((message) => message.url).filter(Boolean));
  const cleaned = raw.split(/\r?\n/).map((line) => {
    const text = line.trim();
    if (!text) return '';
    if (Array.from(matchedUrls).some((url) => text.includes(url))) return '';
    return formatRawEvidenceLine(text, messages, model);
  }).filter(Boolean).join('\n').trim();
  if (!cleaned) return '';
  return `<article class="evidence-card">
    <div class="evidence-meta"><span class="badge neutral">來源摘要補充</span></div>
    <div class="preline">${escapeHtml(cleaned)}</div>
  </article>`;
}

function renderMeetingEvidence(task, taskText, model) {
  const meetings = findEvidenceMeetings(taskText, model);
  if (!meetings.length) return '';
  return meetings.map((meeting) => `<article class="evidence-card">
    <div class="evidence-meta"><span class="badge neutral">會議記錄</span>${meeting.date ? `<span class="badge neutral">${escapeHtml(displayDateValue(meeting.date) || meeting.date)}</span>` : ''}</div>
    <h3>${escapeHtml(meeting.name || '會議記錄')}</h3>
    ${meeting.summary ? `<p class="preline">${escapeHtml(meeting.summary)}</p>` : ''}
    ${meeting.content?.length ? `<div class="preline">${escapeHtml(meeting.content.slice(0, 12).join('\n'))}</div>` : ''}
    ${meeting.url ? `<p class="muted">${link(meeting.url, '開啟會議記錄')}</p>` : ''}
  </article>`).join('');
}

function findEvidenceMeetings(taskText, model) {
  const text = normalizeName(taskText);
  const pageIds = new Set(extractNotionPageIds(taskText).map(normalizeId));
  return (model.meetings || []).filter((meeting) => {
    const name = normalizeName(meeting.name);
    if (name && text.includes(name)) return true;
    if (meeting.url && taskText.includes(meeting.url)) return true;
    return pageIds.has(normalizeId(meeting.id));
  }).slice(0, 6);
}

function renderAttachmentEvidence(taskText, model) {
  const attachments = findEvidenceAttachments(taskText, model);
  if (!attachments.length) return '';
  return attachments.map((attachment) => {
    const links = [
      ...(attachment.fileLinks || []).map((file) => link(file.url, file.name || attachment.name)),
      attachment.source ? link(attachment.source, attachment.name || '附件來源') : '',
      attachment.url ? link(attachment.url, '開啟附件紀錄') : '',
    ].filter(Boolean).join('　');
    return `<article class="evidence-card">
      <div class="evidence-meta"><span class="badge neutral">附件/檔案</span>${attachment.conversationName ? `<span class="badge neutral">${escapeHtml(attachment.conversationName)}</span>` : ''}</div>
      <h3>${escapeHtml(attachment.name || '附件')}</h3>
      ${attachment.messageContent ? `<p class="preline">${escapeHtml(cleanLineConversationBody(attachment.messageContent, { hasMedia: Boolean(attachment.fileLinks?.length || attachment.source) }))}</p>` : ''}
      ${links ? `<p>${links}</p>` : ''}
    </article>`;
  }).join('');
}

function findEvidenceAttachments(taskText, model) {
  const text = normalizeEvidenceText(taskText);
  const pageIds = new Set(extractNotionPageIds(taskText).map(normalizeId));
  return (model.attachments || []).filter((attachment) => {
    if (pageIds.has(normalizeId(attachment.id))) return true;
    if (attachment.url && taskText.includes(attachment.url)) return true;
    if (attachment.lineMessageId && taskText.includes(attachment.lineMessageId)) return true;
    const name = normalizeEvidenceText(attachment.name);
    return name && text.includes(name);
  }).slice(0, 8);
}

function formatRawEvidenceLine(line, messages, model) {
  const conversationMatch = line.match(/^對話\s*[:：]\s*(.+)$/);
  if (conversationMatch) {
    return `對話：${conversationLabelForRawValue(conversationMatch[1], messages, model) || 'LINE 對話群組'}`;
  }

  const syncMatch = line.match(/^同步識別碼\s*[:：]\s*(.+)$/);
  if (syncMatch) {
    return `同步來源：${lineSyncLabel(syncMatch[1], messages, model) || 'LINE 對話群組'}`;
  }

  return replaceKnownIdsWithLabels(line, messages, model);
}

function conversationLabelForRawValue(value, messages, model) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const conversationById = new Map((model.conversations || []).map((conversation) => [normalizeId(conversation.id), conversation]));
  for (const conversation of model.conversations || []) {
    if (conversation.url) conversationById.set(normalizeId(conversation.url), conversation);
  }
  const direct = conversationById.get(normalizeId(raw));
  if (direct?.name) return direct.name;

  const message = messages.find((item) => (item.conversationIds || []).some((id) => normalizeId(id) === normalizeId(raw)));
  if (message?.conversationName) return message.conversationName;

  return firstEvidenceConversationName(messages);
}

function lineSyncLabel(value, messages, model) {
  const raw = String(value || '').trim();
  const tokens = raw.split(':').map((part) => part.trim()).filter(Boolean);
  for (const token of tokens) {
    const conversationLabel = conversationLabelForRawValue(token, messages, model);
    if (conversationLabel) return conversationLabel;

    const message = messages.find((item) => normalizeId(item.id) === normalizeId(token)
      || normalizeId(item.url) === normalizeId(token)
      || normalizeId(item.lineMessageId) === normalizeId(token));
    if (message?.conversationName) return message.conversationName;
  }
  return firstEvidenceConversationName(messages);
}

function replaceKnownIdsWithLabels(line, messages, model) {
  let result = String(line || '');
  for (const conversation of model.conversations || []) {
    if (!conversation.name) continue;
    const ids = [conversation.id, normalizeId(conversation.id), conversation.url].filter(Boolean);
    for (const id of ids) {
      result = replaceLiteral(result, id, conversation.name);
    }
  }
  for (const message of messages || []) {
    if (!message.conversationName) continue;
    const ids = [message.id, normalizeId(message.id), message.url, message.lineMessageId].filter(Boolean);
    for (const id of ids) {
      result = replaceLiteral(result, id, message.conversationName);
    }
  }
  return result;
}

function replaceLiteral(text, search, replacement) {
  const value = String(search || '');
  if (!value) return text;
  return String(text || '').split(value).join(replacement);
}

function firstEvidenceConversationName(messages) {
  return (messages || []).map((message) => message.conversationName).find(Boolean) || '';
}

function humanSpeakerType(value) {
  const text = String(value || '').trim().toLowerCase();
  const labels = {
    user: '使用者',
    group: '群組',
    room: '聊天室',
    bot: '機器人',
    system: '系統',
  };
  return labels[text] || value;
}

function formatDisplayTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function renderContentLine(line, model) {
  const value = String(line || '');
  const lineArchive = renderLineArchiveMessage(value, model);
  if (lineArchive) return lineArchive;
  if (value.startsWith('## ')) return `<h3>${escapeHtml(value.slice(3))}</h3>`;
  if (value.startsWith('- ')) return `<p>• ${escapeHtml(value.slice(2))}</p>`;
  if (value.startsWith('[ ]') || value.startsWith('[x]')) return `<p><span class="badge ready">${escapeHtml(value.slice(0, 3))}</span> ${escapeHtml(value.slice(3).trim())}</p>`;
  return `<p>${escapeHtml(value)}</p>`;
}

function renderTaskContent(task, model) {
  const content = normalizeTaskContentSourceReferences(task, model);
  return content.length ? content.map((line) => renderTaskContentLine(line, model)).join('') : '<p class="muted">No page content loaded.</p>';
}

function renderTaskContentLine(line, model) {
  const value = String(line || '');
  const sourceSummary = renderSourceSummaryLine(value, model);
  if (sourceSummary) return sourceSummary;
  const relatedSource = renderRelatedSourceLine(value, model);
  if (relatedSource) return relatedSource;
  return renderContentLine(value, model);
}

function normalizeTaskContentSourceReferences(task, model) {
  if (isMeetingDerivedTask(task)) {
    return deriveTaskContentFromMeetingSource(task, model);
  }

  const lines = [...(task.content || [])];
  const result = [];
  let lastSourceReference = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isLegacyEvidenceHeading(line) || isLegacyEvidenceIntro(line) || isLegacySourceExplanation(line)) continue;
    const normalizedLine = normalizeTaskDeadlineTextLine(line, task);
    if (/^來源對話群組\s*[:：]/.test(String(normalizedLine || '').trim())) {
      result.push(cleanSourceSummaryBlock(normalizedLine));
      lastSourceReference = normalizedLine;
      continue;
    }
    const sourceReference = taskContentSourceReference(normalizedLine, task, model);
    if (sourceReference) {
      result.push(sourceReference);
      lastSourceReference = sourceReference;
      continue;
    }
    if (lastSourceReference && isLegacyRelatedPageLine(normalizedLine)) {
      result.push(compactRelatedConversationLine(lastSourceReference));
      lastSourceReference = null;
      continue;
    }
    if (isLineArchiveHeader(normalizedLine) && lines[index + 1] && !isLineArchiveHeader(lines[index + 1])) {
      result.push(`${normalizedLine} ${normalizeTaskDeadlineTextLine(lines[index + 1], task)}`);
      index += 1;
      lastSourceReference = null;
      continue;
    }
    result.push(normalizedLine);
    lastSourceReference = null;
  }
  return result.length ? result : deriveTaskContentFromSourceFields(task, model);
}

function normalizeTaskDeadlineTextLine(line, task) {
  const dueDate = displayDateValue(task?.dueDate);
  if (!dueDate) return line;
  return String(line || '').replace(/截止日\s*[:：]\s*未設定/g, `截止日：${dueDate}`);
}

function deriveTaskContentFromSourceFields(task, model) {
  if (isMeetingDerivedTask(task)) {
    return deriveTaskContentFromMeetingSource(task, model);
  }

  const rawSource = String(task.rawSource || '').trim();
  if (!rawSource) return [];
  const messages = exactEvidenceMessagesForText(rawSource, model);
  const conversationName = conversationNameFromSourceText(rawSource, messages, model) || firstEvidenceConversationName(messages) || '';
  const speakers = uniqueValues([
    ...messages.map((message) => message.speaker).filter(Boolean),
    rawSource.match(/(?:^|\n)發話者\s*[:：]\s*([^\n]+)/)?.[1]?.trim() || '',
  ].filter(Boolean));
  const timeRange = evidenceTimeRange(messages);
  const sourceLines = [];
  if (conversationName) sourceLines.push(`來源對話群組：${conversationName}`);
  else sourceLines.push('來源對話群組：LINE 對話群組');
  if (timeRange) sourceLines.push(`相關段落時間：${timeRange}`);
  if (speakers.length) sourceLines.push(`相關發話者：${speakers.join('、')}`);
  const result = [
    '## 四、來源與會議/對話紀錄',
    sourceLines.join('\n'),
    `關聯頁面：${conversationName || 'LINE 對話群組'}`,
  ];
  const messageLines = messages.length
    ? sortMessagesByTime(messages).map((message) => lineArchiveTextFromMessage(message))
    : [lineArchiveTextFromRawSource(rawSource, conversationName)];
  return [...result, ...messageLines.filter(Boolean)];
}

function isMeetingDerivedTask(task) {
  const text = [
    task?.source,
    task?.rawSource,
    ...(task?.content || []),
  ].filter(Boolean).join('\n');
  return /meeting-checkbox|meeting-action|同步識別碼\s*[:：]\s*meeting:/i.test(text);
}

function deriveTaskContentFromMeetingSource(task, model) {
  const rawSource = String(task.rawSource || '').trim();
  const sourceText = rawSource || (task.content || []).join('\n');
  const meeting = findMeetingForTaskSource(sourceText, model);
  const meetingName = meeting?.name || sourceText.match(/(?:^|\n)會議\s*[:：]\s*([^\n]+)/)?.[1]?.trim() || '會議記錄';
  const result = [
    '## 四、來源與會議/對話紀錄',
    '資料來源：會議記錄',
    `關聯頁面：${meeting?.url || meetingName}`,
    `會議：${meetingName}`,
  ];
  if (meeting?.date) result.push(`會議日期：${meeting.date}`);

  const contentLines = meetingContentLines(meeting, sourceText);
  if (contentLines.length) {
    result.push('會議記錄內文：', ...contentLines);
  }

  const action = sourceText.match(/(?:^|\n)行動項目\s*[:：]\s*([^\n]+)/)?.[1]?.trim();
  if (action) result.push(`行動項目：${action}`);
  const sourceMark = sourceText.match(/(?:^|\n)來源標記\s*[:：]\s*([^\n]+)/)?.[1]?.trim();
  if (sourceMark) result.push(`來源標記：${sourceMark}`);
  const syncId = sourceText.match(/(?:^|\n)同步識別碼\s*[:：]\s*([^\n]+)/)?.[1]?.trim();
  if (syncId) result.push(`同步識別碼：${syncId}`);
  return result;
}

function findMeetingForTaskSource(text, model) {
  const raw = String(text || '');
  const syncId = raw.match(/同步識別碼\s*[:：]\s*meeting:([^:\s]+)/i)?.[1] || '';
  if (syncId) {
    const normalizedSyncId = normalizeId(syncId);
    const bySync = (model.meetings || []).find((meeting) => normalizeId(meeting.id) === normalizedSyncId || normalizeId(meeting.url).includes(normalizedSyncId));
    if (bySync) return bySync;
  }

  const meetingName = raw.match(/(?:^|\n)會議\s*[:：]\s*([^\n]+)/)?.[1]?.trim() || '';
  if (meetingName) {
    const byName = findMeetingByName(meetingName, model);
    if (byName) return byName;
  }

  return (model.meetings || []).find((meeting) => meeting.name && raw.includes(meeting.name));
}

function meetingContentLines(meeting, sourceText) {
  const lines = [
    ...(meeting?.content || []),
    ...(meeting?.summary ? String(meeting.summary).split(/\r?\n/) : []),
  ].map((line) => String(line || '').trim()).filter(Boolean);
  const seen = new Set();
  const filtered = lines.filter((line) => {
    if (/^(行動項目|來源標記|同步識別碼)\s*[:：]/.test(line)) return false;
    const normalized = normalizeEvidenceText(line);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  if (filtered.length) return filtered.slice(0, 18);

  return String(sourceText || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line) return false;
    return !/^(會議|行動項目|來源標記|同步識別碼)\s*[:：]/.test(line);
  }).slice(0, 18);
}

function lineArchiveTextFromMessage(message) {
  const conversation = message.conversationName || 'LINE 對話群組';
  const speaker = message.speaker || humanSpeakerType(message.speakerType) || '未知發話者';
  const type = message.type ? `${humanMessageType(message.type)}訊息` : '訊息';
  const time = message.sentAt ? formatDisplayTime(message.sentAt) : '';
  const content = String(message.content || '').trim();
  if (!content) return '';
  return `【${time || '未記錄時間'}】${conversation} - ${speaker}（${type}）\n${content}`;
}

function lineArchiveTextFromRawSource(rawSource, conversationName) {
  const speaker = rawSource.match(/(?:^|\n)發話者\s*[:：]\s*([^\n]+)/)?.[1]?.trim() || '未知發話者';
  const content = rawSource.split(/\r?\n/).filter((line) => {
    const text = line.trim();
    if (!text) return false;
    return !/^(LINE 訊息|對話|發話者|同步識別碼)\s*[:：]/.test(text);
  }).join('\n').trim();
  if (!content) return '';
  return `【未記錄時間】${conversationName || 'LINE 對話群組'} - ${speaker}（文字訊息）\n${content}`;
}

function humanMessageType(type) {
  const value = String(type || '').trim().toLowerCase();
  const labels = {
    text: '文字',
    image: '圖片',
    file: '檔案',
    video: '影片',
    audio: '語音',
    sticker: '貼圖',
  };
  return labels[value] || type;
}

function taskContentSourceReference(line, task, model) {
  const text = String(line || '').trim();
  if (!/^來源訊息\s*[:：]/.test(text)) return '';
  const messages = evidenceMessagesForText(text, model);
  const conversationName = conversationNameFromSourceText(text, messages, model) || firstEvidenceConversationName(messages) || 'LINE 對話群組';
  const speakers = uniqueValues(messages.map((message) => message.speaker).filter(Boolean));
  const timeRange = evidenceTimeRange(messages);
  const parts = [`來源對話群組：${conversationName}`];
  if (timeRange) parts.push(`相關段落時間：${timeRange}`);
  if (speakers.length) parts.push(`相關發話者：${speakers.join('、')}`);
  return parts.join('\n');
}

function isLegacyRelatedPageLine(line) {
  const text = String(line || '').trim();
  return /^關聯頁面\s*[:：]\s*https:\/\/app\.notion\.com\/p\//.test(text);
}

function compactRelatedConversationLine(sourceReference) {
  const conversation = String(sourceReference || '').match(/^來源對話群組\s*[:：]\s*(.+)$/m)?.[1] || 'LINE 對話群組';
  return `關聯頁面：${conversation}`;
}

function isLegacyEvidenceHeading(line) {
  return /^##\s*\d{4}-\d{2}-\d{2}\s+來源證據與對話記錄/.test(String(line || '').trim());
}

function isLegacyEvidenceIntro(line) {
  const text = String(line || '').trim();
  return text.includes('以下依 LINE 對話記錄格式補入') || text.includes('只保留任務判斷需要的時間');
}

function isLegacySourceExplanation(line) {
  return String(line || '').trim().startsWith('說明：下方');
}

function cleanSourceSummaryBlock(line) {
  return String(line || '').split(/\r?\n/).filter((part) => !isLegacySourceExplanation(part)).join('\n');
}

function isLineArchiveHeader(line) {
  return /^【[^】]+】\s*.+?（[^）]+）$/.test(String(line || '').trim());
}

function renderSourceSummaryLine(value, model) {
  const text = String(value || '').trim();
  if (/^資料來源\s*[:：]\s*會議記錄/.test(text)) {
    const rows = text.split(/\r?\n/).slice(1).filter(Boolean).map((line) => `<div>${escapeHtml(line)}</div>`).join('');
    return `<div class="source-summary">
    <div><strong>資料來源：</strong>會議記錄</div>
    ${rows}
  </div>`;
  }
  if (!/^來源對話群組\s*[:：]/.test(text)) return '';
  const groupName = text.match(/^來源對話群組\s*[:：]\s*([^\n]+)/)?.[1]?.trim() || 'LINE 對話群組';
  const group = findConversationByName(groupName, model);
  const groupHtml = group?.uiUrl ? link(group.uiUrl, group.name || groupName) : escapeHtml(groupName);
  const rows = text.split(/\r?\n/).slice(1).filter((line) => !isLegacySourceExplanation(line)).map((line) => `<div>${escapeHtml(line)}</div>`).join('');
  return `<div class="source-summary">
    <div><strong>來源對話群組：</strong>${groupHtml}</div>
    ${rows}
  </div>`;
}

function renderRelatedSourceLine(value, model) {
  const text = String(value || '').trim();
  const match = text.match(/^關聯頁面\s*[:：]\s*(.+)$/);
  if (!match) return '';
  const name = match[1].trim();
  if (/^https:\/\/app\.notion\.com\/p\//.test(name)) {
    const meeting = findMeetingByUrl(name, model);
    return `<p><strong>關聯頁面：</strong>${link(name, meeting?.name || '開啟會議記錄')}</p>`;
  }
  const meeting = findMeetingByName(name, model);
  if (meeting?.url) {
    return `<p><strong>關聯頁面：</strong>${link(meeting.url, meeting.name || name)}</p>`;
  }
  const group = findConversationByName(name, model);
  const html = group?.uiUrl ? link(group.uiUrl, group.name || name) : escapeHtml(name);
  return `<p><strong>關聯頁面：</strong>${html}</p>`;
}

function findMeetingByName(name, model) {
  const normalized = normalizeName(name);
  return (model.meetings || []).find((meeting) => normalizeName(meeting.name) === normalized)
    || (model.meetings || []).find((meeting) => normalizeName(meeting.name).includes(normalized) || normalized.includes(normalizeName(meeting.name)));
}

function findMeetingByUrl(url, model) {
  const normalized = normalizeId(url);
  return (model.meetings || []).find((meeting) => normalizeId(meeting.url) === normalized || normalized.includes(normalizeId(meeting.id)));
}

function findConversationByName(name, model) {
  const normalized = normalizeName(name);
  return (model.conversations || []).find((conversation) => normalizeName(conversation.name) === normalized)
    || (model.conversations || []).find((conversation) => normalizeName(conversation.name).includes(normalized) || normalized.includes(normalizeName(conversation.name)));
}

function evidenceMessagesForText(text, model) {
  const messageMap = new Map();
  for (const message of model.messages || []) {
    if (message.id) messageMap.set(normalizeId(message.id), message);
    if (message.url) messageMap.set(normalizeId(message.url), message);
    if (message.lineMessageId) messageMap.set(normalizeId(message.lineMessageId), message);
  }
  const ids = extractNotionPageIds(text);
  const matched = ids.map((id) => messageMap.get(normalizeId(id))).filter(Boolean);
  return expandEvidenceMessages(text, matched, model.messages || []);
}

function exactEvidenceMessagesForText(text, model) {
  const messageMap = new Map();
  for (const message of model.messages || []) {
    if (message.id) messageMap.set(normalizeId(message.id), message);
    if (message.url) messageMap.set(normalizeId(message.url), message);
    if (message.lineMessageId) messageMap.set(normalizeId(message.lineMessageId), message);
  }
  const ids = extractNotionPageIds(text);
  const seen = new Set();
  return ids.map((id) => messageMap.get(normalizeId(id))).filter((message) => {
    const key = message?.id || message?.url || message?.lineMessageId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function conversationNameFromSourceText(text, messages, model) {
  const match = String(text || '').match(/(?:^|\n)對話\s*[:：]\s*([^\n]+)/);
  if (!match) return '';
  return conversationLabelForRawValue(match[1], messages, model) || match[1].trim();
}

function evidenceTimeRange(messages) {
  const times = uniqueValues((messages || []).map((message) => formatDisplayTime(message.sentAt)).filter(Boolean));
  if (!times.length) return '';
  if (times.length === 1) return times[0];
  return `${times[0]} - ${times[times.length - 1]}`;
}

function renderLineArchiveMessage(value, model = {}) {
  const text = String(value || '').trim();
  const match = text.match(/^(【[^】]+】\s*.+?（[^）]+）)\s*([\s\S]*)$/);
  if (!match) return '';
  const body = match[2].trim();
  const mediaHtml = renderLineArchiveMedia(body, model);
  const displayBody = cleanLineConversationBody(body, { hasMedia: Boolean(mediaHtml) });
  const headClass = isAssistantLineArchiveHead(match[1]) ? 'line-archive-head assistant' : 'line-archive-head';
  return `<div class="line-archive-message">
    <div class="${headClass}">${escapeHtml(match[1])}</div>
    ${mediaHtml}
    ${displayBody ? `<div class="line-archive-body">${escapeHtml(displayBody)}</div>` : ''}
  </div>`;
}

function renderLineConversationMessage(message, attachments = []) {
  const headClass = isAssistantMessage(message) ? 'line-archive-head assistant' : 'line-archive-head';
  return `<div class="line-archive-message">
    <div class="${headClass}">${escapeHtml(lineArchiveHeaderFromMessage(message))}</div>
    ${renderMessageContent(message, attachments)}
  </div>`;
}

function lineArchiveHeaderFromMessage(message) {
  const time = message.sentAt ? formatDisplayTime(message.sentAt) : '未記錄時間';
  const conversation = message.conversationName || 'LINE 對話群組';
  const speaker = displaySpeakerName(message, conversation);
  const type = message.type ? `${humanMessageType(message.type)}訊息` : '訊息';
  if (isAssistantMessage(message) && !message.conversationName) return `【${time}】${speaker}：${type}`;
  return `【${time}】${conversation} - ${speaker}（${type}）`;
}

function displaySpeakerName(message, conversationName = '') {
  const raw = message?.speaker || humanSpeakerType(message?.speakerType) || '未知發話者';
  const conversation = String(conversationName || '').trim();
  if (conversation && String(raw).startsWith(`${conversation} - `)) return String(raw).slice(conversation.length + 3).trim() || raw;
  return raw;
}

function isAssistantMessage(message) {
  const text = `${message?.speaker || ''} ${message?.source || ''} ${message?.speakerType || ''}`.toLowerCase();
  return /seven jr|seven junior|hozo jr|hozo junior|ai-engine|assistant|system|助理|系統/i.test(text);
}

function isAssistantLineArchiveHead(value) {
  return /Seven Jr\.|Seven Junior|HOZO Jr\.|HOZO Junior|助理|系統/.test(String(value || ''));
}

function renderLineArchiveMedia(body, model = {}) {
  const ids = [...String(body || '').matchAll(/(?:圖片|檔案|影片|語音)\s*[:：]\s*([A-Za-z0-9_-]{10,})|\[(?:image|file|video|audio)\]\s*([A-Za-z0-9_-]{10,})/gi)]
    .map((match) => match[1] || match[2])
    .filter(Boolean);
  if (!ids.length) return '';
  const messageMap = new Map();
  for (const message of model.messages || []) {
    if (message.id) messageMap.set(normalizeId(message.id), message);
    if (message.lineMessageId) messageMap.set(normalizeId(message.lineMessageId), message);
  }
  const seen = new Set();
  const media = [];
  for (const id of ids) {
    const message = messageMap.get(normalizeId(id));
    if (!message) continue;
    const html = renderMessageContent(message, attachmentsForMessage(message, model.attachments || []));
    const mediaOnly = html.match(/<div class="message-media">[\s\S]*?<\/div>/)?.[0] || '';
    if (mediaOnly && !seen.has(mediaOnly)) {
      seen.add(mediaOnly);
      media.push(mediaOnly);
    }
  }
  return media.join('');
}

function tasksForProject(project, taskItems) {
  const projectName = normalizeName(project.name);
  return taskItems.filter((task) => {
    const taskProject = normalizeName(task.project);
    if (!taskProject) return false;
    return taskProject === projectName || taskProject.includes(projectName) || projectName.includes(taskProject);
  });
}

function conversationsForProject(project, conversationItems) {
  const projectName = normalizeName(project.name);
  const lineRef = String(project.lineUrl || '');
  const normalizedLineRef = normalizeId(lineRef);
  return conversationItems.filter((conversation) => {
    const conversationProject = normalizeName(conversation.project);
    if (projectName && conversationProject) {
      if (conversationProject === projectName || conversationProject.includes(projectName) || projectName.includes(conversationProject)) return true;
    }
    if (lineRef && conversation.url && lineRef.includes(conversation.url)) return true;
    if (normalizedLineRef && normalizeId(conversation.id) && normalizedLineRef.includes(normalizeId(conversation.id))) return true;
    if (normalizedLineRef && conversation.url && normalizedLineRef.includes(normalizeId(conversation.url))) return true;
    return false;
  });
}

function messagesForConversation(conversation, messageItems) {
  const conversationId = normalizeId(conversation.id);
  return messageItems.filter((message) => message.conversationIds.some((id) => normalizeId(id) === conversationId));
}

function attachmentsForConversation(conversation, attachmentItems) {
  const conversationId = normalizeId(conversation.id);
  return attachmentItems.filter((attachment) => {
    if (attachment.conversationIds?.some((id) => normalizeId(id) === conversationId)) return true;
    return normalizeName(attachment.conversationName) === normalizeName(conversation.name);
  });
}

function attachmentsForMessage(message, attachmentItems) {
  return attachmentItems.filter((attachment) => {
    if (attachment.messageIds?.some((id) => normalizeId(id) === normalizeId(message.id))) return true;
    if (attachment.lineMessageId && message.lineMessageId && attachment.lineMessageId === message.lineMessageId) return true;
    if (attachment.messageUrl && message.url && attachment.messageUrl === message.url) return true;
    return false;
  });
}

function renderMessageContent(message, attachments = []) {
  const mediaItems = [
    ...(message.media || []),
    ...attachments.flatMap((attachment) => attachment.fileLinks || []).map((file) => ({
      type: inferMediaType(file.name, file.url),
      name: file.name,
      url: file.url,
    })),
    ...attachments.filter((attachment) => attachment.source).map((attachment) => ({
      type: inferMediaType(attachment.name, attachment.source),
      name: attachment.name || '附件',
      url: attachment.source,
    })),
  ].filter((item, index, list) => item.url && list.findIndex((other) => other.url === item.url) === index);
  const mediaHtml = mediaItems.length ? `<div class="message-media">${mediaItems.map(renderMessageMedia).join('')}</div>` : '';
  const fallback = isRawMediaPayload(message.content, mediaItems)
    ? `[${message.type || 'media'}] ${message.lineMessageId || ''}`.trim()
    : (message.content || '');
  const displayText = cleanLineConversationBody(fallback, { hasMedia: Boolean(mediaHtml) });
  return `${mediaHtml}${displayText ? `<div class="preline">${escapeHtml(displayText)}</div>` : ''}`;
}

function cleanLineConversationBody(value, { hasMedia = false } = {}) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cleaned = [];
  for (const line of lines) {
    if (/^(日期|時間|群組|使用者|發話者|訊息類型)\s*[:：]/.test(line)) continue;
    if (hasMedia && /^(圖片|照片|檔案|影片|語音)\s*[:：]\s*[A-Za-z0-9_-]{10,}(?:\s+.*)?$/.test(line)) continue;
    if (hasMedia && /^\[(?:image|file|video|audio|media)\]\s*[A-Za-z0-9_-]{10,}$/i.test(line)) continue;
    const contentMatch = line.match(/^內容\s*[:：]\s*(.*)$/);
    if (contentMatch) {
      const content = contentMatch[1].trim();
      if (content) cleaned.push(content);
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join('\n').trim();
}

function renderMessageMedia(item) {
  const label = item.name || 'Open media';
  if (isImageMedia(item)) {
    return `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" title="${escapeHtml(label)}"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(label)}"></a>`;
  }
  return `<a class="message-file" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
}

function inferMediaType(name, url) {
  const value = `${name || ''} ${url || ''}`.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|heic)(\?|#|$)/.test(value)) return 'image';
  if (/image\//.test(value)) return 'image';
  if (/\.pdf(\?|#|$)/.test(value)) return 'pdf';
  return 'file';
}

function isImageMedia(item) {
  return item.type === 'image' || inferMediaType(item.name, item.url) === 'image';
}

function isRawMediaPayload(content, mediaItems) {
  const text = String(content || '').trim();
  return Boolean(mediaItems.length && /^\{[\s\S]*"message"\s*:\s*\{[\s\S]*"type"\s*:\s*"(image|file|video)"/.test(text));
}

function renderProjectConversationLinks(project, conversationItems) {
  const related = conversationsForProject(project, conversationItems);
  if (!related.length) return '<span class="muted">目前沒有找到已關聯的 LINE 對話。</span>';
  return `<div class="link-list">${related.map((conversation) => {
    const label = `${conversation.name || '(unnamed conversation)'}${conversation.count ? ` (${conversation.count} messages)` : ''}`;
    return link(conversation.uiUrl, label);
  }).join('')}</div>`;
}

function projectForTask(projects, task) {
  const taskProject = normalizeName(task.project);
  if (!taskProject) return null;
  return projects.find((project) => {
    const projectName = normalizeName(project.name);
    return taskProject === projectName || taskProject.includes(projectName) || projectName.includes(taskProject);
  }) || null;
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}
