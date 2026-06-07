import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

loadDotenv();

const originalCreateServer = http.createServer.bind(http);

const TASKS_DATA_SOURCE_ID = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const RISK_DECISIONS_DATA_SOURCE_ID = process.env.SEVEN_RISK_DECISIONS_DATA_SOURCE_ID || '0792a903-d274-4a6a-9115-8c66473d1234';
const ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID = process.env.SEVEN_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID || '727d16ff-9ef0-47ed-a83d-bbfd3bf4fb1b';
const CODEX_COMMANDS_DATA_SOURCE_ID = process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID || 'c4eee8de-e596-4d64-906b-1405d79e721c';
const DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID = process.env.SEVEN_DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID || '8f7f95a5-7428-4490-9327-7943499a0e22';
const PROGRESS_REPORTS_DATA_SOURCE_ID = process.env.SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID || 'fc5e4e21-6af6-4de2-9380-aa95126ee13e';
const CONVERSATIONS_DATA_SOURCE_ID = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const MESSAGES_DATA_SOURCE_ID = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID || '';
const OUTGOING_ACTOR_NAME = process.env.SEVEN_OUTGOING_ACTOR_NAME || 'Seven Jr.';
const CONVERSATION_ANCHOR_TEXT = '【Seven LINE】對話記錄';
const OUTGOING_BLOCK_COLOR = 'orange';
const PUBLIC_BASE_URL = (process.env.SEVEN_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://line-oa-webhook-nn5j.onrender.com').replace(/\/+$/, '');
const REPORT_ROUTES = new Map([
  ['/reports/morning-brief', '../reports/morning-brief-prototype.html'],
  ['/reports/morning-brief-prototype.html', '../reports/morning-brief-prototype.html'],
  ['/reports/daily-control-report', '../reports/daily-control-report-prototype.html'],
  ['/reports/daily-control-report-prototype.html', '../reports/daily-control-report-prototype.html'],
  ['/reports/followup-confirmation', '../reports/followup-confirmation-prototype.html'],
  ['/reports/followup-confirmation-prototype.html', '../reports/followup-confirmation-prototype.html'],
]);

http.createServer = function createServerWithControlApi(listener) {
  return originalCreateServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && REPORT_ROUTES.has(pathname)) {
      return serveReportPage(res, pathname);
    }

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
      approvalAcknowledgementEnabled: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      outgoingMessageLoggingEnabled: Boolean(process.env.NOTION_TOKEN && CONVERSATIONS_DATA_SOURCE_ID && MESSAGES_DATA_SOURCE_ID),
      defaultReportTargetConfigured: Boolean(process.env.SEVEN_REPORT_TARGET_ID),
      defaultReportTargetAutoResolveEnabled: Boolean(process.env.NOTION_TOKEN && process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID),
      codexCommandQueueConfigured: Boolean(CODEX_COMMANDS_DATA_SOURCE_ID),
      dailyReportSnapshotsConfigured: Boolean(DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID),
      reportTypes: ['morning', 'daily', 'followup-morning', 'followup-midday', 'followup-afternoon'],
      endpoints: ['POST /control/line/push', 'POST /control/reports/send', 'POST /control/reports/preview', 'POST /control/reports/approve', 'POST /control/codex-commands/test'],
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
      const result = await pushLineMessages(req, body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/reports/send') {
      const result = await sendReport(req, body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/reports/preview') {
      const result = await previewReport(body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/codex-commands/test') {
      const result = await createCodexCommandTest(body);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

async function createCodexCommandTest(body) {
  if (!process.env.NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN is not set.');
  }
  if (!CODEX_COMMANDS_DATA_SOURCE_ID) {
    throw new Error('SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID is not set.');
  }

  const now = new Date();
  const originalText = String(body.text || body.originalText || 'Seven Junior 測試 Command Queue：請回覆我你已成功收到這個測試命令。').trim();
  const trigger = findCodexCommandTrigger(originalText);
  const commandText = extractCodexCommand(originalText);
  const sourceType = String(body.sourceType || body.targetType || 'user').trim();
  const sourceId = String(body.sourceId || body.targetId || process.env.SEVEN_REPORT_TARGET_ID || 'U09dc6553016c78d89c515522be9b74f6').trim();
  const lineMessageId = String(body.lineMessageId || `control-test-${now.getTime()}`).trim();
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : now;

  const page = await notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: CODEX_COMMANDS_DATA_SOURCE_ID },
      properties: compactProperties({
        Name: titleProperty(commandText || originalText),
        Status: selectProperty('Pending'),
        Trigger: richTextProperty(trigger?.label || 'Manual Test'),
        Command: richTextProperty(commandText),
        'Original Text': richTextProperty(originalText),
        'Source Type': selectProperty(sourceType),
        'Source ID': richTextProperty(sourceId),
        'User ID': richTextProperty(sourceType === 'user' ? sourceId : String(body.userId || '')),
        'Conversation Name': richTextProperty(String(body.conversationName || 'Seven Jr. control test')),
        'Actor Name': richTextProperty(String(body.actorName || 'Seven 陳聖文')),
        'Conversation Key': richTextProperty(`${sourceType}:${sourceId}`),
        'LINE Message ID': richTextProperty(lineMessageId),
        'LINE Event ID': richTextProperty(String(body.lineEventId || `control-test-event-${now.getTime()}`)),
        'Message Page URL': body.messagePageUrl ? urlProperty(String(body.messagePageUrl)) : undefined,
        'Conversation Page URL': body.conversationPageUrl ? urlProperty(String(body.conversationPageUrl)) : undefined,
        'Received At': dateProperty(receivedAt),
        'Risk Level': selectProperty(resolveCommandRiskLevel(commandText || originalText)),
        'Raw Event': richTextProperty(JSON.stringify({
          source: 'control-api-test',
          originalText,
          sourceType,
          sourceId,
          lineMessageId,
          createdAt: now.toISOString(),
        })),
      }),
      children: [
        paragraphProperty(`Trigger: ${trigger?.label || 'Manual Test'}`),
        paragraphProperty(`Command: ${commandText || '(no command text after trigger)'}`),
        paragraphProperty(`Source: ${sourceType} ${sourceId}`.trim()),
      ],
    },
  });

  return {
    ok: true,
    pageId: page.id,
    url: page.url,
    status: 'Pending',
    trigger: trigger?.label || 'Manual Test',
    command: commandText,
    sourceType,
    sourceId,
    lineMessageId,
  };
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
    return value;
  }
  return value.replace(trigger.pattern, '').replace(/^[\s:：,，。-]+/, '').trim();
}

