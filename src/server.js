import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createEventQueue } from './event-queue.js';

loadDotenv();

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET;
const notionToken = process.env.NOTION_TOKEN;
const conversationsDataSourceId = process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID;
// Raw LINE event log only. Hourly task judgement reads the conversation master.
const messagesDataSourceId = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID;
const lineGroupMemberIndexDataSourceId = process.env.SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID || '';
const attachmentsDataSourceId = process.env.SEVEN_ATTACHMENTS_DATA_SOURCE_ID;
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '0bdc0de5-46ee-482c-b8d7-cdf6ec958467';
const codexCommandsDataSourceId = process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID || 'c4eee8de-e596-4d64-906b-1405d79e721c';
const judgmentCalibrationCasesDataSourceId = process.env.SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID || '';
const judgmentRulesDataSourceId = process.env.SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID || '';
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const reportUrl = process.env.DAILY_REPORT_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/daily-control-report-prototype.html';
const morningBriefUrl = process.env.MORNING_BRIEF_URL || 'https://htmlpreview.github.io/?https://github.com/sevenchen611/line-oa-webhook/blob/main/reports/morning-brief-prototype.html';
const outgoingActorName = process.env.SEVEN_OUTGOING_ACTOR_NAME || 'Seven Jr.';
const sevenDataSourceParentBlockId = normalizeId(process.env.SEVEN_DATA_SOURCE_PARENT_BLOCK_ID || '');
const verifiedSevenDataSources = new Map();
const recentTaskListsByConversation = new Map();

const notionConfigured = Boolean(notionToken && conversationsDataSourceId && messagesDataSourceId);
const eventQueue = createEventQueue({
  databaseUrl: process.env.DATABASE_URL || '',
  processEvent: (event, rawBody) => handleEvent(event, rawBody),
  onDeadEvent: notifyDeadQueueEvent,
});
const conversationAnchorText = '【Seven LINE】對話記錄（最新在最上方）';
const reportCommands = new Set(['#報告', '報告', '#每日報告', '每日報告']);
const morningBriefCommands = new Set(['#早報', '早報', '#今日早報', '今日早報', '#行程', '行程']);
const dashboardCommands = new Set(['#儀表板', '儀表板', '#總控', '總控', 'dashboard', 'Dashboard', '#dashboard']);
const dashboardUrl = process.env.SEVEN_DASHBOARD_URL || 'https://line-oa-webhook-nn5j.onrender.com/dashboard';
const judgmentCalibrationSessionReviewId = 'SEVEN-JC-SESSION';
// 敏感指令（校準、查待辦、報告連結）只回應 controller 本人的一對一私訊，
// 防止群組成員觸發後把任務內容洩漏到群組。
const controllerUserId = process.env.SEVEN_CONTROLLER_USER_ID || 'U09dc6553016c78d89c515522be9b74f6';

