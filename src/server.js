import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

loadDotenv();

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET;
const notionToken = process.env.NOTION_TOKEN;
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID;
const messagesDataSourceId = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID;
const attachmentsDataSourceId = process.env.SEVEN_ATTACHMENTS_DATA_SOURCE_ID;
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const codexCommandsDataSourceId = process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID || 'c4eee8de-e596-4d64-906b-1405d79e721c';
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const reportUrl = process.env.DAILY_REPORT_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/daily-control-report-prototype.html';
const morningBriefUrl = process.env.MORNING_BRIEF_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/morning-brief-prototype.html';
const outgoingActorName = process.env.SEVEN_OUTGOING_ACTOR_NAME || 'Seven Jr.';
const sevenDataSourceParentBlockId = normalizeId(process.env.SEVEN_DATA_SOURCE_PARENT_BLOCK_ID || '');
const verifiedSevenDataSources = new Map();
const recentTaskListsByConversation = new Map();

const notionConfigured = Boolean(notionToken && conversationsDataSourceId && messagesDataSourceId);
const conversationAnchorText = '【Seven LINE】對話記錄（最新在最上方）';
const reportCommands = new Set(['#報告', '報告', '#每日報告', '每日報告']);
const morningBriefCommands = new Set(['#早報', '早報', '#今日早報', '今日早報', '#行程', '行程']);

if (!channelAccessToken || !channelSecret) {
  console.warn('Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET.');
}

if (!notionConfigured) {
  console.warn('Missing NOTION_TOKEN, SEVEN_CONVERSATIONS_DATA_SOURCE_ID, or SEVEN_MESSAGES_DATA_SOURCE_ID. LINE events will not be stored in Notion.');
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      notionConfigured,
      attachmentsConfigured: Boolean(attachmentsDataSourceId),
      codexCommandQueueConfigured: Boolean(codexCommandsDataSourceId),
      codexCommandTriggers: ['Eleven Junior', 'Eleven Jr.', 'Elven Jr.', 'Seven Junior', '7 Junior', '11 Jr.'],
      autoReplyEnabled: false,
      reportCommandEnabled: true,
      morningBriefCommandEnabled: true,
      taskQueryReplyEnabled: Boolean(notionToken && tasksDataSourceId),
      immediateCommandEnabled: true,
      immediateCommandPrefixes: ['Seven Junior', '7Junior', '7 Junior'],
      reportUrl,
      morningBriefUrl,
      conversationPageBlocksEnabled: true,
      lineContentUploadEnabled: true,
      directFileBlocksEnabled: false,
      attachmentLinksEnabled: true,
      storageMode: 'hozo-crm-style',
    });
  }

  if (req.method !== 'POST' || pathname !== '/webhook/line') {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const rawBody = await readBody(req);
  const signature = req.headers['x-line-signature'];

  if (!isValidLineSignature(rawBody, signature)) {
    return sendJson(res, 401, { error: 'Invalid signature' });
  }

  try {
    const body = JSON.parse(rawBody);
    await Promise.all((body.events || []).map((event) => handleEvent(event, rawBody)));
    return sendText(res, 200, 'OK');
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
});

async function handleEvent(event, rawBody) {
  if (notionConfigured) {
    await storeLineEventInNotion(event, rawBody);
  }

  const commandReply = await buildCommandReply(event);
  if (commandReply && event.replyToken) {
    await replyLineMessage(event.replyToken, commandReply);
    if (notionConfigured) {
      await storeOutgoingReplyInNotion(event, commandReply);
    }
  }
}

async function buildCommandReply(event) {
  const text = event.type === 'message' && event.message?.type === 'text' ? String(event.message.text || '').trim() : '';
  const immediateCommand = parseImmediateCommand(text);

  if (morningBriefCommands.has(text)) {
    return {
      type: 'text',
      text: `早上 8 點行程與待辦報告：\n${morningBriefUrl}\n\n目前這是試跑版，可以在手機上檢視今日行程、昨日未完成事項與今日優先處理清單。`,
    };
  }

  if (reportCommands.has(text)) {
    return {
      type: 'text',
      text: `每日總控報告網頁版：\n${reportUrl}\n\n目前這是試跑版，可以在手機上檢視附件解析與任務狀態確認畫面。`,
    };
  }

  if (immediateCommand && isOpenTaskDetailCommandText(immediateCommand.commandText)) {
    return buildOpenTaskDetailReply(event, immediateCommand.commandText);
  }

  if (isTaskListCommandText(immediateCommand?.commandText || text)) {
    return buildTaskListReply(event, text);
  }

  if (immediateCommand) {
    return buildImmediateCommandAcknowledgement(immediateCommand.commandText);
  }

  return null;
}

function parseImmediateCommand(text) {
  const value = String(text || '').trim();
  const match = value.match(/^(seven\s+junior|7\s*junior)\b[\s,，:：。-]*/i);
  if (!match) {
    return null;
  }
  return {
    trigger: match[1],
    commandText: value.slice(match[0].length).trim(),
  };
}

function isTaskListCommandText(text) {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }
  const hasTaskTerm = /(待辦|任務|工作|todo|task)/i.test(value);
  const hasQueryTerm = /(有哪些|清單|列表|列出|查詢|看一下|是什麼|目前|現在|pending|list|show)/i.test(value);
  return hasTaskTerm && hasQueryTerm;
}

