import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const messagesDataSourceId = process.env.SEVEN_MESSAGES_DATA_SOURCE_ID || '';
const tasksDataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID || '';
const progressReportsDataSourceId = process.env.SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID || '';
const conversationProjectCache = new Map();
const inRunCreatedTasks = new Map();

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const includeOutgoing = Boolean(args['include-outgoing']);
const includeOutgoingGroups = Boolean(args['include-outgoing-groups']);
const reprocess = Boolean(args.reprocess || args['include-judged']);
const sinceHours = clampNumber(Number(args['since-hours'] || process.env.SEVEN_LINE_JUDGEMENT_SINCE_HOURS || 36), 1, 24 * 14);
const limit = clampNumber(Number(args.limit || 50), 1, 100);

if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!messagesDataSourceId) fail('SEVEN_MESSAGES_DATA_SOURCE_ID is not set.');
if (!tasksDataSourceId) fail('SEVEN_TASKS_DATA_SOURCE_ID is not set.');
if (!progressReportsDataSourceId) fail('SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID is not set.');

try {
  const startedAt = new Date();
  const messages = await listMessagesForJudgement();
  const groupedMessages = groupMessagesByConversation(messages);
  const results = [];

  for (const group of groupedMessages) {
    for (const message of group.messages) {
      results.push(await processMessage(message, group.messages));
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    includeOutgoing,
    includeOutgoingGroups,
    reprocess,
    sinceHours,
    scannedMessages: messages.length,
    conversationGroups: groupedMessages.length,
    updatedExistingTasks: results.reduce((count, item) => count + item.updatedExistingTasks.filter((task) => task.action === 'updated-existing').length, 0),
    createdNewEventTasks: results.reduce((count, item) => count + item.createdTasks.filter((task) => task.action === 'created').length, 0),
    createdTasks: results.reduce((count, item) => count + item.createdTasks.filter((task) => task.action === 'created').length, 0),
    createdProgressReports: results.reduce((count, item) => count + item.createdProgressReports.filter((report) => report.action === 'created').length, 0),
    importantMessages: results.filter((item) => item.importanceScore > 0).length,
    markedJudged: results.filter((item) => item.markedJudged).length,
    judgedNoTask: results.filter((item) => item.markedJudged && !item.createdTasks.length && !item.updatedExistingTasks.length).length,
    duplicateSkipped: results.reduce((count, item) => count + item.createdTasks.filter((task) => task.action === 'skipped-duplicate').length, 0),
    skipped: results.filter((item) => item.action === 'ignored' || item.action === 'skipped').length,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    results,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function listMessagesForJudgement() {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const baseFilters = [
    { property: '排序時間', date: { on_or_after: since } },
  ];

  if (!reprocess) {
    baseFilters.unshift({ property: '已進入判斷層', checkbox: { equals: false } });
  }

  if (includeOutgoingGroups) {
    const [lineMessages, outgoingGroupMessages] = await Promise.all([
      queryMessagesForJudgement([...baseFilters, { property: '訊息來源', select: { equals: 'line' } }]),
      queryMessagesForJudgement([
        ...baseFilters,
        { property: '訊息來源', select: { equals: 'ai-engine' } },
        { property: '群組標記', checkbox: { equals: true } },
      ]),
    ]);

    return [...lineMessages, ...outgoingGroupMessages]
      .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0))
      .slice(0, limit);
  }

  const filters = includeOutgoing
    ? baseFilters
    : [...baseFilters, { property: '訊息來源', select: { equals: 'line' } }];

  return queryMessagesForJudgement(filters);
}

async function queryMessagesForJudgement(filters) {
  const result = await notionRequest(`/v1/data_sources/${messagesDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: limit,
      filter: { and: filters },
      sorts: [{ property: '排序時間', direction: 'ascending' }],
    },
  });

  const messages = (result.results || []).map(normalizeMessagePage);
  return enrichMessagesWithConversationProject(messages);
}

async function enrichMessagesWithConversationProject(messages) {
  return Promise.all(messages.map(async (message) => {
    const conversation = await getConversationProject(message.conversationId);
    return {
      ...message,
      conversationProject: conversation.project,
      conversationDisplayName: conversation.name || message.conversationName,
    };
  }));
}

async function getConversationProject(pageId) {
  if (!pageId) return { project: '', name: '' };
  if (conversationProjectCache.has(pageId)) return conversationProjectCache.get(pageId);

  const page = await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
  const name = textProperty(page.properties?.['LINE 對話名稱']) || textProperty(page.properties?.['自定義名稱']);
  const preview = textProperty(page.properties?.['最新訊息預覽']);
  const project = selectName(page.properties?.['總控專案'])
    || inferConversationProject(`${name}\n${preview}`);
  const value = { project, name };
  conversationProjectCache.set(pageId, value);
  return value;
}

function groupMessagesByConversation(messages) {
  const groups = new Map();
  for (const message of messages) {
    const key = message.conversationId || message.conversationName || 'unknown-conversation';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return [...groups.entries()].map(([key, groupMessages]) => ({
    key,
    messages: groupMessages.sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0)),
  }));
}

async function processMessage(message, runConversationMessages = []) {
  const sameConversationContext = await loadSameConversationContext(message, runConversationMessages);
  const analysis = analyzeMessage({ ...message, sameConversationContext });
  const result = {
    messageId: message.messageId,
    messagePageId: message.id,
    time: message.time,
    actor: message.actor,
    conversation: message.conversationName,
    contextMessages: sameConversationContext.length,
    action: analysis.action,
    importanceScore: analysis.importanceScore,
    importanceReasons: analysis.importanceReasons,
    candidates: analysis.candidates.map((candidate) => ({
      name: candidate.name,
      project: candidate.project,
      category: candidate.category,
      priority: candidate.priority,
    })),
    updatedExistingTasks: [],
    createdTasks: [],
    createdProgressReports: [],
    markedJudged: false,
  };

  for (const candidate of analysis.candidates) {
    const candidateKey = normalizeKey(candidate.name);
    const relatedTask = inRunCreatedTasks.get(candidateKey)
      || await findRelatedActiveTask(candidate, message, sameConversationContext);
    if (relatedTask) {
      if (dryRun) {
        result.updatedExistingTasks.push({ action: 'dry-run-update', pageId: relatedTask.id, url: relatedTask.url, name: relatedTask.name, candidate: candidate.name });
      } else {
        await updateTaskWithEvidence(relatedTask, candidate, message, sameConversationContext);
        result.updatedExistingTasks.push({ action: 'updated-existing', pageId: relatedTask.id, url: relatedTask.url, name: relatedTask.name, candidate: candidate.name });
      }
    } else if (dryRun) {
      result.createdTasks.push({ action: 'dry-run', name: candidate.name, properties: candidate.taskProperties });
      inRunCreatedTasks.set(candidateKey, {
        id: `dry-run:${candidateKey}`,
        url: '',
        name: candidate.name,
        project: candidate.project,
        status: '待確認',
        sourceText: candidate.sourceText || '',
        judgementSummary: candidate.summary || '',
        nextStep: candidate.nextStep || '',
      });
    } else {
      const created = await createTask(candidate);
      result.createdTasks.push({ action: 'created', pageId: created.id, url: created.url, name: candidate.name });
      inRunCreatedTasks.set(candidateKey, {
        id: created.id,
        url: created.url,
        name: candidate.name,
        project: candidate.project,
        status: '待確認',
        sourceText: candidate.sourceText || '',
        judgementSummary: candidate.summary || '',
        nextStep: candidate.nextStep || '',
      });
    }

    if (candidate.progressProperties) {
      try {
        const existingProgress = await findExistingProgressReport(candidate.progressName);
        if (existingProgress) {
          result.createdProgressReports.push({ action: 'skipped-duplicate', pageId: existingProgress.id, url: existingProgress.url, name: candidate.progressName });
        } else if (dryRun) {
          result.createdProgressReports.push({ action: 'dry-run', name: candidate.progressName, properties: candidate.progressProperties });
        } else {
          const createdProgress = await createProgressReport(candidate);
          result.createdProgressReports.push({ action: 'created', pageId: createdProgress.id, url: createdProgress.url, name: candidate.progressName });
        }
      } catch (error) {
        result.createdProgressReports.push({ action: 'skipped-error', name: candidate.progressName, reason: error.message });
      }
    }
  }

  if (!dryRun && (!message.judged || reprocess)) {
    await markMessageJudged(message, firstCreatedUrl(result));
    result.markedJudged = true;
  }

  return result;
}

async function loadSameConversationContext(message, runConversationMessages = []) {
  const runContext = runConversationMessages
    .filter((item) => item.conversationId === message.conversationId || item.conversationName === message.conversationName)
    .filter((item) => !item.time || !message.time || new Date(item.time) <= new Date(message.time));

  if (!message.conversationId) {
    return runContext.slice(-12);
  }

  const filters = [
    { property: '對話主檔', relation: { contains: message.conversationId } },
  ];
  if (message.time) {
    filters.push({ property: '排序時間', date: { on_or_before: message.time } });
  }

  try {
    const result = await notionRequest(`/v1/data_sources/${messagesDataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: 12,
        filter: { and: filters },
        sorts: [{ property: '排序時間', direction: 'descending' }],
      },
    });

    return (result.results || [])
      .map(normalizeMessagePage)
      .map((item) => ({
        ...item,
        conversationProject: message.conversationProject,
        conversationDisplayName: message.conversationDisplayName,
      }))
      .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
  } catch (error) {
    console.warn(`Unable to load same conversation context for ${message.messageId}: ${error.message}`);
    return runContext.slice(-12);
  }
}

