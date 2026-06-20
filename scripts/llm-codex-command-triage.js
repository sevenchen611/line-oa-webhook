import { existsSync, readFileSync } from 'node:fs';
import { createLlmBackend } from '../src/llm-backend.js';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const commandsDataSourceId = process.env.SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID || '';
const controlLinePushUrl = process.env.CONTROL_LINE_PUSH_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/line/push';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY || '';
const controllerUserId = process.env.SEVEN_CONTROLLER_USER_ID || 'U09dc6553016c78d89c515522be9b74f6';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const replyEnabled = Boolean(args.reply);
const limit = clampNumber(Number(args.limit || 10), 1, 50);

const anthropic = createLlmBackend();

if (!anthropic.available) {
  console.warn('LLM backend is not available. Codex command triage is skipped; commands stay Pending.');
  process.exit(0);
}
if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!commandsDataSourceId) fail('SEVEN_CODEX_COMMANDS_DATA_SOURCE_ID is not set.');
const startedAt = new Date();
const pending = await listPendingCommands();
const results = [];

for (const command of pending) {
  try {
    results.push(await triageCommand(command));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Command ${command.pageId} triage failed: ${message}`);
    if (!dryRun) {
      await markCommand(command.pageId, 'Pending', `分流失敗，保留待處理：${clampText(message, 500)}`).catch(() => {});
    }
    results.push({ pageId: command.pageId, action: 'failed', error: message });
  }
}

console.log(JSON.stringify({
  ok: true,
  engine: 'claude-llm',
  backend: anthropic.name,
  model: anthropic.model,
  replyEnabled,
  dryRun,
  scannedCommands: pending.length,
  done: results.filter((item) => item.action === 'done').length,
  needsConfirmation: results.filter((item) => item.action === 'needs-confirmation').length,
  failed: results.filter((item) => item.action === 'failed').length,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  results,
}, null, 2));

async function triageCommand(command) {
  const triage = await runTriage(command);

  const resultText = [
    `AI 分流（${anthropic.model}）`,
    `風險等級：${triage.riskLevel}`,
    `分類：${triage.category}`,
    '',
    `分析：${triage.analysis}`,
    triage.proposedAction ? `\n建議行動：${triage.proposedAction}` : '',
    triage.draftReply ? `\n建議回覆草稿：${triage.draftReply}` : '',
  ].filter(Boolean).join('\n');

  if (dryRun) {
    return { pageId: command.pageId, action: 'dry-run', riskLevel: triage.riskLevel };
  }

  if (triage.requiresUserConfirmation) {
    await markCommand(command.pageId, 'Needs Confirmation', resultText);
    await maybeReply(command, [
      `收到指令：「${clampText(command.command || command.originalText, 60)}」`,
      '這個指令需要你確認才能執行。',
      `分析：${clampText(triage.analysis, 400)}`,
      triage.proposedAction ? `建議行動：${clampText(triage.proposedAction, 300)}` : '',
    ].filter(Boolean).join('\n'));
    return { pageId: command.pageId, command: command.command, action: 'needs-confirmation', riskLevel: triage.riskLevel };
  }

  await markCommand(command.pageId, 'Done', resultText);
  await maybeReply(command, clampText(triage.analysis, 1800));
  return { pageId: command.pageId, command: command.command, action: 'done', riskLevel: triage.riskLevel };
}

async function maybeReply(command, text) {
  if (!replyEnabled || dryRun || !text) return;
  if (!controlApiKey) {
    console.warn('SEVEN_CONTROL_API_KEY is not set; instant reply skipped.');
    return;
  }
  // 只回答 controller 本人下的指令，避免把分析結果推進群組（資料外洩防線）。
  if (command.userId !== controllerUserId) {
    console.warn(`Instant reply skipped for non-controller command from ${command.actorName || command.userId || 'unknown'}.`);
    return;
  }
  const targetId = command.sourceId || command.userId;
  if (!targetId) return;

  try {
    const body = JSON.stringify({
      targets: [{ id: targetId, type: command.sourceType || 'user' }],
      text,
    });
    const response = await fetch(controlLinePushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-seven-control-key': controlApiKey,
      },
      body: Buffer.from(body, 'utf8'),
    });
    if (!response.ok) {
      console.warn(`Instant reply push failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
  } catch (error) {
    console.warn(`Instant reply push failed: ${error.message}`);
  }
}