async function buildTaskListReply(event, text) {
  if (!notionToken || !tasksDataSourceId) {
    return { type: 'text', text: 'Seven Jr. 目前還沒有連上總控任務庫，所以暫時無法查詢待辦。' };
  }

  try {
    const actorName = normalizeTaskAssigneeName(text) || await resolveTaskQueryActorName(event);
    const tasks = await findOpenTasksForActor(actorName);
    if (!tasks.length) {
      return {
        type: 'text',
        text: actorName
          ? `目前沒有找到「${actorName}」名下的未完成待辦。`
          : '目前沒有找到未完成待辦。',
      };
    }

    rememberRecentTaskList(event, tasks);
    const scope = actorName ? `「${actorName}」` : '目前';
    const lines = [`Seven Jr. 幫你查到 ${scope}的未完成待辦：`];
    tasks.slice(0, 8).forEach((task, index) => {
      const meta = [task.project, task.owner, task.dueDate ? `期限 ${formatTaipeiDate(task.dueDate)}` : '', task.status]
        .filter(Boolean)
        .join(' / ');
      lines.push(`${index + 1}. ${task.name}${meta ? `\n   ${meta}` : ''}`);
    });
    if (tasks.length > 8) {
      lines.push(`另外還有 ${tasks.length - 8} 項，請到 SevenAM 總控任務庫查看完整清單。`);
    }
    return { type: 'text', text: clampText(lines.join('\n'), 4900) };
  } catch (error) {
    console.warn(`Unable to build task list reply: ${error.message}`);
    return { type: 'text', text: 'Seven Jr. 有收到你的待辦查詢，但目前讀取總控任務庫失敗，我會保留原始訊息供後續追蹤。' };
  }
}

function isOpenTaskDetailCommandText(text) {
  const value = String(text || '').trim();
  return /(打開|開啟|展開|給我看|看一下|查看|詳細|詳情)/.test(value) && /(第\s*[0-9一二三四五六七八九十]+\s*個|[0-9一二三四五六七八九十]+\s*號)/.test(value) && /(任務|待辦|工作)?/.test(value);
}

async function buildOpenTaskDetailReply(event, text) {
  const index = parseTaskOrdinal(text);
  if (!index) {
    return { type: 'text', text: '我收到你要打開任務，但還沒判斷出是哪一個。你可以說：「Seven Junior，打開第 2 個任務」。' };
  }

  const list = getRecentTaskList(event);
  if (!list?.tasks?.length) {
    return { type: 'text', text: '我現在沒有上一份待辦清單可以對照。請先說：「Seven Junior，目前有哪些待辦？」我列出來後，你再說要打開第幾個。' };
  }

  const task = list.tasks[index - 1];
  if (!task) {
    return { type: 'text', text: `上一份待辦清單沒有第 ${index} 個任務。你可以重新查一次待辦清單，我再幫你打開。` };
  }

  const detail = task.id ? await findTaskDetailById(task.id) : task;
  const lines = [
    `第 ${index} 個任務：${detail.name || task.name}`,
    detail.status ? `狀態：${detail.status}` : '',
    detail.owner ? `負責人：${detail.owner}` : '',
    detail.dueDate ? `期限：${formatTaipeiDate(detail.dueDate)}` : '',
    detail.project ? `專案：${detail.project}` : '',
    detail.summary ? `摘要：${detail.summary}` : '',
    detail.url ? `Notion：${detail.url}` : '',
    '',
    '你可以接著說：',
    `Seven Junior，把第 ${index} 個任務狀態改成進行中`,
    `Seven Junior，幫第 ${index} 個任務加備註：今天先確認窗口`,
  ].filter((line) => line !== '');

  return { type: 'text', text: clampText(lines.join('\n'), 4900) };
}

function buildImmediateCommandAcknowledgement(commandText) {
  const riskLevel = resolveCommandRiskLevel(commandText);
  if (riskLevel === 'High') {
    return {
      type: 'text',
      text: `我已收到這個即時指令，但內容可能涉及金流、合約、法律、稅務或外部承諾，所以我先放進待確認，不會直接執行。\n\n指令：${commandText || '(空白)'}`,
    };
  }

  return {
    type: 'text',
    text: `我已收到這個即時指令，並放進 SevenAM 指令佇列。\n\n目前我可以即時處理「查待辦」和「打開第幾個任務」。其他操作會先排入佇列，等 Codex 接手處理。\n\n指令：${commandText || '(空白)'}`,
  };
}

function rememberRecentTaskList(event, tasks) {
  const context = resolveConversationContext(event.source || {});
  recentTaskListsByConversation.set(context.key, {
    savedAt: Date.now(),
    tasks: tasks.slice(0, 8),
  });
}

function getRecentTaskList(event) {
  const context = resolveConversationContext(event.source || {});
  const list = recentTaskListsByConversation.get(context.key);
  if (!list) {
    return null;
  }
  if (Date.now() - list.savedAt > 30 * 60 * 1000) {
    recentTaskListsByConversation.delete(context.key);
    return null;
  }
  return list;
}

