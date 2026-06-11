// Server-rendered task review pages for the daily / follow-up reports.
// Replaces the static prototype content with live pending tasks from Notion.

export async function renderTaskReviewPage({ reportType, title, subtitle }) {
  const pendingTasks = await queryPendingTasks();
  const mergeTargets = await queryMergeTargetTitles();
  return buildHtml({ reportType, title, subtitle, pendingTasks, mergeTargets });
}

async function queryPendingTasks() {
  const tasksDataSourceId = requiredEnv('SEVEN_TASKS_DATA_SOURCE_ID');
  const pages = [];
  let startCursor;
  do {
    const body = {
      page_size: 100,
      filter: {
        and: [
          { property: '確認狀態', select: { equals: '未確認' } },
          { property: '狀態', select: { does_not_equal: '封存' } },
          { property: '狀態', select: { does_not_equal: '已完成' } },
        ],
      },
      sorts: [
        { property: '優先級', direction: 'ascending' },
        { property: '最後更新', direction: 'descending' },
      ],
    };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, { method: 'POST', body });
    pages.push(...(result.results || []));
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor && pages.length < 200);

  return pages.map((page) => {
    const properties = page.properties || {};
    return {
      title: textProperty(properties['任務名稱']),
      project: selectName(properties['專案']) || '未分類',
      status: selectName(properties['狀態']),
      priority: selectName(properties['優先級']),
      confidence: selectName(properties['信心等級']),
      owner: textProperty(properties['負責人']),
      dueDate: properties['截止日']?.date?.start || '',
      summary: textProperty(properties['Codex 判斷摘要']),
      sourceText: textProperty(properties['來源原文']),
      url: page.url,
    };
  }).filter((task) => task.title);
}

