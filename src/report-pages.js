// Server-rendered task review pages for the daily / follow-up reports.
// Section A: pending extraction verdicts (確認狀態=未確認)
// Section B: waiting-for-reply chase decisions (狀態=等待回覆)
// Section C: in-progress reminders with status change + notes (狀態=進行中/未開始)

export async function renderTaskReviewPage({ reportType, title, subtitle }) {
  const [pendingTasks, waitingTasks, inProgressTasks, mergeTargets, officialProjects] = await Promise.all([
    queryTasksByFilter({
      and: [
        { property: '確認狀態', select: { equals: '未確認' } },
        { property: '狀態', select: { does_not_equal: '封存' } },
        { property: '狀態', select: { does_not_equal: '已完成' } },
      ],
    }),
    queryTasksByFilter({ property: '狀態', select: { equals: '等待回覆' } }),
    queryTasksByFilter({
      or: [
        { property: '狀態', select: { equals: '進行中' } },
        { property: '狀態', select: { equals: '未開始' } },
      ],
    }),
    queryMergeTargetTitles(),
    queryOfficialProjects(),
  ]);
  const pendingAttachments = await queryPendingAttachments();
  const projectProposals = await queryProjectProposals();

  const now = new Date();
  const activeWaiting = waitingTasks.filter((task) => !task.snoozedUntil || new Date(task.snoozedUntil) <= now);
  const snoozedCount = waitingTasks.length - activeWaiting.length;
  // 等待回覆的任務已在 B 區處理，不重複出現在 A 區。
  const pendingOnly = pendingTasks.filter((task) => task.status !== '等待回覆');
  const confirmedInProgress = inProgressTasks.filter((task) => task.confirmation !== '未確認');
  // 區段四：已確認但還掛「未分類」的任務（待裁決的會在確認後才進來）。
  const unclassifiedTasks = [...confirmedInProgress, ...activeWaiting]
    .filter((task) => !task.project || task.project === '未分類');

  return buildHtml({
    reportType,
    title,
    subtitle,
    pendingTasks: pendingOnly,
    waitingTasks: activeWaiting,
    snoozedCount,
    inProgressTasks: confirmedInProgress,
    unclassifiedTasks,
    mergeTargets,
    officialProjects,
    pendingAttachments,
    projectProposals,
  });
}

async function queryProjectProposals() {
  const projectsDataSourceId = process.env.SEVEN_PROJECTS_DATA_SOURCE_ID || '2d4e4e80-09e6-447f-b2e2-36269ff1ac5c';
  try {
    const result = await notionRequest(`/v1/data_sources/${projectsDataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: 20,
        filter: { property: '狀態', select: { equals: '候選' } },
      },
    });
    return (result.results || []).map((page) => {
      const properties = page.properties || {};
      return {
        pageId: page.id,
        url: page.url,
        name: textProperty(properties['專案名稱']),
        projectType: properties['專案類型']?.select?.name || '',
        goal: textProperty(properties['目標']),
        reason: textProperty(properties['目前進度摘要']),
      };
    }).filter((proposal) => proposal.name);
  } catch {
    return [];
  }
}

async function queryPendingAttachments() {
  const attachmentsDataSourceId = process.env.SEVEN_ATTACHMENTS_DATA_SOURCE_ID || '';
  if (!attachmentsDataSourceId) return [];
  try {
    const result = await notionRequest(`/v1/data_sources/${attachmentsDataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: 30,
        filter: { property: '轉檔狀態', select: { equals: '待確認' } },
        sorts: [{ property: '建立時間', direction: 'descending' }],
      },
    });
    return (result.results || []).map((page) => {
      const properties = page.properties || {};
      return {
        pageId: page.id,
        url: page.url,
        filename: textProperty(properties['檔案名稱']) || textProperty(properties['附件項目']) || '未命名附件',
        attachmentType: properties['附件類型']?.select?.name || '',
        fileSize: properties['檔案大小']?.number || 0,
        note: textProperty(properties['解析摘要']),
        createdAt: properties['建立時間']?.date?.start || '',
      };
    });
  } catch {
    return [];
  }
}

