import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const attachmentsDataSourceId = process.env.SEVEN_ATTACHMENTS_DATA_SOURCE_ID || '';
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

const AUTO_PARSE_LIMIT_BYTES = 5 * 1024 * 1024;
const IMAGE_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);
const APPROVED_HARD_LIMIT_BYTES = 30 * 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const limit = clampNumber(Number(args.limit || 8), 1, 30);
let parsePropertiesEnsured = false;

if (!anthropicApiKey) {
  console.warn('ANTHROPIC_API_KEY is not set. Attachment parsing skipped; items stay queued.');
  process.exit(0);
}
if (!notionToken) fail('NOTION_TOKEN is not set.');
if (!attachmentsDataSourceId) fail('SEVEN_ATTACHMENTS_DATA_SOURCE_ID is not set.');

const anthropic = new Anthropic({ apiKey: anthropicApiKey });
const startedAt = new Date();
await ensureParseProperties();
const queued = await listQueuedAttachments();
const results = [];

for (const attachment of queued) {
  try {
    results.push(await processAttachment(attachment));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Attachment ${attachment.filename} failed: ${message}`);
    if (!dryRun) {
      await markAttachment(attachment.pageId, '解析失敗', `解析失敗：${clampText(message, 500)}`).catch(() => {});
    }
    results.push({ filename: attachment.filename, action: 'failed', error: message });
  }
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  model: anthropicModel,
  scanned: queued.length,
  parsed: results.filter((item) => item.action === 'parsed').length,
  deferred: results.filter((item) => item.action === 'needs-approval').length,
  unsupported: results.filter((item) => item.action === 'unsupported').length,
  failed: results.filter((item) => item.action === 'failed').length,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  results,
}, null, 2));

async function listQueuedAttachments() {
  const result = await notionRequest(`/v1/data_sources/${attachmentsDataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: limit,
      filter: {
        or: [
          { property: '轉檔狀態', select: { equals: '待轉檔' } },
          { property: '轉檔狀態', select: { equals: '已核准解析' } },
        ],
      },
      sorts: [{ property: '建立時間', direction: 'ascending' }],
    },
  });

  return (result.results || []).map((page) => {
    const properties = page.properties || {};
    const fileEntry = (properties['附件檔案']?.files || [])[0];
    return {
      pageId: page.id,
      url: page.url,
      filename: textProperty(properties['檔案名稱']) || textProperty(properties['附件項目']) || '未命名附件',
      attachmentType: properties['附件類型']?.select?.name || '',
      contentType: textProperty(properties['Content-Type']),
      fileSize: properties['檔案大小']?.number || 0,
      conversionStatus: properties['轉檔狀態']?.select?.name || '',
      conversationId: (properties['對話主檔']?.relation || [])[0]?.id || '',
      fileUrl: fileEntry?.file?.url || fileEntry?.external?.url || '',
    };
  });
}

async function processAttachment(attachment) {
  const kind = classifyAttachment(attachment);
  const approved = attachment.conversionStatus === '已核准解析';

  if (kind === 'unsupported') {
    if (!dryRun) await markAttachment(attachment.pageId, '不支援', `此檔案類型（${attachment.contentType || attachment.filename}）目前不在自動解析範圍。`);
    return { filename: attachment.filename, action: 'unsupported' };
  }

  const sizeLimit = kind === 'image' ? IMAGE_LIMIT_BYTES : AUTO_PARSE_LIMIT_BYTES;
  if (!approved && attachment.fileSize > sizeLimit) {
    if (!dryRun) await markAttachment(attachment.pageId, '待確認', `檔案 ${formatBytes(attachment.fileSize)} 超過自動解析上限（${formatBytes(sizeLimit)}），請在報告頁確認是否解析。`);
    return { filename: attachment.filename, action: 'needs-approval', size: attachment.fileSize };
  }
  if (attachment.fileSize > APPROVED_HARD_LIMIT_BYTES) {
    if (!dryRun) await markAttachment(attachment.pageId, '解析失敗', `檔案 ${formatBytes(attachment.fileSize)} 超過解析硬上限（30MB）。`);
    return { filename: attachment.filename, action: 'failed', error: 'over hard limit' };
  }
  if (!attachment.fileUrl) {
    if (!dryRun) await markAttachment(attachment.pageId, '解析失敗', '附件頁面上找不到檔案連結。');
    return { filename: attachment.filename, action: 'failed', error: 'no file url' };
  }

  if (dryRun) {
    return { filename: attachment.filename, action: 'parsed', kind, dryRun: true };
  }

  const buffer = await downloadFile(attachment.fileUrl);
  const analysis = await analyzeAttachment(kind, attachment, buffer);

  await writeParseResult(attachment, kind, analysis);
  await appendSummaryToConversation(attachment, analysis);

  return { filename: attachment.filename, action: 'parsed', kind, summary: clampText(analysis.summary, 120) };
}

