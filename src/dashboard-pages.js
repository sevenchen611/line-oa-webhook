// SevenAM 三層下鑽 Dashboard（server-rendered, Basic auth 保護）：
//   /dashboard                 全局統計 + 專案卡片牆
//   /dashboard/project?name=X  專案目標/日期 + 旗下任務（母子階層）
//   /dashboard/task?id=Y       任務詳情 + 來源對話內容內嵌

const STATUS_ORDER = ['待確認', '未開始', '進行中', '等待回覆', '待確認完成', '已完成', '封存'];
const STATUS_COLORS = {
  待確認: '#e8590c', 未開始: '#868e96', 進行中: '#2b8a3e', 等待回覆: '#e67700',
  待確認完成: '#1971c2', 已完成: '#495057', 封存: '#adb5bd',
};

export async function renderDashboardOverview() {
  const [tasks, projects] = await Promise.all([queryAllTasks(), queryAllProjects()]);
  const active = tasks.filter((task) => task.status !== '封存');

  const total = active.filter((task) => task.status !== '已完成').length;
  const inProgress = active.filter((task) => ['進行中', '等待回覆'].includes(task.status)).length;
  const pending = active.filter((task) => task.status === '待確認' || (task.status === '未開始' && task.confirmation === '未確認')).length;
  const statusCounts = countBy(active, (task) => task.status);

  const byProject = new Map();
  for (const task of active) {
    const key = task.project || '未分類';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(task);
  }

  const projectCards = [];
  const officialOrder = [...projects.filter((project) => project.status !== '候選'), { name: '未分類', status: '', virtual: true }];
  for (const project of officialOrder) {
    const projectTasks = byProject.get(project.name) || [];
    if (project.virtual && projectTasks.length === 0) continue;
    projectCards.push(projectCard(project, projectTasks));
  }
  const proposals = projects.filter((project) => project.status === '候選');

  const body = `
  <header>
    <h1>SevenAM 總控 Dashboard</h1>
    <div class="meta">產生時間：${escapeHtml(formatTaipeiDateTime(new Date()))}　<a href="/reports/daily-control-report">→ 前往裁決報告頁</a></div>
  </header>

  <div class="stat-row">
    <div class="stat"><div class="num">${total}</div><div class="label">案件總數（未封存未完成）</div></div>
    <div class="stat green"><div class="num">${inProgress}</div><div class="label">進行中（含等待回覆）</div></div>
    <div class="stat orange"><div class="num">${pending}</div><div class="label">待處理（待裁決＋未開始）</div></div>
  </div>
  <div class="chips">
    ${STATUS_ORDER.filter((status) => statusCounts[status]).map((status) => `<span class="chip" style="border-color:${STATUS_COLORS[status]};color:${STATUS_COLORS[status]}">${escapeHtml(status)} ${statusCounts[status]}</span>`).join('')}
  </div>

  <h2 class="section">專案（${projectCards.length}）</h2>
  <div class="grid">${projectCards.join('\n')}</div>
  ${proposals.length ? `<h2 class="section">等待核准的專案提案（${proposals.length}）</h2><div class="hint">${proposals.map((proposal) => escapeHtml(proposal.name)).join('、')}　→ 到報告頁區段六核准</div>` : ''}`;

  return pageShell('SevenAM Dashboard', body);
}

function projectCard(project, tasks) {
  const counts = countBy(tasks, (task) => task.status);
  const overdue = tasks.filter((task) => task.overdue).length;
  const bar = STATUS_ORDER.filter((status) => counts[status])
    .map((status) => `<span class="bar-seg" style="flex:${counts[status]};background:${STATUS_COLORS[status]}" title="${status} ${counts[status]}"></span>`)
    .join('');

  return `
  <a class="card project" href="/dashboard/project?name=${encodeURIComponent(project.name)}">
    <h3>${escapeHtml(project.name)}</h3>
    <div class="badges">
      ${project.status ? `<span class="badge">${escapeHtml(project.status)}</span>` : ''}
      ${project.projectType ? `<span class="badge">${escapeHtml(project.projectType)}</span>` : ''}
      <span class="badge strong">${tasks.length} 個任務</span>
      ${overdue ? `<span class="badge overdue">⚠️ 逾期 ${overdue}</span>` : ''}
    </div>
    ${project.targetDate ? `<div class="mini">🎯 預計完成：${escapeHtml(project.targetDate.slice(0, 10))}</div>` : ''}
    <div class="bar">${bar || '<span class="bar-seg" style="flex:1;background:#e9ecef"></span>'}</div>
    <div class="mini">${STATUS_ORDER.filter((status) => counts[status]).map((status) => `${status} ${counts[status]}`).join('｜') || '尚無任務'}</div>
  </a>`;
}