function isControllerPersonalChat(event) {
  return event?.source?.type === 'user' && event?.source?.userId === controllerUserId;
}

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
      eventQueue: await eventQueue.stats(),
      attachmentsConfigured: Boolean(attachmentsDataSourceId),
      lineGroupMemberIndexConfigured: Boolean(lineGroupMemberIndexDataSourceId),
      codexCommandQueueConfigured: Boolean(codexCommandsDataSourceId),
      codexCommandTriggers: ['Eleven Junior', 'Eleven Jr.', 'Elven Jr.', 'Seven Junior', '7 Junior', '11 Jr.'],
      autoReplyEnabled: false,
      reportCommandEnabled: true,
      morningBriefCommandEnabled: true,
      taskQueryReplyEnabled: Boolean(notionToken && tasksDataSourceId),
      immediateCommandEnabled: true,
      immediateCommandPrefixes: ['Seven Junior', '7Junior', '7 Junior'],
      judgmentCalibrationCommandEnabled: Boolean(notionToken && tasksDataSourceId && judgmentCalibrationCasesDataSourceId && judgmentRulesDataSourceId),
      judgmentCalibrationCommands: ['開始做任務校準', '开始做任务校准', '開始任務核對', '任務校準暫停', '任務校準狀態'],
      reportUrl,
      morningBriefUrl,
      conversationPageBlocksEnabled: true,
      lineContentUploadEnabled: true,
      directFileBlocksEnabled: false,
      attachmentLinksEnabled: true,
      storageMode: 'hozo-crm-style',
    });
  }

  if (req.method === 'GET' && pathname === '/worker/status') {
    if (!eventQueue.enabled) {
      return sendJson(res, 200, { workerActive: false, reason: 'queue-disabled' });
    }
    try {
      const heartbeat = await eventQueue.getLatestWorkerHeartbeat();
      const maxAgeSeconds = Number(process.env.SEVEN_WORKER_HEARTBEAT_MAX_AGE_SECONDS || 600);
      const workerActive = Boolean(heartbeat && heartbeat.ageSeconds <= maxAgeSeconds);
      return sendJson(res, 200, { workerActive, heartbeat, maxAgeSeconds });
    } catch (error) {
      return sendJson(res, 200, { workerActive: false, error: error.message });
    }
  }

  if (req.method === 'POST' && pathname === '/worker/heartbeat') {
    const controlKey = process.env.SEVEN_CONTROL_API_KEY || '';
    const providedKey = req.headers['x-seven-control-key'] || '';
    if (!controlKey || providedKey !== controlKey) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    if (!eventQueue.enabled) {
      return sendJson(res, 503, { error: 'Queue is disabled; heartbeat storage unavailable.' });
    }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const workerId = String(body.workerId || 'local-worker').slice(0, 100);
      await eventQueue.setWorkerHeartbeat(workerId, body.meta || {});
      return sendJson(res, 200, { ok: true, workerId });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
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
    const events = body.events || [];

    if (eventQueue.enabled) {
      try {
        await eventQueue.enqueue(events, rawBody);
        return sendText(res, 200, 'OK');
      } catch (error) {
        console.error('Event queue enqueue failed; falling back to direct processing.', error);
      }
    }

    await Promise.all(events.map((event) => handleEvent(event, rawBody)));
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
    try {
      await replyLineMessage(event.replyToken, commandReply);
    } catch (error) {
      // Reply tokens are one-time and short-lived; a failed reply must not
      // requeue the event after the raw message was already stored.
      console.error(`LINE reply failed for event ${event.webhookEventId || ''}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (notionConfigured) {
      await storeOutgoingReplyInNotion(event, commandReply);
    }
  }
}

async function notifyDeadQueueEvent({ eventKey, attempts, lastError }) {
  const target = process.env.SEVEN_ALERT_TARGET_ID || '';
  if (!target) {
    return;
  }
  await pushLineMessage(target, {
    type: 'text',
    text: [
      `${outgoingActorName} 訊息佇列警告`,
      `事件 ${eventKey} 重試 ${attempts} 次後仍寫入失敗，已移入待人工處理區。`,
      `錯誤：${clampText(String(lastError || ''), 600)}`,
      '原始訊息仍保存在佇列資料庫，修復後可重新處理。',
    ].join('\n'),
  });
}

async function pushLineMessage(to, message) {
  if (!channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  }

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages: [message] }),
  });

  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${await response.text()}`);
  }
}

