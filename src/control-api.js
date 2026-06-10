import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

loadDotenv();

const originalCreateServer = http.createServer.bind(http);

const TASKS_DATA_SOURCE_ID = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const RISK_DECISIONS_DATA_SOURCE_ID = process.env.SEVEN_RISK_DECISIONS_DATA_SOURCE_ID || '0792a903-d274-4a6a-9115-8c66473d1234';
const ATTACHMENTS_DATA_SOURCE_ID = process.env.SEVEN_ATTACHMENTS_DATA_SOURCE_ID || '';
const ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID = process.env.SEVEN_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID || '727d16ff-9ef0-47ed-a83d-bbfd3bf4fb1b';
const CODEX_COMMANDS_DATA_SOURCE_ID = process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID || 'c4eee8de-e596-4d64-906b-1405d79e721c';
const DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID = process.env.SEVEN_DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID || '8f7f95a5-7428-4490-9327-7943499a0e22';
const PROGRESS_REPORTS_DATA_SOURCE_ID = process.env.SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID || 'fc5e4e21-6af6-4de2-9380-aa95126ee13e';
const JUDGMENT_RULES_DATA_SOURCE_ID = process.env.SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID || '';
const CONVERSATIONS_DATA_SOURCE_ID = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID || '';
const MESSAGES_DATA_SOURCE_ID = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID || '';
const LINE_GROUP_OPTIONS_DATA_SOURCE_ID = process.env.SEVEN_LINE_GROUP_OPTIONS_DATA_SOURCE_ID || '';
const LINE_GROUP_MEMBERS_DATA_SOURCE_ID = process.env.SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID || '';
const OUTGOING_ACTOR_NAME = process.env.SEVEN_OUTGOING_ACTOR_NAME || 'Seven Jr.';
const CONVERSATION_ANCHOR_TEXT = '【Seven LINE】對話記錄';
const OUTGOING_BLOCK_COLOR = 'orange';
const SEVEN_DATA_SOURCE_PARENT_BLOCK_ID = normalizeId(process.env.SEVEN_DATA_SOURCE_PARENT_BLOCK_ID || '');
const PUBLIC_BASE_URL = (process.env.SEVEN_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://line-oa-webhook-nn5j.onrender.com').replace(/\/+$/, '');
const dailyConversationProjectCache = new Map();
const verifiedSevenDataSources = new Map();
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

    if (req.method === 'GET' && pathname === '/reports/followup-recipient-candidates') {
      return serveFollowupRecipientCandidates(req, res);
    }

    if (req.method === 'GET' && REPORT_ROUTES.has(pathname)) {
      return serveReportPage(res, pathname);
    }

    if (req.method === 'GET' && pathname.startsWith('/user-ui')) {
      return serveUserUiPage(req, res, pathname);
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
      multiRecipientReportEnabled: true,
      reportCcConfigured: Boolean(process.env.SEVEN_REPORT_CC_TARGET_IDS || process.env.SEVEN_REPORT_CC_NAME_KEYWORDS),
      defaultReportTargetAutoResolveEnabled: Boolean(process.env.NOTION_TOKEN && process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID),
      codexCommandQueueConfigured: Boolean(CODEX_COMMANDS_DATA_SOURCE_ID),
      dailyReportSnapshotsConfigured: Boolean(DAILY_REPORT_SNAPSHOTS_DATA_SOURCE_ID),
      judgmentRulesConfigured: Boolean(JUDGMENT_RULES_DATA_SOURCE_ID),
      userUiLoginEnabled: Boolean(process.env.SEVEN_USER_UI_USERNAME && process.env.SEVEN_USER_UI_PASSWORD),
      reportTypes: ['morning', 'daily', 'followup-morning', 'followup-midday', 'followup-afternoon'],
      endpoints: ['GET /user-ui/user-ui-connected-preview.html', 'GET /reports/followup-recipient-candidates', 'POST /control/line/push', 'POST /control/reports/send', 'POST /control/reports/preview', 'POST /control/reports/approve', 'POST /control/followups/dispatch', 'POST /control/tasks/update', 'POST /control/attachments/update', 'POST /control/judgment-rules/create', 'POST /control/codex-commands/test'],
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

    if (!isAuthorized(req) && !isUserUiAuthorized(req)) {
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

    if (pathname === '/control/followups/dispatch') {
      const result = await dispatchFollowupsFromControl(body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/codex-commands/test') {
      const result = await createCodexCommandTest(body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/tasks/update') {
      const result = await updateTaskFromUserUi(req, body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/attachments/update') {
      const result = await updateAttachmentFromUserUi(req, body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/control/judgment-rules/create') {
      const result = await createJudgmentRuleFromUserUi(req, body);
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

async function createJudgmentRuleFromUserUi(req, body) {
  if (!process.env.NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN is not set.');
  }
  if (!JUDGMENT_RULES_DATA_SOURCE_ID) {
    throw new Error('SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID is not set.');
  }

  const name = stringOrEmpty(body.name || body.ruleName);
  const preferred = stringOrEmpty(body.preferred || body.preferredJudgment);
  if (!name) {
    throw new Error('規則名稱不可空白。');
  }
  if (!preferred) {
    throw new Error('應該怎麼判斷不可空白。');
  }

  const now = new Date();
  const editedBy = resolveUserUiEditor(req, body);
  const appliesTo = normalizeMultiSelect(body.appliesTo || 'SEVEN_AM');
  const category = stringOrEmpty(body.category || 'Task extraction') || 'Task extraction';
  const status = stringOrEmpty(body.status || 'Needs review') || 'Needs review';
  const triggerPattern = stringOrEmpty(body.triggerPattern);
  const avoided = stringOrEmpty(body.avoided || body.avoidedJudgment);
  const reason = stringOrEmpty(body.reason);
  const exceptions = stringOrEmpty(body.exceptions);
  const checklistPlacement = stringOrEmpty(body.checklistPlacement || 'Manual task judgment rules');
  const sourceNote = `User UI 手動新增｜${formatTaipeiDateTime(now)}｜${editedBy}`;

  const page = await notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: JUDGMENT_RULES_DATA_SOURCE_ID },
      properties: compactProperties({
        'Rule Name': titleProperty(name),
        Status: selectProperty(status),
        'Applies To': multiSelectProperty(appliesTo),
        'Preferred Judgment': richTextProperty(preferred),
        'Avoided Judgment': avoided ? richTextProperty(avoided) : undefined,
        Reason: reason ? richTextProperty(reason) : undefined,
        'Trigger Pattern': triggerPattern ? richTextProperty(triggerPattern) : undefined,
        Exceptions: exceptions ? richTextProperty(exceptions) : undefined,
        'Checklist Placement': checklistPlacement ? selectProperty(checklistPlacement) : undefined,
        'Last Verified': dateProperty(now),
        'Source Case Count': numberProperty(0),
      }),
      children: [
        paragraphProperty(`【手動加入任務判斷規則】${sourceNote}`),
        paragraphProperty(`規則：${name}`),
        paragraphProperty(`類別：${category}`),
        paragraphProperty(`應該怎麼判斷：${preferred}`),
        avoided ? paragraphProperty(`避免：${avoided}`) : undefined,
        reason ? paragraphProperty(`原因：${reason}`) : undefined,
        triggerPattern ? paragraphProperty(`觸發條件：${triggerPattern}`) : undefined,
        exceptions ? paragraphProperty(`例外：${exceptions}`) : undefined,
      ].filter(Boolean),
    },
  });

  return {
    ok: true,
    pageId: page.id,
    url: page.url,
    name,
    status,
    appliesTo,
    createdBy: editedBy,
    createdAt: now.toISOString(),
  };
}

async function updateTaskFromUserUi(req, body) {
  if (!process.env.NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN is not set.');
  }

  const pageId = normalizeId(body.pageId || body.taskPageId || body.id);
  if (!pageId) {
    throw new Error('Task page id is required.');
  }

  const page = await assertTaskPage(pageId);
  const submittedAt = new Date();
  const updates = body.updates && typeof body.updates === 'object' ? body.updates : body;
  const editedBy = resolveUserUiEditor(req, updates);
  const properties = compactProperties({
    狀態: taskPropertyUpdate(page, '狀態', normalizeOptionalTaskStatus(updates.status)),
    確認狀態: taskPropertyUpdate(page, '確認狀態', stringOrEmpty(updates.confirmation)),
    負責人: taskPropertyUpdate(page, '負責人', stringOrEmpty(updates.owner)),
    下一步: taskPropertyUpdate(page, '下一步', stringOrEmpty(updates.next)),
    優先級: taskPropertyUpdate(page, '優先級', stringOrEmpty(updates.priority)),
    優先順序: taskPropertyUpdate(page, '優先順序', stringOrEmpty(updates.priority)),
    截止日: taskPropertyUpdate(page, '截止日', stringOrEmpty(updates.dueDate)),
    期限依據: taskPropertyUpdate(page, '期限依據', stringOrEmpty(updates.deadlineBasis)),
    下次追蹤日: taskPropertyUpdate(page, '下次追蹤日', stringOrEmpty(updates.nextFollowupDate)),
    逾期狀態: taskPropertyUpdate(page, '逾期狀態', stringOrEmpty(updates.overdueStatus)),
    'Codex 判斷摘要': taskPropertyUpdate(page, 'Codex 判斷摘要', stringOrEmpty(updates.judgment)),
    來源原文: taskPropertyUpdate(page, '來源原文', stringOrEmpty(updates.rawSource)),
    最後更新: page.properties?.最後更新 ? dateProperty(submittedAt) : undefined,
  });

  if (!Object.keys(properties).length && !stringOrEmpty(updates.editNote) && !stringOrEmpty(updates.pageContent)) {
    throw new Error('No supported task fields were provided.');
  }

  if (Object.keys(properties).length) {
    await notionRequest(`/v1/pages/${pageId}`, {
      method: 'PATCH',
      body: { properties },
    });
  }

  const editNote = stringOrEmpty(updates.editNote);
  const pageContent = stringOrEmpty(updates.pageContent);
  const children = [];
  if (editNote) {
    children.push(paragraphProperty(`【User UI 編輯】${formatTaipeiDateTime(submittedAt)}｜編輯者：${editedBy}｜${editNote}`));
  }
  if (pageContent) {
    children.push(paragraphProperty(`【User UI 頁面內容更新】${formatTaipeiDateTime(submittedAt)}｜編輯者：${editedBy}`));
    children.push(paragraphProperty(pageContent));
  }
  if (children.length) {
    await notionRequest(`/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: { children },
    });
  }

  return {
    ok: true,
    pageId,
    url: page.url,
    updatedProperties: Object.keys(properties),
    noteAppended: Boolean(editNote),
    pageContentAppended: Boolean(pageContent),
    editedBy,
    updatedAt: submittedAt.toISOString(),
  };
}

async function updateAttachmentFromUserUi(req, body) {
  if (!process.env.NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN is not set.');
  }
  if (!ATTACHMENTS_DATA_SOURCE_ID) {
    throw new Error('SEVEN_ATTACHMENTS_DATA_SOURCE_ID is not set.');
  }

  const pageId = normalizeId(body.pageId || body.attachmentPageId || body.id);
  if (!pageId) {
    throw new Error('Attachment page id is required.');
  }

  const page = await assertAttachmentPage(pageId);
  const submittedAt = new Date();
  const updates = body.updates && typeof body.updates === 'object' ? body.updates : body;
  const action = stringOrEmpty(updates.action || body.action || 'update');
  const editedBy = resolveUserUiEditor(req, updates);
  const editNote = stringOrEmpty(updates.editNote || updates.note);

  if (/^(archive|delete|discard|不保存|刪除|封存)$/i.test(action)) {
    const children = [
      paragraphProperty(`【User UI 附件不保存】${formatTaipeiDateTime(submittedAt)}｜編輯者：${editedBy}｜${editNote || '使用者從 User UI 標記此附件不需要保留。'}`),
    ];
    await notionRequest(`/v1/blocks/${pageId}/children`, { method: 'PATCH', body: { children } });
    await notionRequest(`/v1/pages/${pageId}`, { method: 'PATCH', body: { archived: true } });
    return {
      ok: true,
      action: 'archived',
      pageId,
      url: page.url,
      editedBy,
      updatedAt: submittedAt.toISOString(),
    };
  }

  const properties = compactProperties({
    關聯專案: taskPropertyUpdate(page, '關聯專案', normalizeProjectList(updates.projects || updates.project || updates['關聯專案'])),
    轉檔狀態: taskPropertyUpdate(page, '轉檔狀態', normalizeAttachmentStatus(updates.conversionStatus || updates.status || updates['轉檔狀態'])),
  });

  let conversionPage = null;
  if (/^(convert|conversion|startConversion|轉檔|建立轉檔請求)$/i.test(action)) {
    conversionPage = await createAttachmentConversionRequest(page, {
      conversionType: updates.conversionType || updates.type,
      editedBy,
      submittedAt,
      note: editNote,
    });
    if (page.properties?.轉檔狀態) {
      properties.轉檔狀態 = taskPropertyUpdate(page, '轉檔狀態', '待轉檔');
    }
    if (page.properties?.關聯轉檔頁 && conversionPage.url) {
      properties.關聯轉檔頁 = taskPropertyUpdate(page, '關聯轉檔頁', conversionPage.url);
    }
  }

  if (Object.keys(properties).length) {
    await notionRequest(`/v1/pages/${pageId}`, {
      method: 'PATCH',
      body: { properties },
    });
  }

  const children = [];
  if (conversionPage) {
    children.push(paragraphProperty(`【User UI 建立轉檔請求】${formatTaipeiDateTime(submittedAt)}｜編輯者：${editedBy}｜轉檔頁：${conversionPage.url || conversionPage.id}｜目前尚未執行 OCR/PDF 抽取 worker，已先建立待轉檔紀錄。`));
  }
  if (editNote) {
    children.push(paragraphProperty(`【User UI 附件編輯】${formatTaipeiDateTime(submittedAt)}｜編輯者：${editedBy}｜${editNote}`));
  }
  if (children.length) {
    await notionRequest(`/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: { children },
    });
  }

  return {
    ok: true,
    action: conversionPage ? 'conversion-requested' : 'updated',
    pageId,
    url: page.url,
    conversionPageId: conversionPage?.id,
    conversionPageUrl: conversionPage?.url,
    updatedProperties: Object.keys(properties),
    editedBy,
    updatedAt: submittedAt.toISOString(),
  };
}

function resolveUserUiEditor(req, updates) {
  const bodyEditor = stringOrEmpty(updates.editedBy || updates.editor || updates.userName);
  if (bodyEditor) {
    return bodyEditor;
  }

  const basicUser = parseBasicAuth(req)?.username;
  return basicUser || 'User UI 使用者';
}

async function assertTaskPage(pageId) {
  const page = await notionFetchJson(`/v1/pages/${pageId}`);
  const parentId = normalizeId(page.parent?.data_source_id || page.parent?.database_id || '');
  if (parentId !== normalizeId(TASKS_DATA_SOURCE_ID)) {
    throw new Error('Blocked Notion access: page is not in the SevenAM task data source.');
  }
  return page;
}

async function assertAttachmentPage(pageId) {
  const page = await notionFetchJson(`/v1/pages/${pageId}`);
  const parentId = normalizeId(page.parent?.data_source_id || page.parent?.database_id || '');
  if (parentId !== normalizeId(ATTACHMENTS_DATA_SOURCE_ID)) {
    throw new Error('Blocked Notion access: page is not in the SevenAM attachment data source.');
  }
  return page;
}

function taskPropertyUpdate(page, propertyName, value) {
  const property = page.properties?.[propertyName];
  if (!property) {
    return undefined;
  }

  const text = stringOrEmpty(value);
  if (!text) {
    return undefined;
  }

  if (property.type === 'status') {
    return { status: { name: text } };
  }
  if (property.type === 'select') {
    return selectProperty(text);
  }
  if (property.type === 'multi_select') {
    return { multi_select: text.split(/[,，、]/).map((name) => ({ name: name.trim() })).filter((item) => item.name) };
  }
  if (property.type === 'rich_text') {
    return richTextProperty(text);
  }
  if (property.type === 'title') {
    return titleProperty(text);
  }
  if (property.type === 'url') {
    return urlProperty(text);
  }
  if (property.type === 'date') {
    return { date: { start: text } };
  }
  if (property.type === 'number') {
    const number = Number(text);
    return Number.isFinite(number) ? { number } : undefined;
  }
  if (property.type === 'checkbox') {
    return checkboxProperty(/^(true|yes|1|是|已|完成)$/i.test(text));
  }

  return undefined;
}

async function createAttachmentConversionRequest(page, context) {
  if (!ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID) {
    throw new Error('SEVEN_ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID is not set.');
  }

  const fileName = pageTextProperty(page, '檔案名稱') || pageTextProperty(page, '附件項目') || '未命名附件';
  const attachmentType = pageSelectProperty(page, '附件類型') || pageTextProperty(page, 'Content-Type') || 'file';
  const sourceUrl = pageUrlProperty(page, '來源連結') || firstFileUrl(page, '附件檔案') || page.url || '';
  const conversionType = normalizeAttachmentConversionType(context.conversionType || attachmentType || fileName);
  const relationMessageIds = pageRelationIds(page, '訊息紀錄');
  const relationConversationIds = pageRelationIds(page, '對話主檔');
  const summary = `由 ${context.editedBy} 於 ${formatTaipeiDateTime(context.submittedAt)} 從 User UI 建立轉檔請求。${context.note ? `備註：${context.note}` : ''}`;

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: ATTACHMENT_CONVERSIONS_DATA_SOURCE_ID },
      properties: compactProperties({
        轉檔項目: titleProperty(`${fileName} - ${conversionType}`),
        原始檔名: richTextProperty(fileName),
        轉檔狀態: selectProperty('待轉檔'),
        轉檔類型: selectProperty(conversionType),
        附件類型: selectProperty(attachmentType),
        '可供 Codex 判斷': checkboxProperty(false),
        轉檔時間: dateProperty(context.submittedAt),
        摘要: richTextProperty(summary),
        轉檔來源附件: sourceUrl ? urlProperty(sourceUrl) : undefined,
        附件紀錄: relationArrayProperty([page.id]),
        訊息紀錄: relationMessageIds.length ? relationArrayProperty(relationMessageIds) : undefined,
        對話主檔: relationConversationIds.length ? relationArrayProperty(relationConversationIds) : undefined,
        轉檔內容: richTextProperty('尚未執行 OCR/PDF 文件抽取；等待轉檔 worker 接手後，結果會寫入此欄位。'),
      }),
      children: [
        paragraphProperty('【轉檔佇列】此頁由 User UI 建立，目前狀態為待轉檔。'),
        paragraphProperty('OCR/PDF 文件抽取 worker 尚未接上；worker 完成後，請將全文寫入「轉檔內容」，並將「可供 Codex 判斷」改為勾選。'),
      ],
    },
  });
}