export async function renderProjectPage(projectName) {
  const [tasks, projects] = await Promise.all([queryAllTasks(), queryAllProjects()]);
  const project = projects.find((item) => item.name === projectName) || { name: projectName, virtual: true };
  const projectTasks = tasks.filter((task) => (task.project || '未分類') === projectName && task.status !== '封存');

  // 母子階層：先列母任務（或無母任務者），子任務縮排在母任務之下
  const childrenByParent = new Map();
  const taskById = new Map(projectTasks.map((task) => [task.id, task]));
  const roots = [];
  for (const task of projectTasks) {
    const parentId = task.parentIds.find((id) => taskById.has(id));
    if (parentId) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(task);
    } else {
      roots.push(task);
    }
  }
  const statusRank = (task) => STATUS_ORDER.indexOf(task.status) === -1 ? 99 : STATUS_ORDER.indexOf(task.status);
  roots.sort((a, b) => statusRank(a) - statusRank(b) || (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0));

  const officialNames = projects.filter((item) => !['候選', '封存'].includes(item.status)).map((item) => item.name);

  // 每個任務的「可選母任務」＝同專案任務，排除自己與自己的子孫（防循環）。
  const descendantsOf = (taskId) => {
    const collected = new Set();
    const walk = (id) => {
      for (const child of childrenByParent.get(id) || []) {
        if (!collected.has(child.id)) { collected.add(child.id); walk(child.id); }
      }
    };
    walk(taskId);
    return collected;
  };
  const parentCandidatesFor = (task) => {
    const blocked = descendantsOf(task.id);
    return projectTasks.filter((candidate) => candidate.id !== task.id && !blocked.has(candidate.id) && candidate.status !== '已完成');
  };

  const rows = roots.map((task) => taskRow(task, childrenByParent, 0, projectName, officialNames, taskById, parentCandidatesFor)).join('\n');
  const counts = countBy(projectTasks, (task) => task.status);

  const body = `
  <header>
    <div class="crumb"><a href="/dashboard">← Dashboard</a></div>
    <h1>📁 ${escapeHtml(project.name)}</h1>
    <div class="badges">
      ${project.status ? `<span class="badge">${escapeHtml(project.status)}</span>` : ''}
      ${project.projectType ? `<span class="badge">${escapeHtml(project.projectType)}</span>` : ''}
      ${project.priority ? `<span class="badge">優先級 ${escapeHtml(project.priority)}</span>` : ''}
      ${project.owner ? `<span class="badge">負責人 ${escapeHtml(project.owner)}</span>` : ''}
    </div>
  </header>

  ${project.virtual ? '<div class="panel hint">「未分類」是任務收件匣，不是正式專案。請在報告頁區段四為這些任務指定專案。</div>' : `
  <div class="panel">
    <div class="field"><span class="key">目標</span>${escapeHtml(project.goal || '（未設定）')}</div>
    <div class="field"><span class="key">成功條件</span>${escapeHtml(project.successCriteria || '（未設定）')}</div>
    <div class="field-row">
      <div class="field"><span class="key">開始日期</span>${escapeHtml(project.startDate ? project.startDate.slice(0, 10) : '（未設定）')}</div>
      <div class="field"><span class="key">預計完成</span>${escapeHtml(project.targetDate ? project.targetDate.slice(0, 10) : '（未設定）')}</div>
    </div>
    ${project.progressSummary ? `<div class="field"><span class="key">進度摘要</span>${escapeHtml(project.progressSummary)}</div>` : ''}
    ${project.risk ? `<div class="field"><span class="key">主要風險</span>${escapeHtml(project.risk)}</div>` : ''}
    ${project.url ? `<div class="field"><a href="${escapeHtml(project.url)}" target="_blank" rel="noopener">在 Notion 開啟專案頁 ↗</a></div>` : ''}
  </div>`}

  <h2 class="section">任務（${projectTasks.length}）　<span class="mini">${STATUS_ORDER.filter((status) => counts[status]).map((status) => `${status} ${counts[status]}`).join('｜')}</span></h2>
  ${rows || '<div class="hint">此專案目前沒有任務。</div>'}

  <script>
  document.querySelectorAll('select.parent-move').forEach((select) => {
    select.addEventListener('change', async () => {
      if (select.value === 'keep') return;
      const taskName = select.dataset.task;
      const clearing = select.value === '__clear__';
      const message = clearing
        ? '解除「' + taskName + '」的子任務關係？'
        : '將「' + taskName + '」設為所選任務的子任務？';
      if (!confirm(message)) { select.selectedIndex = 0; return; }
      select.disabled = true;
      try {
        const response = await fetch('/dashboard/set-parent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: select.dataset.id, parentId: clearing ? '' : select.value }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || ('HTTP ' + response.status));
        location.reload();
      } catch (error) {
        alert('調整失敗：' + error.message);
        select.disabled = false;
        select.selectedIndex = 0;
      }
    });
  });

  document.querySelectorAll('select.project-move').forEach((select) => {
    select.addEventListener('change', async () => {
      if (select.value === 'keep') return;
      const taskName = select.dataset.task;
      if (!confirm('將「' + taskName + '」移到專案「' + select.value + '」？')) { select.value = 'keep'; return; }
      select.disabled = true;
      try {
        const response = await fetch('/dashboard/assign-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: taskName, project: select.value }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || ('HTTP ' + response.status));
        location.reload();
      } catch (error) {
        alert('移動失敗：' + error.message);
        select.disabled = false;
        select.value = 'keep';
      }
    });
  });
  </script>`;

  return pageShell(`${project.name} - SevenAM`, body);
}