function parseTaskOrdinal(text) {
  const value = String(text || '');
  const match = value.match(/第\s*([0-9一二三四五六七八九十]+)\s*個/) || value.match(/([0-9一二三四五六七八九十]+)\s*號/);
  if (!match) {
    return null;
  }
  const raw = match[1];
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (raw === '十') {
    return 10;
  }
  if (raw.startsWith('十')) {
    return 10 + (digits[raw.slice(1)] || 0);
  }
  if (raw.endsWith('十')) {
    return (digits[raw[0]] || 1) * 10;
  }
  return digits[raw] || null;
}

async function resolveTaskQueryActorName(event) {
  const source = event.source || {};
  const context = resolveConversationContext(source);
  const display = await resolveDisplayNames(source, context);
  return display.actorName || display.conversationName || '';
}

function normalizeTaskAssigneeName(text) {
  const value = String(text || '').trim();
  const match = value.match(/(?:誰|哪個人|負責人|owner|assignee)[:：\s]+(.+)$/i)
    || value.match(/(?:查詢|列出|看一下)\s*(.+?)\s*(?:的)?(?:待辦|任務|工作)/i);
  return match ? match[1].trim().replace(/[，。,.;；]$/, '') : '';
}

async function findOpenTasksForActor(actorName) {
  const tasks = await queryOpenTasks();
  const normalizedActor = normalizeLooseText(actorName);
  if (!normalizedActor) {
    return tasks;
  }

  const matched = tasks.filter((task) => {
    const owner = normalizeLooseText(task.owner);
    const name = normalizeLooseText(task.name);
    return owner.includes(normalizedActor) || normalizedActor.includes(owner) || name.includes(normalizedActor);
  });
  return matched.length ? matched : tasks;
}

async function queryOpenTasks() {
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 25,
    },
  });

  return (result.results || [])
    .map((page) => ({
      id: page.id,
      name: pageText(page, '任務名稱') || pageText(page, 'Name') || pageText(page, '名稱') || '(未命名任務)',
      project: pageRelationTitleFallback(page, '總控專案') || pageText(page, '專案'),
      owner: pageText(page, '負責人') || pageText(page, 'Owner'),
      status: pageStatus(page, '狀態') || pageSelect(page, '狀態'),
      dueDate: pageDate(page, '期限') || pageDate(page, 'Due Date'),
      summary: pageText(page, 'Codex 判斷摘要') || pageText(page, '下一步') || pageText(page, '來源原文'),
      url: page.url || '',
    }))
    .filter((task) => !['已完成', '封存', '完成'].includes(task.status));
}

async function findTaskDetailById(pageId) {
  const page = await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
  return {
    id: page.id,
    name: pageText(page, '任務名稱') || pageText(page, 'Name') || pageText(page, '名稱') || '(未命名任務)',
    project: pageRelationTitleFallback(page, '總控專案') || pageText(page, '專案'),
    owner: pageText(page, '負責人') || pageText(page, 'Owner'),
    status: pageStatus(page, '狀態') || pageSelect(page, '狀態'),
    dueDate: pageDate(page, '期限') || pageDate(page, 'Due Date'),
    summary: pageText(page, 'Codex 判斷摘要') || pageText(page, '下一步') || pageText(page, '來源原文'),
    url: page.url || '',
  };
}

async function replyLineMessage(replyToken, message) {
  if (!channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  }

  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages: [message] }),
  });

  if (!response.ok) {
    throw new Error(`LINE reply failed: ${response.status} ${await response.text()}`);
  }
}

async function storeOutgoingReplyInNotion(event, message) {
  const source = event.source || {};
  const context = resolveConversationContext(source);
  const sentAt = new Date().toISOString();
  const messageType = normalizeMessageType(message?.type || 'unsupported');
  const text = message?.type === 'text' ? String(message.text || '') : JSON.stringify(message || {});
  const display = await resolveDisplayNames(source, context);
  const conversation = await findOrCreateConversation(context, display, sentAt, text);
  const messageId = buildOutgoingReplyMessageId(event, message);

  const existingMessage = await findMessagePage(messageId);
  if (existingMessage) {
    console.log(`Skipping duplicate outgoing LINE message ${messageId}.`);
    return;
  }

  await createOutgoingReplyMessagePage({
    conversationId: conversation.id,
    event,
    message,
    messageId,
    messageType,
    text,
    sentAt,
    context,
  });

  await appendConversationContentFirst({
    conversationId: conversation.id,
    conversationName: display.conversationName,
    actorName: outgoingActorName,
    messageType,
    text,
    message,
    messageId,
    eventTime: sentAt,
  });

  await updateConversationAfterMessage(conversation, display, sentAt, text);
}

async function createOutgoingReplyMessagePage({ conversationId, event, message, messageId, messageType, text, sentAt, context }) {
  const source = event.source || {};
  const payload = {
    direction: 'outgoing',
    actorName: outgoingActorName,
    replyToWebhookEventId: event.webhookEventId || '',
    source,
    message,
    sentAt,
  };

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: messagesDataSourceId },
      properties: {
        '訊息 ID': title(messageId),
        'LINE 事件 ID': richText('outgoing-reply'),
        'Webhook 重送序號': { number: 0 },
        '對話主檔': relation(conversationId),
        '訊息來源': select('ai-engine'),
        '訊息類型': select(messageType),
        '文字內容': richText(text, 1900),
        '原始內容': richText(text, 1900),
        '原始 payload': richText(JSON.stringify(payload), 1900),
        '發話者 ID': richText(outgoingActorName),
        '發話者名稱': richText(outgoingActorName),
        '發話者類型': select('oa'),
        '群組標記': checkbox(Boolean(source.groupId || source.roomId)),
        '排序時間': date(sentAt),
        '已進入判斷層': checkbox(false),
      },
      children: [
        paragraph(`來源：${outgoingActorName} 指令回覆`),
        paragraph(`內容：${text || '(非文字訊息)'}`),
        paragraph(`對話類型：${context.entityType}`),
      ],
    },
  });
}