function resolveCommandRiskLevel(text) {
  const value = String(text || '').toLowerCase();
  const highRiskTerms = ['contract', 'legal', 'tax', 'salary', 'payment', 'invoice', 'fire ', 'terminate', '合約', '法律', '稅', '薪資', '付款', '匯款', '發票', '解僱', '資遣', '報價'];
  return highRiskTerms.some((term) => value.includes(term)) ? 'High' : 'Normal';
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
  const reportContent = String(body.reportContent || body.editedReport || '').trim();
  const decisions = normalizeApprovalList(body.decisions);
  const followups = normalizeApprovalList(body.followups);

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
    reportContent,
    decisions,
    followups,
    notes: body.notes,
  });
  const snapshotUpdate = await maybeMarkDailyReportSnapshotConfirmed({
    reportType,
    decisionPage,
    submittedAt,
  });
  const acknowledgement = await sendReportApprovalAcknowledgement(body, {
    reportType,
    approvedBy,
    submittedAt,
    taskResults,
    attachmentResults,
    decisions,
    followups,
    decisionPage,
  });

  return {
    ok: true,
    reportType,
    decisionPageId: decisionPage.id,
    acknowledgement,
    tasksWritten: taskResults.length,
    attachmentsWritten: attachmentResults.filter((item) => !item.skipped).length,
    attachmentsReviewed: attachmentResults.length,
    snapshotUpdate,
    taskResults,
    attachmentResults,
  };
}

