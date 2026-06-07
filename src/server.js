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
const codexCommandsDataSourceId = process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID || 'c4eee8de-e596-4d64-906b-1405d79e721c';
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const reportUrl = process.env.DAILY_REPORT_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/daily-control-report-prototype.html';
const morningBriefUrl = process.env.MORNING_BRIEF_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/morning-brief-prototype.html';
const outgoingActorName = process.env.SEVEN_OUTGOING_ACTOR_NAME || 'Seven Jr.';

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
  const commandReply = buildCommandReply(event);

  if (notionConfigured) {
    await storeLineEventInNotion(event, rawBody);
  }

  if (commandReply && event.replyToken) {
    await replyLineMessage(event.replyToken, commandReply);
    if (notionConfigured) {
      await storeOutgoingReplyInNotion(event, commandReply);
    }
  }
}

function buildCommandReply(event) {
  const text = event.type === 'message' && event.message?.type === 'text' ? String(event.message.text || '').trim() : '';

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

  return null;
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