function buildOutgoingReplyMessageId(event, message) {
  const base = event.webhookEventId || event.message?.id || event.timestamp || Date.now();
  const hash = createHash('sha256')
    .update(JSON.stringify({ base, message }))
    .digest('hex')
    .slice(0, 16);
  return `out-reply:${base}:${hash}`;
}

async function storeLineEventInNotion(event, rawBody) {
  const source = event.source || {};
  const context = resolveConversationContext(source);
  const eventTime = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
  const message = event.message || {};
  const messageId = message.id || `${event.type}-${event.webhookEventId || eventTime}`;
  const messageType = message.type || event.type || 'unsupported';
  const text = message.type === 'text' ? message.text || '' : buildNonTextMessagePreview(message);

  const existingMessage = await findMessagePage(messageId);
  if (existingMessage) {
    console.log(`Skipping duplicate LINE message ${messageId}.`);
    return;
  }

  const display = await resolveDisplayNames(source, context);
  const conversation = await findOrCreateConversation(context, display, eventTime, text);
  const uploadedContent = await maybeUploadLineContent(message, messageType, messageId);
  const messagePage = await createMessagePage({ conversationId: conversation.id, event, rawBody, messageId, messageType, text, eventTime, display, context });

  let attachmentPage;
  if (messageType === 'file' && attachmentsDataSourceId) {
    attachmentPage = await createAttachmentPage({ conversationId: conversation.id, messagePageId: messagePage.id, event, message, messageId, messageType, eventTime, uploadedContent });
  }

  await appendConversationContentFirst({
    conversationId: conversation.id,
    conversationName: display.conversationName,
    actorName: display.actorName,
    messageType,
    text,
    message,
    messageId,
    eventTime,
    uploadedContent,
    attachmentPageUrl: attachmentPage?.url,
  });

  await updateConversationAfterMessage(conversation, display, eventTime, text);

  if (isCodexCommandText(text)) {
    await maybeCreateCodexCommandPage({
      conversation,
      messagePage,
      event,
      messageId,
      text,
      eventTime,
      display,
      context,
    });
  }
}

function isCodexCommandText(text) {
  return findCodexCommandTrigger(text) !== null;
}

function findCodexCommandTrigger(text) {
  const value = String(text || '');
  const triggers = [
    { label: 'Eleven Junior', pattern: /eleven\s+junior/i },
    { label: 'Eleven Jr.', pattern: /eleven\s+jr\.?/i },
    { label: 'Elven Jr.', pattern: /elven\s+jr\.?/i },
    { label: 'Seven Junior', pattern: /seven\s+junior/i },
    { label: '7 Junior', pattern: /\b7\s*junior\b/i },
    { label: '11 Jr.', pattern: /\b11\s*jr\.?\b/i },
  ];
  return triggers.find((trigger) => trigger.pattern.test(value)) || null;
}

function extractCodexCommand(text) {
  const value = String(text || '').trim();
  const trigger = findCodexCommandTrigger(value);
  if (!trigger) {
    return '';
  }
  return value.replace(trigger.pattern, '').replace(/^[\s:：,，。-]+/, '').trim();
}

async function maybeCreateCodexCommandPage({ conversation, messagePage, event, messageId, text, eventTime, display, context }) {
  if (!codexCommandsDataSourceId) {
    console.warn(`Codex command trigger detected in LINE message ${messageId}, but SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID is not set.`);
    return null;
  }

  try {
    return await createCodexCommandPage({ conversation, messagePage, event, messageId, text, eventTime, display, context });
  } catch (error) {
    console.warn(`Unable to create Codex command queue item for LINE message ${messageId}: ${error.message}`);
    return null;
  }
}

async function createCodexCommandPage({ conversation, messagePage, event, messageId, text, eventTime, display, context }) {
  const source = event.source || {};
  const trigger = findCodexCommandTrigger(text);
  const commandText = extractCodexCommand(text);
  const titleText = commandText || text || `LINE command ${messageId}`;
  const sourceType = source.type || (source.groupId ? 'group' : source.roomId ? 'room' : source.userId ? 'user' : 'unknown');
  const sourceId = source.groupId || source.roomId || source.userId || '';

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: codexCommandsDataSourceId },
      properties: {
        Name: title(titleText),
        Status: select('Pending'),
        Trigger: richText(trigger?.label || ''),
        Command: richText(commandText, 1900),
        'Original Text': richText(text, 1900),
        'Source Type': select(sourceType),
        'Source ID': richText(sourceId),
        'User ID': richText(source.userId || ''),
        'Conversation Name': richText(display.conversationName || ''),
        'Actor Name': richText(display.actorName || ''),
        'Conversation Key': richText(context.key || ''),
        'LINE Message ID': richText(messageId),
        'LINE Event ID': richText(event.webhookEventId || ''),
        'Message Page URL': messagePage?.url ? url(messagePage.url) : undefined,
        'Conversation Page URL': conversation?.url ? url(conversation.url) : undefined,
        'Received At': date(eventTime),
        'Risk Level': select(resolveCommandRiskLevel(commandText || text)),
        'Raw Event': richText(JSON.stringify(event), 1900),
      },
      children: [
        paragraph(`Trigger: ${trigger?.label || ''}`),
        paragraph(`Command: ${commandText || '(no command text after trigger)'}`),
        paragraph(`Source: ${sourceType} ${sourceId}`.trim()),
      ],
    },
  });
}

