import { existsSync, readFileSync, writeFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const outgoingActorName = process.env.SEVEN_OUTGOING_ACTOR_NAME || 'Seven Jr.';

const args = parseArgs(process.argv.slice(2));
const outputPath = String(args.output || 'conversation-dump.json');
const contextLimit = clampNumber(Number(args['context-limit'] || 30), 5, 80);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!conversationsDataSourceId) fail('SEVEN_CONVERSATIONS_DATA_SOURCE_ID is not set.');

const conversations = [];
let startCursor;
do {
  const body = { page_size: 100, sorts: [{ property: '最後訊息時間', direction: 'descending' }] };
  if (startCursor) body.start_cursor = startCursor;
  const result = await notionRequest(`/v1/data_sources/${conversationsDataSourceId}/query`, { method: 'POST', body });
  conversations.push(...(result.results || []).map(normalizeConversationPage));
  startCursor = result.has_more ? result.next_cursor : null;
} while (startCursor);

const dump = [];
for (const conversation of conversations) {
  const timeline = await loadConversationTimeline(conversation);
  dump.push({
    id: conversation.id,
    url: conversation.url,
    name: conversation.name,
    type: conversation.type,
    project: conversation.project,
    lastMessageTime: conversation.lastMessageTime,
    isMainController: conversation.isMainController,
    messageCount: timeline.length,
    messages: timeline,
  });
  console.error(`dumped: ${conversation.name} (${timeline.length} messages)`);
}

writeFileSync(outputPath, JSON.stringify(dump, null, 1));
console.log(JSON.stringify({
  ok: true,
  conversations: dump.length,
  withMessages: dump.filter((item) => item.messageCount > 0).length,
  totalMessages: dump.reduce((sum, item) => sum + item.messageCount, 0),
  outputPath,
}));

function normalizeConversationPage(page) {
  const properties = page.properties || {};
  const name = textProperty(properties['LINE 對話名稱']) || textProperty(properties['自定義名稱']) || page.id;
  return {
    id: page.id,
    url: page.url,
    name,
    type: selectName(properties['對象類型']),
    lastMessageTime: properties['最後訊息時間']?.date?.start || '',
    project: selectName(properties['總控專案']) || '',
    isMainController: isMainControllerConversationName(name),
  };
}

function isMainControllerConversationName(name) {
  const normalized = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (!normalized) return false;
  return ['sevenjunior', '7junior', 'sevenjr.', '7jr.', 'hozojunior', 'hozojr.']
    .some((alias) => normalized.includes(alias));
}

async function loadConversationTimeline(conversation) {
  const blocks = await getBlockChildren(conversation.id);
  const messages = [];
  let current = null;

  for (const block of blocks) {
    const text = plainBlockText(block).trim();
    if (!text || text.includes('LINE 對話記錄')) continue;

    const meta = parseConversationMessageMeta(text);
    if (meta) {
      if (current) messages.push(finalizeTimelineMessage(current));
      current = { ...meta, contentLines: [] };
      continue;
    }
    if (current) current.contentLines.push(text);
  }
  if (current) messages.push(finalizeTimelineMessage(current));

  return messages.slice(0, contextLimit).reverse();
}

function parseConversationMessageMeta(text) {
  const incoming = text.match(/^【(.+?)】(.+?) - (.+?)（(.+?)）$/);
  if (incoming) {
    return { timeText: incoming[1], actor: incoming[3].trim(), source: 'line' };
  }
  const outgoing = text.match(/^【(.+?)】(.+?)：(.+?)$/);
  if (outgoing) {
    return {
      timeText: outgoing[1],
      actor: outgoing[2].trim(),
      source: outgoing[2].trim() === outgoingActorName ? 'ai-engine' : 'line',
    };
  }
  return null;
}

function finalizeTimelineMessage(meta) {
  return {
    timeText: meta.timeText,
    actor: meta.actor,
    source: meta.source,
    text: meta.contentLines.join('\n').trim(),
  };
}

async function getBlockChildren(blockId) {
  const blocks = [];
  let cursor;
  do {
    const query = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=100';
    const result = await notionRequest(`/v1/blocks/${blockId}/children${query}`, { method: 'GET' });
    blocks.push(...(result.results || []));
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return blocks;
}

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

    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 300)}`);
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

function selectName(property) {
  return property?.select?.name || '';
}

function plainBlockText(block) {
  const data = block?.[block?.type] || {};
  return (data.rich_text || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

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
