import { createHash } from 'node:crypto';
import http from 'node:http';

const originalCreateServer = http.createServer.bind(http);

const TASKS_DATA_SOURCE_ID = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const RISK_DECISIONS_DATA_SOURCE_ID = process.env.SEVEN_RISK_DECISIONS_DATA_SOURCE_ID || '0792a903-d274-4a6a-9115-8c66473d1234';
const ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID = process.env.SEVEN_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID || '727d16ff-9ef0-47ed-a83d-bbfd3bf4fb1b';
const CONVERSATIONS_DATA_SOURCE_ID = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const MESSAGES_DATA_SOURCE_ID = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID || '';
const OUTGOING_ACTOR_NAME = process.env.SEVEN_OUTGOING_ACTOR_NAME || 'Seven Jr.';

http.createServer = function createServerWithControlApi(listener) {
  return originalCreateServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';

    if (pathname.startsWith('/control/')) {
      return handleControlRequest(req, res, pathname);
    }

    return listener(req, res);
  });
};

async function handleControlRequest(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    return sendNoContent(res);
  }

  if (req.method === 'GET' && pathname === '/control/health') {
    return sendJson(res, 200, {
      ok: true,
      controlApiEnabled: Boolean(process.env.SEVEN_CONTROL_API_KEY),
      linePushEnabled: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      approvalWriteBackEnabled: Boolean(process.env.NOTION_TOKEN),
      outgoingMessageLoggingEnabled: Boolean(process.env.NOTION_TOKEN && CONVERSATIONS_DATA_SOURCE_ID && MESSAGES_DATA_SOURCE_ID),
      defaultReportTargetConfigured: Boolean(process.env.SEVEN_REPORT_TARGET_ID),
      defaultReportTargetAutoResolveEnabled: Boolean(process.env.NOTION_TOKEN && process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID),
      reportTypes: ['morning', 'daily', 'followup-morning', 'followup-afternoon'],
      endpoints: ['POST /control/line/push', 'POST /control/reports/send', 'POST /control/reports/approve'],
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (pathname === '/control/reports/approve') {
      const body = await readJsonBody(req);
      const result = await approveReport(req, body);
      return sendJson(res, 200, result);
    }

    if (!isAuthorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const body = await readJsonBody(req);

    if (pathname === '/control/line/push') {
      const result = await pushLineMessages(body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/reports/send') {
      const result = await sendReport(body);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

function isAuthorized(req) {
  const expected = process.env.SEVEN_CONTROL_API_KEY;
  if (!expected) {
    return false;
  }

  const headerKey = req.headers['x-seven-control-key'];
  const authorization = req.headers.authorization || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return headerKey === expected || bearerToken === expected;
}

function isApprovalAuthorized(req, body) {
  const expected = process.env.SEVEN_REPORT_APPROVAL_KEY;
  if (!expected) {
    return true;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const headerKey = req.headers['x-seven-approval-key'];
  const queryKey = url.searchParams.get('approvalKey');
  const bodyKey = body.approvalKey;
  return headerKey === expected || queryKey === expected || bodyKey === expected;
}

async function approveReport(req, body) {
  if (!process.env.NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN is not set.');
  }

  if (!isApprovalAuthorized(req, body)) {
    throw new Error('Approval key is invalid.');
  }

  const reportType = String(body.reportType || 'daily').trim().toLowerCase();
  const approvedBy = String(body.approvedBy || 'Seven 陳聖文').trim();
  const submittedAt = body.submittedAt ? new Date(body.submittedAt) : new Date();
  const tasks = normalizeApprovalList(body.tasks);
  const attachments = normalizeApprovalList(body.attachments);

  const taskResults = [];
  for (const item of tasks) {
    taskResults.push(await applyTaskApproval(item, { reportType, approvedBy, submittedAt }));
  }

  const attachmentResults = [];
  for (const item of attachments) {
    attachmentResults.push(await createAttachmentConversionApproval(item, { reportType, approvedBy, submittedAt }));
  }

  const decisionPage = await createApprovalDecisionPage({
    reportType,
    approvedBy,
    submittedAt,
    taskResults,
    attachmentResults,
    notes: body.notes,
  });

  return {
    ok: true,
    reportType,
    decisionPageId: decisionPage.id,
    tasksWritten: taskResults.length,
    attachmentsWritten: attachmentResults.length,
    taskResults,
    attachmentResults,
  };
}

function normalizeApprovalList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

async function applyTaskApproval(item, context) {
  const taskName = String(item.task || item.name || '').trim();
  if (!taskName) {
    throw new Error('Task approval is missing task name.');
  }

  const status = normalizeTaskStatus(item.status);
  const existingPage = await findTaskByName(taskName);
  const summary = `由 ${context.approvedBy} 於 ${formatTaipeiDateTime(context.submittedAt)} 從 ${context.reportType} 報告確認。`;

  if (existingPage) {
    await notionRequest(`/v1/pages/${existingPage.id}`, {
      method: 'PATCH',
      body: {
        properties: compactProperties({
          狀態: selectProperty(status),
          確認狀態: selectProperty('已確認'),
          最後更新: dateProperty(context.submittedAt),
          'Codex 判斷摘要': richTextProperty(summary),
        }),
      },
    });

    return { task: taskName, status, action: 'updated', pageId: existingPage.id };
  }

  const created = await notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: TASKS_DATA_SOURCE_ID },
      properties: compactProperties({
        任務名稱: titleProperty(taskName),
        狀態: selectProperty(status),
        確認狀態: selectProperty('已確認'),
        來源: selectProperty('Codex 手動整理'),
        信心等級: selectProperty('中'),
        優先級: selectProperty('中'),
        專案: selectProperty('未分類'),
        來源原文: richTextProperty(`${context.reportType} 報告頁面確認`),
        'Codex 判斷摘要': richTextProperty(summary),
        最後更新: dateProperty(context.submittedAt),
      }),
    },
  });

  return { task: taskName, status, action: 'created', pageId: created.id };
}

async function findTaskByName(taskName) {
  const result = await notionRequest(`/v1/data_sources/${TASKS_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: { property: '任務名稱', title: { equals: taskName } },
    },
  });

  return result.results?.[0] || null;
}

async function createAttachmentConversionApproval(item, context) {
  const fileName = String(item.file || item.name || '').trim();
  if (!fileName) {
    throw new Error('Attachment approval is missing file name.');
  }

  const action = String(item.action || '暫不轉檔').trim();
  const conversionStatus = resolveConversionStatus(action);
  const conversionType = resolveConversionType(action);
  const sourceUrl = String(item.sourceUrl || '').trim();
  const summary = `由 ${context.approvedBy} 於 ${formatTaipeiDateTime(context.submittedAt)} 從 ${context.reportType} 報告確認：${action}`;

  const created = await notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID },
      properties: compactProperties({
        轉檔項目: titleProperty(`${fileName} - ${action}`),
        原始檔名: richTextProperty(fileName),
        轉檔狀態: selectProperty(conversionStatus),
        轉檔類型: selectProperty(conversionType),
        附件類型: selectProperty('file'),
        '可供 Codex 判斷': checkboxProperty(conversionStatus !== '不需轉檔'),
        轉檔時間: dateProperty(context.submittedAt),
        摘要: richTextProperty(summary),
        轉檔來源附件: sourceUrl ? urlProperty(sourceUrl) : undefined,
      }),
    },
  });

  return { file: fileName, action, conversionStatus, conversionType, pageId: created.id };
}

async function createApprovalDecisionPage({ reportType, approvedBy, submittedAt, taskResults, attachmentResults, notes }) {
  const title = `${reportType} 報告確認 ${formatTaipeiDateTime(submittedAt)}`;
  const taskLines = taskResults.length
    ? taskResults.map((item) => `${item.task} -> ${item.status} (${item.action})`).join('\n')
    : '沒有任務狀態變更。';
  const attachmentLines = attachmentResults.length
    ? attachmentResults.map((item) => `${item.file} -> ${item.action} (${item.conversionStatus})`).join('\n')
    : '沒有附件轉檔確認。';

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: RISK_DECISIONS_DATA_SOURCE_ID },
      properties: compactProperties({
        議題: titleProperty(title),
        類型: selectProperty('決策'),
        專案: selectProperty('跨專案'),
        狀態: selectProperty('已決策'),
        嚴重度: selectProperty('低'),
        說明: richTextProperty(`確認人：${approvedBy}\n報告類型：${reportType}\n\n任務：\n${taskLines}\n\n附件：\n${attachmentLines}`),
        後續行動: richTextProperty(notes ? String(notes) : '依照本次確認結果更新任務與附件轉檔佇列。'),
      }),
    },
  });
}

function normalizeTaskStatus(value) {
  const status = String(value || '').trim();
  const allowed = new Set(['待確認', '未開始', '進行中', '等待回覆', '待確認完成', '已完成', '封存']);
  return allowed.has(status) ? status : '待確認';
}

function resolveConversionStatus(action) {
  return /不需|暫不|不要|跳過/.test(action) ? '不需轉檔' : '待轉檔';
}

function resolveConversionType(action) {
  if (/OCR|圖片|影像/.test(action)) return 'OCR';
  if (/PDF|文字/.test(action)) return 'PDF 文字';
  if (/摘要|整理/.test(action)) return '檔案摘要';
  return '人工整理';
}

async function sendReport(body) {
  const reportType = String(body.reportType || body.type || '').trim().toLowerCase();
  const report = buildReportMessage(reportType, body.text);
  const targets = await resolveReportTargets(body);

  if (!targets.length) {
    throw new Error('No LINE report target found. Send a message to Seven Jr. first, or set SEVEN_REPORT_TARGET_ID.');
  }

  return pushToTargets(targets, [report]);
}

async function resolveReportTargets(body) {
  const targets = normalizeTargets(body.targets, body.targetId, body.targetType);
  if (targets.length) {
    return targets;
  }

  const defaultTargetId = process.env.SEVEN_REPORT_TARGET_ID;
  if (defaultTargetId) {
    return [{ id: defaultTargetId, type: process.env.SEVEN_REPORT_TARGET_TYPE || 'user' }];
  }

  const notionTarget = await findDefaultReportTargetFromNotion();
  return notionTarget ? [notionTarget] : [];
}

async function findDefaultReportTargetFromNotion() {
  const notionToken = process.env.NOTION_TOKEN;
  const dataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID;
  if (!notionToken || !dataSourceId) {
    return null;
  }

  const result = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 10,
      filter: { property: '對象類型', select: { equals: '個人' } },
      sorts: [{ property: '最後訊息時間', direction: 'descending' }],
    },
  });

  const pages = result.results || [];
  const keyword = String(process.env.SEVEN_REPORT_TARGET_NAME_KEYWORD || 'Seven').toLowerCase();
  const preferred = pages.find((page) => pageTextProperty(page, 'LINE 對話名稱').toLowerCase().includes(keyword)
    || pageTextProperty(page, '自定義名稱').toLowerCase().includes(keyword));
  const selected = preferred || pages[0];
  const userId = selected ? pageTextProperty(selected, 'User ID') : '';

  return userId ? { id: userId, type: 'user', source: 'notion-auto' } : null;
}

function buildReportMessage(reportType, customText) {
  if (customText) {
    return { type: 'text', text: clampLineText(customText) };
  }

  const morningBriefUrl = process.env.MORNING_BRIEF_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/morning-brief-prototype.html';
  const dailyReportUrl = process.env.DAILY_REPORT_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/daily-control-report-prototype.html';
  const followupBaseUrl = process.env.FOLLOWUP_CONFIRMATION_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/followup-confirmation-prototype.html';

  if (['morning', 'morning-brief', '早報'].includes(reportType)) {
    return {
      type: 'text',
      text: `早上 8 點早晨總控報告：\n${morningBriefUrl}\n\n請確認今日行程、優先工作、未完成事項與需要決策的項目。`,
    };
  }

  if (['daily', 'evening', 'night', '晚報', '每日報告'].includes(reportType)) {
    return {
      type: 'text',
      text: `晚上 8 點半每日總控報告：\n${dailyReportUrl}\n\n請確認專案進度、待辦狀態、附件解析需求與明日優先事項。`,
    };
  }

  if (['followup-morning', 'followup-10', '10', '上午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `上午 10 點進度追蹤確認：\n${followupBaseUrl}\n\n請確認哪些提醒可以由 Seven Jr. 送出，或需要退回修改。`,
    };
  }

  if (['followup-afternoon', 'followup-17', '17', '下午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `下午 5 點進度追蹤確認：\n${followupBaseUrl}${followupBaseUrl.includes('?') ? '&' : '?'}slot=17\n\n請確認下午要追蹤的對象與訊息，批准後再由 Seven Jr. 送出。`,
    };
  }

  throw new Error('Unknown reportType. Use morning, daily, followup-morning, or followup-afternoon.');
}

async function pushLineMessages(body) {
  const targets = normalizeTargets(body.targets, body.targetId, body.targetType);
  const messages = normalizeMessages(body.messages, body.message, body.text);

  if (!targets.length) {
    throw new Error('Missing targetId or targets.');
  }
  if (!messages.length) {
    throw new Error('Missing text, message, or messages.');
  }

  return pushToTargets(targets, messages);
}

function normalizeTargets(targets, targetId, targetType) {
  if (Array.isArray(targets)) {
    return targets
      .map((target) => ({
        id: target.id || target.targetId || target.to,
        type: target.type || target.targetType || inferTargetType(target.id || target.targetId || target.to),
        name: target.name || target.targetName || target.displayName || '',
      }))
      .filter((target) => target.id);
  }

  if (targetId) {
    return [{ id: targetId, type: targetType || inferTargetType(targetId), name: '' }];
  }

  return [];
}

function normalizeMessages(messages, message, text) {
  if (Array.isArray(messages)) {
    return messages.map(normalizeMessage).filter(Boolean).slice(0, 5);
  }

  if (message) {
    return [normalizeMessage(message)].filter(Boolean);
  }

  if (text) {
    return [{ type: 'text', text: clampLineText(text) }];
  }

  return [];
}

function normalizeMessage(message) {
  if (typeof message === 'string') {
    return { type: 'text', text: clampLineText(message) };
  }

  if (message?.type === 'text' && message.text) {
    return { ...message, text: clampLineText(message.text) };
  }

  return message && message.type ? message : null;
}

function inferTargetType(targetId) {
  const value = String(targetId || '');
  if (value.startsWith('U')) return 'user';
  if (value.startsWith('C')) return 'group';
  if (value.startsWith('R')) return 'room';
  return 'unknown';
}

async function pushToTargets(targets, messages) {
  const results = [];
  for (const target of targets) {
    await pushLine(target.id, messages);
    const outgoingLog = await recordOutgoingMessages(target, messages);
    results.push({
      targetId: target.id,
      targetType: target.type || 'unknown',
      source: target.source || 'request',
      ok: true,
      outgoingLog,
    });
  }

  return { ok: true, sent: results.length, results };
}

async function pushLine(to, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  }

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${responseText}`);
  }
}

async function recordOutgoingMessages(target, messages) {
  if (!process.env.NOTION_TOKEN || !CONVERSATIONS_DATA_SOURCE_ID || !MESSAGES_DATA_SOURCE_ID) {
    return { skipped: true, reason: 'notion-message-logging-not-configured' };
  }

  try {
    const sentAt = new Date().toISOString();
    const context = resolveOutgoingTargetContext(target);
    const preview = buildOutgoingPreview(messages);
    const conversation = await findOrCreateOutgoingConversation(context, target, sentAt, preview);
    const pages = [];

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const messageId = buildOutgoingMessageId(target, message, sentAt, index);
      const text = outgoingMessageText(message);
      const messageType = normalizeOutgoingMessageType(message.type);
      const existing = await findOutgoingMessagePage(messageId);
      if (existing) {
        pages.push({ messageId, pageId: existing.id, duplicate: true });
        continue;
      }

      const page = await createOutgoingMessagePage({
        conversationId: conversation.id,
        messageId,
        message,
        messageType,
        text,
        sentAt,
        target,
        context,
      });
      pages.push({ messageId, pageId: page.id, duplicate: false });
    }

    await appendOutgoingConversationContent({
      conversationId: conversation.id,
      target,
      messages,
      sentAt,
    });

    await updateOutgoingConversation(conversation, target, sentAt, preview, messages.length);

    return { skipped: false, conversationId: conversation.id, messagesLogged: pages.length, pages };
  } catch (error) {
    console.warn(`Unable to record outgoing LINE message for ${target.id}: ${error.message}`);
    return { skipped: true, reason: error.message };
  }
}

function resolveOutgoingTargetContext(target) {
  const type = target.type || inferTargetType(target.id);
  if (type === 'group') {
    return { identityProperty: 'Group ID', identityValue: target.id, entityType: '群組', key: `group:${target.id}` };
  }
  if (type === 'room') {
    return { identityProperty: 'Room ID', identityValue: target.id, entityType: '聊天室', key: `room:${target.id}` };
  }
  if (type === 'user') {
    return { identityProperty: 'User ID', identityValue: target.id, entityType: '個人', key: `user:${target.id}` };
  }
  return { identityProperty: '對話統一鍵', identityValue: `unknown:${target.id}`, entityType: '未知', key: `unknown:${target.id}` };
}

async function findOrCreateOutgoingConversation(context, target, sentAt, preview) {
  const existing = await findOutgoingConversation(context);
  if (existing) {
    return existing;
  }

  const name = target.name || `${context.entityType} ${target.id}`;
  const properties = {
    'LINE 對話名稱': titleProperty(name),
    自定義名稱: richTextProperty(name),
    對象類型: selectProperty(context.entityType),
    對話統一鍵: richTextProperty(context.key),
    最後訊息時間: dateProperty(sentAt),
    最新訊息預覽: richTextProperty(preview),
    '訊息數（總）': { number: 0 },
    監控狀態: selectProperty('啟用'),
  };

  if (context.identityProperty && context.identityValue) {
    properties[context.identityProperty] = richTextProperty(context.identityValue);
  }

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: CONVERSATIONS_DATA_SOURCE_ID },
      properties,
    },
  });
}