async function buildCommandReply(event) {
  const text = event.type === 'message' && event.message?.type === 'text' ? String(event.message.text || '').trim() : '';
  const immediateCommand = parseImmediateCommand(text);
  const fromController = isControllerPersonalChat(event);

  if (morningBriefCommands.has(text)) {
    if (!fromController) return null;
    return {
      type: 'text',
      text: `早上 8 點半行程與待辦報告：\n${morningBriefUrl}\n\n目前這是試跑版，可以在手機上檢視今日行程、昨日未完成事項與今日優先處理清單。`,
    };
  }

  if (reportCommands.has(text)) {
    if (!fromController) return null;
    return {
      type: 'text',
      text: `每日總控報告網頁版：\n${reportUrl}\n\n目前這是試跑版，可以在手機上檢視附件解析與任務狀態確認畫面。`,
    };
  }

  if (dashboardCommands.has(text) || (parseImmediateCommand(text) && dashboardCommands.has(parseImmediateCommand(text).commandText))) {
    if (!fromController) return null;
    return {
      type: 'text',
      text: `📊 SevenAM 總控 Dashboard：\n${dashboardUrl}\n\n三層下鑽：全局統計 → 專案目標與任務 → 任務詳情（含來源對話內容）。\n第一次開啟需輸入 User UI 帳密，瀏覽器會記住。`,
    };
  }

  if (immediateCommand && isJudgmentCalibrationCommandText(immediateCommand.commandText)) {
    if (!fromController) return null;
    return handleJudgmentCalibrationCommand(event, immediateCommand.commandText);
  }

  // 校準回覆攔截只能吃 controller 私訊；缺了這個檢查曾把群組聊天當成校準
  // 回覆、並把校準任務內容回到群組（2026-06-12 會計顧問群事故）。
  if (!immediateCommand && fromController && await shouldHandleJudgmentCalibrationReply(text)) {
    return handleJudgmentCalibrationControllerReply(text);
  }

  if (immediateCommand && isOpenTaskDetailCommandText(immediateCommand.commandText)) {
    if (!fromController) return null;
    return buildOpenTaskDetailReply(event, immediateCommand.commandText);
  }

  if (isTaskListCommandText(immediateCommand?.commandText || text)) {
    if (!fromController) return null;
    return buildTaskListReply(event, text);
  }

  if (immediateCommand) {
    // 非 controller 的指令仍會入佇列留紀錄，但不回執、不觸發即時回答。
    if (!fromController) return null;
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

function isJudgmentCalibrationCommandText(text) {
  return resolveJudgmentCalibrationCommand(text) !== null;
}

function resolveJudgmentCalibrationCommand(text) {
  const value = String(text || '').trim();
  if (!/任務校準|校準任務|判斷校準|任务校准|校准任务|判断校准|任務核對|核對任務|任务核对|核对任务/.test(value)) {
    return null;
  }
  if (/開始|开始|啟動|启动|start|繼續|继续|resume|來做|来做|做一下|進行|进行|run/i.test(value)) {
    return 'start';
  }
  if (/暫停|暂停|停止|先停|pause|stop/i.test(value)) {
    return 'pause';
  }
  if (/狀態|状态|進度|进度|還有多少|还有多少|status|progress/i.test(value)) {
    return 'status';
  }
  return null;
}

async function handleJudgmentCalibrationCommand(event, commandText) {
  if (!isJudgmentCalibrationConfigured()) {
    return { type: 'text', text: buildJudgmentCalibrationNotConfiguredText() };
  }

  const command = resolveJudgmentCalibrationCommand(commandText);
  if (command === 'pause') {
    await setJudgmentCalibrationSessionState('Paused');
    const progress = await getJudgmentCalibrationProgress();
    return { type: 'text', text: buildJudgmentCalibrationPauseText(progress) };
  }

  if (command === 'status') {
    const session = await getJudgmentCalibrationSession();
    const progress = await getJudgmentCalibrationProgress();
    return { type: 'text', text: buildJudgmentCalibrationStatusText(session?.state || 'Paused', progress) };
  }

  await setJudgmentCalibrationSessionState('Active');
  const pending = await findPendingJudgmentCalibrationCase();
  if (pending) {
    const progress = await getJudgmentCalibrationProgress();
    return { type: 'text', text: buildPendingJudgmentCalibrationText(pending, progress) };
  }

  const next = await createNextJudgmentCalibrationCase();
  if (!next) {
    await setJudgmentCalibrationSessionState('Paused');
    const progress = await getJudgmentCalibrationProgress();
    return { type: 'text', text: `任務校準已完成。\n進度：${progress.completed}/${progress.total}\n目前沒有新的待校準任務。` };
  }

  return { type: 'text', text: buildJudgmentCalibrationReviewText(next.casePage, next.task, next.progress) };
}

async function shouldHandleJudgmentCalibrationReply(text) {
  if (!String(text || '').trim()) {
    return false;
  }
  if (!isJudgmentCalibrationConfigured()) {
    return false;
  }
  const session = await getJudgmentCalibrationSession();
  if (session?.state !== 'Active') {
    return false;
  }
  const pending = await findPendingJudgmentCalibrationCase();
  return Boolean(pending);
}

async function handleJudgmentCalibrationControllerReply(text) {
  const pending = await findPendingJudgmentCalibrationCase();
  if (!pending) {
    return { type: 'text', text: '目前沒有等待回覆的任務校準項目。' };
  }

  const parsed = parseJudgmentCalibrationControllerReply(text);
  await applyJudgmentCalibrationReply(pending, parsed);
  const afterUpdateProgress = await getJudgmentCalibrationProgress();
  const next = await createNextJudgmentCalibrationCase();

  if (!next) {
    await setJudgmentCalibrationSessionState('Paused');
    return {
      type: 'text',
      text: [
        '收到，這筆已完成校準並更新任務庫。',
        `進度：${afterUpdateProgress.completed}/${afterUpdateProgress.total}`,
        `已校準：${afterUpdateProgress.completed}｜尚未校準：${Math.max(0, afterUpdateProgress.total - afterUpdateProgress.completed)}`,
        '',
        '目前沒有下一筆待校準任務，我先自動暫停。',
      ].join('\n'),
    };
  }

  return {
    type: 'text',
    text: clampText([
      '收到，上一筆已完成校準並更新任務庫。',
      `進度：${afterUpdateProgress.completed}/${afterUpdateProgress.total}`,
      '',
      buildJudgmentCalibrationReviewText(next.casePage, next.task, next.progress),
    ].join('\n'), 4900),
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
      dueDate: pageDate(page, '截止日') || pageDate(page, '期限') || pageDate(page, 'Due Date'),
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
    dueDate: pageDate(page, '截止日') || pageDate(page, '期限') || pageDate(page, 'Due Date'),
    summary: pageText(page, 'Codex 判斷摘要') || pageText(page, '下一步') || pageText(page, '來源原文'),
    url: page.url || '',
  };
}

function isJudgmentCalibrationConfigured() {
  return Boolean(notionToken && tasksDataSourceId && judgmentCalibrationCasesDataSourceId && judgmentRulesDataSourceId);
}

function buildJudgmentCalibrationNotConfiguredText() {
  const missing = [
    !notionToken ? 'NOTION_TOKEN' : '',
    !tasksDataSourceId ? 'SEVEN_TASKS_DATA_SOURCE_ID' : '',
    !judgmentCalibrationCasesDataSourceId ? 'SEVEN_JUDGMENT_CALIBRATION_CASES_DATA_SOURCE_ID' : '',
    !judgmentRulesDataSourceId ? 'SEVEN_JUDGMENT_RULES_DATA_SOURCE_ID' : '',
  ].filter(Boolean);

  return [
    'Seven Jr. 有認出你要開始任務校準，但線上服務還沒有完成任務校準資料庫設定，所以暫時不能啟動。',
    missing.length ? `缺少設定：${missing.join('、')}` : '',
    '請先在 Render 的 line-oa-webhook 服務補上任務校準案例庫與判斷規則庫環境參數，重新部署後再說：「Seven Junior，開始做任務校準」。',
  ].filter(Boolean).join('\n');
}

async function getJudgmentCalibrationSession() {
  const page = await findJudgmentCalibrationCaseByReviewId(judgmentCalibrationSessionReviewId);
  if (!page) {
    return null;
  }
  return {
    page,
    state: pageText(page, 'Controller Judgment') || 'Paused',
  };
}

async function setJudgmentCalibrationSessionState(state) {
  const existing = await findJudgmentCalibrationCaseByReviewId(judgmentCalibrationSessionReviewId);
  const properties = {
    'Controller Judgment': richText(state),
    'Reply Summary': richText(`Session state: ${state}`),
    'Case Status': select(state === 'Active' ? 'New' : 'Archived'),
  };

  if (existing) {
    await notionRequest(`/v1/pages/${existing.id}`, {
      method: 'PATCH',
      body: { properties },
    });
    return existing;
  }

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: judgmentCalibrationCasesDataSourceId },
      properties: {
        'Review ID': title(judgmentCalibrationSessionReviewId),
        Project: select('SEVEN_AM'),
        'Source Type': select('manual review'),
        'Task Type': select('unknown'),
        'Assistant Judgment': richText('Judgment calibration session state.'),
        'Assistant Reason': richText('Tracks whether the controller is currently available for task calibration.'),
        'Assistant Confidence': select('high'),
        'Data Boundary Check': checkbox(true),
        ...properties,
      },
    },
  });
}