function resolveCommandRiskLevel(text) {
  const value = String(text || '').toLowerCase();
  const highRiskTerms = [
    'contract',
    'legal',
    'tax',
    'salary',
    'payment',
    'invoice',
    'fire ',
    'terminate',
    '合約',
    '法律',
    '稅',
    '薪資',
    '付款',
    '匯款',
    '發票',
    '解僱',
    '資遣',
    '報價',
  ];
  return highRiskTerms.some((term) => value.includes(term)) ? 'High' : 'Normal';
}

function resolveConversationContext(source) {
  if (source.roomId) {
    return { identityProperty: 'Room ID', identityValue: source.roomId, entityType: '聊天室', key: `room:${source.roomId}` };
  }
  if (source.groupId) {
    return { identityProperty: 'Group ID', identityValue: source.groupId, entityType: '群組', key: `group:${source.groupId}` };
  }
  if (source.userId) {
    return { identityProperty: 'User ID', identityValue: source.userId, entityType: '個人', key: `user:${source.userId}` };
  }
  return { identityProperty: '對話統一鍵', identityValue: 'unknown', entityType: '未知', key: 'unknown' };
}

async function resolveDisplayNames(source, context) {
  const fallbackConversationName = `${context.entityType} ${context.identityValue}`;
  let conversationName = fallbackConversationName;
  let actorName = source.userId || 'unknown';

  try {
    if (source.groupId) {
      const groupSummary = await lineGet(`/v2/bot/group/${encodeURIComponent(source.groupId)}/summary`);
      conversationName = groupSummary.groupName || fallbackConversationName;
    } else if (source.userId && !source.roomId) {
      const profile = await lineGet(`/v2/bot/profile/${encodeURIComponent(source.userId)}`);
      conversationName = profile.displayName || fallbackConversationName;
      actorName = profile.displayName || actorName;
    }
  } catch (error) {
    console.warn(`Unable to resolve LINE conversation name: ${error.message}`);
  }

  try {
    if (source.groupId && source.userId) {
      const profile = await lineGet(`/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(source.userId)}`);
      actorName = profile.displayName || actorName;
    } else if (source.roomId && source.userId) {
      const profile = await lineGet(`/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(source.userId)}`);
      actorName = profile.displayName || actorName;
    }
  } catch (error) {
    console.warn(`Unable to resolve LINE actor name: ${error.message}`);
  }

  return { conversationName, actorName };
}

async function findOrCreateConversation(context, display, eventTime, preview) {
  const existing = await findConversationPage(context);
  if (existing) {
    return existing;
  }

  const properties = {
    'LINE 對話名稱': title(display.conversationName),
    '自定義名稱': richText(display.conversationName),
    '對象類型': select(context.entityType),
    '對話統一鍵': richText(context.key),
    '最後訊息時間': date(eventTime),
    '最新訊息預覽': richText(preview, 160),
    '訊息數（總）': { number: 0 },
    '監控狀態': select('啟用'),
  };

  if (context.identityProperty && context.identityValue) {
    properties[context.identityProperty] = richText(context.identityValue);
  }

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: { parent: { type: 'data_source_id', data_source_id: conversationsDataSourceId }, properties, children: [conversationAnchorBlock()] },
  });
}

async function findConversationPage(context) {
  if (!context.identityProperty || !context.identityValue) {
    return null;
  }

  const result = await notionRequest(`/v1/data_sources/${conversationsDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 1, filter: { property: context.identityProperty, rich_text: { equals: context.identityValue } } },
  });

  return result.results?.[0] || null;
}

async function findMessagePage(messageId) {
  const result = await notionRequest(`/v1/data_sources/${messagesDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 1, filter: { property: '訊息 ID', title: { equals: messageId } } },
  });

  return result.results?.[0] || null;
}

async function createMessagePage({ conversationId, event, rawBody, messageId, messageType, text, eventTime, display, context }) {
  const eventId = event.webhookEventId || '';
  const source = event.source || {};
  const deliveryContext = event.deliveryContext || {};

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: messagesDataSourceId },
      properties: {
        '訊息 ID': title(messageId),
        'LINE 事件 ID': richText(eventId),
        'Webhook 重送序號': { number: Number(deliveryContext.redelivery ? 1 : 0) },
        '對話主檔': relation(conversationId),
        '訊息來源': select('line'),
        '訊息類型': select(normalizeMessageType(messageType)),
        '文字內容': richText(text, 1900),
        '原始內容': richText(text, 1900),
        '原始 payload': richText(JSON.stringify(event), 1900),
        '發話者 ID': richText(source.userId || ''),
        '發話者名稱': richText(display.actorName || ''),
        '發話者類型': select('user'),
        '群組標記': checkbox(Boolean(source.groupId || source.roomId)),
        '排序時間': date(eventTime),
        '已進入判斷層': checkbox(false),
      },
      children: [paragraph(`來源：LINE / ${context.entityType}`), paragraph(`內容：${text || '(非文字訊息)'}`)],
    },
  });
}