async function findOutgoingConversation(context) {
  if (!context.identityProperty || !context.identityValue) {
    return null;
  }

  const result = await notionRequest(`/v1/data_sources/${CONVERSATIONS_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: { property: context.identityProperty, rich_text: { equals: context.identityValue } },
    },
  });

  return result.results?.[0] || null;
}

async function updateOutgoingConversation(conversation, target, sentAt, preview, messageCount) {
  const currentCount = conversation.properties?.['訊息數（總）']?.number || 0;
  const context = resolveOutgoingTargetContext(target);
  const name = target.name || pageTextProperty(conversation, 'LINE 對話名稱') || `${context.entityType} ${target.id}`;

  await notionRequest(`/v1/pages/${conversation.id}`, {
    method: 'PATCH',
    body: {
      properties: {
        'LINE 對話名稱': titleProperty(name),
        最後訊息時間: dateProperty(sentAt),
        最新訊息預覽: richTextProperty(preview),
        '訊息數（總）': { number: currentCount + messageCount },
      },
    },
  });
}

async function findOutgoingMessagePage(messageId) {
  const result = await notionRequest(`/v1/data_sources/${MESSAGES_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: { property: '訊息 ID', title: { equals: messageId } },
    },
  });

  return result.results?.[0] || null;
}

async function createOutgoingMessagePage({ conversationId, messageId, message, messageType, text, sentAt, target, context }) {
  const payload = {
    direction: 'outgoing',
    actorName: OUTGOING_ACTOR_NAME,
    target: { id: target.id, type: target.type || inferTargetType(target.id), name: target.name || '' },
    message,
    sentAt,
  };

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: MESSAGES_DATA_SOURCE_ID },
      properties: {
        '訊息 ID': titleProperty(messageId),
        'LINE 事件 ID': richTextProperty('outgoing-control-api'),
        'Webhook 重送序號': { number: 0 },
        對話主檔: relationProperty(conversationId),
        訊息來源: selectProperty('ai-engine'),
        訊息類型: selectProperty(messageType),
        文字內容: richTextProperty(text),
        原始內容: richTextProperty(text),
        '原始 payload': richTextProperty(JSON.stringify(payload)),
        '發話者 ID': richTextProperty(OUTGOING_ACTOR_NAME),
        發話者名稱: richTextProperty(OUTGOING_ACTOR_NAME),
        發話者類型: selectProperty('oa'),
        群組標記: checkboxProperty(['群組', '聊天室'].includes(context.entityType)),
        排序時間: dateProperty(sentAt),
        已進入判斷層: checkboxProperty(false),
      },
      children: [
        paragraphProperty(`來源：${OUTGOING_ACTOR_NAME} 主動發送`),
        paragraphProperty(text || '(非文字訊息)'),
      ],
    },
  });
}