async function findPendingJudgmentCalibrationCase() {
  const pages = await queryJudgmentCalibrationCases();
  return pages
    .filter((page) => pageTitle(page, 'Review ID') !== judgmentCalibrationSessionReviewId)
    .filter((page) => pageSelect(page, 'Case Status') === 'Sent to LINE')
    .sort((left, right) => new Date(pageDate(left, 'LINE Review Sent At') || left.created_time) - new Date(pageDate(right, 'LINE Review Sent At') || right.created_time))[0] || null;
}

async function getJudgmentCalibrationProgress() {
  const [tasks, cases] = await Promise.all([
    queryJudgmentCalibrationScopeTasks(),
    queryJudgmentCalibrationCases(),
  ]);

  const activeTaskIds = new Set(tasks.map((task) => task.id));
  const completedTaskIds = new Set();
  const sentTaskIds = new Set();

  for (const page of cases) {
    if (pageTitle(page, 'Review ID') === judgmentCalibrationSessionReviewId) {
      continue;
    }
    const taskIds = pageRelationIds(page, 'Source Task');
    if (!taskIds.length) {
      continue;
    }
    const status = pageSelect(page, 'Case Status');
    const hasControllerReply = Boolean(pageText(page, 'Controller Judgment'));
    for (const taskId of taskIds) {
      sentTaskIds.add(taskId);
      if (['Updated', 'Rule Extracted', 'Archived', 'Replied'].includes(status) || hasControllerReply || pageCheckbox(page, 'Source Task Updated')) {
        completedTaskIds.add(taskId);
      }
    }
  }

  const totalTaskIds = new Set([...activeTaskIds, ...sentTaskIds, ...completedTaskIds]);
  const pendingCount = [...sentTaskIds].filter((taskId) => !completedTaskIds.has(taskId)).length;
  const completed = completedTaskIds.size;
  const total = totalTaskIds.size;

  return {
    total,
    completed,
    pending: pendingCount,
    remaining: Math.max(0, total - completed),
    nextIndex: Math.min(total || completed + 1, completed + pendingCount + 1),
  };
}

