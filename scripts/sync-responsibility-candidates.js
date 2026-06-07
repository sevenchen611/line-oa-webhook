import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const responsibilityDataSourceId = process.env.SEVEN_RESPONSIBILITY_DATA_SOURCE_ID || '';
const groupOptionsDataSourceId = process.env.SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID || '';
const groupMembersDataSourceId = process.env.SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID || '';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const limit = clampNumber(Number(args.limit || 100), 1, 100);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!responsibilityDataSourceId) fail('SEVEN_RESPONSIBILITY_DATA_SOURCE_ID is not set.');
if (!groupOptionsDataSourceId) fail('SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID is not set.');
if (!groupMembersDataSourceId) fail('SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID is not set.');

try {
  const [responsibilities, groups, members] = await Promise.all([
    queryAllPages(responsibilityDataSourceId, { page_size: limit }),
    queryAllPages(groupOptionsDataSourceId, { page_size: 100 }),
    queryAllPages(groupMembersDataSourceId, { page_size: 100 }),
  ]);

  const groupOptions = groups.map(normalizeGroupOption);
  const memberOptions = members.map(normalizeMemberOption);
  const results = [];

  for (const page of responsibilities) {
    const result = buildResponsibilityCandidateUpdate(page, groupOptions, memberOptions);
    results.push(result);
    if (!dryRun) {
      await updatePage(page.id, result.properties);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    responsibilityRows: responsibilities.length,
    groupOptions: groupOptions.length,
    memberOptions: memberOptions.length,
    updatedRows: results.length,
    results: results.map((item) => ({
      name: item.name,
      project: item.project,
      candidateGroups: item.candidateGroupCount,
      candidateMembers: item.candidateMemberCount,
      status: item.status,
    })),
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function buildResponsibilityCandidateUpdate(page, groupOptions, memberOptions) {
  const props = page.properties || {};
  const name = titleText(props['權責項目名稱'] || props['專案或任務名稱'] || props['名稱']);
  const project = selectName(props['第一層：總控專案'] || props['對應總控專案']);
  const selectedGroupIds = relationIds(props['第二層：主要對話群組'] || props['對話群組（Group ID）']);
  const selectedMemberIds = relationIds(props['第三層：主要負責人'] || props['主要負責人（User ID）']);

  const candidateGroups = project
    ? groupOptions.filter((group) => group.project === project)
    : [];
  const candidateGroupIds = candidateGroups.map((group) => group.id).slice(0, 100);

  const candidateMembers = selectedGroupIds.length
    ? memberOptions.filter((member) => member.groupPageIds.some((groupId) => selectedGroupIds.includes(groupId)))
    : [];
  const candidateMemberIds = candidateMembers.map((member) => member.id).slice(0, 100);

  const selectedMember = selectedMemberIds.length
    ? memberOptions.find((member) => selectedMemberIds.includes(member.id))
    : null;
  const selectedGroup = selectedGroupIds.length
    ? groupOptions.find((group) => selectedGroupIds.includes(group.id))
    : null;

  const status = getSelectionStatus({
    project,
    selectedGroupIds,
    selectedMemberIds,
    candidateGroupCount: candidateGroups.length,
    candidateMemberCount: candidateMembers.length,
  });

  const properties = {
    '候選對話群組（依專案自動帶出）': relationProperty(candidateGroupIds),
    '候選負責人（依群組自動帶出）': relationProperty(candidateMemberIds),
    候選群組數: { number: candidateGroups.length },
    候選負責人數: { number: candidateMembers.length },
    選擇狀態: { select: { name: status } },
    選擇說明: {
      rich_text: [{
        type: 'text',
        text: {
          content: buildInstruction({ project, candidateGroups, selectedGroup, candidateMembers }),
        },
      }],
    },
  };

  if (selectedMember) {
    properties['LINE對象名稱（結果）'] = richTextProperty(selectedMember.memberName || selectedMember.title);
    properties['LINE對象ID（結果）'] = richTextProperty(selectedMember.userId);
    properties['LINE對象類型（結果）'] = { select: { name: 'user' } };
  } else if (selectedGroup) {
    properties['LINE對象名稱（結果）'] = richTextProperty(selectedGroup.title);
    properties['LINE對象ID（結果）'] = richTextProperty(selectedGroup.groupId);
    properties['LINE對象類型（結果）'] = { select: { name: 'group' } };
  }

  return {
    name,
    project,
    candidateGroupCount: candidateGroups.length,
    candidateMemberCount: candidateMembers.length,
    status,
    properties,
  };
}

function getSelectionStatus({ project, selectedGroupIds, selectedMemberIds, candidateGroupCount, candidateMemberCount }) {
  if (!project) return '待選專案';
  if (!selectedGroupIds.length) return candidateGroupCount > 0 ? '待選群組' : '待補專案群組';
  if (!candidateMemberCount) return '待補群組成員';
  if (!selectedMemberIds.length) return '待選負責人';
  return '已完成';
}

function buildInstruction({ project, candidateGroups, selectedGroup, candidateMembers }) {
  if (!project) {
    return '請先選擇「第一層：總控專案」。系統會依專案自動列出候選 LINE 群組。';
  }
  if (!selectedGroup) {
    return `目前專案「${project}」有 ${candidateGroups.length} 個候選 LINE 群組。請從「候選對話群組（依專案自動帶出）」中挑一個，填到「第二層：主要對話群組」。`;
  }
  return `已選主要群組「${selectedGroup.title}」。系統找到 ${candidateMembers.length} 個候選成員，請從「候選負責人（依群組自動帶出）」中挑主辦人，填到「第三層：主要負責人」。`;
}

function normalizeGroupOption(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    title: titleText(props['群組顯示名稱']) || textProperty(props['LINE對話名稱']) || textProperty(props['自定義名稱']),
    project: selectName(props['總控專案']),
    groupId: textProperty(props.GroupID),
  };
}

function normalizeMemberOption(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    title: titleText(props['成員選項名稱']),
    memberName: textProperty(props['成員顯示名稱']),
    userId: textProperty(props.UserID),
    groupId: textProperty(props.GroupID),
    groupName: textProperty(props['群組顯示名稱']),
    groupPageIds: relationIds(props['LINE群組']),
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

async function updatePage(pageId, properties) {
  return notionRequest(`/v1/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties },
  });
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

function relationProperty(ids) {
  return { relation: ids.map((id) => ({ id })) };
}

function richTextProperty(content) {
  return { rich_text: content ? [{ type: 'text', text: { content } }] : [] };
}

function relationIds(property) {
  return (property?.relation || []).map((item) => item.id).filter(Boolean);
}

function selectName(property) {
  return property?.select?.name || '';
}

function titleText(property) {
  return (property?.title || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function textProperty(property) {
  return (property?.rich_text || property?.title || []).map((item) => item.plain_text || item.text?.content || '').join('');
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