async function queryOfficialProjects() {
  const projectsDataSourceId = process.env.SEVEN_PROJECTS_DATA_SOURCE_ID || '2d4e4e80-09e6-447f-b2e2-36269ff1ac5c';
  try {
    const result = await notionRequest(`/v1/data_sources/${projectsDataSourceId}/query`, {
      method: 'POST',
      body: { page_size: 100 },
    });
    return (result.results || [])
      .filter((page) => !['候選', '封存'].includes(page.properties?.['狀態']?.select?.name || ''))
      .map((page) => {
        const titleProperty = Object.values(page.properties || {}).find((property) => property.type === 'title');
        return (titleProperty?.title || []).map((item) => item.plain_text || '').join('').trim();
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function queryTasksByFilter(filter) {
  const tasksDataSourceId = requiredEnv('SEVEN_TASKS_DATA_SOURCE_ID');
  const pages = [];
  let startCursor;
  do {
    const body = {
      page_size: 100,
      filter,
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

  const today = new Date().toISOString().slice(0, 10);
  return pages.map((page) => {
    const properties = page.properties || {};
    const dueDate = properties['截止日']?.date?.start || '';
    return {
      title: textProperty(properties['任務名稱']),
      project: selectName(properties['專案']) || '未分類',
      status: selectName(properties['狀態']),
      confirmation: selectName(properties['確認狀態']),
      priority: selectName(properties['優先級']),
      confidence: selectName(properties['信心等級']),
      owner: textProperty(properties['負責人']),
      dueDate,
      overdue: Boolean(dueDate && dueDate.slice(0, 10) < today),
      nextStep: textProperty(properties['下一步']),
      latestNote: textProperty(properties['最新備註']),
      summary: textProperty(properties['Codex 判斷摘要']),
      sourceText: textProperty(properties['來源原文']),
      snoozedUntil: properties['追蹤暫緩至']?.date?.start || '',
      conversationUrl: properties['關聯 Notion 頁面']?.url || '',
      url: page.url,
    };
  }).filter((task) => task.title);
}

async function queryMergeTargetTitles() {
  try {
    const tasks = await queryTasksByFilter({
      and: [
        { property: '狀態', select: { does_not_equal: '封存' } },
        { property: '狀態', select: { does_not_equal: '已完成' } },
      ],
    });
    return tasks.map((task) => task.title);
  } catch {
    return [];
  }
}

function buildDraftFollowupMessage(task) {
  const ownerPart = task.owner ? `${task.owner}，您好！` : '您好！';
  const stepPart = task.nextStep ? `（${task.nextStep}）` : '';
  return `${ownerPart}想跟您確認一下「${task.title}」目前的進度${stepPart}，方便的時候再麻煩回覆，謝謝！`;
}

function buildHtml({ reportType, title, subtitle, pendingTasks, waitingTasks, snoozedCount, inProgressTasks, unclassifiedTasks, mergeTargets, officialProjects, pendingAttachments = [], projectProposals = [] }) {
  const generatedAt = formatTaipeiDateTime(new Date());

  const pendingSections = groupByProject(pendingTasks)
    .map(([project, tasks]) => `
    <section class="project-group">
      <h2>${escapeHtml(project)}（${tasks.length}）</h2>
      ${tasks.map((task) => pendingCard(task)).join('\n')}
    </section>`).join('\n');

  const waitingCards = waitingTasks.map((task) => waitingCard(task)).join('\n');
  const progressCards = groupByProject(inProgressTasks)
    .map(([project, tasks]) => `
    <section class="project-group">
      <h2>${escapeHtml(project)}（${tasks.length}）</h2>
      ${tasks.map((task) => progressCard(task)).join('\n')}
    </section>`).join('\n');

  const unclassifiedCards = unclassifiedTasks.map((task) => unclassifiedCard(task, officialProjects)).join('\n');
  const attachmentCards = pendingAttachments.map((attachment) => attachmentCard(attachment)).join('\n');
  const proposalCards = projectProposals.map((proposal) => proposalCard(proposal)).join('\n');
  const totalActionable = pendingTasks.length + waitingTasks.length + inProgressTasks.length + unclassifiedTasks.length + pendingAttachments.length + projectProposals.length;

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
  .section-title { font-size: 17px; margin: 26px 0 4px; padding: 8px 12px; border-radius: 8px; color: #fff; }
  .section-title.pending { background: #2f80ed; }
  .section-title.waiting { background: #e8590c; }
  .section-title.progress { background: #2b8a3e; }
  .section-title.unclassified { background: #845ef7; }
  .section-title.attachments { background: #0b7285; }
  .section-title.proposals { background: #d6336c; }
  .section-hint { font-size: 12px; color: #52606d; margin: 4px 0 10px; }
  .project-group h2 { font-size: 15px; margin: 16px 0 8px; color: #334e68; border-left: 4px solid #9aa5b1; padding-left: 8px; }
  .card { background: #fff; border: 1px solid #e0e4e8; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .card h3 { font-size: 15px; margin: 0 0 6px; line-height: 1.45; }
  .card h3 a { color: inherit; text-decoration: none; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2f6; color: #3e4c59; }
  .badge.priority-high { background: #ffe3e3; color: #c92a2a; }
  .badge.overdue { background: #c92a2a; color: #fff; font-weight: 700; }
  .badge.confidence-high { background: #d3f9d8; color: #2b8a3e; }
  .badge.confidence-low { background: #fff3bf; color: #e67700; }
  details { margin: 6px 0; }
  details summary { font-size: 12px; color: #2f80ed; cursor: pointer; }
  details pre { white-space: pre-wrap; font-size: 12px; color: #3e4c59; background: #f8f9fa; border-radius: 6px; padding: 8px; margin: 6px 0 0; }
  .controls { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  select, input[type="text"], textarea { width: 100%; font-size: 15px; padding: 10px; border: 1px solid #cbd2d9; border-radius: 8px; background: #fff; font-family: inherit; }
  textarea { min-height: 64px; }
  .merge-target, .followup-message { display: none; }
  .note-input { min-height: 48px; font-size: 13px; }
  .latest-note { font-size: 12px; color: #6b4c00; background: #fff8e1; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
  .footer { position: sticky; bottom: 0; background: #f4f5f7; padding: 12px 0 4px; }
  button.submit { width: 100%; font-size: 16px; font-weight: 700; padding: 14px; border: 0; border-radius: 10px; background: #2f80ed; color: #fff; cursor: pointer; }
  button.submit:disabled { background: #9aa5b1; }
  .banner { padding: 12px; border-radius: 8px; margin-bottom: 10px; font-size: 14px; display: none; }
  .banner.ok { background: #d3f9d8; color: #2b8a3e; display: block; }
  .banner.err { background: #ffe3e3; color: #c92a2a; display: block; }
  .empty { background: #fff; border: 1px dashed #cbd2d9; border-radius: 10px; padding: 18px; text-align: center; color: #52606d; font-size: 14px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(subtitle || '')}　產生時間：${escapeHtml(generatedAt)}　可處理項目：${totalActionable} 筆</div>
  </header>
  <div id="banner" class="banner"></div>

  <div class="section-title pending">一、新任務裁決（${pendingTasks.length}）</div>
  <div class="section-hint">AI 萃取的候選任務：確認成立、判定誤判（封存）、或合併到既有任務。</div>
  ${pendingTasks.length === 0 ? '<div class="empty">沒有待裁決的新任務。</div>' : pendingSections}

  <div class="section-title waiting">二、等待回覆：要不要追問？（${waitingTasks.length}${snoozedCount ? `，另有 ${snoozedCount} 筆暫緩中` : ''}）</div>
  <div class="section-hint">這些任務在等對方回覆。可以發送追問訊息（可先修改內容）、暫緩幾天再問、或更新狀態。發送後自動暫緩 2 天。</div>
  ${waitingTasks.length === 0 ? '<div class="empty">沒有需要決定的等待回覆任務。</div>' : waitingCards}

  <div class="section-title progress">三、進行中／未開始提醒（${inProgressTasks.length}）</div>
  <div class="section-hint">隨時調整狀態；備註會寫入任務內文（自動標註來源報告與時間），並提供 AI 判讀參考。</div>
  ${inProgressTasks.length === 0 ? '<div class="empty">沒有進行中或未開始的任務。</div>' : progressCards}

  <div class="section-title unclassified">四、未分類任務待歸屬（${unclassifiedTasks.length}）</div>
  <div class="section-hint">這些已確認的任務還沒有專案歸屬。指定專案後，AI 判讀和專案報表才能正確關聯它們。</div>
  ${unclassifiedTasks.length === 0 ? '<div class="empty">沒有未分類的任務。</div>' : unclassifiedCards}

  <div class="section-title attachments">五、附件解析確認（${pendingAttachments.length}）</div>
  <div class="section-hint">超過大小上限或來自私人對話的附件，確認後才會解析。</div>
  ${pendingAttachments.length === 0 ? '<div class="empty">沒有等待確認的附件。</div>' : attachmentCards}

  <div class="section-title proposals">六、專案提案（${projectProposals.length}）</div>
  <div class="section-hint">AI 從未分類任務、無歸屬群組與大型母任務中發現的新工作流。核准後成為正式專案，AI 判讀才能使用。</div>
  ${projectProposals.length === 0 ? '<div class="empty">沒有等待核准的專案提案。</div>' : proposalCards}

  <datalist id="merge-targets">
    ${mergeTargets.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('\n')}
  </datalist>
  ${totalActionable === 0 ? '' : `
  <div class="footer">
    <textarea id="notes" class="notes" placeholder="（選填）整體備註，會寫入決策紀錄"></textarea>
    <button id="submit" class="submit">送出本次處理</button>
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
    if (mergeInput) mergeInput.style.display = select.value === '__merge__' ? 'block' : 'none';
  });
});

document.querySelectorAll('select.followup-action').forEach((select) => {
  select.addEventListener('change', () => {
    const messageInput = select.closest('.card').querySelector('textarea.followup-message');
    if (messageInput) messageInput.style.display = select.value === 'send' ? 'block' : 'none';
  });
});

const submitButton = document.getElementById('submit');
if (submitButton) submitButton.addEventListener('click', async () => {
  const banner = document.getElementById('banner');
  const tasks = [];
  const followupSends = [];
  const snoozes = [];
  const taskNotes = [];
  let invalid = '';

  document.querySelectorAll('.card.pending-card').forEach((card) => {
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

  document.querySelectorAll('.card.waiting-card').forEach((card) => {
    const select = card.querySelector('select.followup-action');
    const taskName = card.dataset.task;
    const value = select.value;
    if (value === 'keep') return;
    if (value === 'send') {
      const message = card.querySelector('textarea.followup-message').value.trim();
      if (!message) { invalid = taskName; return; }
      followupSends.push({ task: taskName, message, conversationUrl: card.dataset.conv || '' });
    } else if (value.startsWith('snooze-')) {
      snoozes.push({ task: taskName, days: Number(value.slice(7)) });
    } else {
      tasks.push({ task: taskName, status: value });
    }
  });

  document.querySelectorAll('.card.progress-card').forEach((card) => {
    const select = card.querySelector('select.progress-status');
    const note = card.querySelector('textarea.note-input').value.trim();
    const taskName = card.dataset.task;
    if (select && select.value !== 'keep') tasks.push({ task: taskName, status: select.value });
    if (note) taskNotes.push({ task: taskName, note });
  });

  const projectAssigns = [];
  document.querySelectorAll('.card.unclassified-card').forEach((card) => {
    const select = card.querySelector('select.project-assign');
    if (select && select.value !== 'keep') projectAssigns.push({ task: card.dataset.task, project: select.value });
  });

  const attachmentDecisions = [];
  document.querySelectorAll('.card.attachment-card').forEach((card) => {
    const select = card.querySelector('select.attachment-decision');
    if (select && select.value !== 'keep') attachmentDecisions.push({ pageId: card.dataset.page, decision: select.value });
  });

  const projectProposalDecisions = [];
  document.querySelectorAll('.card.proposal-card').forEach((card) => {
    const select = card.querySelector('select.proposal-decision');
    if (select && select.value !== 'keep') projectProposalDecisions.push({ pageId: card.dataset.page, decision: select.value });
  });

  if (invalid) {
    banner.className = 'banner err';
    banner.textContent = '「' + invalid + '」缺少必要內容（合併目標或追問訊息）。';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const total = tasks.length + followupSends.length + snoozes.length + taskNotes.length + projectAssigns.length + attachmentDecisions.length + projectProposalDecisions.length;
  if (total === 0) {
    banner.className = 'banner err';
    banner.textContent = '還沒有任何處理（全部都維持原狀）。';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (followupSends.length > 0) {
    const confirmed = confirm('將發送 ' + followupSends.length + ' 則追問訊息到對應的 LINE 對話，確定嗎？');
    if (!confirmed) return;
  }

  submitButton.disabled = true;
  submitButton.textContent = '送出中…（' + total + ' 筆處理）';
  try {
    const response = await fetch(APPROVAL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportType: REPORT_TYPE,
        approvedBy: 'Seven 陳聖文',
        approvalKey: localStorage.getItem(APPROVAL_KEY_STORAGE) || '',
        tasks,
        followupSends,
        snoozes,
        taskNotes,
        projectAssigns,
        attachmentDecisions,
        projectProposalDecisions,
        notes: (document.getElementById('notes') || {}).value || '',
      }),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || ('HTTP ' + response.status));
    const sendOk = (result.followupSendResults || []).filter((item) => item.ok).length;
    const sendFail = (result.followupSendResults || []).filter((item) => !item.ok).length;
    banner.className = 'banner ok';
    banner.textContent = '✅ 已處理 ' + total + ' 筆' + (sendOk ? '，追問已發送 ' + sendOk + ' 則' : '') + (sendFail ? '，' + sendFail + ' 則發送失敗（詳見任務頁）' : '') + '。頁面即將更新…';
    setTimeout(() => location.reload(), 2500);
  } catch (error) {
    banner.className = 'banner err';
    banner.textContent = '送出失敗：' + error.message;
    submitButton.disabled = false;
    submitButton.textContent = '送出本次處理';
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
</script>
</body>
</html>`;
}

function groupByProject(tasks) {
  const byProject = new Map();
  for (const task of tasks) {
    if (!byProject.has(task.project)) byProject.set(task.project, []);
    byProject.get(task.project).push(task);
  }
  return [...byProject.entries()];
}

function badges(task) {
  return [
    task.overdue ? '<span class="badge overdue">⚠️ 已逾期</span>' : '',
    task.priority ? `<span class="badge ${task.priority === '高' ? 'priority-high' : ''}">優先級 ${escapeHtml(task.priority)}</span>` : '',
    task.confidence ? `<span class="badge ${task.confidence === '高' ? 'confidence-high' : task.confidence === '低' ? 'confidence-low' : ''}">信心 ${escapeHtml(task.confidence)}</span>` : '',
    task.owner ? `<span class="badge">負責人 ${escapeHtml(task.owner)}</span>` : '',
    task.dueDate ? `<span class="badge">截止 ${escapeHtml(task.dueDate.slice(0, 10))}</span>` : '',
    task.status ? `<span class="badge">狀態 ${escapeHtml(task.status)}</span>` : '',
  ].filter(Boolean).join('');
}

function cardDetails(task) {
  return [
    task.latestNote ? `<div class="latest-note">📝 最新備註：${escapeHtml(task.latestNote)}</div>` : '',
    task.summary ? `<details><summary>AI 判斷摘要</summary><pre>${escapeHtml(task.summary)}</pre></details>` : '',
    task.sourceText ? `<details><summary>來源原文</summary><pre>${escapeHtml(task.sourceText)}</pre></details>` : '',
  ].filter(Boolean).join('\n');
}

function pendingCard(task) {
  return `
  <div class="card pending-card" data-task="${escapeHtml(task.title)}">
    <h3><a href="${escapeHtml(task.url)}" target="_blank" rel="noopener">${escapeHtml(task.title)}</a></h3>
    <div class="badges">${badges(task)}</div>
    ${cardDetails(task)}
    <div class="controls">
      <select class="verdict">
        <option value="keep" selected>保留未確認（下次再裁決）</option>
        <option value="未開始">✅ 確認成立：未開始</option>
        <option value="進行中">✅ 確認成立：進行中</option>
        <option value="等待回覆">✅ 確認成立：等待回覆</option>
        <option value="待確認完成">✅ 已做完：待確認完成</option>
        <option value="__merge__">🔀 合併到既有任務…</option>
        <option value="封存">❌ 不成立（誤判）：封存</option>
      </select>
      <input type="text" class="merge-target" list="merge-targets" placeholder="輸入或選擇要合併到的任務名稱">
    </div>
  </div>`;
}

function waitingCard(task) {
  const draft = buildDraftFollowupMessage(task);
  return `
  <div class="card waiting-card" data-task="${escapeHtml(task.title)}" data-conv="${escapeHtml(task.conversationUrl)}">
    <h3><a href="${escapeHtml(task.url)}" target="_blank" rel="noopener">${escapeHtml(task.title)}</a></h3>
    <div class="badges">${badges(task)}</div>
    ${cardDetails(task)}
    <div class="controls">
      <select class="followup-action">
        <option value="keep" selected>今天不處理</option>
        <option value="send">📨 發送追問訊息（可先修改下方內容）</option>
        <option value="snooze-1">⏸ 暫緩 1 天再問</option>
        <option value="snooze-3">⏸ 暫緩 3 天再問</option>
        <option value="snooze-5">⏸ 暫緩 5 天再問</option>
        <option value="snooze-7">⏸ 暫緩 7 天再問</option>
        <option value="待確認完成">✅ 已收到回覆：待確認完成</option>
        <option value="進行中">▶️ 改為進行中</option>
        <option value="封存">❌ 不再追蹤：封存</option>
      </select>
      <textarea class="followup-message">${escapeHtml(draft)}</textarea>
    </div>
  </div>`;
}

function attachmentCard(attachment) {
  const size = attachment.fileSize >= 1024 * 1024
    ? `${Math.round((attachment.fileSize / (1024 * 1024)) * 10) / 10}MB`
    : `${Math.round(attachment.fileSize / 1024)}KB`;
  return `
  <div class="card attachment-card" data-page="${escapeHtml(attachment.pageId)}">
    <h3><a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">${escapeHtml(attachment.filename)}</a></h3>
    <div class="badges">
      ${attachment.attachmentType ? `<span class="badge">${escapeHtml(attachment.attachmentType)}</span>` : ''}
      <span class="badge">${escapeHtml(size)}</span>
      ${attachment.createdAt ? `<span class="badge">收到 ${escapeHtml(attachment.createdAt.slice(0, 10))}</span>` : ''}
    </div>
    ${attachment.note ? `<div class="latest-note">${escapeHtml(attachment.note)}</div>` : ''}
    <div class="controls">
      <select class="attachment-decision">
        <option value="keep" selected>暫不決定</option>
        <option value="已核准解析">✅ 核准解析（下一輪自動處理）</option>
        <option value="確定不解析">❌ 不需要解析</option>
      </select>
    </div>
  </div>`;
}

function proposalCard(proposal) {
  return `
  <div class="card proposal-card" data-page="${escapeHtml(proposal.pageId)}">
    <h3><a href="${escapeHtml(proposal.url)}" target="_blank" rel="noopener">📁 ${escapeHtml(proposal.name)}</a></h3>
    <div class="badges">${proposal.projectType ? `<span class="badge">${escapeHtml(proposal.projectType)}</span>` : ''}</div>
    ${proposal.goal ? `<div class="latest-note">🎯 ${escapeHtml(proposal.goal)}</div>` : ''}
    ${proposal.reason ? `<details><summary>提案理由</summary><pre>${escapeHtml(proposal.reason)}</pre></details>` : ''}
    <div class="controls">
      <select class="proposal-decision">
        <option value="keep" selected>暫不決定</option>
        <option value="approve">✅ 核准成立（成為正式專案）</option>
        <option value="reject">❌ 退回提案</option>
      </select>
    </div>
  </div>`;
}

function unclassifiedCard(task, officialProjects) {
  return `
  <div class="card unclassified-card" data-task="${escapeHtml(task.title)}">
    <h3><a href="${escapeHtml(task.url)}" target="_blank" rel="noopener">${escapeHtml(task.title)}</a></h3>
    <div class="badges">${badges(task)}</div>
    ${cardDetails(task)}
    <div class="controls">
      <select class="project-assign">
        <option value="keep" selected>暫不歸屬（保持未分類）</option>
        ${officialProjects.map((name) => `<option value="${escapeHtml(name)}">📁 歸屬到：${escapeHtml(name)}</option>`).join('\n')}
      </select>
    </div>
  </div>`;
}

function progressCard(task) {
  return `
  <div class="card progress-card" data-task="${escapeHtml(task.title)}">
    <h3><a href="${escapeHtml(task.url)}" target="_blank" rel="noopener">${escapeHtml(task.title)}</a></h3>
    <div class="badges">${badges(task)}</div>
    ${task.nextStep ? `<div class="latest-note">➡️ 下一步：${escapeHtml(task.nextStep)}</div>` : ''}
    ${cardDetails(task)}
    <div class="controls">
      <select class="progress-status">
        <option value="keep" selected>維持「${escapeHtml(task.status)}」</option>
        ${task.status !== '進行中' ? '<option value="進行中">▶️ 改為進行中</option>' : ''}
        <option value="等待回覆">⏳ 改為等待回覆</option>
        <option value="待確認完成">✅ 已做完：待確認完成</option>
        <option value="已完成">✔️ 已完成</option>
        <option value="封存">❌ 不再追蹤：封存</option>
      </select>
      <textarea class="note-input" placeholder="（選填）補充備註：寫入任務內文＋提供 AI 判讀參考，會自動標註來源報告與時間"></textarea>
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