async function createNextJudgmentCalibrationCase() {
  const progress = await getJudgmentCalibrationProgress();
  const candidate = await findNextJudgmentCalibrationTaskCandidate();
  if (!candidate) {
    return null;
  }
  const casePage = await createJudgmentCalibrationCase(candidate, progress);
  return {
    casePage,
    task: candidate,
    progress: { ...progress, currentIndex: progress.completed + 1 },
  };
}

async function findNextJudgmentCalibrationTaskCandidate() {
  const [tasks, cases] = await Promise.all([
    queryJudgmentCalibrationScopeTasks(),
    queryJudgmentCalibrationCases(),
  ]);
  const sentTaskIds = new Set();
  for (const page of cases) {
    for (const taskId of pageRelationIds(page, 'Source Task')) {
      sentTaskIds.add(taskId);
    }
  }
  return tasks.find((task) => !sentTaskIds.has(task.id)) || null;
}

async function queryJudgmentCalibrationScopeTasks() {
  const pages = await queryAllDataSourcePages(tasksDataSourceId, { page_size: 100 });
  return pages
    .map(normalizeJudgmentCalibrationTask)
    .filter((task) => task.id && task.name)
    .filter((task) => !isClosedTaskStatus(task.status));
}

function normalizeJudgmentCalibrationTask(page) {
  return {
    id: page.id,
    url: page.url || '',
    name: pageText(page, '任務名稱') || pageText(page, 'Name') || pageText(page, '名稱') || '(未命名任務)',
    project: pageRelationTitleFallback(page, '總控專案') || pageText(page, '專案'),
    owner: pageText(page, '負責人') || pageText(page, 'Owner'),
    status: pageStatus(page, '狀態') || pageSelect(page, '狀態'),
    confirmation: pageSelect(page, '確認狀態'),
    confidence: pageSelect(page, '信心等級'),
    priority: pageSelect(page, '優先級'),
    dueDate: pageDate(page, '期限') || pageDate(page, 'Due Date'),
    summary: pageText(page, 'Codex 判斷摘要') || pageText(page, '下一步') || pageText(page, '來源原文'),
  };
}

function isClosedTaskStatus(status) {
  return /^(已完成|完成|封存|取消|Done|Closed)$/i.test(String(status || '').trim());
}

async function createJudgmentCalibrationCase(task, progress) {
  const reviewId = `SEVEN-JC-${formatDateKey(new Date())}`;
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: judgmentCalibrationCasesDataSourceId },
      properties: {
        'Review ID': title(reviewId),
        Project: select('SEVEN_AM'),
        'Source Type': select('total-control task'),
        'Source Task': relation(task.id),
        'Source URL': url(task.url),
        'Task Type': select(inferJudgmentCalibrationTaskType(task)),
        'Assistant Judgment': richText('請 controller 校準此任務是否應保留、撤除、拆分、改專案或補資料。'),
        'Assistant Reason': richText(buildJudgmentCalibrationReason(task, progress)),
        'Assistant Confidence': select(task.confidence === '高' ? 'high' : task.confidence === '中' ? 'medium' : 'low'),
        'Case Status': select('Sent to LINE'),
        'LINE Review Sent At': date(new Date().toISOString()),
        'Data Boundary Check': checkbox(true),
      },
    },
  });
}

