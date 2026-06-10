import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
loadEnv(path.join(root, '.env'));

const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
const dataSources = {
  tasks: process.env.SEVEN_TASKS_DATA_SOURCE_ID,
  messages: process.env.SEVEN_MESSAGES_DATA_SOURCE_ID,
  progress: process.env.SEVEN_PROGRESS_REPORTS_DATA_SOURCE_ID,
  conversations: process.env.SEVEN_CONVERSATIONS_DATA_SOURCE_ID,
  responsibilities: process.env.SEVEN_RESPONSIBILITY_DATA_SOURCE_ID,
};
const reportTimezone = process.env.SEVEN_REPORT_TIMEZONE || 'Asia/Taipei';

if (!notionToken) throw new Error('NOTION_TOKEN is not set.');
if (!dataSources.tasks) throw new Error('SEVEN_TASKS_DATA_SOURCE_ID is not set.');

const today = dateOnlyInTimezone(new Date(), reportTimezone);
const reportPath = path.join(root, 'reports', `sevenam-0800-daily-report-${today}.html`);

const [tasks, messages, progressReports, responsibilities, calendar] = await Promise.all([
  listTasks(),
  listMessages(),
  listProgressReports(),
  listResponsibilities(),
  loadCalendarSchedule(today),
]);

const openTasks = tasks.filter((item) => !['完成', '已完成', '封存', '取消'].includes(item.status));
const goalGapTasks = openTasks.filter((item) => !item.goalStatus || ['待負責人口述', '待上傳給 Codex', 'Codex 待確認', '需補充', '未確認'].includes(item.goalStatus) || !item.goalDefinition);
const highPriorityTasks = openTasks.filter((item) => item.priority === '高' || item.confidence === '低').slice(0, 8);
const importantMessages = messages.filter((item) => item.score > 0).slice(0, 8);
const responsibilityGaps = responsibilities.filter((item) => item.status && item.status !== '完成').slice(0, 6);

const candidates = buildCandidates({ goalGapTasks, highPriorityTasks, importantMessages, responsibilityGaps }).slice(0, 12);
const projectSummary = summarizeByProject([...openTasks, ...importantMessages, ...progressReports]);
const html = buildHtml({
  today,
  generatedAt: new Date().toISOString(),
  tasks,
  openTasks,
  goalGapTasks,
  highPriorityTasks,
  messages: importantMessages,
  progressReports,
  responsibilities: responsibilityGaps,
  calendar,
  candidates,
  projectSummary,
});

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, html, 'utf8');

console.log(JSON.stringify({
  ok: true,
  reportPath,
  counts: {
    tasks: tasks.length,
    openTasks: openTasks.length,
    goalGapTasks: goalGapTasks.length,
    importantMessages: importantMessages.length,
    progressReports: progressReports.length,
    responsibilityGaps: responsibilityGaps.length,
    calendarEvents: calendar.events.length,
    candidates: candidates.length,
  },
}, null, 2));

async function listTasks() {
  const result = await queryDataSource(dataSources.tasks, {
    page_size: 80,
    sorts: [{ property: '最後更新', direction: 'descending' }],
  });

  return (result.results || []).map((page) => ({
    id: page.id,
    title: textProp(page, '任務名稱') || '未命名任務',
    project: selectProp(page, '專案') || '未分類',
    priority: selectProp(page, '優先級') || '未標示',
    status: selectProp(page, '狀態') || '未標示',
    confirmation: selectProp(page, '確認狀態') || '',
    confidence: selectProp(page, '信心等級') || '',
    goalStatus: selectProp(page, 'Codex 目標確認') || '',
    source: selectProp(page, '來源') || '',
    owner: textProp(page, '負責人') || '',
    dueDate: dateProp(page, '截止日') || '',
    updatedAt: dateProp(page, '最後更新') || page.last_edited_time || '',
    summary: textProp(page, 'Codex 判斷摘要') || textProp(page, '來源原文') || '',
    goalDefinition: textProp(page, '完成目標定義') || '',
    nextStep: textProp(page, '下一步給負責人') || textProp(page, '下一步') || '',
    url: page.url,
  }));
}

async function listMessages() {
  if (!dataSources.messages) return [];
  const since = `${today}T00:00:00+08:00`;
  const result = await queryDataSource(dataSources.messages, {
    page_size: 80,
    filter: { property: '排序時間', date: { on_or_after: since } },
    sorts: [{ property: '排序時間', direction: 'descending' }],
  });

  const messages = [];
  for (const page of result.results || []) {
    const text = textProp(page, '文字內容') || textProp(page, '原始內容') || '';
    const score = scoreMessage(text);
    const conversation = await getConversation(pageRelationId(page, '對話主檔'));
    messages.push({
      id: page.id,
      title: messageTitle(text),
      project: conversation.project || inferProject(text),
      speaker: textProp(page, '發話者名稱') || selectProp(page, '發話者類型') || '',
      source: selectProp(page, '訊息來源') || '',
      type: selectProp(page, '訊息類型') || '',
      time: dateProp(page, '排序時間') || page.created_time || '',
      summary: text,
      nextStep: inferNextStep(text),
      score,
      url: page.url,
    });
  }
  return messages.sort((a, b) => b.score - a.score || new Date(b.time || 0) - new Date(a.time || 0));
}