function analyzeMessage(message) {
  const text = String(message.text || '').trim();
  if (!text || !isTextMessageType(message.type)) {
    return emptyAnalysis('non-text-or-empty');
  }

  if (isOperationalInstructionMessage(text, message)) {
    return emptyAnalysis('operational-instruction-message');
  }

  if (isCommandTriggerMessage(text)) {
    return emptyAnalysis('command-trigger-message');
  }

  if (isPureKnowledgeExplanation(text)) {
    return emptyAnalysis('pure-knowledge-message');
  }

  if (isConversationSetupMessage(text, message)) {
    return emptyAnalysis('conversation-setup-message');
  }

  const contextualConcern = detectContextualConcern(text, message);
  if (contextualConcern) {
    return {
      action: 'context-thread-reconciliation',
      importanceScore: contextualConcern.importanceScore,
      importanceReasons: contextualConcern.reasons,
      candidates: [buildCandidate(contextualConcern, message, {
        score: contextualConcern.importanceScore,
        reasons: contextualConcern.reasons,
      })],
    };
  }

  const importance = scoreImportance(text, message);
  if (importance.score <= 0 && isLowSignal(text)) {
    return emptyAnalysis('low-signal-message');
  }

  const concerns = buildConcerns(text, message, importance);
  if (!concerns.length) {
    return {
      action: 'ignored',
      importanceScore: importance.score,
      importanceReasons: importance.reasons,
      candidates: [],
    };
  }

  return {
    action: 'assistant-manager-capture',
    importanceScore: importance.score,
    importanceReasons: importance.reasons,
    candidates: concerns.map((concern) => buildCandidate(concern, message, importance)),
  };
}

function emptyAnalysis(reason) {
  return {
    action: ['low-signal-message', 'pure-knowledge-message'].includes(reason) ? 'ignored' : 'skipped',
    importanceScore: 0,
    importanceReasons: [reason],
    candidates: [],
  };
}