async function appendOutgoingConversationContent({ conversationId, target, messages, sentAt }) {
  const blocks = [];
  const context = resolveOutgoingTargetContext(target);
  const conversationName = target.name || `${context.entityType} ${target.id}`;

  messages.forEach((message, index) => {
    const messageType = normalizeOutgoingMessageType(message.type);
    const text = outgoingMessageText(message);
    const typeLabel = messageType === 'text' ? '文字訊息' : messageType;
    const meta = `【${formatTaipeiDateTime(sentAt)}】${conversationName} - ${OUTGOING_ACTOR_NAME}：${typeLabel}`;
    blocks.push(paragraphProperty(meta));
    blocks.push(paragraphProperty(text || '(非文字訊息)'));
    if (index < messages.length - 1) {
      blocks.push(paragraphProperty(''));
    }
  });

  if (!blocks.length) {
    return;
  }

  await notionRequest(`/v1/blocks/${conversationId}/children`, {
    method: 'PATCH',
    body: { children: blocks },
  });
}

function buildOutgoingPreview(messages) {
  const text = messages.map(outgoingMessageText).filter(Boolean).join('\n');
  return text || `[${messages.length} outgoing message${messages.length > 1 ? 's' : ''}]`;
}

function outgoingMessageText(message) {
  if (typeof message === 'string') {
    return message;
  }
  if (message?.type === 'text') {
    return message.text || '';
  }
  return message ? JSON.stringify(message) : '';
}