function taskRow(task, childrenByParent, depth, currentProject, officialNames, taskById, parentCandidatesFor) {
  const children = (childrenByParent.get(task.id) || []);
  const moveOptions = officialNames
    .filter((name) => name !== currentProject)
    .map((name) => `<option value="${escapeHtml(name)}">移到：${escapeHtml(name)}</option>`)
    .join('');

  const currentParentId = task.parentIds.find((id) => taskById.has(id)) || '';
  const currentParentName = currentParentId ? taskById.get(currentParentId).title : '';
  const parentOptions = parentCandidatesFor(task)
    .filter((candidate) => candidate.id !== currentParentId)
    .map((candidate) => `<option value="${escapeHtml(candidate.id)}">↳ 設為子任務：${escapeHtml(clampText(candidate.title, 40))}</option>`)
    .join('');

  return `
  <div class="card task" style="margin-left:${depth * 22}px">
    <a class="task-link" href="/dashboard/task?id=${encodeURIComponent(task.id)}">
      <div class="task-line">
        <span class="status-dot" style="background:${STATUS_COLORS[task.status] || '#adb5bd'}"></span>
        <span class="task-title">${depth > 0 ? '└ ' : ''}${escapeHtml(task.title)}</span>
      </div>
      <div class="badges">
        <span class="badge" style="color:${STATUS_COLORS[task.status] || '#495057'}">${escapeHtml(task.status || '未設定')}</span>
        ${task.overdue ? '<span class="badge overdue">⚠️ 已逾期</span>' : ''}
        ${task.priority === '高' ? '<span class="badge overdue">高優先</span>' : ''}
        ${task.owner ? `<span class="badge">${escapeHtml(task.owner)}</span>` : ''}
        ${task.dueDate ? `<span class="badge">截止 ${escapeHtml(task.dueDate.slice(0, 10))}</span>` : ''}
        ${children.length ? `<span class="badge">${children.length} 個子任務</span>` : ''}
      </div>
      ${task.nextStep ? `<div class="mini">➡️ ${escapeHtml(clampText(task.nextStep, 90))}</div>` : ''}
    </a>
    <div class="move-row">
      <select class="project-move" data-task="${escapeHtml(task.title)}">
        <option value="keep" selected>📁 ${escapeHtml(currentProject)}</option>
        ${moveOptions}
        ${currentProject !== '未分類' ? '<option value="未分類">移到：未分類</option>' : ''}
      </select>
      <select class="parent-move" data-id="${escapeHtml(task.id)}" data-task="${escapeHtml(task.title)}">
        <option value="keep" selected>${currentParentName ? `↳ 母任務：${escapeHtml(clampText(currentParentName, 30))}` : '↳ 母任務：（無）'}</option>
        ${currentParentId ? '<option value="__clear__">✂️ 解除子任務關係（升回獨立任務）</option>' : ''}
        ${parentOptions}
      </select>
    </div>
  </div>
  ${children.map((child) => taskRow(child, childrenByParent, depth + 1, currentProject, officialNames, taskById, parentCandidatesFor)).join('\n')}`;
}