function scoreImportance(text, message) {
  const rules = [
    ['health', 5, /頭痛|身體不舒服|生病|發燒|醫院|診所|看醫生|吃藥|疼痛|疼|受傷|失眠/],
    ['relationship-escalation', 6, /不滿|客訴|投訴|抱怨|失望|感覺.*不舒服|沒有回報|沒回報|回報進度|抱歉|道歉|誤會|安撫|關係修復/],
    ['insurance-finance', 5, /火險|保險|保單|房貸|續保|到期|報稅|稅|發票|付款|匯款|費用|金額|銀行/],
    ['assigned-to-seven', 5, /你處理|你要|你來|交給你|麻煩你|提醒你|你確認|你安排|請你|幫我/],
    ['customer-or-tenant-issue', 5, /房客|租客|發黴|漏水|故障|燈光|浴室|投訴|反應|抱怨|修繕|客人.*(問題|反應|投訴|抱怨)/],
    ['decision-needed', 4, /要不要|是不是|是否|怎麼辦|怎麼處理|要怎麼|可不可以|需不需要|同不同意|決定|決策|確認/],
    ['meeting-or-record', 4, /會議|會議記錄|月會|例會|紀錄|討論|結論|行動項目/],
    ['project-progress', 4, /進度|狀態|完成|卡住|卡點|下一步|本週|今天.*安排|方向|策略|想法|看法/],
    ['family-private', 3, /媽媽|媽，|老婆|太太|家裡|家人|小孩|私人|西周|天才家族/],
    ['follow-up', 3, /追蹤|提醒|通知|回覆|再跟|後續|待辦|處理/],
    ['explicit-tag', 5, /#待辦|#todo|#完成|#done|#追蹤|#followup|#決策|#decision|#卡點|#blocked/i],
  ];

  const reasons = [];
  let score = 0;
  for (const [reason, points, pattern] of rules) {
    if (pattern.test(text)) {
      score += points;
      reasons.push(reason);
    }
  }

  if (String(message.conversationName || '').match(/西周|天才家族|家族|家庭/)) {
    score += 2;
    reasons.push('family-conversation');
  }

  if (text.length >= 80) {
    score += 1;
    reasons.push('substantial-message');
  }

  return { score, reasons: [...new Set(reasons)] };
}

function buildConcerns(text, message, importance) {
  const concerns = [];
  const segments = splitIntoSegments(text);

  for (const segment of segments) {
    const segmentImportance = scoreImportance(segment, message);
    if (segmentImportance.score <= 0 && isLowSignal(segment)) continue;

    const detected = detectConcern(segment, message, segmentImportance.score ? segmentImportance : importance);
    if (detected) concerns.push(detected);
  }

  if (!concerns.length && importance.score > 0) {
    concerns.push(detectConcern(text, message, importance));
  }

  return dedupeConcerns(concerns.filter(Boolean));
}

function splitIntoSegments(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numbered = [];
  let current = '';

  for (const line of lines) {
    if (/^(\d+[.、)]|[（(]?\d+[）)]|[一二三四五六七八九十]+[、.．])\s*/.test(line) && current) {
      numbered.push(current.trim());
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) numbered.push(current.trim());

  if (numbered.length > 1) return numbered.slice(0, 8);

  const clauses = text
    .split(/(?<=[。！？!?])\s+|[；;]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 10);

  return clauses.length > 1 ? clauses.slice(0, 8) : [text];
}

function detectConcern(text, message, importance) {
  const category = inferCategory(text);
  const project = inferProject(text, message, category);
  const priority = inferPriority(text, category, importance.score);
  const summary = summarizeText(text);
  const owner = inferOwner(text) || (category === 'delegation' || /你處理|你要|交給你|提醒你/.test(text) ? 'Seven 陳聖文' : message.actor || '');
  const dueDate = inferDueDate(text);

  if (category === 'note') return null;

  return {
    category,
    project,
    priority,
    summary,
    owner,
    dueDate,
    sourceText: text,
    nextStep: inferNextStep(text, category),
    createsProgress: shouldCreateProgress(project, category, text),
    reasons: importance.reasons,
  };
}

function detectContextualConcern(text, message) {
  const project = inferProject(text, message, inferCategory(text));
  const contextText = [
    message.conversationDisplayName,
    message.conversationName,
    ...(message.sameConversationContext || []).map((item) => item.text || ''),
    text,
  ].join('\n');

  if (project === '茲心園工程' && isEngineeringVendorEstimateThread(contextText)) {
    const missingDocs = extractEngineeringMissingDocs(text);
    if (missingDocs.length) {
      return {
        category: 'task',
        project,
        priority: '中',
        summary: `綦盛工程詢問估價所需資料：${missingDocs.join('、')}`,
        owner: 'Seven 陳聖文',
        dueDate: null,
        sourceText: text,
        nextStep: `補提供綦盛工程估價所需資料：${missingDocs.join('、')}；提供後請對方確認是否還缺估價資料。`,
        createsProgress: true,
        reasons: ['engineering-vendor-estimate-thread', 'missing-estimate-documents'],
        importanceScore: 8,
        nameOverride: '茲心園工程：補提供綦盛工程估價所需資料',
      };
    }

    if (isEngineeringDesignDelivery(text)) {
      return {
        category: 'progress',
        project,
        priority: '中',
        summary: '已將茲心園 D 區與 J 棟工程設計圖資料提供給綦盛工程查看。',
        owner: 'Seven 陳聖文',
        dueDate: null,
        sourceText: text,
        nextStep: '綦盛工程已收到 D 區與 J 棟資料連結；等待對方確認是否可估價，或是否需要補基地位置圖、建照、雜照等文件。',
        createsProgress: true,
        reasons: ['engineering-vendor-estimate-thread', 'design-material-delivered'],
        importanceScore: 6,
        nameOverride: '茲心園工程：再發設計圖給 2-3 家營造廠估價',
      };
    }

    if (isVendorContactSetup(text)) {
      return null;
    }
  }

  return null;
}

function dedupeConcerns(concerns) {
  const seen = new Set();
  return concerns.filter((concern) => {
    const key = `${concern.project}:${concern.category}:${normalizeKey(concern.summary).slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildCandidate(concern, message, importance) {
  const syncId = buildSyncId(message.id, concern.sourceText);
  const name = buildTaskName(concern, message);
  const sourceText = [
    `LINE 訊息：${message.url}`,
    message.conversationName ? `對話：${message.conversationName}` : '',
    message.actor ? `發話者：${message.actor}` : '',
    `同步識別碼：${syncId}`,
    '',
    concern.sourceText,
  ].filter(Boolean).join('\n');

  const judgementSummary = [
    `助理經理判斷：${categoryLabel(concern.category)}`,
    `重要原因：${concern.reasons.join('、') || importance.reasons.join('、') || '一般注意事項'}`,
    `重要分數：${importance.score}`,
    `建議處理：${concern.nextStep}`,
    `摘要：${concern.summary}`,
  ].join('\n');

  const taskProperties = compactProperties({
    任務名稱: titleProperty(name),
    專案: selectProperty(concern.project),
    狀態: selectProperty('待確認'),
    確認狀態: selectProperty('未確認'),
    優先級: selectProperty(concern.priority),
    負責人: richTextProperty(concern.owner),
    截止日: concern.dueDate ? dateProperty(concern.dueDate) : undefined,
    來源: selectProperty('LINE'),
    來源原文: richTextProperty(sourceText, 1900),
    'Codex 判斷摘要': richTextProperty(judgementSummary, 1900),
    信心等級: selectProperty(concern.project === '未分類' ? '中' : '高'),
    下一步: richTextProperty(concern.nextStep, 900),
    '關聯 Notion 頁面': urlProperty(message.url),
    最後更新: dateProperty(new Date()),
  });

  const progressName = concern.createsProgress ? buildProgressName(concern, message) : '';
  const progressProperties = concern.createsProgress ? compactProperties({
    報表名稱: titleProperty(progressName),
    專案: selectProperty(concern.project),
    報表週期: dateProperty(message.time ? new Date(message.time) : new Date()),
    目前狀態: selectProperty(concern.priority === '高' ? '需注意' : '更新'),
    負責人: richTextProperty(concern.owner),
    本週進展: richTextProperty(concern.summary, 1200),
    主要卡點: richTextProperty(inferBlockerText(concern.sourceText), 800),
    下一步: richTextProperty(concern.nextStep, 800),
    '需要 Seven 決策': richTextProperty(needsSevenDecision(concern) ? '需要 Seven 確認後再推進。' : '暫無明確決策需求。', 800),
    關聯頁面: urlProperty(message.url),
  }) : null;

  return {
    ...concern,
    name,
    syncId,
    taskProperties,
    progressName,
    progressProperties,
  };
}

function normalizeMessagePage(page) {
  const properties = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    messageId: textProperty(properties['訊息 ID']),
    actor: textProperty(properties['發話者名稱']),
    source: selectName(properties['訊息來源']),
    type: selectName(properties['訊息類型']),
    time: dateValue(properties['排序時間']),
    text: textProperty(properties['文字內容']) || textProperty(properties['原始內容']),
    judged: checkboxValue(properties['已進入判斷層']),
    conversationId: relationId(properties['對話主檔']),
    conversationName: relationMentionName(properties['對話主檔']),
  };
}

function inferCategory(text) {
  if (/#完成|#done|已處理|已完成|完成了|處理完/.test(text) && !/希望完成/.test(text)) return 'done';
  if (/頭痛|身體不舒服|生病|發燒|醫院|診所|看醫生|吃藥|疼痛|疼|受傷|失眠/.test(text)) return 'health';
  if (/不滿|客訴|投訴|抱怨|失望|感覺.*不舒服|沒有回報|沒回報|回報進度|抱歉|道歉|誤會|安撫|關係修復/.test(text)) return 'relationshipIssue';
  if (/火險|保險|保單|房貸|續保/.test(text)) return 'insurance';
  if (/報稅|稅|發票|付款|匯款|費用|金額|銀行/.test(text)) return 'finance';
  if (/房客|租客|發黴|漏水|故障|燈光|浴室|修繕|投訴|反應|抱怨|客人.*(問題|反應|投訴|抱怨)/.test(text)) return 'customerIssue';
  if (/你處理|你要|你來|交給你|麻煩你|提醒你|你確認|你安排/.test(text)) return 'delegation';
  if (/#卡點|#blocked|卡住|卡點|無法|不能|問題/.test(text)) return 'blocked';
  if (/#決策|#decision|決定|批准|同意|是否|要不要|是不是|怎麼辦|怎麼處理|需要.*確認/.test(text)) return 'decision';
  if (/#追蹤|#followup|追蹤|提醒|通知|確認一下|再跟|回覆/.test(text)) return 'followup';
  if (/會議|會議記錄|月會|例會|紀錄|討論|結論|行動項目/.test(text)) return 'meeting';
  if (/進度|狀態|目前|本週|今天|看法|想法|策略|方向|下一步/.test(text)) return 'progress';
  if (/#待辦|#todo|請|麻煩|幫我|我要|需要|希望/.test(text)) return 'task';
  return 'note';
}

function inferProject(text, message, category) {
  if (message.conversationProject) return message.conversationProject;

  const rules = [
    ['茲心園工程', /茲心園|改建|營造|工程|工地/],
    ['HOZO 後臺', /HOZO\s*後|HOZO後|後臺|後台|登入頁|CRM/],
    ['包租代管', /包租代管|包租|代管|房客|租客|租屋|出租|招租|好住寓好|HOZO|發黴|浴室|燈光/],
    ['SmartFront / AI Brain', /SmartFront|AI Brain|AI腦|智能前台/],
    ['財務', /財務|付款|匯款|發票|報稅|稅|薪資|銀行/],
    ['財務', /火險|保險|保單|房貸|續保/],
    ['財務', /十幾年.*沒買過|line提醒你|LINE提醒你/],
    ['人資', /人資|招募|面試|員工|同仁|資遣|解僱/],
    ['營運', /營運|月會|例會|流程|SOP|會議|公司助理系統|手機.*會議記錄/],
    ['營運', /不滿|客訴|投訴|抱怨|失望|沒有回報|沒回報|回報進度|抱歉|道歉|安撫|關係修復/],
    ['私人事務', /老婆|太太|媽媽|媽，|家裡|家人|小孩|私人|西周|天才家族/],
  ];

  for (const [project, pattern] of rules) {
    if (pattern.test(text)) return project;
  }

  const conversationName = String(message.conversationName || '');
  if (/西周|天才家族|家族|家庭/.test(conversationName)) return '私人事務';
  if (['health'].includes(category)) return '私人事務';
  if (['insurance', 'finance'].includes(category)) return '財務';
  if (['meeting', 'progress'].includes(category)) return '營運';
  return '未分類';
}

function inferConversationProject(value) {
  const text = String(value || '');
  const rules = [
    ['茲心園工程', /綦盛|恰恰小紅帽|茲心園|D\s*區|J\s*棟|建照|雜照|基地位置圖|營造|工程|工地|估價|設計圖/],
    ['溪頭 / 南投鹿谷旅館投資評估案', /溪頭|鹿谷|夏緹|南投.*旅館|旅館.*投資|Andy/],
    ['包租代管', /包租代管|房客|租客|好住寓好|HOZO|浴室|燈光|發黴/],
    ['人資', /人資|薪資|Bonnie|離職|退保|同仁|104/],
    ['財務', /財務|付款|匯款|發票|股權移轉|報稅|銀行|網銀|火險|保險/],
    ['私人事務', /溪州|媽媽|媽，|天才家族|讀書會/],
  ];

  for (const [project, pattern] of rules) {
    if (pattern.test(text)) return project;
  }
  return '';
}

function inferPriority(text, category, score) {
  if (['health', 'insurance', 'finance', 'customerIssue', 'relationshipIssue', 'blocked'].includes(category)) return '高';
  if (score >= 8) return '高';
  if (['decision', 'delegation', 'followup', 'meeting'].includes(category)) return '中';
  return '低';
}

function inferDueDate(text) {
  const now = new Date();
  if (/今天|今日/.test(text)) return now;
  if (/明天|明日/.test(text)) return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (/週一|星期一|禮拜一/.test(text)) return nextWeekday(now, 1);
  if (/下週|下禮拜/.test(text)) return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(日|號)/);
  if (monthDay) {
    const year = now.getFullYear();
    return new Date(year, Number(monthDay[1]) - 1, Number(monthDay[2]));
  }
  return null;
}

function inferOwner(text) {
  const mention = text.match(/@([^\s，,。]+)/);
  if (mention) return mention[1];
  if (/我.*(確認|處理|聯絡|回覆)|禮拜一.*我/.test(text)) return 'Seven 陳聖文';
  const named = text.match(/(Seven|Bonnie|逸凡|宜穎|嘉娜|Maggie|昱晴|聖文)/i);
  return named ? named[1] : '';
}

function inferNextStep(text, category) {
  if (category === 'health') return '列為私人健康關心事項，確認是否需要回覆、探問狀況或安排後續協助。';
  if (category === 'insurance') return '確認保單/火險/房貸火險是否需要續保、文件、期限與承辦窗口，避免漏保或逾期。';
  if (category === 'finance') return '列為財務/稅務高優先事項，確認責任人、期限、金額或申報資料是否完整。';
  if (category === 'customerIssue') return '整理房客/客戶問題、回覆口徑、修繕責任與下一步，待 Seven 確認。';
  if (category === 'relationshipIssue') return '列為重大關係/客訴事件，確認不滿原因、內部責任人、週一回覆節點與安撫口徑。';
  if (category === 'delegation') return '對方已把事情交給 Seven 或提醒 Seven，需確認是否建立正式待辦與期限。';
  if (category === 'decision') return '保留為待確認決策，請 Seven 確認是否採納與是否需要對外回覆。';
  if (category === 'meeting') return '確認是否有新的會議結論、行動項目或需要同步到總控任務庫的事項。';
  if (category === 'followup') return '建立追蹤項目，確認對象、期限與是否需要由 Seven Jr. 發出提醒。';
  if (category === 'blocked') return '確認卡點原因、責任人與下一步處理方式。';
  if (category === 'done') return '確認是否可以將對應任務標記為完成，或是否還有驗收/回報動作。';
  return '請確認是否成立為正式任務，並補齊負責人與期限。';
}

function shouldCreateProgress(project, category, text) {
  if (project === '未分類') return false;
  if (['customerIssue', 'relationshipIssue', 'meeting', 'progress', 'blocked', 'decision'].includes(category)) return true;
  return /進度|狀態|看法|想法|策略|方向|本週|今天.*安排|回報進度|沒有回報|沒回報/.test(text);
}

function needsSevenDecision(concern) {
  return ['insurance', 'finance', 'customerIssue', 'relationshipIssue', 'decision', 'delegation', 'blocked'].includes(concern.category);
}

function isLowSignal(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 6) return true;
  if (/^\[[a-z]+\]\s*\d+$/i.test(text.trim())) return true;
  if (/^[()a-zA-Z\s]+$/.test(text.trim()) && compact.length < 20) return true;
  const lowSignalTerms = ['辛苦了', '謝謝', '感謝你', '是的，正確', '收到', '了解', 'OK', 'ok', '好', '嗯'];
  return lowSignalTerms.some((term) => compact === term.replace(/\s+/g, ''));
}

function isPureKnowledgeExplanation(text) {
  const value = String(text || '').trim();
  if (value.length < 60) return false;
  if (!/(研究|指出|機制|原理|受體|血清素|諾麗果|萃取物|濃度|功效|如何改善)/.test(value)) return false;
  return !/(請|麻煩|幫我|需要|確認|追蹤|安排|回覆|聯絡|處理|提醒|決定|要不要|是否)/.test(value);
}

function isConversationSetupMessage(text, message = {}) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const contextText = [
    message.conversationDisplayName,
    message.conversationName,
    ...(message.sameConversationContext || []).map((item) => item.text || ''),
    value,
  ].join('\n');

  if (isEngineeringDesignDelivery(value) || extractEngineeringMissingDocs(value).length) {
    return false;
  }

  if (isEngineeringVendorEstimateThread(contextText) && isVendorContactSetup(value)) {
    return true;
  }

  return /謝謝加入群組|在這個群組裡面進行|就在這個群組裡面討論|群組裡面討論/.test(value)
    && !/(請|麻煩|需要|確認|提供|補|回覆|安排|處理).*(資料|文件|時間|期限|回報|估價)/.test(value);
}

function isEngineeringVendorEstimateThread(value) {
  return /綦盛|恰恰小紅帽|茲心園|D\s*區|J\s*棟|設計圖|營造|估價|建照|雜照|基地位置圖/i.test(String(value || ''));
}

function extractEngineeringMissingDocs(text) {
  const value = String(text || '');
  const docs = [
    ['基地位置圖', /基地位置圖|基地.*位置|位置圖/],
    ['建照', /建照|建造執照/],
    ['雜照', /雜照|雜項執照/],
    ['平面圖', /平面圖/],
    ['圖面檔', /CAD|dwg|圖面檔|設計圖檔/],
  ];
  return docs.filter(([, pattern]) => pattern.test(value)).map(([label]) => label);
}

function isEngineeringDesignDelivery(text) {
  const value = String(text || '');
  return /(drive\.google|設計圖|D\s*區|J\s*棟|連結|資料)/i.test(value)
    && /(已經發給|已發給|發給您|提供給|請.*看一下|再看一下|給您)/.test(value);
}

function isVendorContactSetup(text) {
  const value = String(text || '').trim();
  return /^[^\s@]+@[^@\s]+\.[^@\s]+$/.test(value)
    || /提供.*Gmail|Gmail\s*信箱|名片|謝謝加入群組|群組裡面.*討論|麻煩你[.。…]*$/.test(value)
    || /^(ok|OK|好|收到|了解|麻煩你[.。…]*)$/.test(value);
}

function isTextMessageType(value) {
  return ['text', '文字', '文字訊息'].includes(String(value || '').trim().toLowerCase())
    || ['文字', '文字訊息'].includes(String(value || '').trim());
}

function isCommandTriggerMessage(text) {
  return /\b(Seven|Eleven|Elven)\s+(Junior|Jr\.?)\b|\b(7|11)\s*(Junior|Jr\.?)\b/i.test(text);
}

function isOperationalInstructionMessage(text, message = {}) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const actor = String(message.actor || '').trim();
  if (/^Seven\s+Jr\.?$/i.test(actor)) return true;

  const mentionsAssistant = isCommandTriggerMessage(value)
    || /\b(Junior|Jr\.?)\b/i.test(value)
    || /^(助理|AI\s*助理)[,，:：\s]/i.test(value)
    || /ثابت\s*Junior/i.test(value);
  const taskQuery = /(查|查詢|列出|列表|清單|看一下|給我看|幫我看|有哪些|目前|現在|今天|未完成|pending|list|show)/i.test(value)
    && /(待辦|任務|工作|事項|task|todo)/i.test(value);
  const taskOpen = /(打開|開啟|展開|查看|詳細|詳情)/.test(value)
    && /(第\s*[0-9一二三四五六七八九十]+\s*個|[0-9一二三四五六七八九十]+\s*號)/.test(value)
    && /(任務|待辦|工作)?/.test(value);
  const taskListReply = /^Seven\s+Jr\.?\s+幫你查到/.test(value);

  return taskListReply || (mentionsAssistant && (taskQuery || taskOpen));
}

function summarizeText(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 900);
}

function inferBlockerText(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matched = lines.filter((line) => /問題|卡點|無法|不能|發黴|故障|不足|不夠|逾期|頭痛|身體不舒服|到期/.test(line));
  return matched.length ? matched.slice(0, 4).join('\n') : '暫無明確卡點。';
}

function buildTaskName(concern, message) {
  if (concern.nameOverride) return concern.nameOverride;

  const subject = shortSubject(concern.summary);
  if (concern.category === 'health') return `${concern.project}：關心與追蹤健康狀況 - ${subject}`;
  if (concern.category === 'insurance') return `${concern.project}：確認保險/火險續保處理 - ${subject}`;
  if (concern.category === 'finance') return `${concern.project}：確認財務/稅務事項 - ${subject}`;
  if (concern.category === 'customerIssue') return `${concern.project}：處理房客/客戶問題 - ${subject}`;
  if (concern.category === 'relationshipIssue') return `${concern.project}：處理關係/客訴事件 - ${subject}`;
  if (concern.category === 'delegation') return `${concern.project}：確認交由 Seven 處理事項 - ${subject}`;
  if (concern.category === 'meeting') return `${concern.project}：同步會議/討論行動項目 - ${subject}`;
  if (concern.category === 'decision') return `${concern.project}：確認決策 - ${subject}`;
  if (concern.category === 'followup') return `${concern.project}：追蹤 ${subject}`;
  if (concern.category === 'blocked') return `${concern.project}：處理卡點 ${subject}`;
  if (concern.category === 'done') return `${concern.project}：確認完成 ${subject}`;

  const source = cleanHumanLabel(message.conversationDisplayName || message.conversationName);
  const sourcePrefix = source ? `${source}：` : '';
  return `${concern.project}：${sourcePrefix}${subject}`;
}

function shortSubject(text) {
  return text
    .replace(/#\S+/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b[0-9a-f]{32}\b/gi, '')
    .replace(/\b[CUR][0-9a-f]{32}\b/gi, '')
    .replace(/\bline:[^\s，。,.：:]+/gi, '')
    .replace(/同步識別碼：\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^.*?(請|麻煩|幫我|我要|需要|希望|是否|要不要|是不是)/, '$1')
    .trim()
    .slice(0, 34)
    .replace(/[，。,.：:]+$/g, '') || 'LINE 訊息待判斷';
}

function cleanHumanLabel(value) {
  return String(value || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b[0-9a-f]{32}\b/gi, '')
    .replace(/\b[CUR][0-9a-f]{32}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function categoryLabel(category) {
  const labels = {
    health: '健康/家人關心',
    insurance: '保險/火險',
    finance: '財務/稅務',
    customerIssue: '房客/客戶問題',
    relationshipIssue: '關係/客訴事件',
    delegation: '交辦給 Seven',
    blocked: '卡點',
    decision: '決策',
    followup: '追蹤',
    meeting: '會議/討論',
    task: '待辦',
    done: '完成確認',
    progress: '進度',
    note: '重要觀察',
  };
  return labels[category] || category;
}

function nextWeekday(fromDate, weekday) {
  const date = new Date(fromDate);
  const current = date.getDay();
  let offset = (weekday - current + 7) % 7;
  if (offset === 0) offset = 7;
  date.setDate(date.getDate() + offset);
  return date;
}

function buildProgressName(concern, message) {
  const date = formatDateKey(message.time ? new Date(message.time) : new Date());
  const hash = createHash('sha1').update(`${message.id}:${concern.sourceText}`).digest('hex').slice(0, 6);
  return `${date} ${concern.project} LINE 訊息更新 ${hash}`;
}

function buildSyncId(messageId, text) {
  const hash = createHash('sha1')
    .update(`${messageId}:${normalizeKey(text)}`)
    .digest('hex')
    .slice(0, 12);
  return `line:${messageId}:${hash}`;
}

async function findExistingTask(taskName) {
  const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 1, filter: { property: '任務名稱', title: { equals: taskName } } },
  });
  return result.results?.[0] || null;
}

async function findRelatedActiveTask(candidate, message, sameConversationContext) {
  const exact = await findExistingTask(candidate.name);
  if (exact) {
    const normalizedExact = normalizeTaskPage(exact);
    if (isActiveTask(normalizedExact)) return normalizedExact;
  }

  const possibleTasks = await queryRelatedActiveTasks(candidate, message);
  const scored = possibleTasks
    .filter(isActiveTask)
    .map((task) => ({
      task,
      score: scoreTaskMatch(task, candidate, message, sameConversationContext),
    }))
    .filter((item) => item.score >= 28)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.task || null;
}

async function queryRelatedActiveTasks(candidate, message) {
  const filters = [];
  if (candidate.project && candidate.project !== '未分類') {
    filters.push({ property: '專案', select: { equals: candidate.project } });
  }

  for (const keyword of topKeywords(`${candidate.summary} ${candidate.name}`).slice(0, 5)) {
    filters.push({ property: '任務名稱', title: { contains: keyword } });
  }

  const conversationLabel = cleanHumanLabel(message.conversationDisplayName || message.conversationName);
  if (conversationLabel) {
    filters.push({ property: '來源原文', rich_text: { contains: conversationLabel.slice(0, 60) } });
  }

  const pages = [];
  for (const filter of filters.slice(0, 8)) {
    try {
      const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
        method: 'POST',
        body: {
          page_size: 10,
          filter,
          sorts: [{ property: '最後更新', direction: 'descending' }],
        },
      });
      pages.push(...(result.results || []));
    } catch (error) {
      console.warn(`Unable to search active task with one filter: ${error.message}`);
    }
  }

  return uniqueById(pages).map(normalizeTaskPage);
}

function normalizeTaskPage(page) {
  const properties = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    name: textProperty(properties['任務名稱']),
    project: selectName(properties['專案']),
    status: selectName(properties['狀態']),
    sourceText: textProperty(properties['來源原文']),
    judgementSummary: textProperty(properties['Codex 判斷摘要']),
    nextStep: textProperty(properties['下一步']),
    updatedAt: dateValue(properties['最後更新']),
  };
}

function isActiveTask(task) {
  return !/(完成|已完成|封存|已封存|取消|Deprecated|deprecated)/.test(String(task.status || ''));
}

function scoreContextualTaskMatch(task, candidate, message, contextText) {
  const taskText = `${task.name}\n${task.sourceText}\n${task.judgementSummary}\n${task.nextStep}`.toLowerCase();
  const candidateText = `${candidate.name}\n${candidate.summary}\n${candidate.sourceText}`.toLowerCase();
  const conversationText = `${message.conversationDisplayName || ''}\n${message.conversationName || ''}\n${contextText || ''}`.toLowerCase();

  if (candidate.project === '茲心園工程' && isEngineeringVendorEstimateThread(`${candidateText}\n${conversationText}`)) {
    if (/補提供綦盛工程估價所需資料/.test(candidate.name)
      && /補提供綦盛工程估價所需資料/.test(task.name)) {
      return 100;
    }

    if (/再發設計圖給 2-3 家營造廠估價/.test(candidate.name)
      && /再發設計圖給 2-3 家營造廠估價/.test(task.name)) {
      return 100;
    }

    if (/設計圖|drive\.google|d\s*區|j\s*棟/i.test(candidateText)
      && /設計圖|營造廠|估價/.test(taskText)) {
      return 72;
    }

    if (/基地位置圖|建照|雜照|估價所需資料/.test(candidateText)) {
      return /補提供綦盛工程估價所需資料/.test(task.name) ? 90 : 0;
    }
  }

  return 0;
}

function scoreTaskMatch(task, candidate, message, sameConversationContext) {
  if (normalizeKey(task.name) === normalizeKey(candidate.name)) return 100;

  let score = 0;
  if (task.project && candidate.project && task.project === candidate.project) score += 12;

  const taskText = `${task.name}\n${task.sourceText}\n${task.judgementSummary}`.toLowerCase();
  const candidateText = `${candidate.name}\n${candidate.summary}\n${candidate.sourceText}`.toLowerCase();
  const contextText = sameConversationContext.map((item) => item.text || '').join('\n').toLowerCase();
  const conversationLabel = cleanHumanLabel(message.conversationDisplayName || message.conversationName).toLowerCase();

  const requiresContextualMatch = candidate.project === '茲心園工程'
    && isEngineeringVendorEstimateThread(`${candidateText}\n${conversationLabel}\n${contextText}`);
  const contextualScore = scoreContextualTaskMatch(task, candidate, message, contextText);
  if (requiresContextualMatch) return contextualScore;
  if (contextualScore) return contextualScore;

  const candidateKeywords = topKeywords(candidateText).slice(0, 8);
  const overlap = candidateKeywords.filter((keyword) => taskText.includes(keyword.toLowerCase())).length;
  if (overlap < 2) return 0;

  if (conversationLabel && taskText.includes(conversationLabel)) score += 10;
  if (message.actor && taskText.includes(String(message.actor).toLowerCase())) score += 3;
  if (candidate.category && taskText.includes(categoryLabel(candidate.category).toLowerCase())) score += 4;

  score += overlap * 6;

  const contextOverlap = candidateKeywords.filter((keyword) => contextText.includes(keyword.toLowerCase())).length;
  score += Math.min(contextOverlap * 2, 8);

  if (candidate.category === 'done' && /(完成|已處理|處理完)/.test(candidate.sourceText)) score += 10;
  if (candidate.category === 'meeting' && /月會|會議|例會/.test(taskText)) score += 8;
  if (candidate.category === 'health' && /健康|頭痛|血清素|諾麗果|媽媽|媽/.test(taskText)) score += 8;

  return score;
}

async function updateTaskWithEvidence(task, candidate, message, sameConversationContext) {
  if (message.url && task.sourceText.includes(message.url)) {
    return;
  }

  const evidence = buildTaskUpdateEvidence(candidate, message, sameConversationContext);
  const judgement = [
    task.judgementSummary,
    '',
    `任務更新判斷：新 LINE 訊息被判定為既有任務的延伸，不另建新任務。`,
    `更新原因：${candidate.reasons.join('、') || '同對話前後文與活躍任務比對'}`,
  ].filter(Boolean).join('\n');

  await notionRequest(`/v1/pages/${task.id}`, {
    method: 'PATCH',
    body: {
      properties: compactProperties({
        來源原文: richTextProperty(appendEvidence(task.sourceText, evidence), 1900),
        'Codex 判斷摘要': richTextProperty(appendEvidence('', judgement), 1900),
        下一步: richTextProperty(candidate.nextStep, 900),
        最後更新: dateProperty(new Date()),
      }),
    },
  });
}

function buildTaskUpdateEvidence(candidate, message, sameConversationContext) {
  const nearby = sameConversationContext
    .filter((item) => item.id !== message.id)
    .slice(-4)
    .map((item) => `${item.actor || 'unknown'}：${summarizeText(item.text || '').slice(0, 120)}`)
    .join('\n');

  return [
    `LINE 任務更新證據：${new Date().toISOString()}`,
    message.url ? `訊息：${message.url}` : '',
    message.conversationName ? `對話：${message.conversationName}` : '',
    message.actor ? `發話者：${message.actor}` : '',
    `判斷：更新既有任務，不建立新任務。`,
    `新訊息摘要：${candidate.summary}`,
    nearby ? `同對話前後文：\n${nearby}` : '',
  ].filter(Boolean).join('\n');
}

function appendEvidence(existing, addition, maxLength = 1900) {
  const merged = [existing, addition].filter(Boolean).join('\n\n');
  if (merged.length <= maxLength) return merged;
  return `${merged.slice(0, 450)}\n...\n${merged.slice(-(maxLength - 460))}`;
}

function topKeywords(value) {
  const source = String(value || '');
  const words = source
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  const grams = [];
  for (const chunk of source.match(/[\p{Script=Han}]{3,}/gu) || []) {
    for (let index = 0; index < chunk.length - 1 && grams.length < 80; index += 1) {
      grams.push(chunk.slice(index, index + 2));
      if (index < chunk.length - 2) grams.push(chunk.slice(index, index + 3));
    }
  }

  return [...new Set([...words, ...grams])]
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(LINE|Notion|http|https|www|com|tw|任務|確認|處理|追蹤|需要|是否|這個|那個|我們|你們|他們|Seven|Bonnie|營運|人資|財務|私人事務)$/i.test(item));
}

function uniqueById(pages) {
  const seen = new Set();
  return pages.filter((page) => {
    if (!page?.id || seen.has(page.id)) return false;
    seen.add(page.id);
    return true;
  });
}

async function createTask(candidate) {
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: tasksDataSourceId },
      properties: candidate.taskProperties,
    },
  });
}

async function findExistingProgressReport(name) {
  const result = await notionRequest(`/v1/data_sources/${progressReportsDataSourceId}/query`, {
    method: 'POST',
    body: { page_size: 1, filter: { property: '報表名稱', title: { equals: name } } },
  });
  return result.results?.[0] || null;
}

async function createProgressReport(candidate) {
  return notionRequest('/v1/pages', {
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: progressReportsDataSourceId },
      properties: candidate.progressProperties,
    },
  });
}

async function markMessageJudged(message, relatedUrl) {
  const properties = compactProperties({
    已進入判斷層: checkboxProperty(true),
    關聯總控事件: relatedUrl ? urlProperty(relatedUrl) : undefined,
  });

  try {
    await notionRequest(`/v1/pages/${message.id}`, {
      method: 'PATCH',
      body: { properties },
    });
  } catch (error) {
    if (!String(error.message || '').includes('關聯總控事件 is not a property')) throw error;
    await notionRequest(`/v1/pages/${message.id}`, {
      method: 'PATCH',
      body: { properties: { 已進入判斷層: checkboxProperty(true) } },
    });
  }
}

function firstCreatedUrl(result) {
  const task = result.createdTasks.find((item) => item.url);
  if (task?.url) return task.url;
  const progress = result.createdProgressReports.find((item) => item.url);
  return progress?.url || '';
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

    lastError = new Error(`Notion API ${method} ${pathname} failed: ${response.status} ${responseText}`);
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

function textProperty(property) {
  if (!property) return '';
  if (property.type === 'title') return (property.title || []).map((item) => item.plain_text || '').join('');
  if (property.type === 'rich_text') return (property.rich_text || []).map((item) => item.plain_text || '').join('');
  return '';
}

function selectName(property) {
  return property?.type === 'select' ? property.select?.name || '' : '';
}

function dateValue(property) {
  return property?.type === 'date' ? property.date?.start || '' : '';
}

function checkboxValue(property) {
  return property?.type === 'checkbox' ? Boolean(property.checkbox) : false;
}

function relationMentionName(property) {
  if (property?.type !== 'relation') return '';
  return (property.relation || []).map((item) => item.name || item.id || '').filter(Boolean).join('、');
}

function relationId(property) {
  if (property?.type !== 'relation') return '';
  return property.relation?.[0]?.id || '';
}

function titleProperty(value) {
  return { title: [{ type: 'text', text: { content: String(value || '').slice(0, 2000) } }] };
}

function richTextProperty(value, maxLength = 1900) {
  return { rich_text: [{ type: 'text', text: { content: String(value || '').slice(0, maxLength) } }] };
}

function selectProperty(value) {
  const name = String(value || '').trim();
  return name ? { select: { name } } : undefined;
}

function dateProperty(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : { date: { start: date.toISOString() } };
}

function urlProperty(value) {
  return value ? { url: String(value) } : undefined;
}

function checkboxProperty(value) {
  return { checkbox: Boolean(value) };
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
}

function formatDateKey(value) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(value);
}

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