async function sendReportApprovalAcknowledgement(body, context) {
  if (body.sendAcknowledgement === false || body.acknowledgement === false) {
    return { ok: false, skipped: true, reason: 'disabled-by-request' };
  }

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, skipped: true, reason: 'LINE_CHANNEL_ACCESS_TOKEN is not set.' };
  }

  try {
    const targets = await resolveAcknowledgementTargets(body);
    if (!targets.length) {
      return { ok: false, skipped: true, reason: 'No acknowledgement target found.' };
    }

    const message = buildApprovalAcknowledgementMessage(context);
    const result = await pushToTargets(targets, [message]);
    return { ok: true, targets: result.results || [], message: message.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to send report approval acknowledgement: ${message}`);
    return { ok: false, error: message };
  }
}

async function resolveAcknowledgementTargets(body) {
  const ackTargets = normalizeTargets(body.ackTargets || body.acknowledgementTargets, body.ackTargetId, body.ackTargetType);
  if (ackTargets.length) {
    return ackTargets;
  }

  return resolveReportTargets({
    targets: body.targets,
    targetId: body.targetId,
    targetType: body.targetType,
  });
}

function buildApprovalAcknowledgementMessage({ reportType, approvedBy, submittedAt, taskResults, attachmentResults, decisions, followups, decisionPage }) {
  const label = reportTypeLabel(reportType);
  const lines = [
    `Seven Jr. 已收到你送出的${label}確認。`,
    `確認人：${approvedBy}`,
    `時間：${formatTaipeiDateTime(submittedAt)}`,
  ];

  const summary = [];
  if (decisions.length) summary.push(`決策 ${decisions.length} 項`);
  if (followups.length) summary.push(`追蹤 ${followups.length} 項`);
  if (taskResults.length) summary.push(`任務 ${taskResults.length} 項`);
  if (attachmentResults.length) summary.push(`附件 ${attachmentResults.length} 項`);

  lines.push(summary.length ? `已寫入：${summary.join('、')}` : '已寫入：本次確認紀錄');

  if (decisionPage?.url) {
    lines.push(`Notion 紀錄：${decisionPage.url}`);
  }

  lines.push('我會依照這次確認結果更新後續追蹤。');

  return { type: 'text', text: clampLineText(lines.join('\n')) };
}

function reportTypeLabel(reportType) {
  const labels = {
    morning: '早報',
    'morning-brief': '早報',
    daily: '每日總控報告',
    evening: '每日總控報告',
    night: '每日總控報告',
    'followup-morning': '10:00 追蹤確認與新任務確認',
    'followup-midday': '13:00 追蹤確認與新任務確認',
    'followup-afternoon': '17:00 追蹤確認與新任務確認',
    'followup-10': '10:00 追蹤確認與新任務確認',
    'followup-13': '13:00 追蹤確認與新任務確認',
    'followup-17': '17:00 追蹤確認與新任務確認',
  };
  return labels[String(reportType || '').trim().toLowerCase()] || `${reportType || '報告'}報告`;
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

  if (isConfirmedNoConversion(action)) {
    return {
      file: fileName,
      action,
      conversionStatus: '不需轉檔',
      conversionType: '不轉檔',
      skipped: true,
      reason: 'confirmed-no-conversion',
    };
  }

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

async function createApprovalDecisionPage({ reportType, approvedBy, submittedAt, taskResults, attachmentResults, reportContent, decisions, followups, notes }) {
  const title = `${reportType} 報告確認 ${formatTaipeiDateTime(submittedAt)}`;
  const taskLines = taskResults.length
    ? taskResults.map((item) => `${item.task} -> ${item.status} (${item.action})`).join('\n')
    : '沒有任務狀態變更。';
  const attachmentLines = attachmentResults.length
    ? attachmentResults.map((item) => `${item.file} -> ${item.action} (${item.conversionStatus})`).join('\n')
    : '沒有附件轉檔確認。';
  const decisionLines = decisions?.length
    ? decisions.map((item) => `${item.item || item.title || '決策'} -> ${item.decision || item.value || item.status || ''}`).join('\n')
    : '沒有額外決策選擇。';
  const followupLines = followups?.length
    ? followups.map((item) => [
      `目標：${item.target || ''}`,
      `動作：${item.action || ''}`,
      `是否發送：${item.send ? '是' : '否'}`,
      `訊息：${item.message || ''}`,
    ].join('\n')).join('\n---\n')
    : '沒有追蹤訊息確認。';
  const reportText = reportContent || '沒有提供修改後報告內容。';

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
        說明: richTextProperty(`確認人：${approvedBy}\n報告類型：${reportType}\n\n修改後報告內容：\n${reportText}\n\n決策：\n${decisionLines}\n\n追蹤訊息：\n${followupLines}\n\n任務：\n${taskLines}\n\n附件：\n${attachmentLines}`),
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
  if (isConfirmedNoConversion(action)) return '不轉檔';
  if (/OCR|圖片|影像/.test(action)) return 'OCR';
  if (/PDF|文字/.test(action)) return 'PDF 文字';
  if (/摘要|整理/.test(action)) return '檔案摘要';
  return '人工整理';
}

function isConfirmedNoConversion(action) {
  return /確定不轉檔|不需轉檔|不用轉檔|不要轉檔/.test(String(action || ''));
}

async function sendReport(req, body) {
  const reportType = String(body.reportType || body.type || '').trim().toLowerCase();
  const report = await buildReportMessage(reportType, body.text);
  const targets = await resolveReportTargets(body);
  const cronMeta = readCronMeta(req, body);

  if (!targets.length) {
    throw new Error('No LINE report target found. Send a message to Seven Jr. first, or set SEVEN_REPORT_TARGET_ID.');
  }

  if (cronMeta) {
    console.log(JSON.stringify({
      event: 'control-report-send',
      reportType,
      cronMeta,
      targetCount: targets.length,
    }));
  }

  const result = await pushToTargets(targets, [report]);
  const snapshot = await maybeCreateDailyReportSnapshot({
    reportType,
    report,
    targets,
    cronMeta,
    sentAt: new Date(),
  });
  return { ...result, ...(cronMeta ? { cronMeta } : {}), ...(snapshot ? { snapshot } : {}) };
}

async function previewReport(body) {
  const reportType = String(body.reportType || body.type || '').trim().toLowerCase();
  const report = await buildReportMessage(reportType, body.text);
  return {
    ok: true,
    reportType,
    report,
    wouldSend: false,
  };
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

async function maybeCreateDailyReportSnapshot({ reportType, report, targets, cronMeta, sentAt }) {
  if (!isDailyReportType(reportType) || !DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID || !process.env.NOTION_TOKEN) {
    return null;
  }

  try {
    const text = outgoingMessageText(report);
    const reportUrl = firstUrlFromText(text);
    const reportDate = taipeiDateOnly(sentAt);
    const targetSummary = targets.map((target) => target.name || target.id).filter(Boolean).join('、');
    const title = `${reportDate} 每日總控總確認`;
    const page = await notionRequest('/v1/pages', {
      method: 'POST',
      body: {
        parent: { type: 'data_source_id', data_source_id: DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID },
        properties: compactProperties({
          報告名稱: titleProperty(title),
          報告日期: dateProperty(`${reportDate}T00:00:00+08:00`),
          報告類型: selectProperty('每日總控總確認'),
          狀態: selectProperty('已發送'),
          報告連結: reportUrl ? urlProperty(reportUrl) : undefined,
          LINE訊息內容: richTextProperty(text),
          發送時間: dateProperty(sentAt),
          CronJob: richTextProperty(cronMeta?.jobName || ''),
          RunID: richTextProperty(cronMeta?.runId || ''),
          目標: richTextProperty(targetSummary),
          摘要: richTextProperty('20:30 每日總控總確認已發送，等待使用者確認寫回。'),
        }),
        children: [
          paragraphProperty('每日總控總確認快照'),
          paragraphProperty(`報告日期：${reportDate}`),
          paragraphProperty(`報告連結：${reportUrl || '未提供'}`),
          paragraphProperty(`發送目標：${targetSummary || '預設報告對象'}`),
          paragraphProperty('LINE 訊息內容：'),
          paragraphProperty(text),
        ],
      },
    });

    return { ok: true, pageId: page.id, url: page.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to create daily report snapshot: ${message}`);
    return { ok: false, error: message };
  }
}

