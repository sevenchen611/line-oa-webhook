// Next Action 排程引擎（每 15 分鐘由 Render Cron 觸發）。
//
// 掃描 總控任務庫 中「下次行動時間 <= 現在」且未完成/未封存的任務，依 下次行動模式 觸發：
//   自動發送：把 預定訊息內容 發到 預定發送對象（沒設定就回退到來源對話），
//             發送後狀態改 等待回覆、暫緩追蹤 2 天，並 LINE 通知控制者已代發。
//   提醒我（預設）：LINE 提醒控制者該行動了，附上 下次行動說明、預定訊息草稿
//             與 Dashboard 任務頁連結，由控制者決定下一步。
//
// 死人開關語意：前一步行動有發生時，使用者/AI 會改寫或清除 下次行動時間；
// 都沒人動，時間一到這裡就會觸發。觸發後一律清除 下次行動時間（一次性），
// 並把觸發紀錄寫進任務內文。

import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const controlLinePushUrl = process.env.CONTROL_LINE_PUSH_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/line/push';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY || '';
const publicBaseUrl = (process.env.SEVEN_PUBLIC_BASE_URL || 'https://line-oa-webhook-nn5j.onrender.com').replace(/\/+$/, '');

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const limit = clampNumber(Number(args.limit || 20), 1, 50);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!controlApiKey && !dryRun) fail('SEVEN_CONTROL_API_KEY is not set.');

const startedAt = new Date();
await ensurePlannedActionProperties();
const dueTasks = await listDueTasks();
const results = [];