async function listProgressReports() {
  if (!dataSources.progress) return [];
  const result = await queryDataSource(dataSources.progress, {
    page_size: 30,
    sorts: [{ property: '報表週期', direction: 'descending' }],
  });

  return (result.results || []).map((page) => ({
    id: page.id,
    title: textProp(page, '報表名稱') || '未命名進度',
    project: selectProp(page, '專案') || '未分類',
    owner: textProp(page, '負責人') || '',
    status: selectProp(page, '目前狀態') || '',
    completion: numberProp(page, '完成度'),
    blocker: textProp(page, '主要卡點') || '',
    decision: textProp(page, '需要 Seven 決策') || '',
    progress: textProp(page, '本週進展') || '',
    nextStep: textProp(page, '下一步') || '',
    cycle: dateProp(page, '報表週期') || page.last_edited_time || '',
    url: page.url,
  })).slice(0, 10);
}

async function listResponsibilities() {
  if (!dataSources.responsibilities) return [];
  const result = await queryDataSource(dataSources.responsibilities, {
    page_size: 40,
    sorts: [{ property: '最後確認日', direction: 'descending' }],
  });

  return (result.results || []).map((page) => ({
    id: page.id,
    title: textProp(page, '權責項目名稱') || '未命名權責',
    project: selectProp(page, '第一層：總控專案') || '未分類',
    status: selectProp(page, '選擇狀態') || selectProp(page, '狀態') || '',
    sensitivity: selectProp(page, '敏感等級') || '',
    groupCount: numberProp(page, '候選群組數') || 0,
    ownerCount: numberProp(page, '候選負責人數') || 0,
    instruction: textProp(page, '選擇說明') || '',
    url: page.url,
  }));
}