async function appendConversationContentFirst({ conversationId, conversationName, actorName, messageType, text, message, messageId, eventTime, uploadedContent, attachmentPageUrl }) {
  const anchorBlock = await findOrCreateConversationAnchor(conversationId);
  const blocks = await buildConversationMessageBlocks({ conversationName, actorName, messageType, text, message, messageId, eventTime, uploadedContent, attachmentPageUrl });
  await notionRequest(`/v1/blocks/${conversationId}/children`, { method: 'PATCH', body: { after: anchorBlock.id, children: blocks } });
}

async function findOrCreateConversationAnchor(conversationId) {
  const children = await getBlockChildren(conversationId);
  const anchor = children.find((block) => plainBlockText(block).includes(conversationAnchorText));
  if (anchor) {
    return anchor;
  }

  const result = await notionRequest(`/v1/blocks/${conversationId}/children`, { method: 'PATCH', body: { children: [conversationAnchorBlock()] } });
  return result.results?.[0];
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

async function buildConversationMessageBlocks({ conversationName, actorName, messageType, text, message, messageId, eventTime, uploadedContent, attachmentPageUrl }) {
  const typeLabel = messageTypeLabel(messageType);
  const isOutgoing = actorName === outgoingActorName;
  const color = isOutgoing ? 'orange' : 'blue';
  const meta = isOutgoing
    ? `【${formatTaipeiTime(eventTime)}】${actorName}：${typeLabel}`
    : `【${formatTaipeiTime(eventTime)}】${conversationName} - ${actorName || '未知發話者'}（${typeLabel}）`;
  const blocks = [coloredParagraph(meta, color)];

  if (messageType === 'image') {
    if (uploadedContent?.fileUploadId) {
      blocks.push(imageBlock(uploadedContent.fileUploadId, messageId));
    } else {
      blocks.push(paragraph(`圖片訊息：${messageId}`));
      blocks.push(paragraph('圖片下載或上傳 Notion 失敗，請查看 Render log。'));
    }
    return blocks;
  }

  if (messageType === 'file') {
    const filename = message.fileName || uploadedContent?.filename || messageId;
    blocks.push(paragraph(`檔案：${filename}`));
    if (attachmentPageUrl) {
      blocks.push(linkParagraph(`附件資料庫：${filename}`, attachmentPageUrl));
    } else if (!uploadedContent?.fileUploadId) {
      blocks.push(paragraph('檔案下載或上傳 Notion 失敗，請查看 Render log。'));
    }
    return blocks;
  }

  if (messageType === 'sticker') {
    const stickerUrls = buildLineStickerUrls(message);
    const content = text || buildNonTextMessagePreview(message);
    blocks.push(paragraph(content));
    if (stickerUrls?.imageUrl && (await isUsableExternalImage(stickerUrls.imageUrl))) {
      blocks.push(externalImageBlock(stickerUrls.imageUrl, content));
    } else if (stickerUrls?.productUrl) {
      blocks.push(linkParagraph('LINE sticker shop page', stickerUrls.productUrl));
    }
    return blocks;
  }

  const content = text || buildNonTextMessagePreview(message);
  blocks.push(paragraph(content));
  return blocks;
}

async function updateConversationAfterMessage(conversation, display, eventTime, preview) {
  const currentCount = conversation.properties?.['訊息數（總）']?.number || 0;
  await notionRequest(`/v1/pages/${conversation.id}`, {
    method: 'PATCH',
    body: { properties: { 'LINE 對話名稱': title(display.conversationName), '最後訊息時間': date(eventTime), '最新訊息預覽': richText(preview, 160), '訊息數（總）': { number: currentCount + 1 } } },
  });
}

async function createAttachmentPage({ conversationId, messagePageId, event, message, messageId, messageType, eventTime, uploadedContent }) {
  const filename = uploadedContent?.filename || message.fileName || `${messageType}-${messageId}`;
  const properties = {
    '附件項目': title(filename),
    '對話主檔': relation(conversationId),
    '訊息紀錄': relation(messagePageId),
    'LINE 事件 ID': richText(event.webhookEventId || ''),
    'LINE 訊息 ID': richText(messageId),
    '附件類型': select(normalizeAttachmentType(messageType)),
    '檔案名稱': richText(filename),
    '檔案大小': { number: Number(message.fileSize || uploadedContent?.contentLength || 0) || null },
    'Content-Type': richText(uploadedContent?.contentType || message.contentProvider?.type || ''),
    '來源': select('line'),
    '建立時間': date(eventTime),
    '轉檔狀態': select(uploadedContent?.fileUploadId ? '待轉檔' : '失敗'),
  };

  if (uploadedContent?.fileUploadId) {
    properties['附件檔案'] = files(filename, uploadedContent.fileUploadId);
  }

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: attachmentsDataSourceId },
      properties,
      children: uploadedContent?.fileUploadId ? [fileBlock(uploadedContent.fileUploadId, filename)] : [paragraph('LINE 檔案下載或 Notion 上傳失敗，請查看 Render log。')],
    },
  });
}

