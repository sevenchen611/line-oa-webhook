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
  const results = [];

  for (const message of messages) {
    results.push(await processMessage(message));
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    includeOutgoing,
    includeOutgoingGroups,
    reprocess,
    sinceHours,
    scannedMessages: messages.length,
    createdTasks: results.reduce((count, item) => count + item.createdTasks.filter((task) => task.action === 'created').length, 0),
    createdProgressReports: results.reduce((count, item) => count + item.createdProgressReports.filter((report) => report.action === 'created').length, 0),
    importantMessages: results.filter((item) => item.importanceScore > 0).length,
    markedJudged: results.filter((item) => item.markedJudged).length,
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
  const project = selectName(page.properties?.['總控專案']);
  const name = textProperty(page.properties?.['LINE 對話名稱']) || textProperty(page.properties?.['自定義名稱']);
  const value = { project, name };
  conversationProjectCache.set(pageId, value);
  return value;
}

async function processMessage(message) {
  const analysis = analyzeMessage(message);
  const result = {
    messageId: message.messageId,
    messagePageId: message.id,
    time: message.time,
    actor: message.actor,
    conversation: message.conversationName,
    action: analysis.action,
    importanceScore: analysis.importanceScore,
    importanceReasons: analysis.importanceReasons,
    candidates: analysis.candidates.map((candidate) => ({
      name: candidate.name,
      project: candidate.project,
      category: candidate.category,
      priority: candidate.priority,
    })),
    createdTasks: [],
    createdProgressReports: [],
    markedJudged: false,
  };

  for (const candidate of analysis.candidates) {
    const existing = await findExistingTask(candidate.name);
    if (existing) {
      result.createdTasks.push({ action: 'skipped-duplicate', pageId: existing.id, url: existing.url, name: candidate.name });
    } else if (dryRun) {
      result.createdTasks.push({ action: 'dry-run', name: candidate.name, properties: candidate.taskProperties });
    } else {
      const created = await createTask(candidate);
      result.createdTasks.push({ action: 'created', pageId: created.id, url: created.url, name: candidate.name });
    }

    if (candidate.progressProperties) {
      const existingProgress = await findExistingProgressReport(candidate.progressName);
      if (existingProgress) {
        result.createdProgressReports.push({ action: 'skipped-duplicate', pageId: existingProgress.id, url: existingProgress.url, name: candidate.progressName });
      } else if (dryRun) {
        result.createdProgressReports.push({ action: 'dry-run', name: candidate.progressName, properties: candidate.progressProperties });
      } else {
        const createdProgress = await createProgressReport(candidate);
        result.createdProgressReports.push({ action: 'created', pageId: createdProgress.id, url: createdProgress.url, name: candidate.progressName });
      }
    }
  }

  if (!dryRun && (!message.judged || reprocess)) {
    await markMessageJudged(message, firstCreatedUrl(result));
    result.markedJudged = true;
  }

  return result;
}

function analyzeMessage(message) {
  const text = String(message.text || '').trim();
  if (!text || !isTextMessageType(message.type)) {
    return emptyAnalysis('non-text-or-empty');
  }

  if (isCommandTriggerMessage(text)) {
    return emptyAnalysis('command-trigger-message');
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
    action: reason === 'low-signal-message' ? 'ignored' : 'skipped',
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

  if (importance.score <= 0 && category === 'note') return null;

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

function isTextMessageType(value) {
  return ['text', '文字', '文字訊息'].includes(String(value || '').trim().toLowerCase())
    || ['文字', '文字訊息'].includes(String(value || '').trim());
}

function isCommandTriggerMessage(text) {
  return /\b(Seven|Eleven|Elven)\s+(Junior|Jr\.?)\b|\b(7|11)\s*(Junior|Jr\.?)\b/i.test(text);
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
  if (concern.category === 'health') return `${concern.project}：關心與追蹤健康狀況 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'insurance') return `${concern.project}：確認保險/火險續保處理 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'finance') return `${concern.project}：確認財務/稅務事項 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'customerIssue') return `${concern.project}：處理房客/客戶問題 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'relationshipIssue') return `${concern.project}：處理關係/客訴事件 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'delegation') return `${concern.project}：確認交由 Seven 處理事項 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'meeting') return `${concern.project}：同步會議/討論行動項目 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'decision') return `${concern.project}：確認決策 - ${shortSubject(concern.summary)}`;
  if (concern.category === 'followup') return `${concern.project}：追蹤 ${shortSubject(concern.summary)}`;
  if (concern.category === 'blocked') return `${concern.project}：處理卡點 ${shortSubject(concern.summary)}`;
  if (concern.category === 'done') return `${concern.project}：確認完成 ${shortSubject(concern.summary)}`;

  const source = message.conversationName ? `${message.conversationName} ` : '';
  return `${concern.project}：判斷 ${source}${shortSubject(concern.summary)}`;
}

function shortSubject(text) {
  return text
    .replace(/#\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^.*?(請|麻煩|幫我|我要|需要|希望|是否|要不要|是不是)/, '$1')
    .trim()
    .slice(0, 34)
    .replace(/[，。,.：:]+$/g, '') || 'LINE 訊息待判斷';
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
  await notionRequest(`/v1/pages/${message.id}`, {
    method: 'PATCH',
    body: {
      properties: compactProperties({
        已進入判斷層: checkboxProperty(true),
        關聯總控事件: relatedUrl ? urlProperty(relatedUrl) : undefined,
      }),
    },
  });
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
