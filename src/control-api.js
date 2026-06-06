import http from 'node:http';

const originalCreateServer = http.createServer.bind(http);

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
  if (req.method === 'GET' && pathname === '/control/health') {
    return sendJson(res, 200, {
      ok: true,
      controlApiEnabled: Boolean(process.env.SEVEN_CONTROL_API_KEY),
      linePushEnabled: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      defaultReportTargetConfigured: Boolean(process.env.SEVEN_REPORT_TARGET_ID),
      defaultReportTargetAutoResolveEnabled: Boolean(process.env.NOTION_TOKEN && process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID),
      endpoints: [
        'POST /control/line/push',
        'POST /control/reports/send',
      ],
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
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

  if (['morning', 'morning-brief', '早報'].includes(reportType)) {
    return {
      type: 'text',
      text: `早上 8 點行程與待辦報告：\n${morningBriefUrl}\n\n請先看今天行程、昨日未完成事項與今日優先處理清單。`,
    };
  }

  if (['daily', 'evening', 'night', '晚報', '每日報告'].includes(reportType)) {
    return {
      type: 'text',
      text: `晚上 8 點半每日總控報告：\n${dailyReportUrl}\n\n請確認任務狀態、待解析附件、低信心判斷與明日優先事項。`,
    };
  }

  throw new Error('Unknown reportType. Use morning or daily.');
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
      .map((target) => ({ id: target.id || target.targetId || target.to, type: target.type || target.targetType || 'unknown' }))
      .filter((target) => target.id);
  }

  if (targetId) {
    return [{ id: targetId, type: targetType || 'unknown' }];
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

async function pushToTargets(targets, messages) {
  const results = [];
  for (const target of targets) {
    await pushLine(target.id, messages);
    results.push({ targetId: target.id, targetType: target.type || 'unknown', source: target.source || 'request', ok: true });
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