async function maybeUploadLineContent(message, messageType, messageId) {
  if (!['image', 'file'].includes(messageType)) {
    return null;
  }
  if (message.contentProvider && message.contentProvider.type !== 'line') {
    console.warn(`Skipping ${messageType} ${messageId}: contentProvider is not line.`);
    return null;
  }
  try {
    const content = await downloadLineContent(messageId);
    const filename = resolveLineFilename(message, messageType, messageId, content.contentType);
    const upload = await uploadFileToNotion(content.buffer, filename, content.contentType);
    return { fileUploadId: upload.id, filename, contentType: content.contentType, contentLength: content.buffer.byteLength };
  } catch (error) {
    console.warn(`Unable to upload LINE ${messageType} ${messageId} to Notion: ${error.message}`);
    return null;
  }
}

async function downloadLineContent(messageId) {
  if (!channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  }
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, { headers: { Authorization: `Bearer ${channelAccessToken}` } });
  if (!response.ok) {
    throw new Error(`LINE content download failed: ${response.status} ${await response.text()}`);
  }
  return { buffer: await response.arrayBuffer(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
}

async function uploadFileToNotion(buffer, filename, contentType) {
  const upload = await notionRequest('/v1/file_uploads', { method: 'POST', body: { filename, content_type: contentType } });
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: contentType }), filename);

  const response = await fetch(upload.upload_url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': notionVersion },
    body: formData,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Notion file upload failed: ${response.status} ${responseText}`);
  }
  const result = responseText ? JSON.parse(responseText) : upload;
  if (result.status && result.status !== 'uploaded') {
    throw new Error(`Notion file upload status is ${result.status}`);
  }
  return result.id ? result : upload;
}

async function lineGet(pathname) {
  if (!channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  }
  const response = await fetch(`https://api.line.me${pathname}`, { headers: { Authorization: `Bearer ${channelAccessToken}` } });
  if (!response.ok) {
    throw new Error(`LINE API failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function notionRequest(pathname, { method, body }) {
  if (!notionToken) {
    throw new Error('NOTION_TOKEN is not set.');
  }
  await assertSevenNotionTarget(pathname, body);

  const response = await fetch(`https://api.notion.com${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${notionToken}`, 'Content-Type': 'application/json', 'Notion-Version': notionVersion },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Notion API failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : {};
}

async function assertSevenNotionTarget(pathname, body) {
  const dataSourceIds = new Set();
  const pathMatch = String(pathname || '').match(/\/v1\/data_sources\/([^/?]+)/);
  if (pathMatch) {
    dataSourceIds.add(pathMatch[1]);
  }

  const parent = body?.parent;
  if (parent?.type === 'data_source_id' && parent.data_source_id) {
    dataSourceIds.add(parent.data_source_id);
  }

  for (const dataSourceId of dataSourceIds) {
    await assertSevenDataSource(dataSourceId);
  }
}

async function assertSevenDataSource(dataSourceId) {
  const normalizedId = normalizeId(dataSourceId);
  if (!normalizedId) {
    throw new Error('Notion data source id is missing.');
  }

  const cached = verifiedSevenDataSources.get(normalizedId);
  if (cached) {
    return cached;
  }

  const dataSource = await notionFetchJson(`/v1/data_sources/${normalizedId}`);
  const titleText = notionTitleText(dataSource.title);
  const parentBlockId = normalizeId(dataSource.parent?.block_id || dataSource.parent?.page_id || dataSource.parent?.database_id || '');

  if (dataSource.archived || dataSource.in_trash) {
    throw new Error(`Blocked Notion access: data source "${titleText || normalizedId}" is archived or trashed.`);
  }

  if (!isAllowedSevenDataSourceTitle(titleText)) {
    throw new Error(`Blocked Notion access: data source "${titleText || normalizedId}" does not look like a SevenAM data source.`);
  }

  if (sevenDataSourceParentBlockId && parentBlockId && parentBlockId !== sevenDataSourceParentBlockId) {
    throw new Error(`Blocked Notion access: data source "${titleText || normalizedId}" is outside the configured SevenAM parent scope.`);
  }

  verifiedSevenDataSources.set(normalizedId, true);
  return true;
}

async function notionFetchJson(pathname) {
  const response = await fetch(`https://api.notion.com${pathname}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': notionVersion },
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Notion API failed: ${response.status} ${responseText}`);
  }
  return responseText ? JSON.parse(responseText) : {};
}

function notionTitleText(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('').trim();
}

function isAllowedSevenDataSourceTitle(titleText) {
  const value = String(titleText || '').trim();
  if (!value) {
    return true;
  }
  return /(Seven|SevenAM|7AM|Codex|總控|任務|專案|會議|每日|LINE|Automation|風險|決策|責任|權責)/i.test(value);
}

function buildNonTextMessagePreview(message) {
  if (!message?.type) {
    return '(非 message 事件)';
  }
  if (message.type === 'file') {
    return `[file] ${message.fileName || message.id || ''}`.trim();
  }
  if (message.type === 'sticker') {
    return `[sticker] package:${message.packageId || ''} sticker:${message.stickerId || ''}`.trim();
  }
  return `[${message.type}] ${message.id || ''}`.trim();
}

function buildLineStickerUrls(message) {
  const stickerId = message?.stickerId ? String(message.stickerId).trim() : '';
  const packageId = message?.packageId ? String(message.packageId).trim() : '';
  if (!stickerId) {
    return null;
  }
  return {
    imageUrl: `https://stickershop.line-scdn.net/stickershop/v1/sticker/${encodeURIComponent(stickerId)}/android/sticker.png`,
    productUrl: packageId ? `https://store.line.me/stickershop/product/${encodeURIComponent(packageId)}` : null,
  };
}

async function isUsableExternalImage(imageUrl) {
  try {
    const response = await fetch(imageUrl, { method: 'HEAD' });
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length');
    return contentType.toLowerCase().startsWith('image/') && contentLength !== '0';
  } catch (error) {
    console.warn(`Unable to verify LINE sticker image ${imageUrl}: ${error.message}`);
    return false;
  }
}

function resolveLineFilename(message, messageType, messageId, contentType) {
  if (message.fileName) {
    return message.fileName;
  }
  const extension = extensionFromContentType(contentType) || (messageType === 'image' ? 'jpg' : 'bin');
  return `line-${messageType}-${messageId}.${extension}`;
}

function extensionFromContentType(contentType) {
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' };
  return extensions[String(contentType || '').split(';')[0].trim().toLowerCase()];
}

function normalizeMessageType(messageType) {
  return ['text', 'image', 'sticker', 'file', 'location', 'video', 'audio'].includes(messageType) ? messageType : 'unsupported';
}

function normalizeAttachmentType(messageType) {
  return messageType === 'file' ? 'file' : 'other';
}

function messageTypeLabel(messageType) {
  const labels = { text: '文字訊息', image: '圖片', file: '檔案', sticker: '貼圖', location: '位置', video: '影片', audio: '語音' };
  return labels[messageType] || '其他訊息';
}

function formatTaipeiTime(value) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
}