async function maybeMarkDailyReportSnapshotConfirmed({ reportType, decisionPage, submittedAt }) {
  if (!isDailyReportType(reportType) || !DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID || !process.env.NOTION_TOKEN) {
    return null;
  }

  try {
    const result = await notionRequest(`/v1/data_sources/${DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID}/query`, {
      method: 'POST',
      body: {
        page_size: 1,
        filter: { property: '報告類型', select: { equals: '每日總控總確認' } },
        sorts: [{ property: '發送時間', direction: 'descending' }],
      },
    });
    const snapshot = result.results?.[0];
    if (!snapshot) {
      return { ok: false, skipped: true, reason: 'no-daily-report-snapshot-found' };
    }

    const page = await notionRequest(`/v1/pages/${snapshot.id}`, {
      method: 'PATCH',
      body: {
        properties: compactProperties({
          狀態: selectProperty('已確認'),
          確認時間: dateProperty(submittedAt),
          確認紀錄連結: decisionPage?.url ? urlProperty(decisionPage.url) : undefined,
          摘要: richTextProperty('每日總控總確認已由使用者確認，確認結果已寫入風險與決策庫。'),
        }),
      },
    });

    return { ok: true, pageId: page.id, url: page.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to update daily report snapshot confirmation: ${message}`);
    return { ok: false, error: message };
  }
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

async function buildReportMessage(reportType, customText) {
  if (customText) {
    return { type: 'text', text: clampLineText(customText) };
  }

  const morningBriefUrl = process.env.MORNING_BRIEF_URL || `${PUBLIC_BASE_URL}/reports/morning-brief`;
  const dailyReportUrl = process.env.DAILY_REPORT_URL || `${PUBLIC_BASE_URL}/reports/daily-control-report`;
  const followupBaseUrl = process.env.FOLLOWUP_CONFIRMATION_URL || `${PUBLIC_BASE_URL}/reports/followup-confirmation`;

  if (['morning', 'morning-brief', '早報'].includes(reportType)) {
    return {
      type: 'text',
      text: `早上 8 點早晨總控報告：\n${morningBriefUrl}\n\n請確認今日行程、優先工作、未完成事項與需要決策的項目。`,
    };
  }

  if (['daily', 'evening', 'night', '晚報', '每日報告'].includes(reportType)) {
    const dynamicText = await buildDynamicDailyReportText(dailyReportUrl);
    if (dynamicText) {
      return { type: 'text', text: clampLineText(dynamicText) };
    }

    return {
      type: 'text',
      text: `晚上 8 點半每日總控總確認：\n${dailyReportUrl}\n\n請確認專案進度、待辦狀態、新任務、附件解析需求與明日優先事項。`,
    };
  }

  if (['followup-morning', 'followup-10', '10', '上午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `上午 10 點追蹤確認與新任務確認：\n${withFollowupSlot(followupBaseUrl, '10')}\n\n請確認哪些提醒可以由 Seven Jr. 送出，並檢查新任務是否成立或需要退回修改。`,
    };
  }

  if (['followup-midday', 'followup-13', '13', '中午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `下午 1 點追蹤確認與新任務確認：\n${withFollowupSlot(followupBaseUrl, '13')}\n\n請確認午間前新增的待確認任務、追蹤訊息與需要退回修改的項目。`,
    };
  }

  if (['followup-afternoon', 'followup-17', '17', '下午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `下午 5 點追蹤確認與新任務確認：\n${withFollowupSlot(followupBaseUrl, '17')}\n\n請確認下午要追蹤的對象與訊息，並檢查新任務是否成立或需要退回修改。`,
    };
  }

  throw new Error('Unknown reportType. Use morning, daily, followup-morning, followup-midday, or followup-afternoon.');
}

async function buildDynamicDailyReportText(dailyReportUrl) {
  if (!process.env.NOTION_TOKEN || !TASKS_DATA_SOURCE_ID || !MESSAGES_DATA_SOURCE_ID) {
    return '';
  }

  try {
    const reportDate = taipeiDateOnly(new Date());
    const [tasks, messages, progressReports] = await Promise.all([
      listRecentTasksForDailyReport(),
      listImportantMessagesForDailyReport(),
      listRecentProgressReportsForDailyReport(),
    ]);

    const reportItems = dedupeReportItems([...tasks, ...messages])
      .filter((item) => item.project !== '未分類' || item.priority === '高')
      .sort(compareDailyReportItems);
    const leadingItems = reportItems.filter((item) => item.priority === '高').slice(0, 5);
    const usedKeys = new Set(leadingItems.map(reportItemKey));

    const sections = [
      `20:30 每日總控報告`,
      `日期：${reportDate}`,
      `重點：高優先 ${reportItems.filter((item) => item.priority === '高').length} 件，待確認 ${tasks.filter((item) => item.confirmation === '未確認' || item.status === '待確認').length} 件。`,
      '',
      buildDailySection('一、需要你先看', leadingItems, 5),
      buildCompactDailySection('二、關係 / 客訴 / 承諾追蹤', filterUnusedReportItems(reportItems, usedKeys, ['relationshipIssue', '關係', '客訴', '不滿', '沒有回報', '回報進度', '抱歉', '道歉']), 3),
      buildCompactDailySection('三、包租代管 / 客戶房客', filterUnusedReportItems(reportItems, usedKeys, ['包租代管', 'customerIssue', 'tenant']), 3),
      buildCompactDailySection('四、私人 / 家庭 / 健康', filterUnusedReportItems(reportItems, usedKeys, ['私人事務', 'health', 'family']), 3),
      buildCompactDailySection('五、財務 / 保險 / 報稅', filterUnusedReportItems(reportItems, usedKeys, ['財務', 'finance', 'insurance']), 3),
      buildCompactDailySection('六、營運 / 會議 / 系統', filterUnusedReportItems(reportItems, usedKeys, ['營運', 'meeting', 'progress']), 3),
      buildCompactDailySection('七、今天進度更新', progressReports.sort(compareDailyReportItems), 2),
      '',
      `報告頁：${dailyReportUrl}`,
      '提醒：以上為動態摘要。敏感或低信心事項先保留為待確認，不會自動對外回覆。',
    ].filter((line) => line !== null && line !== undefined);

    return sections.join('\n');
  } catch (error) {
    console.warn(`Unable to build dynamic daily report: ${error.message}`);
    return '';
  }
}

async function listRecentTasksForDailyReport() {
  const result = await notionRequest(`/v1/data_sources/${TASKS_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      page_size: 50,
      sorts: [{ property: '最後更新', direction: 'descending' }],
    },
  });

  const today = taipeiDateOnly(new Date());
  return (result.results || [])
    .map((page) => ({
      source: 'task',
      title: pageTextProperty(page, '任務名稱'),
      project: pageSelectProperty(page, '專案'),
      priority: pageSelectProperty(page, '優先級'),
      status: pageSelectProperty(page, '狀態'),
      confirmation: pageSelectProperty(page, '確認狀態'),
      sourceType: pageSelectProperty(page, '來源'),
      summary: pageTextProperty(page, 'Codex 判斷摘要') || pageTextProperty(page, '下一步') || pageTextProperty(page, '來源原文'),
      nextStep: pageTextProperty(page, '下一步'),
      updatedAt: pageDateProperty(page, '最後更新') || page.last_edited_time || '',
      url: page.url,
    }))
    .filter((item) => isTodayTaipei(item.updatedAt, today) || ['待確認', '未確認', '進行中', '等待回覆'].includes(item.status) || item.confirmation === '未確認')
    .slice(0, 30);
}