export async function renderTaskPage(taskPageId) {
  const tasksDataSourceId = requiredEnv('SEVEN_TASKS_DATA_SOURCE_ID');
  const page = await notionRequest(`/v1/pages/${taskPageId}`, { method: 'GET' });
  const parentDataSource = normalizeId(page.parent?.data_source_id || page.parent?.database_id || '');
  if (parentDataSource && parentDataSource !== normalizeId(tasksDataSourceId)) {
    throw new Error('Page is not a task.');
  }

  const task = normalizeTask(page);
  const bodyBlocks = await getBlockTexts(page.id, 60);
  const conversation = await loadConversationPreview(task.conversationUrl);

  const body = `
  <header>
    <div class="crumb"><a href="/dashboard">← Dashboard</a>　<a href="/dashboard/project?name=${encodeURIComponent(task.project || '未分類')}">← ${escapeHtml(task.project || '未分類')}</a></div>
    <h1>${escapeHtml(task.title)}</h1>
    <div class="badges">
      <span class="badge" style="color:${STATUS_COLORS[task.status] || '#495057'}">${escapeHtml(task.status || '未設定')}</span>
      <span class="badge">確認狀態 ${escapeHtml(task.confirmation || '未設定')}</span>
      ${task.overdue ? '<span class="badge overdue">⚠️ 已逾期</span>' : ''}
      ${task.priority ? `<span class="badge">優先級 ${escapeHtml(task.priority)}</span>` : ''}
      ${task.confidence ? `<span class="badge">信心 ${escapeHtml(task.confidence)}</span>` : ''}
      ${task.owner ? `<span class="badge">負責人 ${escapeHtml(task.owner)}</span>` : ''}
      ${task.dueDate ? `<span class="badge">截止 ${escapeHtml(task.dueDate.slice(0, 10))}</span>` : ''}
    </div>
  </header>

  <div class="panel">
    ${task.latestNote ? `<div class="field"><span class="key">最新備註</span>${escapeHtml(task.latestNote)}</div>` : ''}
    ${task.summary ? `<div class="field"><span class="key">AI 判斷摘要</span><pre>${escapeHtml(task.summary)}</pre></div>` : ''}
    <div class="field"><a href="${escapeHtml(task.url)}" target="_blank" rel="noopener">在 Notion 開啟任務頁 ↗</a></div>
  </div>

  <h2 class="section">✏️ 編輯任務</h2>
  <div class="panel" id="edit-panel" data-page="${escapeHtml(task.id)}">
    <div class="edit-grid">
      <label>狀態
        <select id="edit-status">
          ${STATUS_ORDER.map((status) => `<option value="${status}" ${status === task.status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>
      </label>
      <label>優先級
        <select id="edit-priority">
          ${['高', '中', '低'].map((priority) => `<option value="${priority}" ${priority === (task.priority || '中') ? 'selected' : ''}>${priority}</option>`).join('')}
        </select>
      </label>
      <label>負責人
        <input type="text" id="edit-owner" value="${escapeHtml(task.owner)}" placeholder="姓名">
      </label>
      <label>截止日
        <input type="date" id="edit-due" value="${escapeHtml(task.dueDate.slice(0, 10))}">
      </label>
    </div>
    <label class="edit-full">下一步
      <textarea id="edit-next" rows="2">${escapeHtml(task.nextStep)}</textarea>
    </label>
    <label class="edit-full">新增備註（會寫入任務內文＋提供 AI 判讀參考，自動標註時間）
      <textarea id="edit-note" rows="3" placeholder="（選填）這次更新的說明、現場狀況、口頭承諾⋯⋯"></textarea>
    </label>
    <button id="edit-save" class="save-btn">💾 儲存變更</button>
    <div id="edit-result" class="mini" style="margin-top:8px"></div>
  </div>

  <script>
  (function () {
    const panel = document.getElementById('edit-panel');
    const button = document.getElementById('edit-save');
    const original = {
      status: ${JSON.stringify(task.status)},
      priority: ${JSON.stringify(task.priority || '中')},
      owner: ${JSON.stringify(task.owner)},
      dueDate: ${JSON.stringify(task.dueDate.slice(0, 10))},
      next: ${JSON.stringify(task.nextStep)},
    };
    button.addEventListener('click', async () => {
      const payload = { pageId: panel.dataset.page, editedBy: 'Seven 陳聖文' };
      const status = document.getElementById('edit-status').value;
      const priority = document.getElementById('edit-priority').value;
      const owner = document.getElementById('edit-owner').value.trim();
      const dueDate = document.getElementById('edit-due').value;
      const next = document.getElementById('edit-next').value.trim();
      const note = document.getElementById('edit-note').value.trim();

      if (status !== original.status) {
        payload.status = status;
        if (['未開始', '進行中', '等待回覆', '待確認完成', '已完成'].includes(status)) payload.confirmation = '已確認';
      }
      if (priority !== original.priority) payload.priority = priority;
      if (owner !== original.owner) payload.owner = owner;
      if (dueDate && dueDate !== original.dueDate) payload.dueDate = dueDate;
      if (next !== original.next) payload.next = next;
      if (note) payload.editNote = note;

      if (Object.keys(payload).length <= 2) {
        document.getElementById('edit-result').textContent = '沒有任何變更。';
        return;
      }

      button.disabled = true;
      button.textContent = '儲存中…';
      try {
        const response = await fetch('/control/tasks/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || ('HTTP ' + response.status));
        document.getElementById('edit-result').textContent = '✅ 已儲存，頁面更新中…';
        setTimeout(() => location.reload(), 900);
      } catch (error) {
        document.getElementById('edit-result').textContent = '❌ 儲存失敗：' + error.message;
        button.disabled = false;
        button.textContent = '💾 儲存變更';
      }
    });
  })();
  </script>

  <h2 class="section">📱 來源對話${conversation.name ? `：${escapeHtml(conversation.name)}` : ''}</h2>
  ${conversation.messages.length === 0
    ? '<div class="hint">此任務沒有關聯的對話來源（可能來自會議或手動建立）。</div>'
    : `<div class="chat">${conversation.messages.map((message) => `
        <div class="msg ${message.outgoing ? 'out' : ''}">
          <div class="msg-meta">${escapeHtml(message.meta)}</div>
          <div class="msg-text">${escapeHtml(message.text)}</div>
        </div>`).join('\n')}</div>
      ${conversation.url ? `<div class="hint"><a href="${escapeHtml(conversation.url)}" target="_blank" rel="noopener">在 Notion 開啟完整對話 ↗</a>（顯示最近 ${conversation.messages.length} 則，最新在最上方）</div>` : ''}`}

  <h2 class="section">📋 任務控制紀錄（內文）</h2>
  <div class="panel"><pre class="doc">${escapeHtml(bodyBlocks.join('\n') || '（無內文）')}</pre></div>`;

  return pageShell(`${task.title} - SevenAM`, body);
}

async function loadConversationPreview(conversationUrl) {
  const pageId = extractPageId(conversationUrl);
  if (!pageId) return { name: '', url: '', messages: [] };
  try {
    const page = await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
    const name = textProperty(page.properties?.['LINE 對話名稱']) || textProperty(page.properties?.['自定義名稱']);
    const lines = await getBlockTexts(pageId, 80);

    const messages = [];
    let current = null;
    for (const line of lines) {
      if (line.includes('LINE 對話記錄')) continue;
      const meta = line.match(/^【(.+?)】(.+)$/);
      if (meta) {
        if (current) messages.push(current);
        current = { meta: line.slice(0, 80), text: '', outgoing: /Seven Jr\.|附件解析/.test(line) };
        continue;
      }
      if (current) current.text = current.text ? `${current.text}\n${line}` : line;
    }
    if (current) messages.push(current);

    return { name, url: page.url || '', messages: messages.slice(0, 30) };
  } catch {
    return { name: '', url: conversationUrl, messages: [] };
  }
}

// ---- data loading ----

async function queryAllTasks() {
  const tasksDataSourceId = requiredEnv('SEVEN_TASKS_DATA_SOURCE_ID');
  const pages = [];
  let startCursor;
  do {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const result = await notionRequest(`/v1/data_sources/${tasksDataSourceId}/query`, { method: 'POST', body });
    pages.push(...(result.results || []));
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor && pages.length < 500);
  return pages.map(normalizeTask).filter((task) => task.title);
}

function normalizeTask(page) {
  const properties = page.properties || {};
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = properties['截止日']?.date?.start || '';
  const status = properties['狀態']?.select?.name || properties['狀態']?.status?.name || '';
  return {
    id: normalizeId(page.id),
    url: page.url,
    title: textProperty(properties['任務名稱']),
    project: properties['專案']?.select?.name || '',
    status,
    confirmation: properties['確認狀態']?.select?.name || '',
    priority: properties['優先級']?.select?.name || '',
    confidence: properties['信心等級']?.select?.name || '',
    owner: textProperty(properties['負責人']),
    dueDate,
    overdue: Boolean(dueDate && dueDate.slice(0, 10) < today && !['已完成', '封存'].includes(status)),
    nextStep: textProperty(properties['下一步']),
    latestNote: textProperty(properties['最新備註']),
    summary: textProperty(properties['Codex 判斷摘要']),
    conversationUrl: properties['關聯 Notion 頁面']?.url || '',
    parentIds: (properties['母任務']?.relation || []).map((relation) => normalizeId(relation.id)),
  };
}

async function queryAllProjects() {
  const projectsDataSourceId = process.env.SEVEN_PROJECTS_DATA_SOURCE_ID || '2d4e4e80-09e6-447f-b2e2-36269ff1ac5c';
  try {
    const result = await notionRequest(`/v1/data_sources/${projectsDataSourceId}/query`, {
      method: 'POST',
      body: { page_size: 100 },
    });
    return (result.results || []).map((page) => {
      const properties = page.properties || {};
      return {
        name: textProperty(properties['專案名稱']),
        status: properties['狀態']?.select?.name || '',
        projectType: properties['專案類型']?.select?.name || '',
        priority: properties['優先級']?.select?.name || '',
        owner: textProperty(properties['負責人']),
        goal: textProperty(properties['目標']),
        successCriteria: textProperty(properties['成功條件']),
        progressSummary: textProperty(properties['目前進度摘要']),
        risk: textProperty(properties['主要風險']),
        startDate: properties['開始日期']?.date?.start || '',
        targetDate: properties['目標完成日']?.date?.start || '',
        url: page.url,
      };
    }).filter((project) => project.name && project.status !== '封存');
  } catch {
    return [];
  }
}

async function getBlockTexts(blockId, limit) {
  const result = await notionRequest(`/v1/blocks/${blockId}/children?page_size=${Math.min(limit, 100)}`, { method: 'GET' });
  return (result.results || [])
    .map((block) => {
      const data = block[block.type] || {};
      return (data.rich_text || []).map((item) => item.plain_text || '').join('');
    })
    .filter(Boolean);
}

// ---- shell & helpers ----

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif; background: #f4f5f7; color: #1f2933; }
  body > * { max-width: 860px; margin-left: auto; margin-right: auto; }
  header { margin-bottom: 14px; }
  h1 { font-size: 21px; margin: 4px 0; }
  h2.section { font-size: 16px; margin: 22px auto 10px; color: #334e68; }
  .crumb { font-size: 13px; margin-bottom: 4px; }
  .crumb a, .meta a { color: #2f80ed; text-decoration: none; }
  .meta { color: #52606d; font-size: 13px; }
  .stat-row { display: flex; gap: 10px; margin: 14px auto; }
  .stat { flex: 1; background: #fff; border: 1px solid #e0e4e8; border-radius: 12px; padding: 14px; text-align: center; }
  .stat .num { font-size: 30px; font-weight: 800; }
  .stat.green .num { color: #2b8a3e; } .stat.orange .num { color: #e8590c; }
  .stat .label { font-size: 12px; color: #52606d; margin-top: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px auto; }
  .chip { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1.5px solid; background: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
  .card { display: block; background: #fff; border: 1px solid #e0e4e8; border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; text-decoration: none; color: inherit; }
  .card:hover { border-color: #2f80ed; }
  .card h3 { font-size: 15px; margin: 0 0 6px; }
  .badges { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2f6; color: #3e4c59; }
  .badge.strong { background: #2f80ed; color: #fff; }
  .badge.overdue { background: #c92a2a; color: #fff; font-weight: 700; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 8px 0 4px; }
  .bar-seg { display: block; }
  .mini { font-size: 12px; color: #52606d; }
  .panel { background: #fff; border: 1px solid #e0e4e8; border-radius: 12px; padding: 14px 16px; margin-bottom: 10px; }
  .field { font-size: 14px; margin: 6px 0; line-height: 1.6; }
  .field .key { display: inline-block; min-width: 76px; color: #52606d; font-size: 12px; font-weight: 700; }
  .field-row { display: flex; gap: 24px; flex-wrap: wrap; }
  .field a { color: #2f80ed; }
  .task-line { display: flex; align-items: center; gap: 8px; }
  a.task-link { display: block; text-decoration: none; color: inherit; }
  .move-row { display: flex; gap: 6px; margin-top: 8px; }
  .edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .edit-grid label, .edit-full { display: block; font-size: 12px; color: #52606d; font-weight: 700; margin-bottom: 8px; }
  .edit-grid select, .edit-grid input, .edit-full textarea { display: block; width: 100%; margin-top: 4px; font-size: 14px; font-weight: 400; padding: 9px 10px; border: 1px solid #cbd2d9; border-radius: 8px; background: #fff; font-family: inherit; color: #1f2933; }
  .save-btn { width: 100%; font-size: 15px; font-weight: 700; padding: 12px; border: 0; border-radius: 10px; background: #2f80ed; color: #fff; cursor: pointer; }
  .save-btn:disabled { background: #9aa5b1; }
  select.project-move, select.parent-move { flex: 1; min-width: 0; font-size: 12px; padding: 6px 8px; border: 1px solid #dee2e6; border-radius: 8px; background: #f8f9fa; color: #495057; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .task-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
  .hint { font-size: 13px; color: #52606d; background: #fff; border: 1px dashed #cbd2d9; border-radius: 10px; padding: 12px; }
  .hint a { color: #2f80ed; }
  .chat { background: #dfe7ef; border-radius: 12px; padding: 12px; }
  .msg { background: #fff; border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; max-width: 92%; }
  .msg.out { background: #d3f9d8; margin-left: auto; }
  .msg-meta { font-size: 11px; color: #748094; margin-bottom: 2px; }
  .msg-text { font-size: 13px; white-space: pre-wrap; line-height: 1.5; }
  pre { white-space: pre-wrap; font-family: inherit; font-size: 13px; margin: 4px 0; }
  pre.doc { font-size: 12.5px; line-height: 1.6; color: #3e4c59; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

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

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || '未設定';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
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

function normalizeId(value) {
  return String(value || '').replace(/-/g, '');
}

function extractPageId(url) {
  const match = String(url || '').match(/([0-9a-f]{32})/i);
  return match ? match[1] : '';
}

function clampText(value, maxLength) {
  const text = value == null ? '' : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value);
}
