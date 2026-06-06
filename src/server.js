import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

loadDotenv();

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET;
const notionToken = process.env.NOTION_TOKEN;
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID;
const messagesDataSourceId = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID;
const attachmentsDataSourceId = process.env.SEVEN_ATTACHMENTS_DATA_SOURCE_ID;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';

const notionConfigured = Boolean(notionToken && conversationsDataSourceId && messagesDataSourceId);
const conversationAnchorText = '【Seven LINE】對話記錄（最新在最上方）';

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
      autoReplyEnabled: false,
      conversationPageBlocksEnabled: true,
      lineContentUploadEnabled: true,
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
  if (!notionConfigured) {
    return;
  }

  await storeLineEventInNotion(event, rawBody);
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
  const messagePage = await createMessagePage({
    conversationId: conversation.id,
    event,
    rawBody,
    messageId,
    messageType,
    text,
    eventTime,
    display,
    context,
  });

  let attachmentPage;
  if (messageType === 'file' && attachmentsDataSourceId) {
    attachmentPage = await createAttachmentPage({
      conversationId: conversation.id,
      messagePageId: messagePage.id,
      event,
      message,
      messageId,
      messageType,
      eventTime,
      uploadedContent,
    });
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
}

function resolveConversationContext(source) {
  if (source.roomId) {
    return {
      identityProperty: 'Room ID',
      identityValue: source.roomId,
      entityType: '聊天室',
      key: `room:${source.roomId}`,
    };
  }

  if (source.groupId) {
    return {
      identityProperty: 'Group ID',
      identityValue: source.groupId,
      entityType: '群組',
      key: `group:${source.groupId}`,
    };
  }

  if (source.userId) {
    return {
      identityProperty: 'User ID',
      identityValue: source.userId,
      entityType: '個人',
      key: `user:${source.userId}`,
    };
  }

  return {
    identityProperty: '對話統一鍵',
    identityValue: 'unknown',
    entityType: '未知',
    key: 'unknown',
  };
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
    body: {
      parent: { type: 'data_source_id', data_source_id: conversationsDataSourceId },
      properties,
      children: [conversationAnchorBlock()],
    },
  });
}

async function findConversationPage(context) {
  if (!context.identityProperty || !context.identityValue) {
    return null;
  }

  const result = await notionRequest(`/v1/data_sources/${conversationsDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: {
        property: context.identityProperty,
        rich_text: { equals: context.identityValue },
      },
    },
  });

  return result.results?.[0] || null;
}

async function findMessagePage(messageId) {
  const result = await notionRequest(`/v1/data_sources/${messagesDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: {
        property: '訊息 ID',
        title: { equals: messageId },
      },
    },
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
      children: [
        paragraph(`來源：LINE / ${context.entityType}`),
        paragraph(`內容：${text || '(非文字訊息)'}`),
      ],
    },
  });
}

async function appendConversationContentFirst({ conversationId, conversationName, actorName, messageType, text, message, messageId, eventTime, uploadedContent, attachmentPageUrl }) {
  const anchorBlock = await findOrCreateConversationAnchor(conversationId);
  const blocks = buildConversationMessageBlocks({
    conversationName,
    actorName,
    messageType,
    text,
    message,
    messageId,
    eventTime,
    uploadedContent,
    attachmentPageUrl,
  });

  await notionRequest(`/v1/blocks/${conversationId}/children`, {
    method: 'PATCH',
    body: {
      after: anchorBlock.id,
      children: blocks,
    },
  });
}