function buildJudgmentCalibrationReviewText(casePage, task, progress) {
  const reviewId = pageTitle(casePage, 'Review ID');
  const currentIndex = progress.currentIndex || progress.nextIndex || progress.completed + 1;
  const total = progress.total || currentIndex;
  const remaining = Math.max(0, total - progress.completed);
  return clampText([
    `【判斷校準】${currentIndex}/${total}`,
    `Review ID：${reviewId}`,
    `已校準：${progress.completed}｜尚未校準：${remaining}`,
    '',
    `任務：${task.name}`,
    '來源：SevenAM 總控任務庫',
    '',
    '我的判斷：',
    '這筆需要你校準：保留、撤任務、暫緩、拆任務、改專案或補資料。',
    '',
    '我判斷的理由：',
    [
      task.project ? `專案=${task.project}` : '',
      task.status ? `狀態=${task.status}` : '',
      task.confirmation ? `確認=${task.confirmation}` : '',
      task.confidence ? `信心=${task.confidence}` : '',
      task.priority ? `優先=${task.priority}` : '',
      task.owner ? `負責人=${task.owner}` : '',
    ].filter(Boolean).join('｜') || '任務庫中尚未有足夠校準資料。',
    '',
    '不確定點：',
    task.summary || '需要你指定正確處理方向。',
    '',
    '請回覆：',
    '方向：建立任務 / 撤任務 / 暫緩 / 拆任務 / 改專案 / 補資料 / 其他',
    '原因：...',
    '規則：...',
    '例外：...',
    '',
    '若你現在沒空，可說：Seven Junior，任務校準暫停',
  ].join('\n'), 4900);
}

function buildPendingJudgmentCalibrationText(casePage, progress) {
  const reviewId = pageTitle(casePage, 'Review ID');
  const taskName = pageRelationIds(casePage, 'Source Task').length ? '上一筆已送出的任務' : '上一筆校準項目';
  return [
    '任務校準已開始。',
    `目前還有一筆等待你回覆：${reviewId}`,
    `進度：${progress.completed}/${progress.total}`,
    `已校準：${progress.completed}｜尚未校準：${progress.remaining}`,
    '',
    `${taskName}還沒完成校準；請直接回覆「方向、原因、規則、例外」。`,
  ].join('\n');
}

function buildJudgmentCalibrationPauseText(progress) {
  return [
    '任務校準已暫停。',
    `進度：${progress.completed}/${progress.total}`,
    `已校準：${progress.completed}｜尚未校準：${progress.remaining}`,
    '',
    '你有空時說：「Seven Junior，我們開始做任務校準」，我再繼續發下一筆。',
  ].join('\n');
}

function buildJudgmentCalibrationStatusText(state, progress) {
  const stateText = state === 'Active' ? '進行中' : '暫停中';
  return [
    `任務校準狀態：${stateText}`,
    `進度：${progress.completed}/${progress.total}`,
    `已校準：${progress.completed}｜尚未校準：${progress.remaining}`,
    progress.pending ? `等待你回覆：${progress.pending} 筆` : '目前沒有等待回覆的校準項目。',
  ].join('\n');
}

function parseJudgmentCalibrationControllerReply(text) {
  const value = String(text || '').trim();
  return {
    direction: extractLabeledValue(value, ['方向', '處理方向']) || inferJudgmentDirection(value),
    reason: extractLabeledValue(value, ['原因', '理由']) || inferJudgmentReason(value),
    rule: extractLabeledValue(value, ['規則', '可學習規則', '學習規則']),
    exception: extractLabeledValue(value, ['例外', '例外情況']),
    raw: value,
  };
}