async function queryMergeTargetTitles() {
  const tasksDataSourceId = requiredEnv('SEVEN_TASKS_DATA_SOURCE_ID');
  try {
    const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: 100,
        filter: {
          and: [
            { property: '狀態', select: { does_not_equal: '封存' } },
            { property: '狀態', select: { does_not_equal: '已完成' } },
          ],
        },
        sorts: [{ property: '最後更新', direction: 'descending' }],
      },
    });
    return (result.results || [])
      .map((page) => textProperty(page.properties?.['任務名稱']))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildHtml({ reportType, title, subtitle, pendingTasks, mergeTargets }) {
  const generatedAt = formatTaipeiDateTime(new Date());
  const byProject = new Map();
  for (const task of pendingTasks) {
    if (!byProject.has(task.project)) byProject.set(task.project, []);
    byProject.get(task.project).push(task);
  }

  const sections = [...byProject.entries()].map(([project, tasks]) => `
    <section class="project-group">
      <h2>${escapeHtml(project)}（${tasks.length}）</h2>
      ${tasks.map((task, index) => taskCard(task, `${escapeHtml(project)}-${index}`)).join('\n')}
    </section>
  `).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif; background: #f4f5f7; color: #1f2933; }
  .wrap { max-width: 760px; margin: 0 auto; }
  header { margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #52606d; font-size: 13px; }
  .project-group h2 { font-size: 15px; margin: 20px 0 8px; color: #334e68; border-left: 4px solid #2f80ed; padding-left: 8px; }
  .card { background: #fff; border: 1px solid #e0e4e8; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .card h3 { font-size: 15px; margin: 0 0 6px; line-height: 1.45; }
  .card h3 a { color: inherit; text-decoration: none; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2f6; color: #3e4c59; }
  .badge.priority-high { background: #ffe3e3; color: #c92a2a; }
  .badge.confidence-high { background: #d3f9d8; color: #2b8a3e; }
  .badge.confidence-low { background: #fff3bf; color: #e67700; }
  details { margin: 6px 0; }
  details summary { font-size: 12px; color: #2f80ed; cursor: pointer; }
  details pre { white-space: pre-wrap; font-size: 12px; color: #3e4c59; background: #f8f9fa; border-radius: 6px; padding: 8px; margin: 6px 0 0; }
  .verdict-row { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  select.verdict, input.merge-target { width: 100%; font-size: 15px; padding: 10px; border: 1px solid #cbd2d9; border-radius: 8px; background: #fff; }
  input.merge-target { display: none; }
  .footer { position: sticky; bottom: 0; background: #f4f5f7; padding: 12px 0 4px; }
  textarea.notes { width: 100%; min-height: 60px; font-size: 14px; padding: 10px; border: 1px solid #cbd2d9; border-radius: 8px; margin-bottom: 8px; }
  button.submit { width: 100%; font-size: 16px; font-weight: 700; padding: 14px; border: 0; border-radius: 10px; background: #2f80ed; color: #fff; cursor: pointer; }
  button.submit:disabled { background: #9aa5b1; }
  .banner { padding: 12px; border-radius: 8px; margin-bottom: 10px; font-size: 14px; display: none; }
  .banner.ok { background: #d3f9d8; color: #2b8a3e; display: block; }
  .banner.err { background: #ffe3e3; color: #c92a2a; display: block; }
  .empty { background: #fff; border: 1px dashed #cbd2d9; border-radius: 10px; padding: 28px; text-align: center; color: #52606d; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(subtitle || '')}　產生時間：${escapeHtml(generatedAt)}　待裁決：${pendingTasks.length} 筆</div>
    <div class="meta">裁決說明：確認成立 → 已確認；不成立 → 封存；重複 → 合併到既有任務。送出後本頁會自動更新，已裁決項目不再出現。</div>
  </header>
  <div id="banner" class="banner"></div>
  ${pendingTasks.length === 0 ? '<div class="empty">🎉 目前沒有待裁決的任務。所有萃取結果都已確認完畢。</div>' : sections}
  <datalist id="merge-targets">
    ${mergeTargets.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('\n')}
  </datalist>
  ${pendingTasks.length === 0 ? '' : `
  <div class="footer">
    <textarea id="notes" class="notes" placeholder="（選填）整體備註，會寫入決策紀錄"></textarea>
    <button id="submit" class="submit">送出裁決</button>
  </div>`}
</div>
<script>
const REPORT_TYPE = ${JSON.stringify(reportType)};
const APPROVAL_API = '/control/reports/approve';
const APPROVAL_KEY_STORAGE = 'seven-approval-key';

const urlKey = new URLSearchParams(location.search).get('key');
if (urlKey) localStorage.setItem(APPROVAL_KEY_STORAGE, urlKey);

document.querySelectorAll('select.verdict').forEach((select) => {
  select.addEventListener('change', () => {
    const mergeInput = select.closest('.card').querySelector('input.merge-target');
    mergeInput.style.display = select.value === '__merge__' ? 'block' : 'none';
  });
});

const submitButton = document.getElementById('submit');
if (submitButton) submitButton.addEventListener('click', async () => {
  const banner = document.getElementById('banner');
  const tasks = [];
  let invalid = '';

  document.querySelectorAll('.card').forEach((card) => {
    const select = card.querySelector('select.verdict');
    const taskName = card.dataset.task;
    if (!select || select.value === 'keep') return;
    if (select.value === '__merge__') {
      const mergeInto = card.querySelector('input.merge-target').value.trim();
      if (!mergeInto) { invalid = taskName; return; }
      tasks.push({ task: taskName, actionKey: 'MERGE_INTO_EXISTING', mergeInto, status: '封存' });
    } else {
      tasks.push({ task: taskName, status: select.value });
    }
  });

  if (invalid) {
    banner.className = 'banner err';
    banner.textContent = '「' + invalid + '」選了合併，但還沒輸入要合併到哪個任務。';
    return;
  }
  if (tasks.length === 0) {
    banner.className = 'banner err';
    banner.textContent = '還沒有任何裁決（全部都是「保留未確認」）。';
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = '送出中…（' + tasks.length + ' 筆）';
  try {
    const response = await fetch(APPROVAL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportType: REPORT_TYPE,
        approvedBy: 'Seven 陳聖文',
        approvalKey: localStorage.getItem(APPROVAL_KEY_STORAGE) || '',
        tasks,
        notes: (document.getElementById('notes') || {}).value || '',
      }),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || ('HTTP ' + response.status));
    banner.className = 'banner ok';
    banner.textContent = '✅ 已送出 ' + tasks.length + ' 筆裁決並寫入 Notion。頁面即將更新…';
    setTimeout(() => location.reload(), 2000);
  } catch (error) {
    banner.className = 'banner err';
    banner.textContent = '送出失敗：' + error.message;
    submitButton.disabled = false;
    submitButton.textContent = '送出裁決';
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
</script>
</body>
</html>`;
}

function taskCard(task, cardId) {
  const badges = [
    task.priority ? `<span class="badge ${task.priority === '高' ? 'priority-high' : ''}">優先級 ${escapeHtml(task.priority)}</span>` : '',
    task.confidence ? `<span class="badge ${task.confidence === '高' ? 'confidence-high' : task.confidence === '低' ? 'confidence-low' : ''}">信心 ${escapeHtml(task.confidence)}</span>` : '',
    task.owner ? `<span class="badge">負責人 ${escapeHtml(task.owner)}</span>` : '',
    task.dueDate ? `<span class="badge">截止 ${escapeHtml(task.dueDate.slice(0, 10))}</span>` : '',
    task.status ? `<span class="badge">狀態 ${escapeHtml(task.status)}</span>` : '',
  ].filter(Boolean).join('');

  return `
  <div class="card" data-task="${escapeHtml(task.title)}" id="card-${cardId}">
    <h3><a href="${escapeHtml(task.url)}" target="_blank" rel="noopener">${escapeHtml(task.title)}</a></h3>
    <div class="badges">${badges}</div>
    ${task.summary ? `<details><summary>AI 判斷摘要</summary><pre>${escapeHtml(task.summary)}</pre></details>` : ''}
    ${task.sourceText ? `<details><summary>來源原文</summary><pre>${escapeHtml(task.sourceText)}</pre></details>` : ''}
    <div class="verdict-row">
      <select class="verdict">
        <option value="keep" selected>保留未確認（下次再裁決）</option>
        <option value="未開始">✅ 確認成立：未開始</option>
        <option value="進行中">✅ 確認成立：進行中</option>
        <option value="等待回覆">✅ 確認成立：等待回覆</option>
        <option value="待確認完成">✅ 已做完：待確認完成</option>
        <option value="__merge__">🔀 合併到既有任務…</option>
        <option value="封存">❌ 不成立（誤判）：封存</option>
      </select>
      <input class="merge-target" list="merge-targets" placeholder="輸入或選擇要合併到的任務名稱">
    </div>
  </div>`;
}

// ---- helpers ----

async function notionRequest(pathname, { method, body }) {
  const notionToken = requiredEnv('NOTION_TOKEN');
  const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
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

    lastError = new Error(`Notion API failed: ${response.status} ${responseText.slice(0, 300)}`);
    if (![409, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
      throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function textProperty(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

function selectName(property) {
  return property?.select?.name || '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