async function listImportantMessagesForDailyReport() {
  if (!MESSAGES_DATA_SOURCE_ID) return [];

  const since = taipeiStartOfDayIso(new Date());
  const [lineResult, outgoingGroupResult] = await Promise.all([
    queryMessagesForDailyReport([
      { property: '排序時間', date: { on_or_after: since } },
      { property: '訊息來源', select: { equals: 'line' } },
    ]),
    queryMessagesForDailyReport([
      { property: '排序時間', date: { on_or_after: since } },
      { property: '訊息來源', select: { equals: 'ai-engine' } },
      { property: '群組標記', checkbox: { equals: true } },
    ]),
  ]);

  return [...lineResult, ...outgoingGroupResult]
    .sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0))
    .filter((item) => item.score > 0)
    .slice(0, 30);
}

async function queryMessagesForDailyReport(filters) {
  const result = await notionRequest(`/v1/data_sources/${MESSAGES_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      page_size: 80,
      filter: { and: filters },
      sorts: [{ property: '排序時間', direction: 'ascending' }],
    },
  });

  return (result.results || [])
    .map((page) => {
      const text = pageTextProperty(page, '文字內容') || pageTextProperty(page, '原始內容');
      const score = scoreDailyMessageImportance(text);
      return {
        source: 'message',
        title: buildMessageReportTitle(text),
        project: inferDailyMessageProject(text),
        priority: score >= 5 ? '高' : score >= 3 ? '中' : '低',
        status: pageTextProperty(page, '發話者名稱'),
        summary: text,
        nextStep: inferMessageNextStep(text),
        updatedAt: pageDateProperty(page, '排序時間'),
        url: page.url,
        tags: dailyMessageTags(text),
        score,
      };
    })
    .filter((item) => item.score > 0);
}

async function listRecentProgressReportsForDailyReport() {
  if (!PROGRESS_REPORTS_DATA_SOURCE_ID) return [];

  const result = await notionRequest(`/v1/data_sources/${PROGRESS_REPORTS_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      page_size: 20,
      sorts: [{ property: '報表週期', direction: 'descending' }],
    },
  });

  const today = taipeiDateOnly(new Date());
  return (result.results || [])
    .map((page) => ({
      source: 'progress',
      title: pageTextProperty(page, '報表名稱'),
      project: pageSelectProperty(page, '專案'),
      priority: pageSelectProperty(page, '目前狀態') === '需注意' ? '高' : '中',
      status: pageSelectProperty(page, '目前狀態'),
      summary: pageTextProperty(page, '本週進展') || pageTextProperty(page, '下一步'),
      nextStep: pageTextProperty(page, '下一步'),
      updatedAt: pageDateProperty(page, '報表週期') || page.last_edited_time,
      url: page.url,
    }))
    .filter((item) => isTodayTaipei(item.updatedAt, today))
    .slice(0, 10);
}