async function findOrCreateConversationAnchor(conversationId) {
  const children = await getBlockChildren(conversationId);
  const anchor = children.find((block) => plainBlockText(block).includes(conversationAnchorText));
  if (anchor) {
    return anchor;
  }

  const result = await notionRequest(`/v1/blocks/${conversationId}/children`, {
    method: 'PATCH',
    body: { children: [conversationAnchorBlock()] },
  });

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

function buildConversationMessageBlocks({ conversationName, actorName, messageType, text, message, messageId, eventTime, uploadedContent, attachmentPageUrl }) {
  const typeLabel = messageTypeLabel(messageType);
  const meta = `【${formatTaipeiTime(eventTime)}】${conversationName} - ${actorName || '未知發話者'}（${typeLabel}）`;
  const blocks = [coloredParagraph(meta, 'blue')];

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
    blocks.push(paragraph(`檔案：${message.fileName || messageId}`));
    if (attachmentPageUrl) {
      blocks.push(paragraph(`附件資料庫：${attachmentPageUrl}`));
    }
    return blocks;
  }

  blocks.push(paragraph(text || buildNonTextMessagePreview(message)));
  return blocks;
}

async function updateConversationAfterMessage(conversation, display, eventTime, preview) {
  const currentCount = conversation.properties?.['訊息數（總）']?.number || 0;

  await notionRequest(`/v1/pages/${conversation.id}`, {
    method: 'PATCH',
    body: {
      properties: {
        'LINE 對話名稱': title(display.conversationName),
        '最後訊息時間': date(eventTime),
        '最新訊息預覽': richText(preview, 160),
        '訊息數（總）': { number: currentCount + 1 },
      },
    },
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
      children: uploadedContent?.fileUploadId ? [fileBlock(uploadedContent.fileUploadId)] : [paragraph('LINE 檔案下載或 Notion 上傳失敗，請查看 Render log。')],
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
    return {
      fileUploadId: upload.id,
      filename,
      contentType: content.contentType,
      contentLength: content.buffer.byteLength,
    };
  } catch (error) {
    console.warn(`Unable to upload LINE ${messageType} ${messageId} to Notion: ${error.message}`);
    return null;
  }
}

async function downloadLineContent(messageId) {
  if (!channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  }

  const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });

  if (!response.ok) {
    throw new Error(`LINE content download failed: ${response.status} ${await response.text()}`);
  }

  return {
    buffer: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

async function uploadFileToNotion(buffer, filename, contentType) {
  const upload = await notionRequest('/v1/file_uploads', {
    method: 'POST',
    body: {
      filename,
      content_type: contentType,
    },
  });

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: contentType }), filename);

  const response = await fetch(upload.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': notionVersion,
    },
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

  const response = await fetch(`https://api.line.me${pathname}`, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
  });

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

function resolveLineFilename(message, messageType, messageId, contentType) {
  if (message.fileName) {
    return message.fileName;
  }

  const extension = extensionFromContentType(contentType) || (messageType === 'image' ? 'jpg' : 'bin');
  return `line-${messageType}-${messageId}.${extension}`;
}

function extensionFromContentType(contentType) {
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
  };

  return extensions[String(contentType || '').split(';')[0].trim().toLowerCase()];
}

function normalizeMessageType(messageType) {
  return ['text', 'image', 'sticker', 'file', 'location', 'video', 'audio'].includes(messageType) ? messageType : 'unsupported';
}

function normalizeAttachmentType(messageType) {
  return messageType === 'file' ? 'file' : 'other';
}

function messageTypeLabel(messageType) {
  const labels = {
    text: '文字訊息',
    image: '圖片',
    file: '檔案',
    sticker: '貼圖',
    location: '位置',
    video: '影片',
    audio: '語音',
  };

  return labels[messageType] || '其他訊息';
}

function formatTaipeiTime(value) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
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

function conversationAnchorBlock() {
  return coloredParagraph(conversationAnchorText, 'blue');
}

function coloredParagraph(content, color) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: clampText(content, 1900) }, annotations: { color } }],
    },
  };
}

function imageBlock(fileUploadId, caption) {
  return {
    object: 'block',
    type: 'image',
    image: {
      type: 'file_upload',
      file_upload: { id: fileUploadId },
      caption: caption ? [{ type: 'text', text: { content: clampText(caption, 1900) } }] : [],
    },
  };
}

function fileBlock(fileUploadId) {
  return {
    object: 'block',
    type: 'file',
    file: {
      type: 'file_upload',
      file_upload: { id: fileUploadId },
      caption: [],
    },
  };
}

function paragraph(content) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: clampText(content, 1900) } }] },
  };
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
