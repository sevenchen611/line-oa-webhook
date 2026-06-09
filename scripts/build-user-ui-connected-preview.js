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
const skipLineMedia = Boolean(args.skipLineMedia || process.env.USER_UI_SKIP_LINE_MEDIA === 'true');

const dataSources = {
  projectMaster: projectEnv('PROJECTS_DATA_SOURCE_ID') || args.projectDataSourceId || '',
  tasks: projectEnv('TASKS_DATA_SOURCE_ID') || '',
  conversations: projectEnv('CONVERSATIONS_DATA_SOURCE_ID') || '',
  messages: projectEnv('MESSAGES_DATA_SOURCE_ID') || '',
  attachments: projectEnv('ATTACHMENTS_DATA_SOURCE_ID') || '',
  meetings: projectEnv('MEETINGS_DATA_SOURCE_ID') || '',
  progressReports: projectEnv('PROGRESS_REPORTS_DATA_SOURCE_ID') || '',
  judgmentRules: projectEnv('JUDGMENT_RULES_DATA_SOURCE_ID') || '',
  judgmentCases: projectEnv('JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID') || '',
  commands: projectEnv('CODEX_COMMANDS_DATA_SOURCE_ID') || '',
};

const envRows = Object.entries(process.env)
  .filter(([key]) => /^(SEVEN|HOZO|LINE|NOTION|CONTROL|DAILY|MORNING|FOLLOWUP|PORT|CRON|RENDER)/.test(key))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => ({
    key,
    value: isSensitiveKey(key) ? '••••••••••••••••' : String(value || ''),
    type: isSensitiveKey(key) ? 'Secret' : inferEnvType(key, value),
  }));

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
const messages = await mapMessages(data.messages);
const conversationById = new Map(conversations.map((item) => [item.id, item]));
const messageById = new Map(messages.map((item) => [item.id, item]));

const viewModel = {
  generatedAt: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
  projectName,
  projectRoot,
  outputPath,
  controlApiBaseUrl: args.controlApiBaseUrl || process.env.SEVEN_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000',
  envRows,
  schemas,
  projects: await mapProjects(data.projectMaster),
  tasks: await mapTasks(data.tasks),
  conversations,
  messages,
  attachments: mapAttachments(data.attachments, { conversationById, messageById }),
  meetings: mapMeetings(data.meetings),
  progressReports: mapProgressReports(data.progressReports),
  judgmentRules: mapJudgmentRules(data.judgmentRules),
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

function inferEnvType(key, value) {
  if (/DATA_SOURCE|DATABASE/.test(key)) return 'Notion ID';
  if (/URL/.test(key) || /^https?:\/\//.test(String(value || ''))) return 'URL';
  if (/PORT/.test(key)) return 'Runtime';
  return 'Config';
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
      judgment: firstPageText(page, ['Codex 判斷摘要', '判斷摘要', 'AM 判斷摘要', '判斷原因']) || '',
      rawSource: firstPageText(page, ['來源原文', '原始內容', '線索訊息', '來源訊息']) || '',
      content: await pageContentPreview(page.id),
      uiUrl: userUiPageHref(`user-ui-task-${index}.html`),
      notionUrl: pageUrl(page),
      url: pageUrl(page),
    });
  }
  return mapped;
}