function buildDailySection(title, items, limit) {
  const uniqueItems = dedupeReportItems(items).slice(0, limit);
  if (!uniqueItems.length) {
    return `${title}\n今天沒有明確項目。`;
  }

  return [
    title,
    ...uniqueItems.map((item, index) => formatReportCard(item, index + 1)),
  ].join('\n\n');
}

function buildCompactDailySection(title, items, limit) {
  const uniqueItems = dedupeReportItems(items).slice(0, limit);
  if (!uniqueItems.length) {
    return `${title}\n今天沒有明確項目。`;
  }

  return [
    title,
    ...uniqueItems.map((item, index) => `${index + 1}. ${readableReportTitle(item)}${item.project && item.project !== '未分類' ? `｜${item.project}` : ''}`),
  ].join('\n');
}

function filterUnusedReportItems(items, usedKeys, keywords) {
  const matched = items.filter((item) => {
    if (usedKeys.has(reportItemKey(item))) return false;
    const haystack = [
      item.project,
      item.title,
      item.summary,
      item.priority,
      item.status,
      ...(item.tags || []),
    ].join('\n');
    return keywords.some((keyword) => haystack.includes(keyword));
  });

  matched.forEach((item) => usedKeys.add(reportItemKey(item)));
  return matched;
}

function dedupeReportItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = reportItemKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reportItemKey(item) {
  const cleaned = normalizeReportKey(`${item.project || ''}:${readableReportTitle(item)}:${cleanReportSummary(item.summary).slice(0, 50)}`);
  return cleaned || normalizeReportKey(item.url || item.title || item.summary);
}

function compareDailyReportItems(a, b) {
  const aScore = reportItemImportanceScore(a);
  const bScore = reportItemImportanceScore(b);
  if (aScore !== bScore) return bScore - aScore;
  const priorityRank = { 高: 3, 中: 2, 低: 1 };
  const aRank = priorityRank[a.priority] || 0;
  const bRank = priorityRank[b.priority] || 0;
  if (aRank !== bRank) return bRank - aRank;
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
}

function reportItemImportanceScore(item) {
  const haystack = `${item.project}\n${item.title}\n${item.summary}\n${(item.tags || []).join('\n')}`;
  let score = item.priority === '高' ? 10 : item.priority === '中' ? 5 : 1;
  if (/頭痛|身體不舒服|生病|醫院|吃藥|health/.test(haystack)) score += 9;
  if (/火險|保險|保單|房貸|續保|報稅|稅|finance|insurance/.test(haystack)) score += 8;
  if (/房客|租客|發黴|漏水|故障|燈光|浴室|customerIssue|tenant/.test(haystack)) score += 7;
  if (/不滿|客訴|投訴|抱怨|沒有回報|回報進度|relationshipIssue/.test(haystack)) score += 6;
  if (/你處理|交給你|提醒你|請你/.test(haystack)) score += 5;
  if (/會議|月會|meeting/.test(haystack)) score += 3;
  return score + (Number(item.score) || 0);
}

function formatReportCard(item, index) {
  const project = item.project && item.project !== '未分類' ? `｜${item.project}` : '';
  const priority = item.priority ? `｜${item.priority}` : '';
  const title = readableReportTitle(item);
  const detail = conciseReportText(cleanReportSummary(item.summary), 54);
  const nextStep = conciseReportText(item.nextStep || extractNextStep(item.summary) || inferMessageNextStep(`${item.title}\n${item.summary}`), 44);

  return [
    `${index}. ${title}${project}${priority}`,
    detail ? `   重點：${detail}` : '',
    nextStep ? `   下一步：${nextStep}` : '',
  ].filter(Boolean).join('\n');
}

function readableReportTitle(item) {
  const project = String(item.project || '');
  let title = String(item.title || item.summary || '').replace(/\s+/g, ' ').trim();
  title = title.replace(new RegExp(`^${escapeRegExp(project)}[：:]`), '');
  title = title.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
  title = title.replace(/[0-9a-f]{32}/gi, '');
  title = title.replace(/^判斷\s+/, '');
  title = title.replace(/^確認保險\/火險續保處理\s*[-－]\s*/, '火險/保險續保：');
  title = title.replace(/^關心與追蹤健康狀況\s*[-－]\s*/, '健康關心：');
  title = title.replace(/^處理房客\/客戶問題\s*[-－]\s*/, '房客/客戶問題：');
  title = title.replace(/^確認財務\/稅務事項\s*[-－]\s*/, '財務/稅務：');
  title = title.replace(/^確認交由 Seven 處理事項\s*[-－]\s*/, '交由 Seven 處理：');
  title = title.replace(/^確認決策\s*[-－]\s*/, '決策確認：');
  title = title.replace(/\s+/g, ' ').trim();
  return conciseReportText(title || cleanReportSummary(item.summary), 34);
}

function conciseReportText(value, maxLength) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/LINE 訊息：https?:\/\/\S+/g, '')
    .replace(/同步識別碼：\S+/g, '')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function cleanReportSummary(value) {
  const text = String(value || '').trim();
  const summaryMatch = text.match(/摘要：([\s\S]+)/);
  if (summaryMatch) return summaryMatch[1].trim();
  const nextStepMatch = text.match(/建議處理：([^\n]+)/);
  if (nextStepMatch) return nextStepMatch[1].trim();
  return text;
}

function extractNextStep(value) {
  const text = String(value || '');
  return text.match(/建議處理：([^\n]+)/)?.[1]?.trim() || '';
}