for (const task of dueTasks) {
  try {
    results.push(await fireNextAction(task));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Next action for ${task.title} failed: ${message}`);
    results.push({ task: task.title, action: 'failed', error: message });
    // 失敗時把觸發時間往後推 2 小時再重試，避免每 15 分鐘轟炸；並通知控制者避免無聲卡住。
    await deferNextActionTime(task.pageId, 2).catch(() => {});
    await notifyController([
      `Seven Jr. 排程行動失敗 ⚠️`,
      `任務：${task.title}`,
      `原因：${clampText(message, 300)}`,
      `任務頁：${dashboardTaskUrl(task.pageId)}`,
    ].join('\n')).catch(() => {});
  }
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  scanned: dueTasks.length,
  sent: results.filter((item) => item.action === 'sent').length,
  reminded: results.filter((item) => item.action === 'reminded').length,
  skipped: results.filter((item) => item.action === 'skipped').length,
  failed: results.filter((item) => item.action === 'failed').length,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  results,
}, null, 2));

// 欄位可能尚未建立（與 control-api 的 ensureTaskReviewProperties 同一組），先確保存在再查詢。
async function ensurePlannedActionProperties() {
  try {
    await notionRequest(`/v1/data_sources/${tasksDataSourceId}`, {
      method: 'PATCH',
      body: {
        properties: {
          預定訊息內容: { rich_text: {} },
          預定發送對象: { rich_text: {} },
          預定發送對象ID: { rich_text: {} },
          下次行動時間: { date: {} },
          下次行動模式: { select: { options: [{ name: '提醒我' }, { name: '自動發送' }] } },
          下次行動說明: { rich_text: {} },
        },
      },
    });
  } catch (error) {
    console.warn(`Unable to ensure planned action properties: ${error.message}`);
  }
}

async function listDueTasks() {
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: limit,
      filter: {
        and: [
          { property: '下次行動時間', date: { on_or_before: new Date().toISOString() } },
          { property: '狀態', select: { does_not_equal: '已完成' } },
          { property: '狀態', select: { does_not_equal: '封存' } },
        ],
      },
      sorts: [{ property: '下次行動時間', direction: 'ascending' }],
    },
  });

  return (result.results || []).map((page) => {
    const properties = page.properties || {};
    return {
      pageId: page.id,
      url: page.url,
      title: textProperty(properties['任務名稱']),
      status: properties['狀態']?.select?.name || '',
      owner: textProperty(properties['負責人']),
      mode: properties['下次行動模式']?.select?.name || '提醒我',
      actionNote: textProperty(properties['下次行動說明']),
      plannedMessage: textProperty(properties['預定訊息內容']),
      plannedTargetName: textProperty(properties['預定發送對象']),
      plannedTargetId: textProperty(properties['預定發送對象ID']),
      conversationUrl: properties['關聯 Notion 頁面']?.url || '',
      fireAt: properties['下次行動時間']?.date?.start || '',
    };
  }).filter((task) => task.title);
}

async function fireNextAction(task) {
  const firedAtText = formatTaipeiDateTime(new Date());

  if (task.mode === '自動發送') {
    if (!task.plannedMessage) {
      // 設了自動發送卻沒寫內容：降級為提醒，請控制者補內容。
      return remind(task, firedAtText, '（此任務排了自動發送，但沒有預定訊息內容，請補上內容或改手動處理）');
    }

    const target = parsePlannedTarget(task.plannedTargetId, task.plannedTargetName)
      || await resolveConversationTarget(task.conversationUrl);
    if (!target) {
      return remind(task, firedAtText, '（此任務排了自動發送，但找不到發送對象，請設定預定發送對象）');
    }

    if (dryRun) return { task: task.title, action: 'sent', dryRun: true, target: target.id };

    await pushViaControl([{ id: target.id, type: target.type, name: target.name || task.plannedTargetName }], task.plannedMessage);
    await appendTaskRecord(task.pageId, `排程訊息已自動發送（${firedAtText}）`, task.plannedMessage,
      `發送對象：${target.name || task.plannedTargetName || target.id}（${target.type}）；由排程引擎依你先前核准的內容與時間自動發送。`);
    await patchTaskAfterSend(task);
    await notifyController([
      'Seven Jr. 已代你發送排程訊息 📨',
      `任務：${task.title}`,
      `對象：${target.name || task.plannedTargetName || target.id}`,
      `內容：${clampText(task.plannedMessage, 200)}`,
      `任務已轉為「等待回覆」，2 天後若無回音會再問你要不要追問。`,
      `任務頁：${dashboardTaskUrl(task.pageId)}`,
    ].join('\n'));

    return { task: task.title, action: 'sent', target: target.id, targetType: target.type };
  }

  return remind(task, firedAtText, '');
}

async function remind(task, firedAtText, extraNote) {
  if (dryRun) return { task: task.title, action: 'reminded', dryRun: true };

  const lines = [
    'Seven Jr. 下次行動提醒 ⏰',
    `任務：${task.title}`,
  ];
  if (task.actionNote) lines.push(`行動：${task.actionNote}`);
  if (task.owner) lines.push(`負責人：${task.owner}`);
  if (task.plannedMessage) lines.push(`預定訊息草稿：${clampText(task.plannedMessage, 200)}`);
  if (task.plannedTargetName) lines.push(`預定對象：${task.plannedTargetName}`);
  if (extraNote) lines.push(extraNote);
  lines.push(`到任務頁發送或改排程：${dashboardTaskUrl(task.pageId)}`);

  await notifyController(lines.join('\n'));
  await appendTaskRecord(task.pageId, `下次行動提醒已發出（${firedAtText}）`,
    task.actionNote || '（未填下次行動說明）',
    `排程引擎已 LINE 提醒控制者。${extraNote || ''}`);
  await clearNextActionTime(task.pageId);

  return { task: task.title, action: 'reminded' };
}

// 預定發送對象ID 格式「type:id」（group:Cxxx／user:Uxxx），也接受裸 LINE ID。
function parsePlannedTarget(spec, name) {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(group|room|user)\s*[:：]\s*(\S+)$/i);
  if (match) return { id: match[2], type: match[1].toLowerCase(), name: String(name || '').trim() };
  if (/^[CRU][0-9a-f]{10,}$/i.test(trimmed)) {
    const type = trimmed.startsWith('U') ? 'user' : trimmed.startsWith('C') ? 'group' : 'room';
    return { id: trimmed, type, name: String(name || '').trim() };
  }
  return null;
}

async function resolveConversationTarget(conversationUrl) {
  const pageId = (String(conversationUrl || '').match(/([0-9a-f]{32})/i) || [])[1];
  if (!pageId) return null;
  try {
    const page = await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
    const properties = page.properties || {};
    const targetType = properties['對象類型']?.select?.name || '';
    const groupId = textProperty(properties['Group ID']);
    const roomId = textProperty(properties['Room ID']);
    const userId = textProperty(properties['User ID']);
    const name = textProperty(properties['自定義名稱'])
      || (properties['LINE 對話名稱']?.title || []).map((item) => item.plain_text || '').join('');
    if (targetType === '群組' && groupId) return { id: groupId, type: 'group', name };
    if (targetType === '聊天室' && roomId) return { id: roomId, type: 'room', name };
    if (userId) return { id: userId, type: 'user', name };
    if (groupId) return { id: groupId, type: 'group', name };
    return null;
  } catch {
    return null;
  }
}

async function pushViaControl(targets, text) {
  const response = await fetch(controlLinePushUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-seven-control-key': controlApiKey },
    body: Buffer.from(JSON.stringify({ targets, text }), 'utf8'),
  });
  if (!response.ok) {
    throw new Error(`Control push failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
}

async function notifyController(text) {
  if (dryRun) return;
  const response = await fetch(controlLinePushUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-seven-control-key': controlApiKey },
    body: Buffer.from(JSON.stringify({ useDefaultReportTarget: true, text }), 'utf8'),
  });
  if (!response.ok) {
    throw new Error(`Controller notify failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
}

async function appendTaskRecord(pageId, heading, content, note) {
  await notionRequest(`/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    body: {
      children: [
        { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: heading } }] } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampText(content, 1800) } }] } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampText(note, 1800) } }], color: 'gray' } },
      ],
    },
  });
}

async function patchTaskAfterSend(task) {
  const now = new Date();
  const snoozeUntil = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const properties = {
    下次行動時間: { date: null },
    追蹤暫緩至: { date: { start: snoozeUntil.toISOString() } },
  };
  if (!['已完成', '封存'].includes(task.status)) {
    properties['狀態'] = { select: { name: '等待回覆' } };
    properties['確認狀態'] = { select: { name: '已確認' } };
  }
  await notionRequest(`/v1/pages/${task.pageId}`, {
    method: 'PATCH',
    body: { properties: { ...properties, 最後更新: { date: { start: now.toISOString() } } } },
  });
}

async function deferNextActionTime(pageId, hours) {
  const deferredTo = new Date(Date.now() + hours * 60 * 60 * 1000);
  await notionRequest(`/v1/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties: { 下次行動時間: { date: { start: deferredTo.toISOString() } } } },
  });
}

async function clearNextActionTime(pageId) {
  await notionRequest(`/v1/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties: { 下次行動時間: { date: null }, 最後更新: { date: { start: new Date().toISOString() } } } },
  });
}

function dashboardTaskUrl(pageId) {
  return `${publicBaseUrl}/dashboard/task?id=${String(pageId || '').replace(/-/g, '')}`;
}

// ---- helpers ----

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
    if (response.ok) return responseText ? JSON.parse(responseText) : {};
    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 300)}`);
    if (![409, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError;
}

function textProperty(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

function clampText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatTaipeiDateTime(value) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
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