function normalizeOptionalTaskStatus(value) {
  const status = stringOrEmpty(value);
  return status ? normalizeTaskStatus(status) : '';
}

function normalizeAttachmentStatus(value) {
  const text = stringOrEmpty(value);
  if (!text) return '';
  const aliases = new Map([
    ['pending', '待轉檔'],
    ['queued', '待轉檔'],
    ['processing', '轉檔中'],
    ['done', '已完成'],
    ['completed', '已完成'],
    ['failed', '失敗'],
    ['skip', '不需轉檔'],
    ['skipped', '不需轉檔'],
  ]);
  return aliases.get(text.toLowerCase()) || text;
}

function normalizeAttachmentConversionType(value) {
  const text = stringOrEmpty(value);
  if (/pdf/i.test(text)) return 'PDF 文字抽取';
  if (/image|png|jpe?g|gif|webp|heic|ocr|圖片|照片/i.test(text)) return 'OCR';
  if (/audio|m4a|mp3|wav|語音/i.test(text)) return '語音轉文字';
  return text || '文件轉文字';
}

function normalizeProjectList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stringOrEmpty(item)).filter(Boolean).join(', ');
  }
  return stringOrEmpty(value);
}

function normalizeMultiSelect(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，、]/);
  return [...new Set(values.map((item) => stringOrEmpty(item)).filter(Boolean))];
}