function inferMessageNextStep(text) {
  const value = String(text || '');
  if (/頭痛|身體不舒服|生病|疼痛|疼|醫院|吃藥/.test(value)) return '關心身體狀況，必要時提醒就醫或追蹤是否已改善。';
  if (/不滿|客訴|投訴|抱怨|失望|沒有回報|沒回報|回報進度|抱歉|道歉|安撫/.test(value)) return '確認要回覆、道歉、安撫或追蹤承諾進度。';
  if (/火險|保險|保單|房貸|續保/.test(value)) return '確認到期日、是否續保、文件與簽名流程。';
  if (/報稅|稅|發票|付款|匯款/.test(value)) return '確認期限、資料缺口與下一個處理動作。';
  if (/房客|租客|發黴|漏水|故障|燈光|浴室/.test(value)) return '確認回覆口徑、修繕責任與是否列入 SOP。';
  if (/會議|會議記錄|月會|例會/.test(value)) return '確認是否有會議行動項目需要寫入任務庫。';
  if (/你處理|你要|交給你|提醒你/.test(value)) return '確認是否由 Seven 負責，以及期限與完成標準。';
  return '確認是否保留為待辦或只作紀錄。';
}

function scoreDailyMessageImportance(text) {
  const value = String(text || '');
  const rules = [
    [5, /頭痛|身體不舒服|生病|醫院|吃藥|疼痛|疼|受傷/],
    [6, /不滿|客訴|投訴|抱怨|失望|感覺.*不舒服|沒有回報|沒回報|回報進度|抱歉|道歉|誤會|安撫|關係修復/],
    [5, /火險|保險|保單|房貸|續保|報稅|稅|發票|付款|匯款/],
    [5, /房客|租客|發黴|漏水|故障|燈光|浴室|修繕|投訴|反應|客人.*(問題|反應|投訴|抱怨)/],
    [5, /你處理|你要|交給你|麻煩你|提醒你|請你|幫我/],
    [4, /要不要|是不是|是否|怎麼辦|怎麼處理|確認|決定|決策/],
    [4, /會議|會議記錄|月會|例會|結論|行動項目/],
    [3, /進度|狀態|下一步|卡住|卡點|今天.*安排|想法|看法|策略|方向/],
    [3, /媽媽|媽，|老婆|太太|家裡|家人|西周|天才家族/],
  ];
  return rules.reduce((score, [points, pattern]) => (pattern.test(value) ? score + points : score), 0);
}

function dailyMessageTags(text) {
  const tags = [];
  if (/頭痛|身體不舒服|生病|疼痛|疼|醫院|吃藥/.test(text)) tags.push('health', 'family');
  if (/不滿|客訴|投訴|抱怨|失望|感覺.*不舒服|沒有回報|沒回報|回報進度|抱歉|道歉|誤會|安撫|關係修復/.test(text)) tags.push('relationshipIssue', 'customerIssue');
  if (/火險|保險|保單|房貸|續保/.test(text)) tags.push('insurance', 'finance');
  if (/報稅|稅|發票|付款|匯款/.test(text)) tags.push('finance');
  if (/房客|租客|發黴|漏水|故障|燈光|浴室|客人.*(問題|反應|投訴|抱怨)/.test(text)) tags.push('customerIssue', 'tenant');
  if (/會議|會議記錄|月會|例會/.test(text)) tags.push('meeting');
  if (/進度|狀態|策略|方向|看法|想法/.test(text)) tags.push('progress');
  return tags;
}

function inferDailyMessageProject(text) {
  if (/茲心園|改建|營造|工程|工地/.test(text)) return '茲心園工程';
  if (/HOZO\s*後|HOZO後|後臺|後台|登入頁|CRM/.test(text)) return 'HOZO 後臺';
  if (/包租代管|包租|代管|房客|租客|租屋|出租|招租|好住寓好|HOZO|發黴|浴室|燈光/.test(text)) return '包租代管';
  if (/SmartFront|AI Brain|AI腦|智能前台/.test(text)) return 'SmartFront / AI Brain';
  if (/不滿|客訴|投訴|抱怨|失望|沒有回報|沒回報|回報進度|抱歉|道歉|安撫|關係修復/.test(text)) {
    return /同仁|員工|人員|人力|公司|update/i.test(text) ? '人資' : '營運';
  }
  if (/火險|保險|保單|房貸|續保|財務|付款|匯款|發票|報稅|稅|薪資/.test(text)) return '財務';
  if (/人資|招募|面試|員工|同仁|資遣|解僱/.test(text)) return '人資';
  if (/營運|月會|例會|流程|SOP|會議|公司助理系統|手機.*會議記錄/.test(text)) return '營運';
  if (/老婆|太太|媽媽|媽，|家裡|家人|小孩|私人|西周|天才家族/.test(text)) return '私人事務';
  return '未分類';
}

function buildMessageReportTitle(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (/頭痛|身體不舒服|生病|疼痛|疼/.test(value)) return `健康關心：${value.slice(0, 34)}`;
  if (/不滿|客訴|投訴|抱怨|失望|沒有回報|沒回報|回報進度|抱歉|道歉|安撫/.test(value)) return `關係/客訴追蹤：${value.slice(0, 34)}`;
  if (/火險|保險|保單|房貸|續保/.test(value)) return `保險/火險：${value.slice(0, 34)}`;
  if (/房客|租客|發黴|漏水|燈光|浴室/.test(value)) return `房客問題：${value.slice(0, 34)}`;
  if (/報稅|稅/.test(value)) return `報稅/稅務：${value.slice(0, 34)}`;
  return value.slice(0, 46);
}