function mapConversations(pages) {
  return pages.map((page, index) => ({
    id: page.id,
    index,
    uiUrl: userUiPageHref(`user-ui-line-${index}.html`),
    name: pageText(page, '自定義名稱') || pageTitle(page),
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
    const lineMedia = skipLineMedia || pageMedia.length ? [] : await downloadLineMessageMedia(lineMessageId, type, pageText(page, '文字內容') || pageTitle(page));
    mapped.push({
      id: page.id,
      lineMessageId,
      conversationIds: relationIds(page, '對話主檔'),
      speaker: pageText(page, '發話者名稱') || pageText(page, '發話者類型') || '',
      type,
      source: pageText(page, '訊息來源') || '',
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

function mapMeetings(pages) {
  return pages.map((page) => ({
    name: pageText(page, '會議名稱') || pageTitle(page),
    date: pageText(page, '日期') || '',
    department: pageText(page, '部門') || '',
    category: pageText(page, '類別') || '',
    summary: pageText(page, '摘要') || pageText(page, '會議記錄') || '',
    url: pageUrl(page),
  }));
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

function renderSideNav(basePath = '') {
  const base = String(basePath || userUiHomeHref());
  return `<nav class="nav">
        <a href="${base}#overview" data-view="overview">檔案總覽</a>
        <a href="${base}#projects" data-view="projects">所有專案</a>
        <a href="${base}#tasks" data-view="tasks">所有任務</a>
        <a href="${base}#line" data-view="line">LINE 群組與訊息</a>
        <a href="${base}#attachments" data-view="attachments">附件與檔案</a>
        <a href="${base}#meetings" data-view="meetings">會議紀錄</a>
        <a href="${base}#reports" data-view="reports">每日/進度報告</a>
        <a href="${base}#rules" data-view="rules">判斷規則</a>
        <a href="${base}#calibration" data-view="calibration">任務校準案例</a>
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
        <h2>每日/進度報告</h2>
        <table>
          <thead><tr><th>Report</th><th>Project</th><th>Status</th><th>Progress</th><th>Next</th></tr></thead>
          <tbody>${rows(model.progressReports, [
            { value: (item) => link(item.url, item.name), html: true },
            { value: 'project' },
            { value: (item) => `<span class="badge ${statusClass(item.status)}">${escapeHtml(item.status)}</span>`, html: true },
            { value: 'progress' },
            { value: (item) => short(item.next || item.blocker, 120) },
          ])}</tbody>
        </table>
      </section>

      <section id="rules" class="section view-panel hidden">
        <h2>判斷規則</h2>
        <div class="cards">
          ${cards(model.judgmentRules, (item) => `<article class="card">
            <h3>${link(item.url, item.name)}</h3>
            <p class="muted">${escapeHtml(short(item.preferred || item.reason, 160))}</p>
            <p><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'Rule')}</span> <span class="badge neutral">${escapeHtml(item.appliesTo || 'Project')}</span></p>
          </article>`)}
        </div>
      </section>

      <section id="calibration" class="section view-panel hidden">
        <h2>任務校準案例</h2>
        <table>
          <thead><tr><th>Case</th><th>Status</th><th>Project</th><th>Controller judgment</th><th>Reason</th></tr></thead>
          <tbody>${rows(model.judgmentCases, [
            { value: (item) => link(item.url, item.name), html: true },
            { value: (item) => `<span class="badge ${statusClass(item.status)}">${escapeHtml(item.status)}</span>`, html: true },
            { value: 'project' },
            { value: (item) => short(item.judgment, 120) },
            { value: (item) => short(item.reason || item.severity, 120) },
          ])}</tbody>
        </table>
      </section>

      <section id="env" class="section view-panel hidden">
        <h2>Environment data</h2>
        <table>
          <thead><tr><th>Key</th><th>Value</th><th>Type</th></tr></thead>
          <tbody>${rows(model.envRows, [
            { value: (item) => `<span class="mono">${escapeHtml(item.key)}</span>`, html: true },
            { value: (item) => `<span class="mono">${escapeHtml(short(item.value, 220))}</span>`, html: true },
            { value: (item) => `<span class="badge ${item.type === 'Secret' ? 'wait' : 'neutral'}">${escapeHtml(item.type)}</span>`, html: true },
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
      reports: '每日/進度報告',
      rules: '判斷規則',
      calibration: '任務校準案例',
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
        <div class="note">儲存會透過 SevenAM 後端寫回 Notion。請從 /user-ui 網址登入後使用；系統會記錄編輯者與編輯內容。</div>
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
            <div class="field full">
              <label for="taskNext">下一步</label>
              <textarea id="taskNext" name="next">${escapeHtml(task.next || '')}</textarea>
            </div>
            <div class="field full">
              <label for="taskJudgment">Codex 判斷摘要</label>
              <textarea id="taskJudgment" name="judgment">${escapeHtml(task.judgment || '')}</textarea>
            </div>
            <div class="field full">
              <label for="taskRawSource">來源原文</label>
              <textarea id="taskRawSource" name="rawSource">${escapeHtml(task.rawSource || '')}</textarea>
            </div>
            <div class="field full">
              <label for="taskEditNote">本次編輯備註</label>
              <textarea id="taskEditNote" name="editNote" placeholder="例如：由 User UI 手動確認狀態，下一步改為..."></textarea>
            </div>
            <div class="field full">
              <label for="taskPageContent">Notion 頁面內容更新</label>
              <textarea id="taskPageContent" name="pageContent" placeholder="在這裡填入要新增到 Notion 任務頁正文的內容。">${escapeHtml((task.content || []).join('\n'))}</textarea>
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
            <tr><th>判斷信心</th><td>${escapeHtml(task.confidence || '')}</td></tr>
            <tr><th>下一步</th><td>${escapeHtml(task.next || '')}</td></tr>
          </tbody>
        </table>
      </section>
      <section class="section">
        <h2>AM 判斷與來源</h2>
        <table>
          <tbody>
            <tr><th>Codex 判斷摘要</th><td class="preline">${escapeHtml(task.judgment || '')}</td></tr>
            <tr><th>來源原文</th><td class="preline">${escapeHtml(task.rawSource || '')}</td></tr>
          </tbody>
        </table>
      </section>
      <section class="section">
        <h2>Notion 頁面內容</h2>
        <div class="card">${task.content?.length ? task.content.map((line) => renderContentLine(line)).join('') : '<p class="muted">No page content loaded.</p>'}</div>
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
      const updates = Object.fromEntries(['status', 'confirmation', 'owner', 'priority', 'next', 'judgment', 'rawSource', 'editNote', 'pageContent', 'editedBy'].map((key) => [key, String(form.get(key) || '').trim()]));
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
    .message-media { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px; }
    .message-media a { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#f8fafc; }
    .message-media img { display:block; width:180px; max-width:100%; max-height:180px; object-fit:cover; }
    .message-file { padding:8px 10px; font-weight:800; }
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
            { value: (item) => renderMessageContent(item, attachmentsForMessage(item, conversationAttachments)), html: true },
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
  return tasks.map((item) => `
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
  return sortTasksByStatus(tasks).map((item) => `
    <tr data-project-task-row data-status="${escapeHtml(item.status || 'No status')}">
      <td>${link(item.uiUrl, item.name)}</td>
      <td><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status || 'No status')}</span></td>
      <td>${escapeHtml(item.owner || '')}</td>
      <td>${escapeHtml(short(item.next, 150))}</td>
    </tr>
  `).join('');
}

function sortTasksByStatus(tasks) {
  return [...tasks].sort((a, b) => {
    const statusDiff = statusSortIndex(a.status) - statusSortIndex(b.status);
    if (statusDiff !== 0) return statusDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant');
  });
}

function statusSortIndex(status) {
  const normalized = statusLabel(String(status || 'No status'));
  const order = ['未開始', '待確認', '待回覆', '等待回覆', '進行中', '待確認完成', '已完成', '封存'];
  const index = order.indexOf(normalized);
  return index >= 0 ? index : 999;
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
    const projectTasks = tasks.filter((task) => (task.project || 'No project') === project);
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

function renderContentLine(line) {
  const value = String(line || '');
  if (value.startsWith('## ')) return `<h3>${escapeHtml(value.slice(3))}</h3>`;
  if (value.startsWith('- ')) return `<p>• ${escapeHtml(value.slice(2))}</p>`;
  if (value.startsWith('[ ]') || value.startsWith('[x]')) return `<p><span class="badge ready">${escapeHtml(value.slice(0, 3))}</span> ${escapeHtml(value.slice(3).trim())}</p>`;
  return `<p>${escapeHtml(value)}</p>`;
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
  return `${mediaHtml}<div class="preline">${escapeHtml(fallback)}</div>`;
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