function normalizeOutgoingMessageType(messageType) {
  return ['text', 'image', 'sticker', 'file', 'location', 'video', 'audio'].includes(messageType) ? messageType : 'unsupported';
}

function buildOutgoingMessageId(target, message, sentAt, index) {
  const hash = createHash('sha256')
    .update(JSON.stringify({ targetId: target.id, message, sentAt, index }))
    .digest('hex')
    .slice(0, 16);
  return `out:${sentAt}:${target.id}:${index}:${hash}`;
}

async function notionRequest(pathname, { method, body }) {
  const response = await fetch(`https://api.notion.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': process.env.NOTION_VERSION || '2025-09-03',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Notion API failed: ${response.status} ${responseText}`);
  }

  return responseText ? JSON.parse(responseText) : {};
}

function pageTextProperty(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property) {
    return '';
  }

  if (property.type === 'title') {
    return richTextPlain(property.title);
  }

  if (property.type === 'rich_text') {
    return richTextPlain(property.rich_text);
  }

  return '';
}

function richTextPlain(items) {
  return (items || []).map((item) => item.plain_text || item.text?.content || '').join('');
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function titleProperty(value) {
  return { title: [{ text: { content: clampNotionText(value) } }] };
}

function richTextProperty(value) {
  return { rich_text: [{ text: { content: clampNotionText(value) } }] };
}

function selectProperty(name) {
  return { select: { name } };
}

function dateProperty(value) {
  return { date: { start: value instanceof Date ? value.toISOString() : new Date(value).toISOString() } };
}

function checkboxProperty(value) {
  return { checkbox: Boolean(value) };
}

function relationProperty(id) {
  return { relation: [{ id }] };
}

function urlProperty(value) {
  return { url: value };
}

function paragraphProperty(content) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampNotionText(content) } }] } };
}

async function readJsonBody(req) {
  const rawBody = await readBody(req);
  if (!rawBody.trim()) {
    return {};
  }

  return JSON.parse(rawBody);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function clampLineText(value) {
  const text = String(value || '');
  return text.length > 4900 ? `${text.slice(0, 4897)}...` : text;
}

function clampNotionText(value) {
  const text = String(value || '');
  return text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
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
  }).format(value instanceof Date ? value : new Date(value));
}

function sendNoContent(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, x-seven-control-key, x-seven-approval-key',
  };
}