function withFollowupSlot(baseUrl, slot) {
  if (baseUrl.includes('htmlpreview.github.io/?')) {
    return `${baseUrl}#slot=${encodeURIComponent(slot)}`;
  }

  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}slot=${encodeURIComponent(slot)}`;
}

function isDailyReportType(reportType) {
  return ['daily', 'evening', 'night', '晚報', '每日報告'].includes(String(reportType || '').trim().toLowerCase());
}

function firstUrlFromText(text) {
  return String(text || '').match(/https?:\/\/\S+/)?.[0] || '';
}

function taipeiDateOnly(value) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value instanceof Date ? value : new Date(value));
}

function taipeiStartOfDayIso(value) {
  const date = taipeiDateOnly(value instanceof Date ? value : new Date(value));
  return `${date}T00:00:00+08:00`;
}

function isTodayTaipei(value, today = taipeiDateOnly(new Date())) {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return taipeiDateOnly(date) === today;
}

function normalizeReportKey(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase().slice(0, 80);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pushLineMessages(req, body) {
  const targets = await resolvePushTargets(body);
  const messages = normalizeMessages(body.messages, body.message, body.text);
  const cronMeta = readCronMeta(req, body);

  if (!targets.length) {
    throw new Error('Missing targetId or targets.');
  }
  if (!messages.length) {
    throw new Error('Missing text, message, or messages.');
  }

  if (cronMeta) {
    console.log(JSON.stringify({
      event: 'control-line-push',
      cronMeta,
      targetCount: targets.length,
      messageCount: messages.length,
    }));
  }

  const result = await pushToTargets(targets, messages);
  return cronMeta ? { ...result, cronMeta } : result;
}

async function resolvePushTargets(body) {
  const directTargets = normalizeTargets(body.targets, body.targetId, body.targetType);
  if (directTargets.length) {
    return directTargets;
  }

  if (body.useDefaultReportTarget) {
    return resolveReportTargets({});
  }

  return [];
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

function readCronMeta(req, body) {
  const cronMeta = body?.cronMeta && typeof body.cronMeta === 'object' ? body.cronMeta : null;
  const headerJobName = body?.cronJobName || requestHeaderValue(req, 'x-seven-cron-job');
  const headerRunId = body?.cronRunId || requestHeaderValue(req, 'x-seven-cron-run-id');
  const headerReportType = body?.cronReportType || requestHeaderValue(req, 'x-seven-cron-scheduled-report');

  const merged = {
    jobName: cronMeta?.jobName || headerJobName || '',
    runId: cronMeta?.runId || headerRunId || '',
    reportType: cronMeta?.reportType || headerReportType || '',
    startedAt: cronMeta?.startedAt || '',
    source: cronMeta?.source || 'control-api',
  };

  return merged.jobName || merged.runId || merged.reportType ? merged : null;
}

function requestHeaderValue(req, headerName) {
  const value = req?.headers?.[headerName];
  return typeof value === 'string' ? value : '';
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

  messages.forEach((message, index) => {
    const messageType = normalizeOutgoingMessageType(message.type);
    const text = outgoingMessageText(message);
    const typeLabel = messageType === 'text' ? '文字訊息' : messageType;
    const meta = `【${formatTaipeiDateTime(sentAt)}】${OUTGOING_ACTOR_NAME}：${typeLabel}`;
    blocks.push(coloredParagraphProperty(meta, OUTGOING_BLOCK_COLOR));
    blocks.push(paragraphProperty(text || '(非文字訊息)'));
    if (index < messages.length - 1) {
      blocks.push(paragraphProperty(''));
    }
  });

  if (!blocks.length) {
    return;
  }

  const anchorBlock = await findConversationAnchorBlock(conversationId);
  await notionRequest(`/v1/blocks/${conversationId}/children`, {
    method: 'PATCH',
    body: { ...(anchorBlock ? { after: anchorBlock.id } : {}), children: blocks },
  });
}

async function findConversationAnchorBlock(conversationId) {
  const blocks = await getBlockChildren(conversationId);
  return blocks.find((block) => plainBlockText(block).includes(CONVERSATION_ANCHOR_TEXT)) || null;
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

function plainBlockText(block) {
  const richText = block?.[block.type]?.rich_text || [];
  return richText.map((item) => item.plain_text || item.text?.content || '').join('');
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
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
    if (response.ok) {
      return responseText ? JSON.parse(responseText) : {};
    }

    lastError = new Error(`Notion API failed: ${response.status} ${responseText}`);
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
      throw lastError;
    }

    await sleep(600 * attempt);
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function pageSelectProperty(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'select' ? property.select?.name || '' : '';
}

function pageDateProperty(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'date' ? property.date?.start || '' : '';
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

function coloredParagraphProperty(content, color) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{
        type: 'text',
        text: { content: clampNotionText(content) },
        annotations: { color },
      }],
    },
  };
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

function serveReportPage(res, pathname) {
  const reportFile = REPORT_ROUTES.get(pathname);
  if (!reportFile) {
    return sendJson(res, 404, { error: 'Report not found' });
  }

  const html = readFileSync(new URL(reportFile, import.meta.url), 'utf8');
  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
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