function extractLabeledValue(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:：是]?\\s*([\\s\\S]*?)(?=[，,。；;\\n\\s]*(方向|處理方向|原因|理由|規則|可學習規則|學習規則|例外|例外情況)\\s*[:：是]?|$)`, 'i');
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return '';
}

function inferJudgmentDirection(text) {
  if (/撤任務|不是任務|不用列入|不列入|退回|封存/.test(text)) return '撤任務';
  if (/拆任務|拆成|分開/.test(text)) return '拆任務';
  if (/改專案|換專案|歸到/.test(text)) return '改專案';
  if (/暫緩|先不要|之後再/.test(text)) return '暫緩';
  if (/補資料|不清楚|確認/.test(text)) return '補資料';
  if (/建立任務|保留|列入/.test(text)) return '建立任務';
  return '其他';
}

function inferJudgmentReason(text) {
  const match = text.match(/原因(?:是|[:：])?([\s\S]*?)(?:規則|例外|$)/);
  return (match?.[1] || text).trim().slice(0, 900);
}

async function applyJudgmentCalibrationReply(casePage, parsed) {
  const sourceTaskId = pageRelationIds(casePage, 'Source Task')[0];
  const rulePage = parsed.rule ? await createJudgmentRuleFromReply(parsed) : null;
  const properties = {
    'Controller Judgment': richText(parsed.direction),
    'Controller Reason': richText(parsed.reason),
    'Reply Summary': richText(parsed.raw),
    'Generalized Rule': richText(parsed.rule),
    'Controller Replied At': date(new Date().toISOString()),
    'Case Status': select(parsed.rule ? 'Rule Extracted' : 'Updated'),
    'Source Task Updated': checkbox(Boolean(sourceTaskId)),
  };
  if (rulePage) {
    properties['Rule Link'] = relation(rulePage.id);
  }

  await notionRequest(`/v1/pages/${casePage.id}`, {
    method: 'PATCH',
    body: { properties },
  });

  if (sourceTaskId) {
    await updateJudgmentCalibrationSourceTask(sourceTaskId, parsed);
  }
}

async function createJudgmentRuleFromReply(parsed) {
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: judgmentRulesDataSourceId },
      properties: {
        'Rule Name': title(clampText(parsed.rule.replace(/\s+/g, ' ').trim(), 80)),
        'Trigger Pattern': richText(parsed.reason || parsed.direction),
        'Preferred Judgment': richText(parsed.direction),
        'Avoided Judgment': richText('Use assistant original judgment without controller calibration.'),
        Reason: richText(parsed.reason),
        'Applies To': multiSelect(['SEVEN_AM']),
        Exceptions: richText(parsed.exception),
        'Source Case Count': number(1),
        Status: select('Needs review'),
        'Checklist Placement': select('task start'),
        'Last Verified': date(new Date().toISOString()),
      },
    },
  });
}

async function updateJudgmentCalibrationSourceTask(taskId, parsed) {
  const summary = [
    `Controller 校準：${parsed.direction}`,
    parsed.reason ? `原因：${parsed.reason}` : '',
    parsed.rule ? `規則：${parsed.rule}` : '',
    parsed.exception ? `例外：${parsed.exception}` : '',
  ].filter(Boolean).join('\n');
  const properties = {
    'Codex 判斷摘要': richText(summary, 1900),
  };

  if (/撤任務|不是任務|退回|封存/.test(parsed.direction)) {
    properties['狀態'] = select('封存');
    properties['確認狀態'] = select('退回');
  } else if (/暫緩/.test(parsed.direction)) {
    properties['狀態'] = select('等待回覆');
  } else if (/建立任務|保留/.test(parsed.direction)) {
    properties['確認狀態'] = select('已確認');
  } else if (/補資料|拆任務|改專案/.test(parsed.direction)) {
    properties['確認狀態'] = select('未確認');
  }

  await notionRequest(`/v1/pages/${taskId}`, {
    method: 'PATCH',
    body: { properties },
  });
}

function buildJudgmentCalibrationReason(task, progress) {
  return [
    `進度=${progress.completed + 1}/${progress.total || progress.completed + 1}`,
    task.status ? `狀態=${task.status}` : '',
    task.confirmation ? `確認狀態=${task.confirmation}` : '',
    task.confidence ? `信心等級=${task.confidence}` : '',
    task.priority ? `優先級=${task.priority}` : '',
  ].filter(Boolean).join('；') || 'SevenAM 任務校準流程選出此任務。';
}

function inferJudgmentCalibrationTaskType(task) {
  const text = `${task.name} ${task.summary}`;
  if (/Render|部署|production|deploy/i.test(text)) return 'deployment';
  if (/資料|Notion|LINE|權限|token|secret|database/i.test(text)) return 'data governance';
  if (/目標|完成標準|驗收|口述/.test(text)) return 'goal';
  if (/責任|負責人|權責/.test(text)) return 'responsibility item';
  return 'task';
}

async function queryJudgmentCalibrationCases() {
  return queryAllDataSourcePages(judgmentCalibrationCasesDataSourceId, { page_size: 100 });
}

async function findJudgmentCalibrationCaseByReviewId(reviewId) {
  const result = await notionRequest(`/v1/data_sources/${judgmentCalibrationCasesDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: { property: 'Review ID', title: { equals: reviewId } },
    },
  });
  return result.results?.[0] || null;
}

