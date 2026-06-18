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
  const DASHBOARD_STATUS_COLORS = ${JSON.stringify(STATUS_COLORS)};
  const DASHBOARD_CONFIRMED_STATUSES = new Set(['未開始', '進行中', '等待回覆', '待確認完成', '已完成']);

  document.querySelectorAll('select.status-quick').forEach((select) => {
    select.addEventListener('change', async () => {
      const original = select.dataset.original || '';
      const status = select.value;
      const taskName = select.dataset.task || '此任務';
      const state = select.closest('.quick-status-control')?.querySelector('.quick-save-state');
      if (status === original) return;

      const payload = {
        pageId: select.dataset.id,
        status,
        editedBy: 'Seven 陳聖文',
      };
      if (DASHBOARD_CONFIRMED_STATUSES.has(status)) {
        payload.confirmation = '已確認';
      } else if (status === '待確認') {
        payload.confirmation = '未確認';
      }

      select.disabled = true;
      select.classList.add('saving');
      if (state) state.textContent = '儲存中...';
      try {
        const response = await fetch('/control/tasks/update', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || ('HTTP ' + response.status));

        select.dataset.original = status;
        const card = select.closest('.card.task');
        const color = DASHBOARD_STATUS_COLORS[status] || '#495057';
        const dot = card?.querySelector('.status-dot');
        const badge = card?.querySelector('[data-status-badge]');
        if (dot) dot.style.background = color;
        if (badge) {
          badge.textContent = status || '未設定';
          badge.style.color = color;
        }
        if (status === '封存') {
          card?.classList.add('archived-inline');
          if (state) state.textContent = '已封存，重新整理後隱藏';
        } else if (state) {
          state.textContent = '已儲存';
          setTimeout(() => { if (state.textContent === '已儲存') state.textContent = ''; }, 1800);
        }
      } catch (error) {
        alert('「' + taskName + '」狀態儲存失敗：' + error.message);
        select.value = original;
        if (state) state.textContent = '儲存失敗';
      } finally {
        select.disabled = false;
        select.classList.remove('saving');
      }
    });
  });

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
  const statusOptions = STATUS_ORDER
    .map((status) => `<option value="${escapeHtml(status)}" ${status === task.status ? 'selected' : ''}>狀態：${escapeHtml(status)}</option>`)
    .join('');

  return `
  <div class="card task" style="margin-left:${depth * 22}px">
    <a class="task-link" href="/dashboard/task?id=${encodeURIComponent(task.id)}">
      <div class="task-line">
        <span class="status-dot" style="background:${STATUS_COLORS[task.status] || '#adb5bd'}"></span>
        <span class="task-title">${depth > 0 ? '└ ' : ''}${escapeHtml(task.title)}</span>
      </div>
      <div class="badges">
        <span class="badge" data-status-badge style="color:${STATUS_COLORS[task.status] || '#495057'}">${escapeHtml(task.status || '未設定')}</span>
        ${task.overdue ? '<span class="badge overdue">⚠️ 已逾期</span>' : ''}
        ${task.priority === '高' ? '<span class="badge overdue">高優先</span>' : ''}
        ${task.owner ? `<span class="badge">${escapeHtml(task.owner)}</span>` : ''}
        ${task.dueDate ? `<span class="badge">截止 ${escapeHtml(task.dueDate.slice(0, 10))}</span>` : ''}
        ${children.length ? `<span class="badge">${children.length} 個子任務</span>` : ''}
      </div>
      ${task.nextStep ? `<div class="mini">➡️ ${escapeHtml(clampText(task.nextStep, 90))}</div>` : ''}
    </a>
    <div class="move-row">
      <div class="quick-status-control">
        <select class="status-quick" data-id="${escapeHtml(task.id)}" data-task="${escapeHtml(task.title)}" data-original="${escapeHtml(task.status)}">
          ${statusOptions}
        </select>
        <span class="quick-save-state" aria-live="polite"></span>
      </div>
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
  const sourceRecipients = await loadSourceConversationRecipients(conversation);
  const sourceTarget = sourceConversationTarget(conversation);
  const currentTargetLabel = task.plannedTargetName || sourceTarget?.name || (conversation.name ? `來源對話「${conversation.name}」` : '未設定');
  const defaultTargetOption = task.plannedTargetId
    ? `<option value="" selected>沿用：${escapeHtml(task.plannedTargetName || task.plannedTargetId)}</option>`
    : sourceTarget
      ? `<option value="${escapeHtml(sourceTarget.value)}" data-name="${escapeHtml(sourceTarget.name)}" selected>${escapeHtml(sourceTarget.label)}</option>`
      : '<option value="" selected>（先搜尋再選擇）</option>';
  markSourceMessages(conversation.messages, task.sourceText);

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
      ${task.nextActionAt ? `<span class="badge strong">⏰ ${escapeHtml(task.nextActionMode)} ${escapeHtml(task.nextActionAt.slice(0, 16).replace('T', ' '))}</span>` : ''}
    </div>
  </header>

  <div class="panel">
    ${task.sourceText ? `<div class="field"><span class="key">來源原文</span><pre>${escapeHtml(clampText(task.sourceText, 600))}</pre></div>` : ''}
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
          credentials: 'include',
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

  <h2 class="section">📨 預定訊息與下次行動</h2>
  <div class="panel" id="planned-panel" data-page="${escapeHtml(task.id)}">
    ${task.nextActionAt ? `<div class="field" style="background:#fff8e1;border-radius:8px;padding:8px 10px">⏰ 已排程：${escapeHtml(formatTaipeiDateTime(new Date(task.nextActionAt)))}（${escapeHtml(task.nextActionMode)}）${task.nextActionNote ? `｜${escapeHtml(task.nextActionNote)}` : ''}</div>` : ''}
    <label class="edit-full">預定訊息內容（確認後按「立即發送」直接傳出；或排程到時自動處理）
      <textarea id="planned-message" rows="3">${escapeHtml(task.plannedMessage || defaultDraftMessage(task))}</textarea>
    </label>
    <div class="edit-grid">
      <label>發送對象（目前：${escapeHtml(currentTargetLabel)}）
        <input type="text" id="planned-target-search" placeholder="輸入姓名或群組名稱搜尋…" value="">
      </label>
      <label>來源對話 / 來源群組成員 / 搜尋結果（選擇後成為發送對象）
        <select id="planned-target-select">
          ${defaultTargetOption}
          ${sourceTarget && task.plannedTargetId ? `<optgroup label="來源對話"><option value="${escapeHtml(sourceTarget.value)}" data-name="${escapeHtml(sourceTarget.name)}">${escapeHtml(sourceTarget.label)}</option></optgroup>` : ''}
          ${sourceRecipients.length ? `<optgroup label="來源群組成員：${escapeHtml(conversation.name)}">${sourceRecipients.map((recipient) => `<option value="${escapeHtml(recipient.value)}" data-name="${escapeHtml(recipient.label)}">${escapeHtml(recipient.label)}</option>`).join('')}</optgroup>` : ''}
          <optgroup label="搜尋結果" id="planned-search-results"></optgroup>
        </select>
      </label>
    </div>
    <div class="edit-grid">
      <label>下次行動模式
        <select id="planned-mode">
          <option value="提醒我" ${task.nextActionMode !== '自動發送' ? 'selected' : ''}>⏰ 時間到提醒我（由我決定）</option>
          <option value="自動發送" ${task.nextActionMode === '自動發送' ? 'selected' : ''}>📨 時間到自動發送預定訊息</option>
        </select>
      </label>
      <label>下次行動時間
        <input type="datetime-local" id="planned-at" value="${escapeHtml(toDatetimeLocal(task.nextActionAt))}">
      </label>
    </div>
    <div class="quick-days">
      <button type="button" class="day-btn" data-days="1">+1 天</button>
      <button type="button" class="day-btn" data-days="3">+3 天</button>
      <button type="button" class="day-btn" data-days="5">+5 天</button>
      <button type="button" class="day-btn" data-days="7">+7 天</button>
      ${task.nextActionAt ? '<button type="button" class="day-btn" id="planned-clear">✂️ 取消排程</button>' : ''}
    </div>
    <label class="edit-full">下次行動說明（提醒時會顯示，例如「提醒我跟 Kevin 聯繫約見面」）
      <input type="text" id="planned-note" value="${escapeHtml(task.nextActionNote)}">
    </label>
    <div class="planned-actions">
      <button id="planned-save" class="save-btn half">💾 儲存預定與排程</button>
      <button id="planned-send" class="save-btn half send">📨 立即發送</button>
    </div>
    <div id="planned-result" class="mini" style="margin-top:8px"></div>
  </div>

  <script>
  (function () {
    const panel = document.getElementById('planned-panel');
    const resultBox = document.getElementById('planned-result');
    const searchInput = document.getElementById('planned-target-search');
    const targetSelect = document.getElementById('planned-target-select');
    let searchTimer = null;

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const text = searchInput.value.trim();
      if (text.length < 2) return;
      searchTimer = setTimeout(async () => {
        try {
          const response = await fetch('/reports/followup-recipient-candidates?target=' + encodeURIComponent(text));
          const data = await response.json();
          const searchGroup = document.getElementById('planned-search-results');
          if (searchGroup) searchGroup.innerHTML = '';
          for (const candidate of data.candidates || []) {
            const option = document.createElement('option');
            const isMemberTarget = Boolean(candidate.targetMemberUserId);
            const targetId = isMemberTarget ? candidate.targetMemberUserId : candidate.targetId;
            option.value = (isMemberTarget ? 'user' : candidate.targetType) + ':' + targetId;
            option.dataset.name = candidate.label;
            option.textContent = candidate.label;
            (searchGroup || targetSelect).appendChild(option);
          }
          if ((data.candidates || []).length) {
            const firstSearchOption = searchGroup?.querySelector('option');
            if (firstSearchOption) firstSearchOption.selected = true;
          }
          resultBox.textContent = (data.candidates || []).length ? '' : '找不到符合的對象，換個關鍵字試試。';
        } catch (error) {
          resultBox.textContent = '對象搜尋失敗：' + error.message;
        }
      }, 350);
    });

    document.querySelectorAll('.day-btn[data-days]').forEach((button) => {
      button.addEventListener('click', () => {
        const fireAt = new Date(Date.now() + Number(button.dataset.days) * 86400000);
        fireAt.setHours(9, 0, 0, 0);
        const pad = (n) => String(n).padStart(2, '0');
        document.getElementById('planned-at').value = fireAt.getFullYear() + '-' + pad(fireAt.getMonth() + 1) + '-' + pad(fireAt.getDate()) + 'T' + pad(fireAt.getHours()) + ':' + pad(fireAt.getMinutes());
      });
    });

    const clearButton = document.getElementById('planned-clear');
    if (clearButton) clearButton.addEventListener('click', () => {
      document.getElementById('planned-at').value = '';
      clearButton.dataset.cleared = '1';
      resultBox.textContent = '已標記取消排程，按「儲存預定與排程」生效。';
    });

    function selectedTarget() {
      const option = targetSelect.options[targetSelect.selectedIndex];
      if (!option || !option.value) return null;
      return { id: option.value, name: option.dataset.name || option.textContent };
    }

    document.getElementById('planned-save').addEventListener('click', async () => {
      const payload = { pageId: panel.dataset.page, editedBy: 'Seven 陳聖文' };
      const message = document.getElementById('planned-message').value.trim();
      const at = document.getElementById('planned-at').value;
      const note = document.getElementById('planned-note').value.trim();
      const target = selectedTarget();
      if (message) payload.plannedMessage = message;
      if (target) { payload.plannedTargetId = target.id; payload.plannedTargetName = target.name; }
      if (at) payload.nextActionAt = at + ':00+08:00';
      else if (clearButton && clearButton.dataset.cleared) payload.clearNextAction = true;
      payload.nextActionMode = document.getElementById('planned-mode').value;
      if (note) payload.nextActionNote = note;
      await submit('/control/tasks/update', payload, document.getElementById('planned-save'), '💾 儲存預定與排程');
    });

    document.getElementById('planned-send').addEventListener('click', async () => {
      const message = document.getElementById('planned-message').value.trim();
      if (!message) { resultBox.textContent = '請先填寫預定訊息內容。'; return; }
      const target = selectedTarget();
      const targetLabel = target ? target.name : ${JSON.stringify(task.plannedTargetName || '')} || ${JSON.stringify('來源對話')};
      if (!confirm('確定把這則訊息發送給「' + targetLabel + '」？\n\n' + message)) return;
      const payload = { pageId: panel.dataset.page, editedBy: 'Seven 陳聖文', message };
      if (target) { payload.targetId = target.id; payload.targetName = target.name; }
      await submit('/control/tasks/send-planned', payload, document.getElementById('planned-send'), '📨 立即發送');
    });

    async function submit(url, payload, button, label) {
      button.disabled = true;
      button.textContent = '處理中…';
      try {
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const responseText = await response.text();
        let result = {};
        try { result = responseText ? JSON.parse(responseText) : {}; } catch {}
        if (!response.ok || !result.ok) {
          throw new Error(result.error || responseText || ('HTTP ' + response.status));
        }
        resultBox.textContent = '✅ 完成，頁面更新中…';
        setTimeout(() => location.reload(), 900);
      } catch (error) {
        const message = '❌ 失敗：' + error.message;
        resultBox.textContent = message;
        alert(message);
        button.disabled = false;
        button.textContent = label;
      }
    }
  })();
  </script>

  <h2 class="section">📱 來源對話${conversation.name ? `：${escapeHtml(conversation.name)}` : ''}</h2>
  ${conversation.messages.length === 0
    ? '<div class="hint">此任務沒有關聯的對話來源（可能來自會議或手動建立）。</div>'
    : `<div class="chat">${conversation.messages.map((message) => `
        <div class="msg ${message.outgoing ? 'out' : ''}${message.isSource ? ' src' : ''}">
          ${message.isSource ? '<div class="src-tag">⭐ 本任務來源</div>' : ''}
          <div class="msg-meta">${escapeHtml(message.meta)}</div>
          ${message.text ? `<div class="msg-text">${escapeHtml(message.text)}</div>` : ''}
          ${(message.images || []).map((image) => `<a href="${escapeHtml(image.url)}" target="_blank" rel="noopener"><img class="msg-img" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.caption || '圖片')}" loading="lazy"></a>`).join('')}
          ${(message.files || []).map((file) => `<div class="msg-file">📎 <a href="${escapeHtml(file.url)}" target="_blank" rel="noopener">${escapeHtml(file.name)}</a></div>`).join('')}
          ${(message.links || []).map((link) => `<div class="msg-file">🔗 <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a></div>`).join('')}
        </div>`).join('\n')}</div>
      ${task.sourceText && !conversation.messages.some((message) => message.isSource) ? '<div class="hint">ℹ️ 本任務的來源訊息比下方顯示的範圍更早，已不在最近的訊息中——確切的出生原文請看上方「來源原文」欄位。</div>' : ''}
      ${conversation.url ? `<div class="hint"><a href="${escapeHtml(conversation.url)}" target="_blank" rel="noopener">在 Notion 開啟完整對話 ↗</a>（顯示最近 ${conversation.messages.length} 則，最新在最上方；圖片與檔案連結約 1 小時內有效，過期重新整理頁面即可）</div>` : ''}`}

  <h2 class="section">📋 任務控制紀錄（內文）</h2>
  <div class="panel"><pre class="doc">${escapeHtml(bodyBlocks.join('\n') || '（無內文）')}</pre></div>`;

  return pageShell(`${task.title} - SevenAM`, body);
}

function markSourceMessages(messages, sourceText) {
  const normalized = String(sourceText || '').replace(/\s+/g, '');
  if (normalized.length < 10) return;
  for (const message of messages) {
    const text = String(message.text || '').replace(/\s+/g, '');
    if (text.length < 10) continue;
    // 任一方包含對方的前段內容即視為來源訊息（來源原文常帶前綴或被截斷）。
    if (normalized.includes(text.slice(0, 60)) || text.includes(normalized.slice(0, 60))) {
      message.isSource = true;
    }
  }
}

async function loadConversationPreview(conversationUrl) {
  const pageId = extractPageId(conversationUrl);
  if (!pageId) return { name: '', url: '', messages: [] };
  try {
    const page = await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
    const name = textProperty(page.properties?.['LINE 對話名稱']) || textProperty(page.properties?.['自定義名稱']);
    const targetType = page.properties?.['對象類型']?.select?.name || '';
    const groupId = textProperty(page.properties?.['Group ID']);
    const roomId = textProperty(page.properties?.['Room ID']);
    const userId = textProperty(page.properties?.['User ID']);
    const result = await notionRequest(`/v1/blocks/${pageId}/children?page_size=100`, { method: 'GET' });

    const messages = [];
    let current = null;
    for (const block of result.results || []) {
      const data = block[block.type] || {};

      // 圖片區塊：Notion 簽名網址約 1 小時有效，server-side 每次重抓都是新的。
      if (block.type === 'image') {
        const imageUrl = data.file?.url || data.external?.url || '';
        const caption = (data.caption || []).map((item) => item.plain_text || '').join('');
        if (imageUrl && current) current.images.push({ url: imageUrl, caption });
        continue;
      }
      if (block.type === 'file') {
        const fileUrl = data.file?.url || data.external?.url || '';
        const fileName = (data.caption || []).map((item) => item.plain_text || '').join('') || data.name || '附件檔案';
        if (fileUrl && current) current.files.push({ url: fileUrl, name: fileName });
        continue;
      }

      const richItems = data.rich_text || [];
      const line = richItems.map((item) => item.plain_text || '').join('');
      if (!line || line.includes('LINE 對話記錄')) continue;

      const meta = line.match(/^【(.+?)】(.+)$/);
      if (meta) {
        if (current) messages.push(current);
        current = { meta: line.slice(0, 80), text: '', outgoing: /Seven Jr\.|附件解析/.test(line), images: [], files: [], links: [] };
        continue;
      }
      if (current) {
        current.text = current.text ? `${current.text}\n${line}` : line;
        // 文字中夾帶的超連結（例如附件紀錄頁連結）保留為可點連結。
        for (const item of richItems) {
          const href = item.href || item.text?.link?.url || '';
          if (href) current.links.push({ url: href, label: (item.plain_text || '連結').slice(0, 60) });
        }
      }
    }
    if (current) messages.push(current);

    return { id: page.id, name, url: page.url || '', targetType, groupId, roomId, userId, messages: messages.slice(0, 30) };
  } catch {
    return { name: '', url: conversationUrl, messages: [] };
  }
}

function sourceConversationTarget(conversation) {
  if (!conversation) return null;
  const name = conversation.name || '來源對話';
  if (conversation.groupId) {
    return {
      value: `group:${conversation.groupId}`,
      name,
      label: `整個來源群組：${name}`,
    };
  }
  if (conversation.roomId) {
    return {
      value: `room:${conversation.roomId}`,
      name,
      label: `整個來源聊天室：${name}`,
    };
  }
  if (conversation.userId) {
    return {
      value: `user:${conversation.userId}`,
      name,
      label: `來源個人對話：${name}`,
    };
  }
  return null;
}

async function loadSourceConversationRecipients(conversation) {
  if (!conversation) return [];
  const source = conversation.roomId
    ? { type: 'room', id: conversation.roomId }
    : conversation.groupId
      ? { type: 'group', id: conversation.groupId }
      : null;
  if (!source) return [];

  const indexedRecipients = await loadIndexedSourceConversationRecipients(conversation, source);
  if (indexedRecipients.length) return indexedRecipients;

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return [];

  try {
    const memberIds = await listLineMemberIds(source);
    const profiles = await Promise.all(memberIds.slice(0, 500).map(async (userId) => {
      const profile = await getLineMemberProfile(source, userId).catch(() => null);
      return {
        userId,
        displayName: profile?.displayName || userId,
      };
    }));

    return profiles
      .filter((profile) => profile.userId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'))
      .map((profile) => ({
        value: `user:${profile.userId}`,
        label: `${profile.displayName}｜${conversation.name || '來源群組'}成員`,
      }));
  } catch {
    return [];
  }
}

async function loadIndexedSourceConversationRecipients(conversation, source) {
  const dataSourceId = process.env.SEVEN_LINE_GROUP_MEMBER_INDEX_DATA_SOURCE_ID || process.env.SEVEN_LINE_GROUP_MEMBERS_DATA_SOURCE_ID || '';
  if (!dataSourceId) return [];

  const targetProperty = source.type === 'room' ? 'RoomID' : 'GroupID';
  try {
    const result = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: 100,
        filter: { property: targetProperty, rich_text: { equals: source.id } },
        sorts: [{ property: '成員顯示名稱', direction: 'ascending' }],
      },
    });

    return (result.results || [])
      .map((page) => {
        const userId = textProperty(page.properties?.['UserID']);
        const displayName = textProperty(page.properties?.['成員顯示名稱']) || textProperty(page.properties?.['成員選項名稱']) || userId;
        return userId ? {
          value: `user:${userId}`,
          label: `${displayName}｜${conversation.name || '來源群組'}成員`,
        } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function listLineMemberIds(source) {
  const pathname = source.type === 'room'
    ? `/v2/bot/room/${encodeURIComponent(source.id)}/members/ids`
    : `/v2/bot/group/${encodeURIComponent(source.id)}/members/ids`;
  const memberIds = [];
  let start = '';
  do {
    const query = start ? `?start=${encodeURIComponent(start)}` : '';
    const response = await lineRequest(`${pathname}${query}`);
    memberIds.push(...(response.memberIds || []));
    start = response.next || '';
  } while (start);
  return [...new Set(memberIds)];
}

async function getLineMemberProfile(source, userId) {
  const pathname = source.type === 'room'
    ? `/v2/bot/room/${encodeURIComponent(source.id)}/member/${encodeURIComponent(userId)}`
    : `/v2/bot/group/${encodeURIComponent(source.id)}/member/${encodeURIComponent(userId)}`;
  return lineRequest(pathname);
}

async function lineRequest(pathname) {
  const response = await fetch(`https://api.line.me${pathname}`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  const responseText = await response.text();
  const json = responseText ? JSON.parse(responseText) : {};
  if (!response.ok) {
    throw new Error(json.message || responseText || `LINE request failed: ${response.status}`);
  }
  return json;
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
    sourceText: textProperty(properties['來源原文']),
    conversationUrl: properties['關聯 Notion 頁面']?.url || '',
    parentIds: (properties['母任務']?.relation || []).map((relation) => normalizeId(relation.id)),
    plannedMessage: textProperty(properties['預定訊息內容']),
    plannedTargetName: textProperty(properties['預定發送對象']),
    plannedTargetId: textProperty(properties['預定發送對象ID']),
    nextActionAt: properties['下次行動時間']?.date?.start || '',
    nextActionMode: properties['下次行動模式']?.select?.name || '提醒我',
    nextActionNote: textProperty(properties['下次行動說明']),
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
  .move-row { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
  .quick-status-control { flex: 1 1 160px; display: flex; align-items: center; gap: 6px; min-width: 150px; }
  .quick-save-state { min-width: 56px; font-size: 11px; color: #2b8a3e; white-space: nowrap; }
  .edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .edit-grid label, .edit-full { display: block; font-size: 12px; color: #52606d; font-weight: 700; margin-bottom: 8px; }
  .edit-grid select, .edit-grid input, .edit-full textarea { display: block; width: 100%; margin-top: 4px; font-size: 14px; font-weight: 400; padding: 9px 10px; border: 1px solid #cbd2d9; border-radius: 8px; background: #fff; font-family: inherit; color: #1f2933; }
  .save-btn { width: 100%; font-size: 15px; font-weight: 700; padding: 12px; border: 0; border-radius: 10px; background: #2f80ed; color: #fff; cursor: pointer; }
  .save-btn:disabled { background: #9aa5b1; }
  .planned-actions { display: flex; gap: 8px; }
  .save-btn.half { flex: 1; width: auto; }
  .save-btn.send { background: #e8590c; }
  .quick-days { display: flex; gap: 6px; margin: 0 0 10px; flex-wrap: wrap; }
  .day-btn { font-size: 12px; padding: 6px 12px; border: 1px solid #cbd2d9; border-radius: 999px; background: #fff; color: #3e4c59; cursor: pointer; }
  .day-btn:hover { border-color: #2f80ed; color: #2f80ed; }
  .edit-grid label input[type="datetime-local"] { display: block; width: 100%; margin-top: 4px; font-size: 14px; font-weight: 400; padding: 9px 10px; border: 1px solid #cbd2d9; border-radius: 8px; background: #fff; font-family: inherit; color: #1f2933; }
  select.project-move, select.parent-move, select.status-quick { flex: 1; min-width: 0; font-size: 12px; padding: 6px 8px; border: 1px solid #dee2e6; border-radius: 8px; background: #f8f9fa; color: #495057; }
  select.status-quick.saving { opacity: .65; }
  .card.task.archived-inline { opacity: .58; border-style: dashed; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .task-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
  .hint { font-size: 13px; color: #52606d; background: #fff; border: 1px dashed #cbd2d9; border-radius: 10px; padding: 12px; }
  .hint a { color: #2f80ed; }
  .chat { background: #dfe7ef; border-radius: 12px; padding: 12px; }
  .msg { background: #fff; border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; max-width: 92%; }
  .msg.out { background: #d3f9d8; margin-left: auto; }
  .msg.src { border: 2px solid #e8590c; }
  .src-tag { font-size: 11px; font-weight: 700; color: #e8590c; margin-bottom: 3px; }
  .msg-meta { font-size: 11px; color: #748094; margin-bottom: 2px; }
  .msg-text { font-size: 13px; white-space: pre-wrap; line-height: 1.5; }
  .msg-img { display: block; max-width: 100%; max-height: 320px; border-radius: 8px; margin-top: 6px; border: 1px solid #e0e4e8; }
  .msg-file { font-size: 13px; margin-top: 4px; }
  .msg-file a { color: #2f80ed; }
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

function defaultDraftMessage(task) {
  const ownerPart = task.owner ? `${task.owner}，您好！` : '您好！';
  const stepPart = task.nextStep ? `（${task.nextStep}）` : '';
  return `${ownerPart}想跟您確認一下「${task.title}」目前的進度${stepPart}，方便的時候再麻煩回覆，謝謝！`;
}

// Notion 日期（ISO）轉 <input type="datetime-local"> 的台北時間值。
function toDatetimeLocal(isoValue) {
  if (!isoValue) return '';
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  return parts.replace(' ', 'T');
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