function classifyAttachment(attachment) {
  const name = attachment.filename.toLowerCase();
  const contentType = (attachment.contentType || '').toLowerCase();
  if (attachment.attachmentType === '圖片' || contentType.startsWith('image/')) return 'image';
  if (name.endsWith('.pdf') || contentType.includes('pdf')) return 'pdf';
  if (name.endsWith('.docx') || contentType.includes('wordprocessingml')) return 'docx';
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || contentType.includes('spreadsheetml') || contentType.includes('ms-excel')) return 'xlsx';
  if (name.endsWith('.pptx') || contentType.includes('presentationml')) return 'pptx';
  return 'unsupported';
}

async function downloadFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`File download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function analyzeAttachment(kind, attachment, buffer) {
  if (kind === 'image') {
    const mediaType = normalizeImageMediaType(attachment.contentType);
    return callClaude([
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
      { type: 'text', text: '這是 LINE 群組訊息中的附件圖片。請解析它的內容。' },
    ]);
  }

  if (kind === 'pdf') {
    return callClaude([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: `這是 LINE 群組訊息中的 PDF 附件「${attachment.filename}」。請解析它的內容。` },
    ]);
  }

  const text = await extractOfficeText(kind, buffer);
  if (!text.trim()) {
    throw new Error('Office 檔案抽不出文字內容。');
  }
  return callClaude([
    { type: 'text', text: `這是 LINE 群組訊息中的 ${kind} 附件「${attachment.filename}」，以下是抽取出的文字內容：\n\n${clampText(text, 30000)}` },
  ]);
}

async function extractOfficeText(kind, buffer) {
  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }

  if (kind === 'xlsx') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts = [];
    for (const sheetName of workbook.SheetNames.slice(0, 10)) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      parts.push(`=== 工作表：${sheetName} ===\n${clampText(csv, 8000)}`);
    }
    return parts.join('\n\n');
  }

  if (kind === 'pptx') {
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const parts = [];
    for (const name of slideNames.slice(0, 50)) {
      const xml = await zip.files[name].async('string');
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]).filter(Boolean);
      if (texts.length) parts.push(`【第 ${name.match(/\d+/)[0]} 頁】${texts.join(' ')}`);
    }
    return parts.join('\n');
  }

  return '';
}

async function callClaude(content) {
  const response = await anthropic.messages.create({
    model: anthropicModel,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: [
          '你是 SevenAM 控制中心的附件解析引擎。附件來自工程、財務、營運相關的 LINE 群組。',
          '解析目標：讓任務判讀引擎和使用者快速理解這份附件「在講什麼、跟哪些工作有關」。',
          '- summary：2-4 句語意摘要（繁體中文），講清楚這是什麼、關鍵內容、與工作的關聯。',
          '- extractedText：圖片做完整 OCR；文件列出關鍵段落與數字。保留金額、日期、人名、項目名稱等可查證細節。',
          '- workSignals：列出與任務相關的訊號（完工回報、報價金額、期限、待辦、問題回報），沒有就空陣列。',
          '- sensitive：內容涉及金錢、合約、法律、人資、個資時為 true。',
        ].join('\n'),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['summary', 'extractedText', 'workSignals', 'sensitive'],
          properties: {
            summary: { type: 'string' },
            extractedText: { type: 'string' },
            workSignals: { type: 'array', items: { type: 'string' } },
            sensitive: { type: 'boolean' },
          },
        },
      },
    },
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error(`Claude response has no text block (stop_reason: ${response.stop_reason}).`);
  }
  return JSON.parse(textBlock.text);
}

function normalizeImageMediaType(contentType) {
  const type = (contentType || '').toLowerCase();
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) return type;
  if (type.includes('jpg') || type.includes('jpeg')) return 'image/jpeg';
  if (type.includes('png')) return 'image/png';
  return 'image/jpeg';
}

async function writeParseResult(attachment, kind, analysis) {
  const timestamp = formatTaipeiDateTime(new Date());
  await notionRequest(`/v1/blocks/${attachment.pageId}/children`, {
    method: 'PATCH',
    body: {
      children: [
        heading2(`解析結果（${timestamp}）`),
        paragraph(`摘要：${analysis.summary || '無'}`),
        ...(analysis.workSignals?.length ? [paragraph(`工作訊號：${analysis.workSignals.join('；')}`)] : []),
        ...(analysis.sensitive ? [paragraph('⚠️ 內容涉及敏感資訊（金錢／合約／法律／人資／個資）。')] : []),
        heading3('解析內文'),
        ...splitIntoParagraphBlocks(analysis.extractedText || '（無文字內容）'),
      ],
    },
  });

  await ensureParseProperties();
  await notionRequest(`/v1/pages/${attachment.pageId}`, {
    method: 'PATCH',
    body: {
      properties: compactProperties({
        轉檔狀態: { select: { name: '已解析' } },
        解析摘要: richTextProperty(analysis.summary || ''),
        解析時間: { date: { start: new Date().toISOString() } },
      }),
    },
  });
}

async function appendSummaryToConversation(attachment, analysis) {
  if (!attachment.conversationId) return;
  try {
    const anchor = await findConversationAnchor(attachment.conversationId);
    const timeText = formatTaipeiDateTime(new Date());
    // 格式與 LINE 訊息一致，讓每小時的任務判讀把解析摘要當成時間軸內容讀進去。
    const children = [
      paragraph(`【${timeText}】附件解析：${clampText(attachment.filename, 80)}`),
      paragraph(clampText(`${analysis.summary}${analysis.workSignals?.length ? `（工作訊號：${analysis.workSignals.join('；')}）` : ''}`, 1800)),
    ];
    const body = anchor ? { children, after: anchor } : { children };
    await notionRequest(`/v1/blocks/${attachment.conversationId}/children`, { method: 'PATCH', body });
  } catch (error) {
    console.warn(`Unable to append parse summary to conversation for ${attachment.filename}: ${error.message}`);
  }
}

async function findConversationAnchor(conversationId) {
  const result = await notionRequest(`/v1/blocks/${conversationId}/children?page_size=50`, { method: 'GET' });
  for (const block of result.results || []) {
    const data = block[block.type] || {};
    const text = (data.rich_text || []).map((item) => item.plain_text || '').join('');
    if (text.includes('LINE 對話記錄')) return block.id;
  }
  return '';
}

async function markAttachment(pageId, status, note) {
  await ensureParseProperties();
  await notionRequest(`/v1/pages/${pageId}`, {
    method: 'PATCH',
    body: {
      properties: compactProperties({
        轉檔狀態: { select: { name: status } },
        解析摘要: note ? richTextProperty(note) : undefined,
        解析時間: { date: { start: new Date().toISOString() } },
      }),
    },
  });
}

async function ensureParseProperties() {
  if (parsePropertiesEnsured) return;
  try {
    // Select filters reject unknown options, so register the full parsing
    // status vocabulary before querying (existing options are preserved).
    const dataSource = await notionRequest(`/v1/data_sources/${attachmentsDataSourceId}`, { method: 'GET' });
    const existingOptions = (dataSource.properties?.['轉檔狀態']?.select?.options || []).map((option) => option.name);
    const wanted = ['待轉檔', '待確認', '已核准解析', '已解析', '確定不解析', '不支援', '解析失敗'];
    const merged = [...new Set([...existingOptions, ...wanted])].map((name) => ({ name }));

    await notionRequest(`/v1/data_sources/${attachmentsDataSourceId}`, {
      method: 'PATCH',
      body: {
        properties: {
          轉檔狀態: { select: { options: merged } },
          解析摘要: { rich_text: {} },
          解析時間: { date: {} },
        },
      },
    });
    parsePropertiesEnsured = true;
  } catch (error) {
    console.warn(`Unable to ensure parse properties: ${error.message}`);
  }
}

// ---- Notion helpers ----

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

    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 400)}`);
    if (![409, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
      throw lastError;
    }
    await delay(attempt * 1000);
  }
  throw lastError;
}

function textProperty(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

function richTextProperty(content, maxLength = 1900) {
  return { rich_text: [{ type: 'text', text: { content: clampText(content, maxLength) } }] };
}

function compactProperties(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
}

function heading2(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: clampText(text, 1900) } }] } };
}

function heading3(text) {
  return { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: clampText(text, 1900) } }] } };
}

function paragraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: clampText(text, 1900) } }] } };
}

function splitIntoParagraphBlocks(text) {
  const value = String(text || '').trim();
  const blocks = [];
  for (let index = 0; index < value.length && blocks.length < 20; index += 1800) {
    blocks.push(paragraph(value.slice(index, index + 1800)));
  }
  return blocks.length ? blocks : [paragraph('（無文字內容）')];
}

// ---- utilities ----

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

function formatBytes(bytes) {
  if (!bytes) return '0B';
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
  return `${Math.round(bytes / 1024)}KB`;
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
  }).format(value);
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