async function queryAllDataSourcePages(dataSourceId, body = {}) {
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
  await maybeUpsertLineGroupMemberIndex({ source, context, display, conversation, eventTime });
  const uploadedContent = await maybeUploadLineContent(message, messageType, messageId);
  const messagePage = await createMessagePage({ conversationId: conversation.id, event, rawBody, messageId, messageType, text, eventTime, display, context });

  let attachmentPage;
  if (['file', 'image'].includes(messageType) && attachmentsDataSourceId && uploadedContent?.fileUploadId) {
    // 私人對話的照片不自動解析，進待確認；其餘附件由解析排程處理。
    const conversationProject = conversation.properties?.['總控專案']?.select?.name || '';
    const privateImage = messageType === 'image' && (!conversationProject || conversationProject === '私人事務');
    attachmentPage = await createAttachmentPage({
      conversationId: conversation.id,
      messagePageId: messagePage.id,
      event,
      message,
      messageId,
      messageType,
      eventTime,
      uploadedContent,
      initialConversionStatus: privateImage ? '待確認' : '待轉檔',
    });
  } else if (messageType === 'file' && attachmentsDataSourceId) {
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

async function maybeUpsertLineGroupMemberIndex({ source, context, display, conversation, eventTime }) {
  if (!lineGroupMemberIndexDataSourceId || !source?.userId || !['group', 'room'].includes(source.type)) {
    return null;
  }

  try {
    return await upsertLineGroupMemberIndex({ source, context, display, conversation, eventTime });
  } catch (error) {
    console.warn(`Unable to sync LINE group member index: ${error.message}`);
    return null;
  }
}

async function upsertLineGroupMemberIndex({ source, context, display, conversation, eventTime }) {
  const targetType = source.roomId ? 'room' : 'group';
  const targetId = source.roomId || source.groupId || '';
  if (!targetId) return null;

  const existing = await findLineGroupMemberIndexPage({ targetType, targetId, userId: source.userId });
  const properties = {
    對象類型: select(targetType),
    GroupID: richText(targetType === 'group' ? targetId : ''),
    RoomID: richText(targetType === 'room' ? targetId : ''),
    群組顯示名稱: richText(display.conversationName || context.entityType || ''),
    UserID: richText(source.userId),
    成員顯示名稱: richText(display.actorName || source.userId),
    成員狀態: select('active'),
    來源: select('Webhook'),
    LINE對話主檔: relation(conversation.id),
    最後同步時間: date(eventTime),
    最後出現時間: date(eventTime),
    同步訊息: richText('Captured from incoming LINE webhook event.'),
  };

  if (existing) {
    return notionRequest(`/v1/pages/${existing.id}`, {
      method: 'PATCH',
      body: { properties },
    });
  }

  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: lineGroupMemberIndexDataSourceId },
      properties: {
        成員索引名稱: title(`${display.conversationName || targetId} / ${display.actorName || source.userId}`),
        ...properties,
      },
    },
  });
}

async function findLineGroupMemberIndexPage({ targetType, targetId, userId }) {
  const targetProperty = targetType === 'room' ? 'RoomID' : 'GroupID';
  const result = await notionRequest(`/v1/data_sources/${lineGroupMemberIndexDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: {
        and: [
          { property: '對象類型', select: { equals: targetType } },
          { property: targetProperty, rich_text: { equals: targetId } },
          { property: 'UserID', rich_text: { equals: userId } },
        ],
      },
    },
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

async function createAttachmentPage({ conversationId, messagePageId, event, message, messageId, messageType, eventTime, uploadedContent, initialConversionStatus }) {
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
    '轉檔狀態': select(uploadedContent?.fileUploadId ? (initialConversionStatus || '待轉檔') : '失敗'),
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

function multiSelect(names) {
  return { multi_select: names.filter(Boolean).map((name) => ({ name })) };
}

function number(value) {
  return { number: Number.isFinite(value) ? value : null };
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

function pageTitle(page, propertyName) {
  return pageText(page, propertyName);
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

function pageRelationIds(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'relation' ? (property.relation || []).map((item) => item.id).filter(Boolean) : [];
}

function pageCheckbox(page, propertyName) {
  const property = page?.properties?.[propertyName];
  return property?.type === 'checkbox' ? Boolean(property.checkbox) : false;
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

function formatDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .format(date)
    .replace(/[^0-9]/g, '');
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

if (eventQueue.enabled) {
  eventQueue.init().catch((error) => {
    console.error('Event queue init failed; webhook falls back to direct Notion writes.', error);
  });
} else {
  console.warn('DATABASE_URL is not set. Webhook events are written to Notion synchronously without a durable queue.');
}

server.listen(port, () => {
  console.log(`LINE webhook server is listening on port ${port}`);
});
