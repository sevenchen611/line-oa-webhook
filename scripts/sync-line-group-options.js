import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const groupOptionsDataSourceId = process.env.SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID || '';
const groupMembersDataSourceId = process.env.SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID || '';
const memberIndexDataSourceId = process.env.SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID || '';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const limit = clampNumber(Number(args.limit || 100), 1, 100);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!conversationsDataSourceId) fail('SEVEN_CONVERSATIONS_DATA_SOURCE_ID is not set.');
if (!groupOptionsDataSourceId) fail('SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID is not set.');
if (!groupMembersDataSourceId) fail('SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID is not set.');
if (!memberIndexDataSourceId) fail('SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID is not set.');

try {
  await Promise.all([
    assertSevenDataSource(conversationsDataSourceId),
    assertSevenDataSource(groupOptionsDataSourceId),
    assertSevenDataSource(groupMembersDataSourceId),
    assertSevenDataSource(memberIndexDataSourceId),
  ]);

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
  const existingGroups = await queryAllPages(groupOptionsDataSourceId, { page_size: 100 });
  const existingMembers = await queryAllPages(groupMembersDataSourceId, { page_size: 100 });
  const memberIndexRows = await queryAllPages(memberIndexDataSourceId, { page_size: 100 });

  const existingGroupsBySourcePage = new Map();
  const existingGroupsByTarget = new Map();
  for (const page of existingGroups) {
    const option = normalizeGroupOptionPage(page);
    if (option.sourceConversationPageId) existingGroupsBySourcePage.set(option.sourceConversationPageId, option);
    if (option.targetKey) existingGroupsByTarget.set(option.targetKey, option);
  }

  const createdGroups = [];
  const updatedGroups = [];
  const activeGroupOptions = new Map();

  for (const conversation of conversations) {
    const option = normalizeConversationOption(conversation);
    if (!option.targetId || option.targetType === 'unknown') continue;

    const existing = existingGroupsBySourcePage.get(conversation.id) || existingGroupsByTarget.get(option.targetKey);
    if (!existing) {
      createdGroups.push(option);
      if (!dryRun) {
        const page = await createPage(groupOptionsDataSourceId, groupOptionProperties(option, conversation));
        const normalized = normalizeGroupOptionPage(page);
        activeGroupOptions.set(conversation.id, normalized);
        existingGroupsBySourcePage.set(conversation.id, normalized);
        existingGroupsByTarget.set(option.targetKey, normalized);
      }
      continue;
    }

    activeGroupOptions.set(conversation.id, existing);
    const patch = groupOptionUpdateProperties(option, conversation, existing);
    if (Object.keys(patch).length) {
      updatedGroups.push({ ...option, pageId: existing.id });
      if (!dryRun) {
        await updatePage(existing.id, patch);
      }
    }
  }

  if (dryRun) {
    for (const conversation of conversations) {
      const option = normalizeConversationOption(conversation);
      const existing = existingGroupsBySourcePage.get(conversation.id) || existingGroupsByTarget.get(option.targetKey);
      if (existing) activeGroupOptions.set(conversation.id, existing);
    }
  }

  const existingMemberKeys = new Set(existingMembers.map((page) => normalizeMemberKey(page)).filter(Boolean));
  const memberCandidates = new Map();
  for (const indexRow of memberIndexRows.map(normalizeMemberIndexRow)) {
    if (!indexRow.userId || indexRow.status === 'left') continue;
    const groupOption = [...activeGroupOptions.values()].find((option) => option.targetKey === indexRow.targetKey);
    if (!groupOption) continue;

    const userId = indexRow.userId;
    if (!userId || userId === groupOption.groupId) continue;

    const key = `${groupOption.id}:${userId}`;
    if (existingMemberKeys.has(key)) continue;

    const seenAt = indexRow.lastSeenAt || indexRow.syncedAt;
    const existing = memberCandidates.get(key);
    if (existing) {
      existing.count += 1;
      if (seenAt && (!existing.lastSeenAt || new Date(seenAt) > new Date(existing.lastSeenAt))) {
        existing.lastSeenAt = seenAt;
      }
      continue;
    }

    memberCandidates.set(key, {
      userId,
      displayName: indexRow.displayName || '未命名成員',
      groupPageId: groupOption.id,
      groupId: groupOption.groupId,
      groupName: groupOption.title,
      lastSeenAt: seenAt,
      count: 1,
    });
  }

  const createdMembers = Array.from(memberCandidates.values());
  if (!dryRun) {
    for (const member of createdMembers) {
      await createPage(groupMembersDataSourceId, {
        成員選項名稱: titleProperty(`${member.groupName} / ${member.displayName}`),
        成員顯示名稱: richTextProperty(member.displayName),
        UserID: richTextProperty(member.userId),
        GroupID: richTextProperty(member.groupId),
        群組顯示名稱: richTextProperty(member.groupName),
        LINE群組: relationProperty([member.groupPageId]),
        來源: richTextProperty('7AM LINE 群組成員索引'),
        最後出現時間: member.lastSeenAt ? dateProperty(member.lastSeenAt) : undefined,
        出現次數: numberProperty(member.count),
        同步狀態: selectProperty('自動建立'),
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    scannedConversations: conversations.length,
    existingGroupOptions: existingGroups.length,
    createdGroupOptions: createdGroups.map((item) => ({
      displayName: item.displayName,
      targetType: item.targetType,
      project: item.project,
    })),
    updatedGroupOptions: updatedGroups.map((item) => item.displayName),
    createdMemberOptions: createdMembers.map((item) => ({
      groupName: item.groupName,
      displayName: item.displayName,
    })),
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function normalizeConversationOption(page) {
  const targetType = normalizeTargetType(pageSelect(page, '對象類型') || 'unknown');
  const lineName = pageText(page, 'LINE 對話名稱');
  const customName = pageText(page, '自定義名稱');
  const displayName = customName || lineName || `${targetType} ${page.id}`;
  const targetId = targetType === 'room' ? pageText(page, 'Room ID') : pageText(page, 'Group ID');
  const haystack = `${displayName} ${pageText(page, '最新訊息預覽')}`;
  return {
    sourceConversationPageId: page.id,
    sourceConversationUrl: page.url,
    targetType,
    targetId,
    targetKey: `${targetType}:${targetId}`,
    lineName,
    customName,
    displayName,
    project: inferProject(haystack),
    messageCount: pageNumber(page, '訊息數（總）'),
    lastMessageAt: pageDate(page, '最後訊息時間'),
  };
}

function normalizeGroupOptionPage(page) {
  const groupId = pageText(page, 'GroupID');
  const targetType = selectName(page.properties?.['對象類型']) || 'group';
  return {
    id: page.id,
    title: pageTitle(page, '群組顯示名稱') || pageText(page, 'LINE對話名稱') || pageText(page, '自定義名稱'),
    lineName: pageText(page, 'LINE對話名稱'),
    customName: pageText(page, '自定義名稱'),
    groupId,
    targetType,
    targetKey: `${targetType}:${groupId}`,
    sourceConversationPageId: pageText(page, '來源對話頁ID'),
    sourceConversationUrl: page.properties?.['對話頁面URL']?.url || '',
    project: selectName(page.properties?.['總控專案']),
    messageCount: pageNumber(page, '訊息數（總）'),
    lastMessageAt: pageDate(page, '最後訊息時間'),
  };
}

function groupOptionProperties(option, conversation) {
  return {
    群組顯示名稱: titleProperty(option.displayName),
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
  };
}

function groupOptionUpdateProperties(option, conversation, existing) {
  const properties = {};
  if (!existing.sourceConversationPageId) properties.來源對話頁ID = richTextProperty(conversation.id);
  if (!existing.groupId && option.targetId) properties.GroupID = richTextProperty(option.targetId);
  if (!existing.title && option.displayName) properties.群組顯示名稱 = titleProperty(option.displayName);
  if ((!existing.project || (existing.project !== option.project && option.project !== '未分類')) && option.project) {
    properties.總控專案 = selectProperty(option.project);
  }
  if (existing.lineName !== option.lineName) properties.LINE對話名稱 = richTextProperty(option.lineName);
  if (existing.customName !== option.customName) properties.自定義名稱 = richTextProperty(option.customName);
  if (existing.sourceConversationUrl !== conversation.url) properties.對話頁面URL = urlProperty(conversation.url);
  if (existing.messageCount !== option.messageCount) properties['訊息數（總）'] = numberProperty(option.messageCount);
  if (option.lastMessageAt && normalizeDate(existing.lastMessageAt) !== normalizeDate(option.lastMessageAt)) {
    properties.最後訊息時間 = dateProperty(option.lastMessageAt);
  }
  return compactProperties(properties);
}

function normalizeMemberKey(page) {
  const userId = pageText(page, 'UserID');
  const groupPageIds = relationIds(page.properties?.['LINE群組']);
  if (!userId || !groupPageIds.length) return '';
  return `${groupPageIds[0]}:${userId}`;
}

function normalizeMemberIndexRow(page) {
  const targetType = selectName(page.properties?.['對象類型']) || 'group';
  const targetId = targetType === 'room' ? pageText(page, 'RoomID') : pageText(page, 'GroupID');
  return {
    userId: pageText(page, 'UserID'),
    displayName: pageText(page, '成員顯示名稱') || pageTitle(page, '成員索引名稱'),
    targetType,
    targetId,
    targetKey: `${targetType}:${targetId}`,
    status: selectName(page.properties?.['成員狀態']) || 'unknown',
    syncedAt: pageDate(page, '最後同步時間'),
    lastSeenAt: pageDate(page, '最後出現時間'),
  };
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

async function assertSevenDataSource(dataSourceId) {
  const dataSource = await notionRequest(`/v1/data_sources/${dataSourceId}`, { method: 'GET' });
  const title = plainText(dataSource.title || []);
  if (!/(Seven|7AM|七號|SevenAM|LINE|Responsibility|group|member|conversation)/i.test(title)) {
    fail(`Refusing to write to non-7AM data source: ${title || dataSourceId}`);
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

function normalizeTargetType(value) {
  if (value === '群組') return 'group';
  if (value === '聊天室') return 'room';
  if (value === '個人') return 'user';
  if (value === '未知') return 'unknown';
  return value || 'unknown';
}

function inferProject(value) {
  const text = String(value || '');
  if (/綦盛|恰恰小紅帽|茲心園|D\s*區|J\s*棟|建照|雜照|基地位置圖|工務|場域|採購|組裝|家具|設備|資產|裝修|工程|點交|硬體|維修|修繕|營造|估價|設計圖/.test(text)) return '茲心園工程';
  if (/法規|合規|公司治理|公司設立|設立|合約|稅務|發票|保險|股東|登記|付款|匯款|報稅|銀行|股權移轉/.test(text)) return '財務';
  if (/房客|租客|包租|代管|住客|客訴|客服|體驗|入住|退房|房務|清潔|管家/.test(text)) return '包租代管';
  if (/人資|薪資|Bonnie|同仁|離職|退保|招募|面試/.test(text)) return '人資';
  if (/系統|自動化|Notion|LINE|資料|Codex|Render|Webhook|API|報告|公司助理系統|手機.*會議記錄/.test(text)) return '營運';
  if (/媽媽|溪州|天才家族|讀書會|私人/.test(text)) return '私人事務';
  return '未分類';
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

function relationIds(property) {
  return (property?.relation || []).map((item) => item.id).filter(Boolean);
}

function pageTitle(page, propertyName) {
  return plainText(page?.properties?.[propertyName]?.title || []);
}

function pageText(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return plainText(property?.title || property?.rich_text || []);
}

function pageSelect(page, propertyName) {
  return selectName(page?.properties?.[propertyName]);
}

function pageDate(page, propertyName) {
  return page?.properties?.[propertyName]?.date?.start || '';
}

function pageNumber(page, propertyName) {
  return Number(page?.properties?.[propertyName]?.number || 0);
}

function normalizeDate(value) {
  if (!value) return '';
  return new Date(value).toISOString();
}

function selectName(property) {
  return property?.select?.name || '';
}

function plainText(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function clampText(value) {
  return String(value || '').slice(0, 1900);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
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

