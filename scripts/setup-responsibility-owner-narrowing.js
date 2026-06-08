import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const parentPageId = normalizeId(process.env.SEVEN_DATA_SOURCE_PARENT_BLOCK_ID || '');
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const messagesDataSourceId = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID || '';

const command = String(process.argv[2] || 'create').trim().toLowerCase();
const args = parseArgs(process.argv.slice(3));
let resolvedParentPageId = normalizeId(args.parent || process.env.SEVEN_RESPONSIBILITY_PARENT_PAGE_ID || parentPageId);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!resolvedParentPageId) fail('SEVEN_DATA_SOURCE_PARENT_BLOCK_ID is not set.');
if (!conversationsDataSourceId) fail('SEVEN_CONVERSATIONS_DATA_SOURCE_ID is not set.');
if (!messagesDataSourceId) fail('SEVEN_MESSAGES_DATA_SOURCE_ID is not set.');

if (command === 'create') {
  const result = await createResponsibilityOwnerNarrowingDatabases();
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'seed') {
  const result = await seedResponsibilityOwnerNarrowingData({
    responsibilityDataSourceId: requiredArg('responsibility', process.env.SEVEN_RESPONSIBILITY_DATA_SOURCE_ID),
    groupOptionsDataSourceId: requiredArg('groups', process.env.SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID),
    groupMembersDataSourceId: requiredArg('members', process.env.SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID),
    limit: clampNumber(Number(args.limit || 100), 1, 100),
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  fail('Usage: npm run setup:responsibility -- create OR npm run setup:responsibility -- seed --responsibility <id> --groups <id> --members <id> [--limit 100]');
}

async function createResponsibilityOwnerNarrowingDatabases() {
  let groupDatabase = null;
  let groupOptionsDataSourceId = normalizeId(args.groups || process.env.SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID || '');
  if (!groupOptionsDataSourceId) {
    groupDatabase = await createDatabase({
      title: 'Seven LINE 群組選項庫',
      dataSourceTitle: 'Seven LINE 群組選項',
      properties: groupOptionProperties(),
    });
    groupOptionsDataSourceId = dataSourceIdFromDatabase(groupDatabase);
  }
  if (!groupOptionsDataSourceId) fail('Unable to read group option data source id.');

  const memberDatabase = await createDatabase({
    title: 'Seven LINE 群組成員選項庫',
    dataSourceTitle: 'Seven LINE 群組成員',
    properties: groupMemberProperties(groupOptionsDataSourceId),
  });
  const groupMembersDataSourceId = dataSourceIdFromDatabase(memberDatabase);
  if (!groupMembersDataSourceId) fail('Unable to read group member data source id.');

  const responsibilityDatabase = await createDatabase({
    title: 'Seven 權責定義庫',
    dataSourceTitle: 'Seven 權責定義',
    properties: responsibilityProperties(groupOptionsDataSourceId, groupMembersDataSourceId),
  });
  const responsibilityDataSourceId = dataSourceIdFromDatabase(responsibilityDatabase);
  if (!responsibilityDataSourceId) fail('Unable to read responsibility data source id.');

  return {
    ok: true,
    databases: {
      responsibility: {
        databaseId: responsibilityDatabase.id,
        dataSourceId: responsibilityDataSourceId,
        url: responsibilityDatabase.url,
        renderEnvVar: `SEVEN_RESPONSIBILITY_DATA_SOURCE_ID=${responsibilityDataSourceId}`,
      },
      groupOptions: {
        databaseId: groupDatabase?.id || null,
        dataSourceId: groupOptionsDataSourceId,
        url: groupDatabase?.url || null,
        renderEnvVar: `SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID=${groupOptionsDataSourceId}`,
      },
      groupMembers: {
        databaseId: memberDatabase.id,
        dataSourceId: groupMembersDataSourceId,
        url: memberDatabase.url,
        renderEnvVar: `SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID=${groupMembersDataSourceId}`,
      },
    },
    nextStep: 'Run seed with these SEVEN_* data source IDs, then run npm run responsibility:sync -- --dry-run.',
  };
}

async function seedResponsibilityOwnerNarrowingData({ responsibilityDataSourceId, groupOptionsDataSourceId, groupMembersDataSourceId, limit }) {
  await assertSevenDataSource(responsibilityDataSourceId);
  await assertSevenDataSource(groupOptionsDataSourceId);
  await assertSevenDataSource(groupMembersDataSourceId);

  const conversations = await queryAllPages(conversationsDataSourceId, {
    page_size: limit,
    filter: {
      or: [
        { property: '對象類型', select: { equals: '群組' } },
        { property: '對象類型', select: { equals: '聊天室' } },
      ],
    },
    sorts: [{ property: '最後訊息時間', direction: 'descending' }],
  });

  const groupOptions = [];
  for (const conversation of conversations) {
    const option = normalizeConversationOption(conversation);
    if (!option.targetId) continue;
    const page = await createPage(groupOptionsDataSourceId, {
      '群組顯示名稱': titleProperty(option.displayName),
      LINE對話名稱: richTextProperty(option.lineName),
      自定義名稱: richTextProperty(option.customName),
      GroupID: richTextProperty(option.targetId),
      對象類型: selectProperty(option.targetType),
      總控專案: selectProperty(option.project),
      來源對話頁ID: richTextProperty(conversation.id),
      對話頁面URL: urlProperty(conversation.url),
      '訊息數（總）': numberProperty(option.messageCount),
      最後訊息時間: option.lastMessageAt ? dateProperty(option.lastMessageAt) : undefined,
      同步狀態: selectProperty('自動建立'),
    });
    groupOptions.push({ ...option, pageId: page.id, conversationPageId: conversation.id });
  }

  const messages = await queryAllPages(messagesDataSourceId, {
    page_size: limit,
    filter: { property: '發話者 ID', rich_text: { is_not_empty: true } },
    sorts: [{ property: '排序時間', direction: 'descending' }],
  });

  const memberMap = new Map();
  for (const message of messages) {
    const relationIds = pageRelationIds(message, '對話主檔');
    const groupOption = groupOptions.find((option) => relationIds.includes(option.conversationPageId));
    if (!groupOption) continue;
    const userId = pageText(message, '發話者 ID');
    if (!userId || userId === groupOption.targetId) continue;
    const key = `${groupOption.pageId}:${userId}`;
    const existing = memberMap.get(key);
    const seenAt = pageDate(message, '排序時間');
    if (existing) {
      existing.count += 1;
      if (seenAt && (!existing.lastSeenAt || new Date(seenAt) > new Date(existing.lastSeenAt))) {
        existing.lastSeenAt = seenAt;
      }
      continue;
    }
    memberMap.set(key, {
      userId,
      displayName: pageText(message, '發話者名稱') || '未命名成員',
      groupPageId: groupOption.pageId,
      groupId: groupOption.targetId,
      groupName: groupOption.displayName,
      lastSeenAt: seenAt,
      count: 1,
    });
  }

  const members = [];
  for (const member of memberMap.values()) {
    const page = await createPage(groupMembersDataSourceId, {
      成員選項名稱: titleProperty(`${member.groupName} / ${member.displayName}`),
      成員顯示名稱: richTextProperty(member.displayName),
      UserID: richTextProperty(member.userId),
      GroupID: richTextProperty(member.groupId),
      群組顯示名稱: richTextProperty(member.groupName),
      LINE群組: relationProperty([member.groupPageId]),
      來源: richTextProperty('Seven LINE 訊息紀錄'),
      最後出現時間: member.lastSeenAt ? dateProperty(member.lastSeenAt) : undefined,
      出現次數: numberProperty(member.count),
      同步狀態: selectProperty('自動建立'),
    });
    members.push({ ...member, pageId: page.id });
  }

  const responsibilities = [];
  for (const project of sevenProjectOptions()) {
    const page = await createPage(responsibilityDataSourceId, {
      權責項目名稱: titleProperty(project),
      '第一層：總控專案': selectProperty(project),
      選擇狀態: selectProperty('待選群組'),
      選擇說明: richTextProperty('請執行候選同步後，從候選對話群組中選出主要群組，再選主要負責人。'),
      責任說明: richTextProperty('由主專案負責人口述確認此專案的權責窗口與完成目標。'),
      更新時間: dateProperty(new Date()),
    });
    responsibilities.push({ project, pageId: page.id });
  }

  return {
    ok: true,
    created: {
      groupOptions: groupOptions.length,
      groupMembers: members.length,
      responsibilityRows: responsibilities.length,
    },
    note: 'Run npm run responsibility:sync -- --dry-run, then npm run responsibility:sync to refresh candidate relations.',
  };
}

function groupOptionProperties() {
  return {
    群組顯示名稱: { title: {} },
    LINE對話名稱: { rich_text: {} },
    自定義名稱: { rich_text: {} },
    GroupID: { rich_text: {} },
    對象類型: {
      select: {
        options: [
          { name: 'group', color: 'blue' },
          { name: 'room', color: 'purple' },
          { name: 'unknown', color: 'gray' },
        ],
      },
    },
    總控專案: projectSelectSchema(),
    來源對話頁ID: { rich_text: {} },
    對話頁面URL: { url: {} },
    '訊息數（總）': { number: { format: 'number' } },
    最後訊息時間: { date: {} },
    同步狀態: {
      select: {
        options: [
          { name: '自動建立', color: 'blue' },
          { name: '手動新增', color: 'green' },
          { name: '需確認', color: 'yellow' },
          { name: '停用', color: 'gray' },
        ],
      },
    },
  };
}

function groupMemberProperties(groupOptionsDataSourceId) {
  return {
    成員選項名稱: { title: {} },
    成員顯示名稱: { rich_text: {} },
    UserID: { rich_text: {} },
    GroupID: { rich_text: {} },
    群組顯示名稱: { rich_text: {} },
    LINE群組: { relation: { data_source_id: groupOptionsDataSourceId, single_property: {} } },
    來源: { rich_text: {} },
    最後出現時間: { date: {} },
    出現次數: { number: { format: 'number' } },
    同步狀態: {
      select: {
        options: [
          { name: '自動建立', color: 'blue' },
          { name: '手動新增', color: 'green' },
          { name: '需確認', color: 'yellow' },
          { name: '停用', color: 'gray' },
        ],
      },
    },
  };
}

function responsibilityProperties(groupOptionsDataSourceId, groupMembersDataSourceId) {
  return {
    權責項目名稱: { title: {} },
    '第一層：總控專案': projectSelectSchema(),
    '候選對話群組（依專案自動帶出）': { relation: { data_source_id: groupOptionsDataSourceId, single_property: {} } },
    候選群組數: { number: { format: 'number' } },
    '第二層：主要對話群組': { relation: { data_source_id: groupOptionsDataSourceId, single_property: {} } },
    '候選負責人（依群組自動帶出）': { relation: { data_source_id: groupMembersDataSourceId, single_property: {} } },
    候選負責人數: { number: { format: 'number' } },
    '第三層：主要負責人': { relation: { data_source_id: groupMembersDataSourceId, single_property: {} } },
    備援對話群組: { relation: { data_source_id: groupOptionsDataSourceId, single_property: {} } },
    備援負責人: { relation: { data_source_id: groupMembersDataSourceId, single_property: {} } },
    選擇狀態: {
      select: {
        options: [
          { name: '待選專案', color: 'gray' },
          { name: '待補專案群組', color: 'red' },
          { name: '待選群組', color: 'yellow' },
          { name: '待補群組成員', color: 'orange' },
          { name: '待選負責人', color: 'purple' },
          { name: '已完成', color: 'green' },
        ],
      },
    },
    選擇說明: { rich_text: {} },
    'LINE對象名稱（結果）': { rich_text: {} },
    'LINE對象ID（結果）': { rich_text: {} },
    'LINE對象類型（結果）': {
      select: {
        options: [
          { name: 'user', color: 'green' },
          { name: 'group', color: 'blue' },
          { name: 'room', color: 'purple' },
          { name: 'unknown', color: 'gray' },
        ],
      },
    },
    責任說明: { rich_text: {} },
    更新時間: { date: {} },
  };
}

async function createDatabase({ title, dataSourceTitle, properties }) {
  const body = {
    parent: { type: 'page_id', page_id: resolvedParentPageId },
    title: [{ type: 'text', text: { content: title } }],
    is_inline: false,
    initial_data_source: {
      title: [{ type: 'text', text: { content: dataSourceTitle } }],
      properties,
    },
  };

  try {
    return await notionRequest('/v1/databases', { method: 'POST', body });
  } catch (error) {
    if (!String(error?.message || '').includes('Parent block type column cannot contain databases')) {
      throw error;
    }
    const ancestorPageId = await findAncestorPageId(resolvedParentPageId);
    if (!ancestorPageId || ancestorPageId === resolvedParentPageId) {
      throw error;
    }
    resolvedParentPageId = ancestorPageId;
    body.parent = { type: 'page_id', page_id: resolvedParentPageId };
    return notionRequest('/v1/databases', { method: 'POST', body });
  }
}

async function findAncestorPageId(blockId) {
  let currentId = normalizeId(blockId);
  for (let depth = 0; depth < 8 && currentId; depth += 1) {
    const block = await notionRequest(`/v1/blocks/${currentId}`, { method: 'GET' });
    if (block.parent?.type === 'page_id') {
      return normalizeId(block.parent.page_id);
    }
    currentId = normalizeId(block.parent?.block_id || '');
  }
  return '';
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

async function assertSevenDataSource(dataSourceId) {
  const dataSource = await notionRequest(`/v1/data_sources/${dataSourceId}`, { method: 'GET' });
  const title = plainText(dataSource.title);
  if (!/(Seven|好住|寓好|LINE|Responsibility|group|member)/i.test(title)) {
    fail(`Refusing to write to non-Seven data source: ${title || dataSourceId}`);
  }
  return dataSource;
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

function normalizeConversationOption(page) {
  const targetType = normalizeTargetType(pageSelect(page, '對象類型') || 'unknown');
  const lineName = pageText(page, 'LINE 對話名稱');
  const customName = pageText(page, '自定義名稱');
  const displayName = customName || lineName || `${targetType} ${page.id}`;
  const targetId = targetType === 'room' ? pageText(page, 'Room ID') : pageText(page, 'Group ID');
  const haystack = `${displayName} ${pageText(page, '最新訊息預覽')}`;
  return {
    targetType,
    lineName,
    customName,
    displayName,
    targetId,
    project: inferProject(haystack),
    messageCount: pageNumber(page, '訊息數（總）'),
    lastMessageAt: pageDate(page, '最後訊息時間'),
  };
}

function normalizeTargetType(value) {
  if (value === '群組') return 'group';
  if (value === '聊天室') return 'room';
  if (value === '個人') return 'user';
  if (value === '未知') return 'unknown';
  return value || 'unknown';
}

function inferProject(value) {
  const text = String(value || '');
  if (/法規|合規|公司治理|合約|稅務|發票|保險|股東|登記/.test(text)) return '公司治理、法規合規';
  if (/場域|採購|組裝|家具|設備|資產|裝修|工程|點交|硬體/.test(text)) return '場域建置、資產採購';
  if (/品牌|官網|網站|內容|文案|SEO|照片|視覺|社群/.test(text)) return '品牌官網內容';
  if (/通路|營收|訂房|OTA|銷售|價格|房價|上架|導流/.test(text)) return '營運類：通路與營收啟動';
  if (/交接|房務|清潔|維護|修繕|營運|SOP|入住|退房|管家/.test(text)) return '營運類：交接、房務、營運維護';
  if (/系統|自動化|Notion|LINE|資料|Codex|Render|Webhook|API|報告/.test(text)) return '系統自動化與資料治理';
  return '未分類';
}

function projectSelectSchema() {
  return {
    select: {
      options: sevenProjectOptions().map((name, index) => ({
        name,
        color: ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'][index] || 'gray',
      })),
    },
  };
}

function sevenProjectOptions() {
  return [
    '公司治理、法規合規',
    '場域建置、資產採購',
    '品牌官網內容',
    '營運類：通路與營收啟動',
    '營運類：交接、房務、營運維護',
    '系統自動化與資料治理',
    '未分類',
  ];
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

function numberProperty(value) {
  return Number.isFinite(value) ? { number: value } : undefined;
}

function dateProperty(value) {
  return { date: { start: value instanceof Date ? value.toISOString() : new Date(value).toISOString() } };
}

function relationProperty(ids) {
  return { relation: ids.map((id) => ({ id })) };
}

function urlProperty(value) {
  return value ? { url: value } : undefined;
}

function pageText(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return plainText(property?.title || property?.rich_text || []);
}

function pageSelect(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.select?.name || '';
}

function pageDate(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.date?.start || '';
}

function pageNumber(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return Number(property?.number || 0);
}

function pageRelationIds(page, propertyName) {
  return (page?.properties?.[propertyName]?.relation || []).map((item) => item.id).filter(Boolean);
}

function plainText(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function dataSourceIdFromDatabase(database) {
  return database.data_sources?.[0]?.id || database.data_sources?.[0]?.data_source_id || null;
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function normalizeId(value) {
  return String(value || '').replace(/-/g, '').trim();
}

function clampText(value) {
  return String(value || '').slice(0, 1900);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function requiredArg(name, fallback = '') {
  const value = String(args[name] || fallback || '').trim();
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

function fail(message) {
  console.error(message);
  process.exit(1);
}