function stringOrEmpty(value) {
  return String(value ?? '').trim();
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

function isUserUiAuthorized(req) {
  const expectedUsername = process.env.SEVEN_USER_UI_USERNAME;
  const expectedPassword = process.env.SEVEN_USER_UI_PASSWORD;
  if (!expectedUsername || !expectedPassword) {
    return false;
  }

  const credentials = parseBasicAuth(req);
  return credentials?.username === expectedUsername && credentials.password === expectedPassword;
}

function parseBasicAuth(req) {
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
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
  const followupDispatch = await dispatchApprovedFollowups(followups, {
    dryRun: body.dryRunFollowups === true || body.sendApprovedFollowups !== true,
    approvedBy,
    reportType,
    submittedAt,
  });

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
    followupDispatch,
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
    followupDispatch,
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
    followupDispatch,
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

function buildApprovalAcknowledgementMessage({ reportType, approvedBy, submittedAt, taskResults, attachmentResults, decisions, followups, followupDispatch, decisionPage }) {
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
  if (followupDispatch?.sent) summary.push(`已發送追蹤 ${followupDispatch.sent} 則`);
  if (followupDispatch?.dryRunResolved) summary.push(`可發送待確認 ${followupDispatch.dryRunResolved} 則`);
  if (followupDispatch?.pending) summary.push(`待補對象 ${followupDispatch.pending} 則`);

  lines.push(summary.length ? `已寫入：${summary.join('、')}` : '已寫入：本次確認紀錄');

  const reportPageUrl = approvalReportPageUrl(reportType);
  if (reportPageUrl) {
    lines.push(`互動報告頁：${reportPageUrl}`);
  }

  if (decisionPage?.url) {
    lines.push(`Notion 確認紀錄：${decisionPage.url}`);
  }

  lines.push('我會依照這次確認結果更新後續追蹤。');

  return { type: 'text', text: clampLineText(lines.join('\n')) };
}

function approvalReportPageUrl(reportType) {
  const type = String(reportType || '').trim().toLowerCase();
  const morningBriefUrl = process.env.MORNING_BRIEF_URL || `${PUBLIC_BASE_URL}/reports/morning-brief`;
  const dailyReportUrl = process.env.DAILY_REPORT_URL || `${PUBLIC_BASE_URL}/reports/daily-control-report`;
  const followupBaseUrl = process.env.FOLLOWUP_CONFIRMATION_URL || `${PUBLIC_BASE_URL}/reports/followup-confirmation`;

  if (['morning', 'morning-brief', '早報'].includes(type)) return morningBriefUrl;
  if (['daily', 'evening', 'night', '晚報', '每日報告'].includes(type)) return dailyReportUrl;
  if (['followup-morning', 'followup-10', '10', '上午追蹤'].includes(type)) return withFollowupSlot(followupBaseUrl, '10');
  if (['followup-midday', 'followup-13', '13', '中午追蹤'].includes(type)) return withFollowupSlot(followupBaseUrl, '13');
  if (['followup-afternoon', 'followup-17', '17', '下午追蹤'].includes(type)) return withFollowupSlot(followupBaseUrl, '17');
  return '';
}

async function dispatchApprovedFollowups(followups, context) {
  const items = followups
    .map((item, index) => normalizeFollowupDispatchItem(item, index))
    .filter((item) => item.shouldDispatch);

  const results = [];
  for (const item of items) {
    const resolved = await resolveFollowupDispatchTarget(item);
    if (!resolved.ok) {
      results.push({
        target: item.target,
        action: item.action,
        speaker: item.speaker,
        targetMemberName: item.targetMemberName,
        targetMemberUserId: item.targetMemberUserId,
        message: item.message,
        status: 'pending-target',
        reason: resolved.reason,
        candidates: resolved.candidates || [],
      });
      continue;
    }

    if (context.dryRun) {
      results.push({
        target: item.target,
        action: item.action,
        speaker: item.speaker,
        targetMemberName: item.targetMemberName,
        targetMemberUserId: item.targetMemberUserId,
        message: item.message,
        status: 'dry-run',
        resolvedTarget: resolved.target,
      });
      continue;
    }

    const pushResult = await pushToTargets([resolved.target], [{ type: 'text', text: item.message }]);
    results.push({
      target: item.target,
      action: item.action,
      speaker: item.speaker,
      targetMemberName: item.targetMemberName,
      targetMemberUserId: item.targetMemberUserId,
      message: item.message,
      status: 'sent',
      resolvedTarget: resolved.target,
      pushResult,
    });
  }

  const sent = results.filter((item) => item.status === 'sent').length;
  const dryRun = results.filter((item) => item.status === 'dry-run').length;
  const pending = results.filter((item) => item.status === 'pending-target').length;
  return {
    ok: pending === 0,
    dryRun: context.dryRun,
    requested: items.length,
    sent,
    dryRunResolved: dryRun,
    pending,
    results,
  };
}

function normalizeFollowupDispatchItem(item, index) {
  const action = String(item.action || item.decision || '').trim();
  const speaker = String(item.speaker || item.sender || item.voice || 'Seven Jr. 協助追蹤').trim();
  const targetMemberName = String(item.targetMemberName || item.recipientName || '').trim();
  const targetMemberUserId = String(item.targetMemberUserId || item.recipientUserId || '').trim();
  const target = String(item.target || item.targetName || '').trim();
  const message = String(item.message || item.text || '').trim();
  const explicitTargetId = String(item.targetId || item.id || '').trim();
  const explicitTargetType = String(item.targetType || item.type || '').trim();
  const send = Boolean(item.send);
  const approved = /批准|發送|送出|send|approved/i.test(action) && !/取消|暫緩|不發|不要/.test(action) && !/只作內部紀錄/.test(`${speaker} ${targetMemberName}`);

  return {
    index,
    action,
    speaker,
    targetMemberName,
    targetMemberUserId,
    target,
    message,
    explicitTargetId,
    explicitTargetType,
    shouldDispatch: send && approved && Boolean(message),
  };
}

async function resolveFollowupDispatchTarget(item) {
  if (/私人事務|內部|不對外/.test(item.target)) {
    return { ok: false, reason: 'internal-only-target' };
  }

  if (item.explicitTargetId) {
    return {
      ok: true,
      target: {
        id: item.explicitTargetId,
        type: item.explicitTargetType || inferTargetType(item.explicitTargetId),
        name: item.target,
        source: 'followup-explicit',
      },
    };
  }

  const candidates = await findFollowupTargetsFromConversations(item.target);
  if (!candidates.length) {
    return { ok: false, reason: 'no-target-match' };
  }

  const topScore = candidates[0].score;
  const topCandidates = candidates.filter((candidate) => candidate.score === topScore);
  if (topCandidates.length !== 1) {
    return {
      ok: false,
      reason: 'ambiguous-target-match',
      candidates: topCandidates.map(publicFollowupCandidate),
    };
  }

  const selected = topCandidates[0];
  return {
    ok: true,
    target: {
      id: selected.id,
      type: selected.type,
      name: selected.name,
      source: 'followup-conversation-match',
    },
  };
}

async function findFollowupTargetsFromConversations(targetLabel) {
  if (!process.env.NOTION_TOKEN || !CONVERSATIONS_DATA_SOURCE_ID) {
    return [];
  }

  const pages = await listRecentConversationPagesForDispatch();
  const label = normalizeDispatchText(targetLabel);
  const terms = dispatchSearchTerms(targetLabel);
  const scored = [];

  for (const page of pages) {
    const candidate = conversationDispatchCandidate(page);
    if (!candidate.id) {
      continue;
    }

    const haystack = normalizeDispatchText([
      candidate.name,
      candidate.customName,
      candidate.project,
      candidate.note,
    ].join(' '));
    const score = scoreFollowupTargetMatch({ label, terms, candidate, haystack });
    if (score >= 40) {
      scored.push({ ...candidate, score });
    }
  }

  return scored.sort((a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 5);
}

async function listRecentConversationPagesForDispatch() {
  const result = await notionRequest(`/v1/data_sources/${CONVERSATIONS_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      page_size: 100,
      sorts: [{ property: '最後訊息時間', direction: 'descending' }],
    },
  });
  return result.results || [];
}

function conversationDispatchCandidate(page) {
  const entityType = pageSelectProperty(page, '對象類型');
  const groupId = pageTextProperty(page, 'Group ID');
  const roomId = pageTextProperty(page, 'Room ID');
  const userId = pageTextProperty(page, 'User ID');
  const id = groupId || roomId || userId;
  return {
    id,
    type: groupId ? 'group' : roomId ? 'room' : userId ? 'user' : inferTargetType(id),
    entityType,
    name: pageTextProperty(page, 'LINE 對話名稱'),
    customName: pageTextProperty(page, '自定義名稱'),
    project: pageSelectProperty(page, '總控專案'),
    note: pageTextProperty(page, '備註'),
    updatedAt: pageDateProperty(page, '最後訊息時間'),
  };
}

function scoreFollowupTargetMatch({ label, terms, candidate, haystack }) {
  let score = 0;
  const name = normalizeDispatchText(candidate.name);
  const customName = normalizeDispatchText(candidate.customName);

  if (label && (name === label || customName === label)) score += 100;
  if (label && (name.includes(label) || customName.includes(label) || label.includes(name) || label.includes(customName))) score += 60;

  for (const term of terms) {
    if (term.length >= 2 && haystack.includes(term)) score += 18;
  }

  if (candidate.project && label.includes(normalizeDispatchText(candidate.project))) score += 20;
  if (candidate.type === 'group' || candidate.type === 'room') score += 8;
  if (/私人|內部/.test(haystack)) score -= 40;

  return score;
}

function dispatchSearchTerms(value) {
  return normalizeDispatchText(value)
    .split(/[\/／,，、\s&]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !['群組', '專案', '追蹤'].includes(item));
}

function normalizeDispatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]]/g, '')
    .trim();
}

function publicFollowupCandidate(candidate) {
  return {
    name: candidate.customName || candidate.name,
    type: candidate.type,
    project: candidate.project,
    score: candidate.score,
  };
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

  if (isMergeTaskApproval(item)) {
    return applyTaskMergeApproval(taskName, item, context);
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

function isMergeTaskApproval(item) {
  const actionKey = String(item.actionKey || item.action || item.decision || '').trim();
  return actionKey === 'MERGE_INTO_EXISTING' || Boolean(String(item.mergeInto || item.targetTask || '').trim());
}

async function applyTaskMergeApproval(taskName, item, context) {
  const mergeInto = String(item.mergeInto || item.targetTask || item.parentTask || '').trim();
  if (!mergeInto) {
    throw new Error(`Merge target is missing for task: ${taskName}`);
  }

  const sourcePage = await findTaskByName(taskName);
  const targetPage = await findTaskByName(mergeInto);
  if (!targetPage) {
    throw new Error(`Merge target task was not found: ${mergeInto}`);
  }

  const note = String(item.note || '').trim();
  const targetNext = note || `此任務已吸收「${taskName}」；請依主任務追蹤下一步。`;
  const targetSummary = [
    `由 ${context.approvedBy} 於 ${formatTaipeiDateTime(context.submittedAt)} 從 ${context.reportType} 報告確認。`,
    `「${taskName}」合併到既有任務「${mergeInto}」。`,
    note ? `使用者備註：${note}` : '',
  ].filter(Boolean).join('\n');

  await notionRequest(`/v1/pages/${targetPage.id}`, {
    method: 'PATCH',
    body: {
      properties: compactProperties({
        狀態: selectProperty(normalizeTaskStatus(item.targetStatus || '進行中')),
        確認狀態: selectProperty('已確認'),
        優先級: item.priority ? selectProperty(String(item.priority)) : undefined,
        下一步: richTextProperty(targetNext),
        'Codex 判斷摘要': richTextProperty(targetSummary),
        最後更新: dateProperty(context.submittedAt),
      }),
    },
  });

  if (sourcePage) {
    await notionRequest(`/v1/pages/${sourcePage.id}`, {
      method: 'PATCH',
      body: {
        properties: compactProperties({
          狀態: selectProperty('封存'),
          確認狀態: selectProperty('合併到既有任務'),
          下一步: richTextProperty(`已合併到「${mergeInto}」；不再作為獨立任務追蹤。`),
          'Codex 判斷摘要': richTextProperty(targetSummary),
          最後更新: dateProperty(context.submittedAt),
        }),
      },
    });
  }

  return {
    task: taskName,
    status: '合併到既有任務',
    action: sourcePage ? 'merged' : 'merged-source-not-found',
    mergeInto,
    pageId: sourcePage?.id || null,
    targetPageId: targetPage.id,
  };
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

async function createApprovalDecisionPage({ reportType, approvedBy, submittedAt, taskResults, attachmentResults, reportContent, decisions, followups, followupDispatch, notes }) {
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
      `追蹤對象：${item.targetMemberName || '尚未指定個人'}${item.targetMemberUserId ? ` (${item.targetMemberUserId})` : ''}`,
      `是否發送：${item.send ? '是' : '否'}`,
      `訊息：${item.message || ''}`,
    ].join('\n')).join('\n---\n')
    : '沒有追蹤訊息確認。';
  const dispatchLines = followupDispatch?.results?.length
    ? followupDispatch.results.map((item) => [
      `目標：${item.target || ''}`,
      `追蹤對象：${item.targetMemberName || '尚未指定個人'}${item.targetMemberUserId ? ` (${item.targetMemberUserId})` : ''}`,
      `狀態：${item.status || ''}`,
      item.resolvedTarget ? `解析對象：${item.resolvedTarget.name || item.resolvedTarget.id} (${item.resolvedTarget.type})` : '',
      item.reason ? `原因：${item.reason}` : '',
      item.candidates?.length ? `候選：${item.candidates.map((candidate) => `${candidate.name || ''} (${candidate.type || ''}, ${candidate.project || ''})`).join('、')}` : '',
    ].filter(Boolean).join('\n')).join('\n---\n')
    : '沒有執行追蹤訊息推送解析。';
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
        說明: richTextProperty(`確認人：${approvedBy}\n報告類型：${reportType}\n\n修改後報告內容：\n${reportText}\n\n決策：\n${decisionLines}\n\n追蹤訊息：\n${followupLines}\n\n追蹤推送解析：\n${dispatchLines}\n\n任務：\n${taskLines}\n\n附件：\n${attachmentLines}`),
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

async function dispatchFollowupsFromControl(body) {
  const followups = normalizeApprovalList(body.followups);
  const shouldActuallySend = body.sendApprovedFollowups === true || body.confirmSend === true;
  const dryRun = body.dryRun !== false || !shouldActuallySend;
  const result = await dispatchApprovedFollowups(followups, {
    dryRun,
    approvedBy: String(body.approvedBy || 'Seven 陳聖文').trim(),
    reportType: String(body.reportType || 'manual-followup-dispatch').trim(),
    submittedAt: body.submittedAt ? new Date(body.submittedAt) : new Date(),
  });

  return {
    ok: true,
    dryRun,
    followupDispatch: result,
  };
}

async function resolveReportTargets(body) {
  const targets = normalizeTargets(body.targets, body.targetId, body.targetType);
  if (targets.length) {
    return uniqueTargets(targets);
  }

  const resolvedTargets = [];
  resolvedTargets.push(...targetsFromIds(process.env.SEVEN_REPORT_TARGET_IDS || process.env.SEVEN_REPORT_TARGET_ID, process.env.SEVEN_REPORT_TARGET_TYPE || 'user', 'env-primary'));
  resolvedTargets.push(...targetsFromIds(process.env.SEVEN_REPORT_CC_TARGET_IDS, process.env.SEVEN_REPORT_CC_TARGET_TYPE || 'user', 'env-cc'));

  const mainKeywords = process.env.SEVEN_REPORT_TARGET_NAME_KEYWORD || (resolvedTargets.length ? '' : 'Seven');
  resolvedTargets.push(...await findReportTargetsFromNotion(mainKeywords, { fallbackLatestPersonal: !resolvedTargets.length, source: 'notion-primary' }));
  resolvedTargets.push(...await findReportTargetsFromNotion(process.env.SEVEN_REPORT_CC_NAME_KEYWORDS || '', { fallbackLatestPersonal: false, source: 'notion-cc' }));

  return uniqueTargets(resolvedTargets);
}

function targetsFromIds(value, targetType, source) {
  return String(value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id, type: targetType || inferTargetType(id), source }));
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
  const targets = await findReportTargetsFromNotion(process.env.SEVEN_REPORT_TARGET_NAME_KEYWORD || 'Seven', { fallbackLatestPersonal: true, source: 'notion-auto' });
  return targets[0] || null;
}

async function findReportTargetsFromNotion(keywordValue, options = {}) {
  const notionToken = process.env.NOTION_TOKEN;
  const dataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID;
  if (!notionToken || !dataSourceId) {
    return [];
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
  const keywords = String(keywordValue || '')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);

  let selectedPages = [];
  if (keywords.length) {
    selectedPages = pages.filter((page) => {
      const names = [
        pageTextProperty(page, 'LINE 對話名稱'),
        pageTextProperty(page, '自定義名稱'),
        pageTextProperty(page, '備註'),
      ].join(' ').toLowerCase();
      return keywords.some((keyword) => names.includes(keyword));
    });
  }

  if (!selectedPages.length && options.fallbackLatestPersonal) {
    selectedPages = pages.slice(0, 1);
  }

  return selectedPages
    .map((page) => {
      const userId = pageTextProperty(page, 'User ID');
      return userId
        ? {
            id: userId,
            type: 'user',
            name: pageTextProperty(page, '自定義名稱') || pageTextProperty(page, 'LINE 對話名稱'),
            source: options.source || 'notion-auto',
          }
        : null;
    })
    .filter(Boolean);
}

function uniqueTargets(targets) {
  const seen = new Set();
  const unique = [];
  for (const target of targets) {
    const id = String(target?.id || '').trim();
    if (!id) {
      continue;
    }
    const type = target.type || inferTargetType(id);
    const key = `${type}:${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ ...target, id, type });
  }
  return unique;
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
      text: `早上 8 點半晨報：\n${morningBriefUrl}\n\n請先做目標追認：今天新增或尚未確認的任務/專案，都要先問負責人「完成目標是什麼、怎樣叫完成、由誰驗收」。口述內容要寫進「目標口述原文」並上傳給 Codex 確認；確認前不列入真實進度。`,
    };
  }

  if (['daily', 'evening', 'night', '晚報', '每日報告'].includes(reportType)) {
    const dynamicText = await buildDynamicDailyReportText(dailyReportUrl);
    if (dynamicText) {
      return { type: 'text', text: clampLineText(dynamicText) };
    }

    return {
      type: 'text',
      text: `晚上 8 點半每日總控總確認：\n${dailyReportUrl}\n\n請先收斂今天的目標追認：哪些任務/專案已取得口述、哪些已上傳給 Codex、哪些已確認可追蹤。只有「Codex 目標確認」為已確認可追蹤或追蹤中的案件，才安排下一步與完成百分比。`,
    };
  }

  if (['followup-morning', 'followup-10', '10', '上午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `上午 10 點目標追認與新任務確認：\n${withFollowupSlot(followupBaseUrl, '10')}\n\n請檢查上午新增任務/專案；凡是沒有「完成目標定義」的，先用 LINE 或 Email 問負責人口述目標。口述上傳給 Codex 確認後，下一個時段再決定後續追蹤。`,
    };
  }

  if (['followup-midday', 'followup-13', '13', '中午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `下午 1 點目標追認與新任務確認：\n${withFollowupSlot(followupBaseUrl, '13')}\n\n請確認午間前新增項目的目標是否已被負責人口述；若尚未口述，先追問。若已口述，請上傳給 Codex 確認，確認後才排下一步。`,
    };
  }

  if (['followup-afternoon', 'followup-17', '17', '下午追蹤'].includes(reportType)) {
    return {
      type: 'text',
      text: `下午 5 點目標追認與新任務確認：\n${withFollowupSlot(followupBaseUrl, '17')}\n\n請確認下午要發出的 LINE/Email 追問；如果窗口不知道目標，請她指定真正負責人。Codex 確認完成目標後，下一個時段才告訴負責人後續要做什麼。`,
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
    const synthesizedEvents = buildSynthesizedDailyEvents(reportItems, progressReports);
    const usedKeys = new Set(synthesizedEvents.flatMap((event) => event.items.map(reportItemKey)));

    const sections = [
      `20:30 每日總控報告`,
      `日期：${reportDate}`,
      `摘要：已整合 ${synthesizedEvents.length} 件主要事件；每件事以「主題、對象、影響、結論、建議待辦」呈現。`,
      '',
      buildEventSummarySection('一、今日主要事件', synthesizedEvents, 6),
      buildCompactDailySection('二、其他待確認線索', filterActionableRemainders(reportItems, usedKeys), 4),
      '',
      `報告頁：${dailyReportUrl}`,
      '提醒：第一層只放事件結論；零散訊息不直接上報，除非能形成待辦或風險。',
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
      goalStatus: pageSelectProperty(page, 'Codex 目標確認'),
      sourceType: pageSelectProperty(page, '來源'),
      summary: pageTextProperty(page, 'Codex 判斷摘要') || pageTextProperty(page, '完成目標定義') || pageTextProperty(page, '下一步') || pageTextProperty(page, '來源原文'),
      nextStep: pageTextProperty(page, '下一步給負責人') || pageTextProperty(page, '下一步'),
      updatedAt: pageDateProperty(page, '最後更新') || page.last_edited_time || '',
      url: page.url,
    }))
    .filter((item) => isTodayTaipei(item.updatedAt, today)
      || ['待確認', '未確認', '進行中', '等待回覆'].includes(item.status)
      || item.confirmation === '未確認'
      || ['待負責人口述', '待上傳給 Codex', 'Codex 待確認', '需補充'].includes(item.goalStatus))
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

  const items = [];
  for (const page of result.results || []) {
    const text = pageTextProperty(page, '文字內容') || pageTextProperty(page, '原始內容');
    const score = scoreDailyMessageImportance(text);
    const conversation = await getDailyMessageConversationProject(pageRelationId(page, '對話主檔'));
    items.push({
      source: 'message',
      title: buildMessageReportTitle(text),
      project: conversation.project || inferDailyMessageProject(text),
      priority: score >= 5 ? '高' : score >= 3 ? '中' : '低',
      status: pageTextProperty(page, '發話者名稱'),
      summary: text,
      nextStep: inferMessageNextStep(text),
      updatedAt: pageDateProperty(page, '排序時間'),
      url: page.url,
      tags: dailyMessageTags(text),
      score,
    });
  }

  return items.filter((item) => item.score > 0);
}