function buildCandidates({ goalGapTasks, highPriorityTasks, importantMessages, responsibilityGaps }) {
  const seen = new Set();
  const rows = [];
  const add = (item) => {
    const key = `${item.sourceType}:${item.sourceId || item.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(item);
  };

  goalGapTasks.slice(0, 5).forEach((task) => add({
    sourceId: task.id,
    title: task.title,
    sourceType: 'TASK_GOAL_GAP',
    project: task.project,
    risk: task.priority === '高' ? '高' : '一般',
    confidence: task.confidence || '中',
    summary: task.summary || task.nextStep || '任務缺少明確完成條件，需要早上先補目標。',
    suggestedGoal: task.goalDefinition || task.nextStep || '請負責人口述完成目標、驗收方式與今天要做到哪一步。',
    url: task.url,
    preferredAction: 'REQUEST_OWNER_GOAL_STATEMENT',
  }));

  highPriorityTasks.slice(0, 4).forEach((task) => add({
    sourceId: task.id,
    title: task.title,
    sourceType: 'HIGH_PRIORITY_TASK',
    project: task.project,
    risk: task.priority === '高' ? '高' : '一般',
    confidence: task.confidence || '中',
    summary: task.summary || task.nextStep || '高優先任務需要早上確認今日下一步。',
    suggestedGoal: task.goalDefinition || task.nextStep || '今天確認下一步並回報狀態。',
    url: task.url,
    preferredAction: 'SET_TASK_GOAL',
  }));

  importantMessages.slice(0, 4).forEach((message) => add({
    sourceId: message.id,
    title: message.title,
    sourceType: 'LINE_MESSAGE_SIGNAL',
    project: message.project,
    risk: message.score >= 5 ? '高' : '一般',
    confidence: message.project === '未分類' ? '低' : '中',
    summary: message.summary,
    suggestedGoal: message.nextStep,
    url: message.url,
    preferredAction: message.project === '未分類' ? 'CHANGE_PROJECT' : 'CREATE_TASK',
  }));

  responsibilityGaps.slice(0, 3).forEach((item) => add({
    sourceId: item.id,
    title: item.title,
    sourceType: 'RESPONSIBILITY_GAP',
    project: item.project,
    risk: item.sensitivity === '高' ? '高' : '一般',
    confidence: item.groupCount && item.ownerCount ? '中' : '低',
    summary: item.instruction || '權責定義尚未完整，需要指定主要群組或主要負責人。',
    suggestedGoal: '補齊權責窗口，讓後續任務能自動找到追蹤對象。',
    url: item.url,
    preferredAction: 'REQUEST_OWNER_GOAL_STATEMENT',
  }));

  return rows.sort((a, b) => riskScore(b.risk) - riskScore(a.risk));
}

function summarizeByProject(items) {
  const map = new Map();
  for (const item of items) {
    const project = item.project || '未分類';
    const row = map.get(project) || { project, count: 0, high: 0, nextSteps: [] };
    row.count += 1;
    if (item.priority === '高' || item.risk === '高') row.high += 1;
    const detail = firstMeaningful([item.nextStep, item.title, item.summary]);
    if (detail && row.nextSteps.length < 4 && !row.nextSteps.includes(detail)) row.nextSteps.push(detail);
    map.set(project, row);
  }
  return [...map.values()].sort((a, b) => b.high - a.high || b.count - a.count).slice(0, 8);
}

function projectSummaryCardHtml(item) {
  const listedCount = item.nextSteps.length;
  const remainingCount = Math.max(0, item.count - listedCount);
  return `<article class="summary-card"><h3>${escapeHtml(item.project)}</h3><p>相關項目 ${item.count} 筆，高優先 ${item.high} 筆。</p>${listedCount ? `<ol class="project-items">${item.nextSteps.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ol>` : ''}${remainingCount ? `<p>另有 ${remainingCount} 筆未列在此卡片中。</p>` : ''}</article>`;
}

function buildHtml(data) {
  const candidatesJson = JSON.stringify(data.candidates).replace(/</g, '\\u003c');
  const calendarBusyCount = data.calendar.events.filter((item) => item.busy).length;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SevenAM 08:30 日報 - ${escapeHtml(data.today)}</title>
  <style>
    :root{--bg:#f6f5ef;--ink:#20242a;--muted:#66707c;--line:#d9d7cc;--surface:#fffdf7;--band:#27313a;--green:#2f6f5e;--blue:#315f8c;--red:#a2453f;--yellow:#936b26;--violet:#6a527d;--shadow:0 12px 30px rgba(40,42,35,.08)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Microsoft JhengHei","PingFang TC",system-ui,sans-serif;line-height:1.5}button,input,select,textarea{font:inherit}.app{min-height:100vh;display:grid;grid-template-columns:236px minmax(0,1fr)}aside{position:sticky;top:0;height:100vh;background:var(--band);color:#f7f4e9;padding:22px 18px}.brand strong{display:block;font-size:24px;line-height:1.2}.brand span{display:block;color:#d7dfd9;font-size:13px;margin-top:8px}nav{display:grid;gap:8px;margin-top:28px}nav a{color:#edf0eb;text-decoration:none;padding:9px 10px;border-radius:6px}nav a:hover{background:rgba(255,255,255,.08)}main{padding:24px;min-width:0}.top{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:18px}h1{margin:0;font-size:28px;line-height:1.22}.sub{color:var(--muted);margin-top:5px;font-size:14px}.pill{display:inline-flex;align-items:center;min-height:26px;padding:3px 9px;border-radius:999px;background:#ece9df;color:#3f4852;font-size:12px;white-space:nowrap}.pill.green{background:#e2efe9;color:var(--green)}.pill.blue{background:#e4edf6;color:var(--blue)}.pill.red{background:#f3e1df;color:var(--red)}.pill.yellow{background:#f5ead6;color:var(--yellow)}.pill.violet{background:#ebe3ef;color:var(--violet)}.status-line,.meta{display:flex;gap:7px;flex-wrap:wrap}.status-line{justify-content:flex-end}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:18px}.metric,section{background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow)}.metric{padding:12px 13px;min-height:82px}.metric span{display:block;color:var(--muted);font-size:13px}.metric strong{display:block;font-size:27px;margin-top:5px}.calendar-list{display:grid;gap:10px;padding:14px}.calendar-item{display:grid;grid-template-columns:126px minmax(0,1fr) 90px;gap:12px;align-items:start;border:1px solid var(--line);background:#fffef9;border-radius:8px;padding:11px 12px}.calendar-time{font-weight:700;color:var(--blue)}.calendar-title{font-weight:700}.calendar-meta{color:var(--muted);font-size:13px;margin-top:4px}.calendar-empty{padding:14px;color:var(--muted)}section{margin-bottom:16px;overflow:hidden}.section-head{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:13px 15px;background:#fbfaf4;border-bottom:1px solid var(--line)}.section-head h2{margin:0;font-size:18px}.section-head span{color:var(--muted);font-size:13px}.summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:14px}.summary-card,.candidate{border:1px solid var(--line);border-radius:8px;background:#fffef9;padding:13px}.summary-card h3,.candidate h3{margin:0;font-size:16px}.summary-card p,.candidate p{margin:8px 0 0;color:#3c4248}.project-items{margin:9px 0 0;padding-left:22px;color:#3c4248}.project-items li{margin:5px 0;padding-left:3px}.candidate-list{display:grid;gap:12px;padding:14px}.candidate.active{border-color:#7fa996;box-shadow:0 0 0 2px rgba(47,111,94,.14)}.candidate.saved{border-color:#9aaea5;background:#fbfdf9}.candidate-main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px}.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-content:start}.action-btn,.main-btn,.ghost-btn{min-height:36px;border:1px solid var(--line);border-radius:6px;background:#fffdf7;color:var(--ink);cursor:pointer;padding:8px 10px;text-align:center}.action-btn:hover,.ghost-btn:hover{background:#f2f0e7}.action-btn.selected{border-color:var(--green);background:#e8f3ee;color:#1f5145;font-weight:700}.action-btn.danger.selected{border-color:var(--red);background:#f6e6e4;color:#8c342e}.inline-editor{border-top:1px solid var(--line);background:#fbfaf4;margin-top:12px;padding:13px;border-radius:0 0 8px 8px}.inline-editor-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px}.inline-editor-head strong{display:block;font-size:15px}.inline-editor-head span{color:var(--muted);font-size:13px}.form-block{display:grid;gap:12px;margin-top:13px}label{display:grid;gap:6px;color:var(--muted);font-size:13px;font-weight:700}input,select,textarea{width:100%;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);padding:9px 10px;min-height:38px}textarea{min-height:90px;resize:vertical;line-height:1.55}.panel-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.main-btn{background:var(--green);color:#fff;border-color:var(--green);font-weight:700}.main-btn:disabled{cursor:not-allowed;opacity:.56;background:#7d8f88;border-color:#7d8f88}.summary-box,.decision-summary{border:1px solid var(--line);background:#fbfaf4;border-radius:8px;padding:11px;color:#48505a;font-size:13px;margin-top:14px}.decision-summary{border-color:#c9dbd1;background:#eef6f1;color:#284c42}.history,.submit-section{padding:14px;display:grid;gap:8px}.history-row{display:grid;grid-template-columns:130px minmax(0,1fr) 110px;gap:10px;border-bottom:1px solid var(--line);padding:8px 0;font-size:14px}.history-row:last-child{border-bottom:0}.submit-card{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:14px;align-items:center;border:1px solid var(--line);border-radius:8px;background:#fffef9;padding:14px}.submit-card strong{display:block;font-size:18px;margin-bottom:4px}.submit-card p{margin:0;color:var(--muted)}.submit-result{display:none;border:1px solid #b8d2c6;background:#edf6f1;color:#234d42;border-radius:8px;padding:12px 13px;font-size:14px}.submit-result.show{display:block}@media(max-width:920px){.app{display:block}aside{position:static;height:auto}main{padding:16px}.top{display:block}.status-line{justify-content:flex-start;margin-top:12px}.metrics,.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.candidate-main,.history-row,.submit-card,.calendar-item{grid-template-columns:1fr}}@media(max-width:560px){.metrics,.summary-grid,.actions,.panel-actions{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand"><strong>SevenAM<br>08:30 日報</strong><span>由 SevenAM Notion 資料庫產生<br>${escapeHtml(data.today)} 08:30</span></div>
      <nav><a href="#summary">總覽</a><a href="#calendar">今日行程</a><a href="#projects">專案</a><a href="#candidates">候選項目</a><a href="#history">本次決策</a><a href="#submitReport">送出日報</a></nav>
    </aside>
    <main>
      <div class="top">
        <div><h1>早上 8 點半總控日報</h1><div class="sub">這份是用 SevenAM 專案的 Notion 資料庫產生的本機預覽，不會寫回 Notion，也不會送 LINE。</div></div>
        <div class="status-line"><span class="pill green">SevenAM</span><span class="pill blue">${escapeHtml(data.today)}</span><span class="pill yellow">候選 ${data.candidates.length}</span><span class="pill red">高風險 ${data.candidates.filter((item) => item.risk === '高').length}</span></div>
      </div>
      <div class="metrics">
        <div class="metric"><span>總控任務</span><strong>${data.tasks.length}</strong></div>
        <div class="metric"><span>未完成任務</span><strong>${data.openTasks.length}</strong></div>
        <div class="metric"><span>待補目標</span><strong>${data.goalGapTasks.length}</strong></div>
        <div class="metric"><span>今日訊息線索</span><strong>${data.messages.length}</strong></div>
        <div class="metric"><span>今日行程</span><strong>${calendarBusyCount}</strong></div>
      </div>
      <section id="summary"><div class="section-head"><h2>今日開局摘要</h2><span>先定方向，再處理候選項</span></div><div class="summary-grid">
        <article class="summary-card"><h3>今日總控重點</h3><p>${escapeHtml(firstMeaningful([data.highPriorityTasks[0]?.nextStep, data.goalGapTasks[0]?.suggestedGoal, '先處理待補目標與高優先任務。']))}</p></article>
        <article class="summary-card"><h3>待負責人口述</h3><p>目前有 ${data.goalGapTasks.length} 筆任務缺少明確完成目標，08:30 適合先要求負責人口述。</p></article>
        <article class="summary-card"><h3>今日行程安排</h3><p>${escapeHtml(calendarSummaryText(data.calendar))}</p></article>
        <article class="summary-card"><h3>近期進度</h3><p>${escapeHtml(data.progressReports[0]?.nextStep || data.progressReports[0]?.progress || '目前沒有可摘要的最新進度報表。')}</p></article>
        <article class="summary-card"><h3>權責缺口</h3><p>${data.responsibilities.length ? `有 ${data.responsibilities.length} 筆權責定義仍待補齊。` : '目前沒有讀到待補權責項目。'}</p></article>
      </div></section>
      <section id="calendar"><div class="section-head"><h2>今天的行程安排</h2><span>${escapeHtml(data.calendar.sourceLabel)}</span></div>${calendarSectionHtml(data.calendar)}</section>
      <section id="projects"><div class="section-head"><h2>專案狀態掃描</h2><span>依任務、訊息、進度報表彙整</span></div><div class="summary-grid">
        ${data.projectSummary.map(projectSummaryCardHtml).join('') || '<article class="summary-card"><h3>沒有專案項目</h3><p>目前沒有足夠資料可彙整。</p></article>'}
      </div></section>
      <section id="candidates"><div class="section-head"><h2>候選項目介入</h2><span>每一筆可原地決策並暫存</span></div><div class="candidate-list" id="candidateList"></div></section>
      <section id="history"><div class="section-head"><h2>本次決策紀錄</h2><span>預覽會寫回的決策，不含真實寫回</span></div><div class="history" id="decisionHistory"><div class="history-row"><strong>尚未決策</strong><span>請在候選項目中點選一個介入動作。</span><span class="pill">Draft</span></div></div></section>
      <section id="submitReport"><div class="section-head"><h2>送出日報決策</h2><span>送出目前只產生預覽摘要</span></div><div class="submit-section"><div class="submit-card"><div><strong id="submitStatusTitle">尚未有可送出的決策</strong><p id="submitStatusText">請先完成至少一筆候選項決策。</p><div class="meta" id="submitMeta"><span class="pill">已決策 0</span><span class="pill yellow">未決策 ${data.candidates.length}</span></div></div><button class="main-btn" id="submitReportButton" type="button" onclick="submitDailyReport()" disabled>送出本次日報決策</button></div><div class="submit-result" id="submitResult"></div></div></section>
    </main>
  </div>
  <script>
    const actions=[{key:"CREATE_TASK",label:"建立任務",status:"已建立任務"},{key:"DISMISS_NOT_TASK",label:"不是任務",status:"不是任務",danger:true},{key:"CHANGE_PROJECT",label:"改專案",status:"已改專案"},{key:"SET_PROJECT_GOAL",label:"指定專案目標",status:"已指定專案目標"},{key:"SET_TASK_GOAL",label:"指定任務目標",status:"已指定任務目標"},{key:"REQUEST_OWNER_GOAL_STATEMENT",label:"要求口述目標",status:"待負責人口述目標"}];
    const candidates=${candidatesJson};
    let selected=null; const decisions=new Map(); renderCandidates(); updateSubmitState();
    function renderCandidates(){const list=document.getElementById("candidateList");list.innerHTML=candidates.map(item=>\`<article class="candidate \${selected&&selected.id===item.sourceId?"active":""} \${decisions.has(item.sourceId)?"saved":""}" id="\${item.sourceId}"><div class="candidate-main"><div><h3>\${escapeHtml(item.title)}</h3><p>\${escapeHtml(item.summary)}</p><div class="meta"><span class="pill blue">\${escapeHtml(item.sourceType)}</span><span class="pill green">\${escapeHtml(getDecisionField(item.sourceId,"targetProject")||item.project)}</span><span class="pill \${item.risk==="高"?"red":"yellow"}">\${escapeHtml(item.risk)}風險</span><span class="pill violet">信心 \${escapeHtml(item.confidence)}</span>\${decisionStatusChip(item.sourceId)}</div>\${decisionSummary(item.sourceId)}</div><div class="actions">\${actions.map(action=>\`<button class="action-btn \${action.danger?"danger":""} \${selected&&selected.id===item.sourceId&&selected.action===action.key?"selected":""}" type="button" onclick="chooseAction('\${item.sourceId}','\${action.key}')">\${action.label}</button>\`).join("")}</div></div>\${selected&&selected.id===item.sourceId?inlineEditor():""}</article>\`).join("");if(selected) bindInlinePreview();}
    function chooseAction(candidateId,actionKey){const candidate=candidates.find(item=>item.sourceId===candidateId);const action=actions.find(item=>item.key===actionKey);selected={...candidate,id:candidate.sourceId,action:action.key,actionLabel:action.label,status:action.status};renderCandidates();document.getElementById(candidateId).scrollIntoView({behavior:"smooth",block:"nearest"});}
    function inlineEditor(){const fields=fieldSetFor(selected.action);return \`<div class="inline-editor"><div class="inline-editor-head"><div><strong>\${escapeHtml(selected.actionLabel)}</strong><span>\${escapeHtml(selected.status)} / \${escapeHtml(selected.action)}</span></div><span class="pill green">原地填寫</span></div><div class="form-block" id="dynamicFields">\${fields.map(field=>\`<label>\${field.label}\${field.type==="textarea"?\`<textarea id="\${field.id}">\${escapeHtml(field.value||"")}</textarea>\`:field.type==="select"?\`<select id="\${field.id}">\${field.options.map(option=>\`<option>\${escapeHtml(option)}</option>\`).join("")}</select>\`:\`<input id="\${field.id}" value="\${escapeHtml(field.value||"")}">\`}</label>\`).join("")}</div><div class="panel-actions"><button class="ghost-btn" type="button" onclick="clearSelection()">取消</button><button class="main-btn" type="button" onclick="saveDecision()">儲存並收起</button></div><div class="summary-box" id="writePreview"></div></div>\`;}
    function fieldSetFor(actionKey){const commonProjects=[...new Set(candidates.map(item=>item.project).filter(Boolean).concat(["未分類"]))];if(actionKey==="CREATE_TASK")return[{id:"targetProject",label:"修正後總控專案",type:"select",options:commonProjects},{id:"taskGoal",label:"指定任務目標",type:"textarea",value:selected.suggestedGoal},{id:"owner",label:"負責人或群組",type:"input",value:"待指定"},{id:"controllerNote",label:"控制者備註",type:"textarea",value:""}];if(actionKey==="DISMISS_NOT_TASK")return[{id:"dismissReason",label:"排除原因",type:"select",options:["只是背景資訊","重複項目","不需要追蹤","交由人工處理"]},{id:"controllerNote",label:"控制者備註",type:"textarea",value:""}];if(actionKey==="CHANGE_PROJECT")return[{id:"targetProject",label:"修正後總控專案",type:"select",options:commonProjects},{id:"controllerNote",label:"改派原因",type:"textarea",value:""}];if(actionKey==="SET_PROJECT_GOAL")return[{id:"targetProject",label:"總控專案",type:"select",options:commonProjects},{id:"projectGoal",label:"指定專案目標",type:"textarea",value:"今天先完成專案目標定義與下一步安排。"},{id:"controllerNote",label:"控制者備註",type:"textarea",value:""}];if(actionKey==="SET_TASK_GOAL")return[{id:"taskGoal",label:"指定任務目標",type:"textarea",value:selected.suggestedGoal},{id:"dueDate",label:"期望完成日",type:"input",value:"${escapeJs(data.today)}"},{id:"controllerNote",label:"控制者備註",type:"textarea",value:""}];return[{id:"ownerOrOwnerGroup",label:"要求口述目標對象",type:"input",value:"待指定負責人"},{id:"candidateQuestion",label:"要發給負責人的問題",type:"textarea",value:"請口述這件事的完成目標：怎樣叫完成、誰驗收、今天要做到哪一步？"},{id:"controllerNote",label:"控制者備註",type:"textarea",value:""}];}
    function bindInlinePreview(){updateWritePreview();document.querySelectorAll("#dynamicFields input,#dynamicFields select,#dynamicFields textarea").forEach(input=>input.addEventListener("input",updateWritePreview));}
    function updateWritePreview(){if(!selected)return;const preview=document.getElementById("writePreview");if(!preview)return;const values=[...document.querySelectorAll("#dynamicFields input,#dynamicFields select,#dynamicFields textarea")].map(input=>\`<strong>\${escapeHtml(input.parentElement.firstChild.textContent.trim())}</strong>：\${escapeHtml(input.value||"未填")}\`).join("<br>");preview.innerHTML=\`<strong>介入狀態</strong>：\${escapeHtml(selected.status)}<br><strong>介入動作</strong>：\${escapeHtml(selected.action)}<br>\${values}\`;}
    function saveDecision(){if(!selected)return;decisions.set(selected.id,{id:selected.id,title:selected.title,action:selected.action,actionLabel:selected.actionLabel,status:selected.status,at:new Date().toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit"}),fields:collectInlineFields()});selected=null;renderCandidates();renderHistory();updateSubmitState();}
    function renderHistory(){const rows=[...decisions.values()];document.getElementById("decisionHistory").innerHTML=rows.length?rows.map(item=>\`<div class="history-row"><strong>\${escapeHtml(item.at)}</strong><span>\${escapeHtml(item.title)}<br>\${escapeHtml(item.actionLabel)} / \${escapeHtml(item.action)}</span><span class="pill green">\${escapeHtml(item.status)}</span></div>\`).join(""):\`<div class="history-row"><strong>尚未決策</strong><span>請在候選項目中點選一個介入動作。</span><span class="pill">Draft</span></div>\`;}
    function updateSubmitState(){const decided=decisions.size;const undecided=candidates.length-decided;const button=document.getElementById("submitReportButton");button.disabled=decided===0;document.getElementById("submitStatusTitle").innerText=decided===0?"尚未有可送出的決策":"可以送出本次日報決策";document.getElementById("submitStatusText").innerText=decided===0?"請先完成至少一筆候選項決策。":undecided>0?\`目前已暫存 \${decided} 筆，還有 \${undecided} 筆未決策；可先送出已處理項目。\`:\`全部 \${decided} 筆候選項目都已完成決策，可以送出。\`;document.getElementById("submitMeta").innerHTML=\`<span class="pill green">已決策 \${decided}</span><span class="pill \${undecided?"yellow":"green"}">未決策 \${undecided}</span>\`;}
    function submitDailyReport(){if(!decisions.size)return;const rows=[...decisions.values()];const result=document.getElementById("submitResult");result.className="submit-result show";result.innerHTML=\`<strong>已送出 08:30 日報決策預覽</strong><br>已送出決策：\${rows.length} 筆；未決策：\${candidates.length-rows.length} 筆。<br><br>\${rows.map(item=>\`\${escapeHtml(item.title)}：\${escapeHtml(item.actionLabel)} / \${escapeHtml(item.action)}\`).join("<br>")}\`;document.getElementById("submitReportButton").innerText="已送出本次日報決策";result.scrollIntoView({behavior:"smooth",block:"nearest"});}
    function clearSelection(){selected=null;renderCandidates();}
    function collectInlineFields(){const fields={};document.querySelectorAll("#dynamicFields input,#dynamicFields select,#dynamicFields textarea").forEach(input=>{fields[input.id]=input.value||""});return fields;}
    function decisionStatusChip(id){const decision=decisions.get(id);return decision?\`<span class="pill green">\${escapeHtml(decision.status)}</span>\`:'<span class="pill">待確認</span>';}
    function decisionSummary(id){const decision=decisions.get(id);if(!decision)return"";const important=[decision.fields.targetProject&&\`專案：\${decision.fields.targetProject}\`,decision.fields.projectGoal&&\`專案目標：\${decision.fields.projectGoal}\`,decision.fields.taskGoal&&\`任務目標：\${decision.fields.taskGoal}\`,decision.fields.ownerOrOwnerGroup&&\`口述對象：\${decision.fields.ownerOrOwnerGroup}\`,decision.fields.candidateQuestion&&\`詢問：\${decision.fields.candidateQuestion}\`,decision.fields.dismissReason&&\`原因：\${decision.fields.dismissReason}\`].filter(Boolean).slice(0,3);return \`<div class="decision-summary"><strong>\${escapeHtml(decision.actionLabel)} 已暫存</strong><br>\${important.length?important.map(escapeHtml).join("<br>"):"已記錄控制者決策。"}</div>\`;}
    function getDecisionField(id,fieldName){const decision=decisions.get(id);return decision&&decision.fields?decision.fields[fieldName]:"";}
    function escapeHtml(value){return String(value||"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));}
  </script>
</body>
</html>`;
}

async function loadCalendarSchedule(date) {
  const raw = readCalendarPayload();
  if (!raw) {
    return {
      sourceLabel: 'Google Calendar 尚未連線',
      status: 'not_configured',
      events: [],
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const sourceEvents = Array.isArray(parsed) ? parsed : parsed.events || parsed.items || [];
    const events = sourceEvents
      .map((event) => normalizeCalendarEvent(event, date))
      .filter(Boolean)
      .sort((a, b) => (a.sortKey || '').localeCompare(b.sortKey || ''));

    return {
      sourceLabel: '由 Google Calendar 整理',
      status: 'loaded',
      events,
    };
  } catch (error) {
    return {
      sourceLabel: 'Google Calendar 資料讀取失敗',
      status: 'error',
      error: error.message,
      events: [],
    };
  }
}

function readCalendarPayload() {
  const inlineJson = process.env.SEVEN_GOOGLE_CALENDAR_EVENTS_JSON || process.env.GOOGLE_CALENDAR_EVENTS_JSON || '';
  if (inlineJson.trim()) return inlineJson;

  const filePath = process.env.SEVEN_GOOGLE_CALENDAR_EVENTS_FILE || process.env.GOOGLE_CALENDAR_EVENTS_FILE || '';
  if (filePath && fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');

  return '';
}

function normalizeCalendarEvent(event, reportDate) {
  if (!event) return null;
  const title = event.summary || event.title || event.name || '未命名行程';
  const startValue = event.start?.dateTime || event.start?.date || event.start_time || event.start || '';
  const endValue = event.end?.dateTime || event.end?.date || event.end_time || event.end || '';
  const isAllDay = Boolean(event.start?.date || /^\d{4}-\d{2}-\d{2}$/.test(String(startValue)));
  const startDate = parseCalendarDate(startValue, isAllDay);
  const endDate = parseCalendarDate(endValue, isAllDay);

  if (startDate && dateOnlyInTimezone(startDate, reportTimezone) !== reportDate && !isAllDay) return null;
  if (isAllDay && String(startValue).slice(0, 10) !== reportDate) return null;

  const location = event.location || '';
  const description = event.description || event.notes || '';
  const transparency = event.transparency || event.showAs || '';
  const busy = !isAllDay && !/transparent|free/i.test(String(transparency));

  return {
    title,
    time: isAllDay ? '全天' : formatCalendarTimeRange(startDate, endDate),
    sortKey: isAllDay ? `${reportDate}T00:00:00` : startDate?.toISOString() || '',
    location,
    note: firstMeaningful([location, compactText(description, 70), event.htmlLink || event.url || '']),
    busy,
    tag: isAllDay ? '全天' : busy ? '已安排' : '參考',
  };
}

function calendarSummaryText(calendar) {
  if (calendar.status === 'not_configured') return 'SevenAM 尚未取得 Google Calendar 授權資料；此區塊會在連線後顯示今天的行程。';
  if (calendar.status === 'error') return `Google Calendar 資料讀取失敗：${calendar.error || '未知錯誤'}`;
  const busy = calendar.events.filter((item) => item.busy);
  if (!busy.length) return '今天沒有讀到已排定行程，可以優先安排深度工作與待補目標追認。';
  return `今天有 ${busy.length} 個已排定行程；先避開會議時段，再安排高優先任務。`;
}

function calendarSectionHtml(calendar) {
  if (calendar.status === 'not_configured') {
    return '<div class="calendar-empty">尚未讀到 Google Calendar 授權資料。請先提供 Calendar 事件來源，或設定 SevenAM 的 Calendar 讀取環境後，這裡就會顯示今天的真實行程。</div>';
  }
  if (calendar.status === 'error') {
    return `<div class="calendar-empty">Google Calendar 資料讀取失敗：${escapeHtml(calendar.error || '未知錯誤')}</div>`;
  }
  if (!calendar.events.length) {
    return '<div class="calendar-empty">今天沒有讀到 Google Calendar 行程。</div>';
  }
  return `<div class="calendar-list">${calendar.events.map((event) => `<div class="calendar-item"><div class="calendar-time">${escapeHtml(event.time)}</div><div><div class="calendar-title">${escapeHtml(event.title)}</div>${event.note ? `<div class="calendar-meta">${escapeHtml(event.note)}</div>` : ''}</div><div><span class="pill ${event.busy ? 'blue' : 'yellow'}">${escapeHtml(event.tag)}</span></div></div>`).join('')}</div>`;
}

function parseCalendarDate(value, isAllDay = false) {
  if (!value) return null;
  if (isAllDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return new Date(`${value}T00:00:00+08:00`);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCalendarTimeRange(start, end) {
  if (!start) return '時間未定';
  const startText = timeOnlyInTimezone(start, reportTimezone);
  const endText = end ? timeOnlyInTimezone(end, reportTimezone) : '';
  return endText && endText !== startText ? `${startText}-${endText}` : startText;
}

function compactText(value, limit) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

async function queryDataSource(id, body) {
  return notionRequest(`/v1/data_sources/${id}/query`, { method: 'POST', body });
}

async function getConversation(pageId) {
  if (!pageId || !dataSources.conversations) return { project: '' };
  try {
    const page = await notionRequest(`/v1/pages/${pageId}`, { method: 'GET' });
    return { project: selectProp(page, '總控專案') || '' };
  } catch {
    return { project: '' };
  }
}

async function notionRequest(endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.notion.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': notionVersion,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${json.message || 'Notion request failed'}`);
  return json;
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function textProp(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return '';
  if (prop.type === 'title') return richText(prop.title);
  if (prop.type === 'rich_text') return richText(prop.rich_text);
  if (prop.type === 'url') return prop.url || '';
  if (prop.type === 'email') return prop.email || '';
  if (prop.type === 'phone_number') return prop.phone_number || '';
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'status') return prop.status?.name || '';
  if (prop.type === 'number') return prop.number === null || prop.number === undefined ? '' : String(prop.number);
  if (prop.type === 'formula') return formulaText(prop.formula);
  if (prop.type === 'rollup') return rollupText(prop.rollup);
  return '';
}

function richText(value) {
  return (value || []).map((item) => item.plain_text || '').join('').trim();
}

function selectProp(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return '';
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'status') return prop.status?.name || '';
  if (prop.type === 'rich_text' || prop.type === 'title') return textProp(page, name);
  return '';
}

function dateProp(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return '';
  if (prop.type === 'date') return prop.date?.start || '';
  if (prop.type === 'created_time') return prop.created_time || '';
  if (prop.type === 'last_edited_time') return prop.last_edited_time || '';
  return '';
}

function numberProp(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return null;
  if (prop.type === 'number') return prop.number;
  return null;
}

function pageRelationId(page, name) {
  const prop = page.properties?.[name];
  return prop?.type === 'relation' ? prop.relation?.[0]?.id || '' : '';
}

function formulaText(formula) {
  if (!formula) return '';
  if (formula.type === 'string') return formula.string || '';
  if (formula.type === 'number') return formula.number === null ? '' : String(formula.number);
  if (formula.type === 'boolean') return formula.boolean ? 'true' : 'false';
  if (formula.type === 'date') return formula.date?.start || '';
  return '';
}

function rollupText(rollup) {
  if (!rollup) return '';
  if (rollup.type === 'array') return rollup.array.map((item) => formulaText(item.formula) || item.title?.map((t) => t.plain_text).join('') || item.rich_text?.map((t) => t.plain_text).join('') || item.select?.name || '').filter(Boolean).join(', ');
  if (rollup.type === 'number') return rollup.number === null ? '' : String(rollup.number);
  if (rollup.type === 'date') return rollup.date?.start || '';
  return '';
}

function scoreMessage(text) {
  const value = String(text || '');
  let score = 0;
  if (/今天|早上|下午|晚上|明天|下週|截止|要先|一定要/.test(value)) score += 2;
  if (/待辦|任務|追蹤|確認|處理|完成|回覆|報價|估價|測試|修正|上線|部署/.test(value)) score += 2;
  if (/風險|錯誤|失敗|逾期|緊急|不要|不能|壞掉|問題/.test(value)) score += 2;
  if (/Codex|Notion|LINE|Render|資料庫|群組|專案|總控/.test(value)) score += 1;
  if (value.length > 260) score += 1;
  return score;
}

function messageTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 36) + (clean.length > 36 ? '...' : '') : '未命名訊息線索';
}

function inferProject(text) {
  const value = String(text || '');
  if (/茲心園|工程|報價|估價|營造/.test(value)) return '茲心園工程';
  if (/人資|Bonnie|薪資|排班/.test(value)) return '人資';
  if (/Codex|Notion|LINE|Render|資料庫|後台|系統/.test(value)) return '系統建置';
  if (/財務|報稅|帳/.test(value)) return '財務';
  return '未分類';
}

function inferNextStep(text) {
  const value = String(text || '');
  if (/完成目標|怎樣叫完成|驗收/.test(value)) return '請負責人口述完成目標，Codex 確認後再排追蹤。';
  if (/報價|估價/.test(value)) return '確認報價/估價目前卡點與下一個回覆期限。';
  if (/資料庫|Notion|LINE|群組/.test(value)) return '確認資料是否已進入正確資料庫與專案歸屬。';
  if (/錯誤|失敗|壞掉|問題/.test(value)) return '先確認影響範圍，再建立修復任務。';
  return '確認是否成立為總控任務，並指定今日下一步。';
}

function riskScore(value) {
  return value === '高' ? 2 : 1;
}

function firstMeaningful(values) {
  return values.find((value) => value && String(value).trim()) || '';
}

function dateOnlyInTimezone(date, timeZone = 'Asia/Taipei') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function timeOnlyInTimezone(date, timeZone = 'Asia/Taipei') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('hour')}:${get('minute')}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function escapeJs(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