function plainBlockText(block) {
  const richText = block?.[block.type]?.rich_text || [];
  return richText.map((item) => item.plain_text || item.text?.content || '').join('');
}

function title(content) {
  return { title: [{ type: 'text', text: { content: clampText(content, 1900) } }] };
}

function richText(content, maxLength = 1900) {
  const value = content == null ? '' : String(content);
  if (!value) {
    return { rich_text: [] };
  }
  return { rich_text: [{ type: 'text', text: { content: clampText(value, maxLength) } }] };
}

function select(name) {
  return { select: { name } };
}

function date(start) {
  return { date: { start } };
}

function checkbox(value) {
  return { checkbox: Boolean(value) };
}

function relation(id) {
  return { relation: [{ id }] };
}

function files(name, fileUploadId) {
  return { files: [{ name, type: 'file_upload', file_upload: { id: fileUploadId } }] };
}

function url(value) {
  return { url: value || null };
}

function conversationAnchorBlock() {
  return coloredParagraph(conversationAnchorText, 'blue');
}

function coloredParagraph(content, color) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampText(content, 1900) }, annotations: { color } }] } };
}

function imageBlock(fileUploadId, caption) {
  return { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: fileUploadId }, caption: caption ? [{ type: 'text', text: { content: clampText(caption, 1900) } }] : [] } };
}

function externalImageBlock(imageUrl, caption) {
  return { object: 'block', type: 'image', image: { type: 'external', external: { url: imageUrl }, caption: caption ? [{ type: 'text', text: { content: clampText(caption, 1900) } }] : [] } };
}

function fileBlock(fileUploadId, caption) {
  return { object: 'block', type: 'file', file: { type: 'file_upload', file_upload: { id: fileUploadId }, caption: caption ? [{ type: 'text', text: { content: clampText(caption, 1900) } }] : [] } };
}

function linkParagraph(content, url) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampText(content, 1900), link: { url } } }] } };
}

function paragraph(content) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampText(content, 1900) } }] } };
}

function pageText(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property) {
    return '';
  }
  if (property.type === 'title') {
    return richTextItemsPlain(property.title);
  }
  if (property.type === 'rich_text') {
    return richTextItemsPlain(property.rich_text);
  }
  if (property.type === 'people') {
    return (property.people || []).map((person) => person.name || person.person?.email || '').filter(Boolean).join('、');
  }
  return '';
}

function pageSelect(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'select' ? property.select?.name || '' : '';
}

function pageStatus(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'status' ? property.status?.name || '' : '';
}

function pageDate(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'date' ? property.date?.start || '' : '';
}

function pageRelationTitleFallback(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'relation' && property.relation?.length ? '' : '';
}

function richTextItemsPlain(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('').trim();
}

function normalizeLooseText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeId(value) {
  return String(value || '').trim().replace(/-/g, '').toLowerCase();
}

function formatTaipeiDate(value) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(value));
}

function clampText(value, maxLength) {
  const text = value == null ? '' : String(value);
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

function isValidLineSignature(rawBody, signature) {
  if (!channelSecret || typeof signature !== 'string') {
    return false;
  }
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return expected === signature;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
  res.end(text);
}

function loadDotenv() {
  if (!existsSync('.env')) {
    return;
  }
  const envFile = readFileSync('.env', 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`LINE webhook server is listening on port ${port}`);
});