async function runTriage(command) {
  return anthropic.completeJson({
    maxTokens: 8000,
    system: [
          '你是 SevenAM（Seven Assistant Manager）的指令分流助理。使用者透過 LINE 對 Seven Jr. 下達指令，這些指令進入佇列等待處理。',
          '你的工作：分析每個指令，能直接回答的分析、整理、摘要類指令就直接給出完整答案；需要實際執行動作或屬於敏感事項的，標記為需要使用者確認並提出具體的執行計畫。',
          '',
          '專案討論模式：',
          '- 當指令是在 Seven Junior / SevenAM / LINE OA / Notion / 任務判斷 / 自動通知 / Computer Use / 專案設計等主題上提問時，請把它視為 SevenAM 專案設計討論，而不是一般常識問答。',
          '- 回答時必須先對齊本專案現況：SevenAM 已有 LINE OA webhook、Notion 指令佇列、local worker、Control API、LINE push、報告確認頁、任務與通知排程；不要忽略現有架構。',
          '- 如果使用者問「能不能用 Computer Use 操作 LINE 發訊息」，正確方向是：技術上可作為人工備援或一次性輔助，但正式產品流程應優先使用既有 LINE OA Messaging API / Control API / 通知候選佇列與核准頁，因為它可稽核、可權限控管、可避免誤點 UI 發錯人。',
          '- 若現有 LINE OA 訊息額度、Google token、worker、API 權限等可能影響答案，請明確指出這是目前限制，不要只給通用建議。',
          '- 不要建議已不適合本專案長期採用的旁路方案（例如用桌面 UI 取代正式 API、自行用個人 LINE 模擬機器人）作為主方案；可以列為臨時備援，但要說明風險。',
          '- 使用者正在討論系統設計時，不要回答成「我沒有任務資料來源」；應基於 SevenAM 的既有 Notion/LINE 架構提出可落地的設計建議，除非該指令真的要求即時查某筆資料。',
          '',
          '判斷規則：',
          '- 涉及金錢、投資、合約、法律、稅務、人資、對外承諾、發送訊息給其他人的指令：requiresUserConfirmation 必須為 true，riskLevel 為「高」。',
          '- 需要實際操作外部系統（發 LINE 訊息、改資料、刪除東西）的指令：requiresUserConfirmation 為 true。',
          '- 純粹的分析、解釋、摘要、建議類指令：直接在 analysis 給出完整、可直接使用的答案，requiresUserConfirmation 為 false。',
          '- 指令內容不明確、無法理解時：requiresUserConfirmation 為 true，在 analysis 說明需要使用者補充什麼。',
          '- 一律使用繁體中文回答。',
    ].join('\n'),
    userContent: [
      {
        type: 'text',
        text: [
          `指令時間：${command.receivedAt || '未知'}`,
          `來源對話：${command.conversationName || '未知'}`,
          `發話者：${command.actorName || '未知'}`,
          `風險預判：${command.riskLevel || '未標記'}`,
          '',
          '## 指令內容',
          command.command || command.originalText || '（空白）',
          '',
          '## 原始訊息全文',
          command.originalText || '（無）',
        ].join('\n'),
      },
    ],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['riskLevel', 'category', 'requiresUserConfirmation', 'analysis', 'proposedAction', 'draftReply'],
      properties: {
        riskLevel: { type: 'string', enum: ['低', '中', '高'] },
        category: { type: 'string', description: '指令類型，例如：分析、摘要、任務操作、訊息發送、財務、其他。' },
        requiresUserConfirmation: { type: 'boolean' },
        analysis: { type: 'string', description: '對指令的完整分析或直接答覆。' },
        proposedAction: { type: 'string', description: '需要確認時的具體執行計畫，否則填空字串。' },
        draftReply: { type: 'string', description: '如果指令需要回覆某人，提供回覆草稿，否則填空字串。' },
      },
    },
  });
}

async function listPendingCommands() {
  const result = await notionRequest(`/v1/data_sources/${commandsDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: limit,
      filter: { property: 'Status', select: { equals: 'Pending' } },
      sorts: [{ property: 'Received At', direction: 'ascending' }],
    },
  });

  return (result.results || []).map((page) => {
    const properties = page.properties || {};
    return {
      pageId: page.id,
      command: getText(properties.Command),
      originalText: getText(properties['Original Text']),
      conversationName: getText(properties['Conversation Name']),
      actorName: getText(properties['Actor Name']),
      riskLevel: properties['Risk Level']?.select?.name || '',
      receivedAt: properties['Received At']?.date?.start || '',
      sourceType: properties['Source Type']?.select?.name || 'user',
      sourceId: getText(properties['Source ID']),
      userId: getText(properties['User ID']),
    };
  });
}

async function markCommand(pageId, status, resultText) {
  const properties = {
    Status: { select: { name: status } },
    Result: { rich_text: [{ type: 'text', text: { content: clampText(resultText, 1900) } }] },
  };
  return notionRequest(`/v1/pages/${pageId}`, { method: 'PATCH', body: { properties } });
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

    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 500)}`);
    if (![409, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
      throw lastError;
    }
    await delay(attempt * 1000);
  }
  throw lastError;
}

function getText(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clampText(value, maxLength) {
  const text = value == null ? '' : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvFile(pathname) {
  if (!existsSync(pathname)) return;
  const envFile = readFileSync(pathname, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