async function getDailyMessageConversationProject(pageId) {
  if (!pageId) return { project: '' };
  if (dailyConversationProjectCache.has(pageId)) return dailyConversationProjectCache.get(pageId);

  const page = await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
  const value = { project: pageSelectProperty(page, '總控專案') };
  dailyConversationProjectCache.set(pageId, value);
  return value;
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

function buildEventSummarySection(title, events, limit) {
  const selected = events.slice(0, limit);
  if (!selected.length) {
    return `${title}\n今天沒有明確事件。`;
  }

  return [
    title,
    ...selected.map((event, index) => formatEventSummaryCard(event, index + 1)),
  ].join('\n\n');
}

function buildSynthesizedDailyEvents(reportItems, progressReports) {
  const events = [];
  const addEvent = (event) => {
    if (!event || !event.items.length) return;
    events.push(event);
  };

  addEvent(buildMotherHealthEvent(reportItems));
  addEvent(buildYifanMeetingEvent(reportItems));
  addEvent(buildFireInsuranceEvent(reportItems));
  addEvent(buildRentalCustomerIssueEvent(reportItems, progressReports));
  addEvent(buildRelationshipEscalationEvent(reportItems));
  addEvent(buildTaxEvent(reportItems));
  addEvent(buildGoalRecognitionEvent(reportItems));

  const usedKeys = new Set(events.flatMap((event) => event.items.map(reportItemKey)));
  const remainingHigh = reportItems
    .filter((item) => item.priority === '高' && !usedKeys.has(reportItemKey(item)))
    .slice(0, 3)
    .map((item) => ({
      subject: readableReportTitle(item),
      target: item.project || '未分類',
      project: item.project || '未分類',
      priority: item.priority || '高',
      impact: '尚未歸入明確事件，但內容具備高優先或待確認訊號。',
      conclusion: cleanReportSummary(item.summary),
      nextAction: item.nextStep || inferMessageNextStep(`${item.title}\n${item.summary}`),
      solution: '先確認是否成立為事件；若成立，再合併同類訊息並產生單一待辦。',
      depth: '可回任務庫查看原始訊息與判斷摘要。',
      items: [item],
    }));

  return [...events, ...remainingHigh]
    .sort((a, b) => eventPriorityScore(b) - eventPriorityScore(a))
    .slice(0, 8);
}

function buildMotherHealthEvent(items) {
  const matched = items.filter((item) => /媽媽|媽，|頭痛|吃藥|不痛|醫師|半年|一年/.test(eventHaystack(item)));
  if (!matched.length) return null;

  return {
    subject: '媽媽健康追蹤',
    target: '媽媽 / Seven',
    project: '私人事務',
    priority: '高',
    impact: '健康與家人關心事項，需要持續留意，但目前看起來不是立即危急事件。',
    conclusion: '媽媽吃藥約 4-5 天後頭痛已比較不痛；她自述半年到一年會發作一次，目前狀況還好。',
    nextAction: '1-2 天後再關心一次；若頭痛反覆或加劇，再提醒回診或確認用藥。',
    solution: '低強度追蹤即可，不需要升級成緊急處理。',
    depth: `${matched.length} 則健康相關訊息已合併。`,
    items: matched,
  };
}

function buildYifanMeetingEvent(items) {
  const matched = items.filter((item) => /逸凡|YIFAN|月會|館長|參加月會|加入月會群組/.test(eventHaystack(item)));
  if (!matched.length) return null;

  return {
    subject: '逸凡加入月會',
    target: '逸凡 / 月會成員 / 茲心園',
    project: '營運 / 茲心園工程',
    priority: '中',
    impact: '茲心園現場資訊會進入固定月會節奏，後續能被總控追蹤。',
    conclusion: '逸凡會加入月會，並已向大家同步自己會一起參與。',
    nextAction: '確認逸凡知道月會時間、地點與報告重點即可。',
    solution: '把逸凡視為月會固定成員，後續會議紀錄再轉成任務。',
    depth: `${matched.length} 則月會相關訊息已合併。`,
    items: matched,
  };
}

function buildFireInsuranceEvent(items) {
  const matched = items.filter((item) => /火險|保險|保單|房貸|續保|7 月 20|7月20/.test(eventHaystack(item)));
  if (!matched.length) return null;

  return {
    subject: '房貸火險續保',
    target: 'Seven / 保險窗口',
    project: '財務',
    priority: '高',
    impact: '保險不能中斷，否則房貸/住宅風險會增加。',
    conclusion: '不論老婆口氣如何，結論是火險要繼續買；Seven 已確定要續保。',
    nextAction: '跟保險窗口確認續保方式、申請書、簽名流程與完成期限，並持續追蹤到續保完成。',
    solution: '同一套解法：找窗口確認流程，補齊文件，完成續保。',
    depth: `${matched.length} 則火險/續保相關訊息與任務已合併。`,
    items: matched,
  };
}

function buildRentalCustomerIssueEvent(items, progressReports) {
  const matched = [...items, ...progressReports].filter((item) => /包租代管|HOZO|房客|租客|燈光|浴室|發黴|客人問題回報|設備租用|清潔打掃 SOP/.test(eventHaystack(item)));
  if (!matched.length) return null;

  return {
    subject: '包租代管客人問題 SOP',
    target: 'HOZO 房客 / 房務清潔 / 包租代管營運',
    project: '包租代管',
    priority: '高',
    impact: '若沒有標準，客人可能要求隨意更換設備，清潔疏漏也會反覆變成客訴。',
    conclusion: '事件其實只有一個待辦：把 SOP 做出來。燈光太暗要定義標準回覆與不可任意更換原則；可另設移動式燈具租用。廁所發黴要建立清潔檢查 SOP。',
    nextAction: '產出兩份 SOP：燈光回覆/租用燈具標準、浴室發黴清潔檢查標準。',
    solution: '用同一套「客人問題處理 SOP」解決燈光與發黴兩個問題。',
    depth: `${matched.length} 則包租代管相關訊息/進度已合併。`,
    items: matched,
  };
}

function buildRelationshipEscalationEvent(items) {
  const matched = items.filter((item) => /吳|小姐|碧純|財務|不滿|客訴|投訴|抱怨|失望|沒有回報|沒回報|回報進度|反應速度|太慢|抱歉|道歉|安撫/.test(eventHaystack(item)));
  if (!matched.length) return null;

  return {
    subject: '吳小姐案件：財務回應速度',
    target: '吳小姐 / 公司財務窗口 / Seven',
    project: '營運 / 財務',
    priority: '高',
    impact: '財務回應速度太慢會讓對方感覺事情被拖延，影響信任與後續合作關係。',
    conclusion: '吳小姐案件需要追蹤的是「財務為什麼反應慢、目前處理到哪裡、何時回覆」。',
    nextAction: '向財務窗口確認案件狀態與延遲原因，整理一段清楚回覆給吳小姐。',
    solution: '建立「對外承諾/財務案件回報節奏」：承辦人、目前狀態、下一步、回覆時間。',
    depth: `${matched.length} 則關係/財務回報相關訊息已合併。`,
    items: matched,
  };
}

function buildTaxEvent(items) {
  const matched = items.filter((item) => /報稅|稅務|稅|申報|逾期/.test(eventHaystack(item)));
  if (!matched.length) return null;

  return {
    subject: '報稅時間點追蹤',
    target: 'Seven / 稅務處理窗口',
    project: '財務',
    priority: '高',
    impact: '目前還沒報稅，若繼續延後會有逾期或資料缺漏風險。',
    conclusion: '要報稅就要趕快報；目前最重要不是討論方法，而是確認實際報稅時間點。',
    nextAction: '確認何時報稅、資料是否齊全、誰負責送出，並追蹤到完成。',
    solution: '把報稅拆成三個狀態：資料齊全、預計送出時間、已完成送出。',
    depth: `${matched.length} 則稅務相關訊息/任務已合併。`,
    items: matched,
  };
}

function buildGoalRecognitionEvent(items) {
  const matched = items.filter((item) => /完成目標|目標口述|Codex 目標確認|待負責人口述|待上傳給 Codex|追認|驗收|怎樣叫完成|完成百分比/.test(eventHaystack(item)));
  if (!matched.length) return null;

  return {
    subject: '目標追認缺口',
    target: '所有新增任務與專案負責人',
    project: '跨專案',
    priority: '高',
    impact: '沒有完成目標定義，就不能合理判斷完成百分比，也無法知道下一步是否正確。',
    conclusion: '目前最重要的管理動作是取得負責人口述，並讓 Codex 確認能否追蹤。',
    nextAction: '每個報告時段檢查新增項目：缺目標先問，已口述就上傳給 Codex，確認後才追蹤。',
    solution: '使用「Codex 目標確認、目標口述原文、對外詢問草稿、下一步給負責人」四個欄位收斂。',
    depth: `${matched.length} 則目標追認相關訊號已合併。`,
    items: matched,
  };
}

function formatEventSummaryCard(event, index) {
  const project = event.project ? `｜${event.project}` : '';
  const priority = event.priority ? `｜${event.priority}` : '';
  return [
    `${index}. ${event.subject || event.title}${project}${priority}`,
    `   主題：${conciseReportText(event.subject || event.title, 48)}`,
    `   對象：${conciseReportText(event.target || event.project || '未分類', 48)}`,
    `   影響：${conciseReportText(event.impact || event.effect, 76)}`,
    `   結論：${conciseReportText(event.conclusion || event.result, 92)}`,
    `   建議待辦：${conciseReportText(event.nextAction || event.nextStep, 86)}`,
    event.solution ? `   解法：${conciseReportText(event.solution, 74)}` : '',
    `   深看：${conciseReportText(event.depth, 58)}`,
  ].filter(Boolean).join('\n');
}

function eventPriorityScore(event) {
  let score = event.priority === '高' ? 100 : event.priority === '中' ? 60 : 30;
  score += Math.min(event.items.length, 10);
  const subject = event.subject || event.title || '';
  if (/媽媽|健康|火險|房客|關係|客訴|報稅|吳小姐/.test(subject)) score += 20;
  if (/逸凡|月會/.test(subject)) score += 55;
  return score;
}

function eventHaystack(item) {
  return [
    item.project,
    item.title,
    item.summary,
    item.nextStep,
    item.status,
    item.goalStatus,
    ...(item.tags || []),
  ].join('\n');
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

function filterActionableRemainders(items, usedKeys) {
  return items
    .filter((item) => !usedKeys.has(reportItemKey(item)))
    .filter((item) => item.priority === '高' || /待辦|確認|追蹤|決策|卡點|處理|回覆|期限|到期|客訴|投訴|健康|保險|報稅|發黴|漏水|月會/.test(eventHaystack(item)))
    .filter((item) => !/寄東西很方便|枕頭都太好睡|今天的行程安排/.test(eventHaystack(item)))
    .sort(compareDailyReportItems);
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

function normalizeId(value) {
  return String(value || '').trim().replace(/-/g, '').toLowerCase();
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
  await assertSevenNotionTarget(pathname, body);

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

  if (SEVEN_DATA_SOURCE_PARENT_BLOCK_ID && parentBlockId && parentBlockId !== SEVEN_DATA_SOURCE_PARENT_BLOCK_ID) {
    throw new Error(`Blocked Notion access: data source "${titleText || normalizedId}" is outside the configured SevenAM parent scope.`);
  }

  verifiedSevenDataSources.set(normalizedId, true);
  return true;
}

async function notionFetchJson(pathname) {
  const response = await fetch(`https://api.notion.com${pathname}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': process.env.NOTION_VERSION || '2025-09-03',
    },
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

function pageUrlProperty(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'url' ? property.url || '' : '';
}

function pageRelationId(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'relation' ? property.relation?.[0]?.id || '' : '';
}

function pageRelationIds(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'relation' ? (property.relation || []).map((item) => item.id).filter(Boolean) : [];
}

function firstFileUrl(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (property?.type !== 'files') return '';
  const file = property.files?.[0];
  return file?.file?.url || file?.external?.url || '';
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

function multiSelectProperty(values) {
  return {
    multi_select: normalizeMultiSelect(values).map((name) => ({ name })),
  };
}

function numberProperty(value) {
  const number = Number(value);
  return { number: Number.isFinite(number) ? number : 0 };
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

function relationArrayProperty(ids) {
  return { relation: ids.map((id) => ({ id })).filter((item) => item.id) };
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

async function findFollowupRecipientCandidates(searchText) {
  if (!process.env.NOTION_TOKEN) return [];
  const terms = recipientSearchTerms(searchText);
  if (!terms.length) return [];

  const [groups, members, conversations] = await Promise.all([
    LINE_GROUP_OPTIONS_DATA_SOURCE_ID ? queryDataSourcePages(LINE_GROUP_OPTIONS_DATA_SOURCE_ID, { page_size: 100 }) : Promise.resolve([]),
    LINE_GROUP_MEMBERS_DATA_SOURCE_ID ? queryDataSourcePages(LINE_GROUP_MEMBERS_DATA_SOURCE_ID, { page_size: 100 }) : Promise.resolve([]),
    CONVERSATIONS_DATA_SOURCE_ID ? queryDataSourcePages(CONVERSATIONS_DATA_SOURCE_ID, { page_size: 100 }) : Promise.resolve([]),
  ]);

  const groupsByPageId = new Map(groups.map((page) => [page.id, normalizeRecipientGroupOption(page)]));
  const candidates = [];

  for (const member of members) {
    const candidate = normalizeRecipientMemberOption(member, groupsByPageId);
    const score = scoreRecipientCandidate(terms, [
      candidate.memberName,
      candidate.groupName,
      candidate.project,
    ].join(' '));
    if (score <= 0 || !candidate.targetId) continue;
    candidates.push({
      label: `${candidate.memberName}｜${candidate.groupName || candidate.targetType}`,
      targetMemberName: candidate.memberName,
      targetMemberUserId: candidate.userId,
      targetId: candidate.targetId,
      targetType: candidate.targetType,
      groupName: candidate.groupName,
      source: 'line-group-member',
      score,
    });
  }

  for (const conversation of conversations) {
    const candidate = normalizeRecipientConversationOption(conversation);
    const score = scoreRecipientCandidate(terms, [
      candidate.name,
      candidate.customName,
      candidate.project,
    ].join(' '));
    if (score <= 0 || !candidate.targetId) continue;
    candidates.push({
      label: `${candidate.name || candidate.customName}｜${candidate.targetType === 'user' ? '個人對話' : 'LINE 群組'}`,
      targetMemberName: candidate.name || candidate.customName,
      targetMemberUserId: candidate.targetType === 'user' ? candidate.targetId : '',
      targetId: candidate.targetId,
      targetType: candidate.targetType,
      groupName: candidate.targetType === 'user' ? '' : (candidate.name || candidate.customName),
      source: 'conversation-master',
      score: score - (candidate.targetType === 'user' ? 0 : 15),
    });
  }

  return uniqueRecipientCandidates(candidates)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, 'zh-Hant'))
    .slice(0, 12)
    .map(({ score, ...candidate }) => candidate);
}

async function queryDataSourcePages(dataSourceId, body = {}) {
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

function normalizeRecipientGroupOption(page) {
  return {
    pageId: page.id,
    groupName: pageTextProperty(page, '群組顯示名稱') || pageTextProperty(page, 'LINE對話名稱') || pageTextProperty(page, '自定義名稱'),
    targetId: pageTextProperty(page, 'GroupID'),
    targetType: pageSelectProperty(page, '對象類型') || inferTargetType(pageTextProperty(page, 'GroupID')),
    project: pageSelectProperty(page, '總控專案'),
  };
}

function normalizeRecipientMemberOption(page, groupsByPageId) {
  const groupPageIds = pageRelationIds(page, 'LINE群組');
  const group = groupPageIds.map((id) => groupsByPageId.get(id)).find(Boolean) || {};
  return {
    memberName: pageTextProperty(page, '成員顯示名稱') || pageTextProperty(page, '成員選項名稱'),
    userId: pageTextProperty(page, 'UserID'),
    groupName: pageTextProperty(page, '群組顯示名稱') || group.groupName || '',
    targetId: group.targetId || pageTextProperty(page, 'GroupID'),
    targetType: group.targetType || inferTargetType(group.targetId || pageTextProperty(page, 'GroupID')),
    project: group.project || '',
  };
}

function normalizeRecipientConversationOption(page) {
  const groupId = pageTextProperty(page, 'Group ID');
  const roomId = pageTextProperty(page, 'Room ID');
  const userId = pageTextProperty(page, 'User ID');
  const targetId = groupId || roomId || userId;
  return {
    name: pageTextProperty(page, 'LINE 對話名稱'),
    customName: pageTextProperty(page, '自定義名稱'),
    targetId,
    targetType: groupId ? 'group' : roomId ? 'room' : userId ? 'user' : inferTargetType(targetId),
    project: pageSelectProperty(page, '總控專案'),
  };
}

function recipientSearchTerms(value) {
  return normalizeDispatchText(value)
    .split(/[\/／,，、\s&：:()（）【】\[\]\-]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(line|codex|seven|jr|追蹤|對象|群組|成員|建議|訊息|原因|確認|使用|教學|登入頁|任務|專案|包租代管|茲心園工程|私人事務)$/i.test(item));
}

function scoreRecipientCandidate(terms, candidateText) {
  const text = normalizeDispatchText(candidateText);
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (text === term) score += 120;
    else if (text.includes(term)) score += 80;
    else if (term.includes(text) && text.length >= 2) score += 40;
  }
  return score;
}

function uniqueRecipientCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = `${candidate.targetType}:${candidate.targetId}:${candidate.targetMemberUserId || candidate.targetMemberName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

async function serveFollowupRecipientCandidates(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const target = url.searchParams.get('target') || '';
    const reason = url.searchParams.get('reason') || '';
    const message = url.searchParams.get('message') || '';
    const candidates = await findFollowupRecipientCandidates(`${target} ${reason} ${message}`);
    return sendJson(res, 200, { ok: true, candidates });
  } catch (error) {
    console.warn(`Unable to resolve follow-up recipient candidates: ${error.message}`);
    return sendJson(res, 200, { ok: false, candidates: [], error: error.message });
  }
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

function serveUserUiPage(req, res, pathname) {
  if (!isUserUiAuthorized(req)) {
    res.writeHead(401, {
      ...corsHeaders(),
      'WWW-Authenticate': 'Basic realm="SevenAM User UI"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Login required.');
    return;
  }

  const fileName = resolveUserUiFileName(pathname);
  if (!/^user-ui-(connected-preview|project-\d+|task-\d+|line-\d+|scheduled-[a-z-]+)\.html$/.test(fileName)) {
    return sendJson(res, 404, { error: 'User UI page not found' });
  }

  const fileUrl = new URL(`../docs/${fileName}`, import.meta.url);
  if (!existsSync(fileUrl)) {
    return sendJson(res, 404, { error: 'User UI page not generated yet' });
  }

  const html = readFileSync(fileUrl, 'utf8');
  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function resolveUserUiFileName(pathname) {
  if (pathname === '/user-ui') {
    return 'user-ui-connected-preview.html';
  }
  if (/^\/user-ui-[^/]+\.html$/.test(pathname)) {
    return pathname.slice(1);
  }
  return pathname.replace(/^\/user-ui\//, '');
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
