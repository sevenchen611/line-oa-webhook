// SevenAM 早上 8:30 晨報：動態資料 + HTML 渲染（worker 端執行，有 Google 金鑰）。
//
// 設計（2026-06-14，目標追認後動工）：
//   - 今日行程必須讀「真實 Google Calendar 的全部日曆」（使用者決策），不可寫死。
//   - 昨日未完成 / 今日優先 / 需決策來自 Notion 總控任務。
//   - 封面日期一律為「當天」（Asia/Taipei）。整份無任何 prototype 樣板資料。
//   - 本檔只負責「取資料 + 算 HTML」；存檔與服務頁面由 Render 端負責（worker 無 DATABASE_URL）。
//
// 匯出：buildMorningBrief() -> { html, reportDate, summary }
//      fetchTodayCalendarEvents(), fetchTasks() （供測試與重用）

import { listEvents, getAccessToken } from './google-calendar.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const TZ = process.env.SEVEN_CALENDAR_TIMEZONE || 'Asia/Taipei';

// ---- 日期工具（皆以台北時區為準） ----

export function taipeiToday() {
  // 'YYYY-MM-DD' in Asia/Taipei
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function taipeiWeekday(dateStr) {
  // 用當天中午建一個 Date，避免時區跨日；只取星期幾。
  const d = new Date(`${dateStr}T12:00:00+08:00`);
  return new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, weekday: 'long' }).format(d);
}

function formatTaipeiDateTime(value) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value instanceof Date ? value : new Date(value));
}

function formatEventTime(ev) {
  if (ev.allDay) return '全天';
  const start = new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ev.startInstant));
  if (!ev.endInstant) return start;
  const end = new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ev.endInstant));
  return `${start}–${end}`;
}

// ---- Google Calendar：全部日曆當天行程 ----

async function listAllCalendars() {
  const token = await getAccessToken();
  const response = await fetch(`${CAL_API}/users/me/calendarList?maxResults=250`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`calendarList failed: ${response.status} ${text.slice(0, 200)}`);
  return (JSON.parse(text).items || []).map((c) => {
    const id = c.id || '';
    const isHoliday = /#holiday@/.test(id);
    // 只保留台灣節日；外國節日（如 en.usa#holiday）視為雜訊，預設排除。
    const isTaiwanHoliday = isHoliday && /(^|[.])(zh-tw|taiwan)/i.test(id);
    return {
      id,
      name: c.summaryOverride || c.summary || id,
      primary: Boolean(c.primary),
      isHoliday,
      isForeignHoliday: isHoliday && !isTaiwanHoliday,
    };
  });
}

export async function fetchTodayCalendarEvents(dateStr = taipeiToday(), { includeForeignHolidays = false } = {}) {
  const timeMin = `${dateStr}T00:00:00+08:00`;
  // 當天結束 = 隔天 00:00。用 listEvents 的 timeMax（exclusive 足夠）。
  const next = new Date(`${dateStr}T00:00:00+08:00`);
  next.setDate(next.getDate() + 1);
  const timeMax = next.toISOString();

  const calendars = await listAllCalendars();
  const events = [];
  const errors = [];
  for (const cal of calendars) {
    if (cal.isForeignHoliday && !includeForeignHolidays) continue;
    try {
      const items = await listEvents({ calendarId: cal.id, timeMin, timeMax, maxResults: 50 });
      for (const e of items) {
        if (e.status === 'cancelled') continue;
        const allDay = Boolean(e.start?.date && !e.start?.dateTime);
        const startInstant = allDay
          ? new Date(`${e.start.date}T00:00:00+08:00`).toISOString()
          : new Date(e.start.dateTime).toISOString();
        const endInstant = e.end
          ? (allDay ? null : new Date(e.end.dateTime).toISOString())
          : null;
        events.push({
          calendarName: cal.name,
          isHoliday: cal.isHoliday,
          summary: e.summary || '(未命名事件)',
          location: e.location || '',
          allDay,
          startInstant,
          endInstant,
        });
      }
    } catch (error) {
      errors.push({ calendar: cal.name, error: error.message });
    }
  }

  // 去重（同名同起始時間，跨日曆重複邀請）
  const seen = new Set();
  const deduped = [];
  for (const ev of events) {
    const key = `${ev.summary}@${ev.startInstant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ev);
  }
  // 全天事件排最前，其餘按真實時間排序
  deduped.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return String(a.startInstant).localeCompare(String(b.startInstant));
  });
  return { events: deduped, calendars, errors };
}

// ---- Notion：總控任務 ----

async function notionRequest(pathname, body) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN is not set.');
  const notionVersion = process.env.NOTION_VERSION || '2025-09-03';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`https://api.notion.com${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': notionVersion,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : {};
    if (![409, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(`Notion API failed: ${response.status} ${text.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return {};
}

function textProperty(property) {
  const items = property?.title || property?.rich_text || [];
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}
function selectName(property) { return property?.select?.name || ''; }

export async function fetchTasks(dateStr = taipeiToday()) {
  const dataSourceId = process.env.SEVEN_TASKS_DATA_SOURCE_ID;
  if (!dataSourceId) return [];
  const pages = [];
  let startCursor;
  do {
    const body = {
      page_size: 100,
      filter: {
        and: [
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
    const result = await notionRequest(`/v1/data_sources/${dataSourceId}/query`, body);
    pages.push(...(result.results || []));
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor && pages.length < 200);

  return pages.map((page) => {
    const p = page.properties || {};
    const dueDate = p['截止日']?.date?.start || '';
    return {
      title: textProperty(p['任務名稱']),
      project: selectName(p['專案']) || '未分類',
      status: selectName(p['狀態']),
      confirmation: selectName(p['確認狀態']),
      priority: selectName(p['優先級']),
      confidence: selectName(p['信心等級']),
      owner: textProperty(p['負責人']),
      dueDate,
      overdue: Boolean(dueDate && dueDate.slice(0, 10) < dateStr),
      nextStep: textProperty(p['下一步']),
      url: page.url,
    };
  }).filter((t) => t.title);
}

// ---- 組裝 + 渲染 ----

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export async function buildMorningBrief({ dateStr } = {}) {
  const date = dateStr || taipeiToday();
  const generatedAt = formatTaipeiDateTime(new Date());

  // 行程（Google Calendar 全部日曆）為硬需求；任務（Notion）失敗則容錯為空。
  const calendar = await fetchTodayCalendarEvents(date);
  let tasks = [];
  let tasksError = '';
  try {
    tasks = await fetchTasks(date);
  } catch (error) {
    tasksError = error.message;
  }

  const confirmed = tasks.filter((t) => t.confirmation !== '未確認');
  // 昨日未完成與延續：已確認、狀態為等待回覆/進行中/未開始。
  const carryover = confirmed
    .filter((t) => ['等待回覆', '進行中', '未開始'].includes(t.status))
    .sort((a, b) => (b.overdue - a.overdue) || (rankPriority(a.priority) - rankPriority(b.priority)))
    .slice(0, 12);
  // 今日優先：逾期或高優先（取 3–7 件）。
  const priorities = confirmed
    .filter((t) => t.overdue || t.priority === '高')
    .sort((a, b) => (b.overdue - a.overdue) || (rankPriority(a.priority) - rankPriority(b.priority)))
    .slice(0, 7);
  // 需要決策：尚未確認的新任務，或信心等級為低。
  const decisions = tasks
    .filter((t) => t.confirmation === '未確認' || t.confidence === '低')
    .slice(0, 8);

  const summary = {
    reportDate: date,
    eventCount: calendar.events.length,
    calendarCount: calendar.calendars.length,
    calendarErrors: calendar.errors,
    carryoverCount: carryover.length,
    priorityCount: priorities.length,
    decisionCount: decisions.length,
    tasksError,
  };

  const html = renderHtml({
    date, weekday: taipeiWeekday(date), generatedAt,
    calendar, carryover, priorities, decisions, tasksError,
  });
  return { html, reportDate: date, summary };
}

function rankPriority(priority) {
  return { 高: 0, 中: 1, 低: 2 }[priority] ?? 3;
}

function eventRow(ev) {
  const chipClass = ev.isHoliday ? 'chip holiday' : (ev.allDay ? 'chip allday' : 'chip');
  const tag = ev.isHoliday ? '節日' : (ev.allDay ? '全天' : ev.calendarName);
  return `<div class="event">
    <div class="time">${escapeHtml(formatEventTime(ev))}</div>
    <div><div class="event-title">${escapeHtml(ev.summary)}</div>
      ${ev.location ? `<div class="event-meta">📍 ${escapeHtml(ev.location)}</div>` : ''}
      <div class="event-meta">${escapeHtml(ev.calendarName)}</div></div>
    <div><span class="${chipClass}">${escapeHtml(tag)}</span></div>
  </div>`;
}

function taskRow(t) {
  const badges = [
    t.overdue ? '<span class="chip risk">逾期</span>' : '',
    t.priority ? `<span class="chip ${t.priority === '高' ? 'warn' : ''}">優先 ${escapeHtml(t.priority)}</span>` : '',
    t.owner ? `<span class="chip info">${escapeHtml(t.owner)}</span>` : '',
    t.dueDate ? `<span class="chip">截止 ${escapeHtml(t.dueDate.slice(0, 10))}</span>` : '',
    t.status ? `<span class="chip">${escapeHtml(t.status)}</span>` : '',
  ].filter(Boolean).join(' ');
  return `<div class="task">
    <div class="task-main">
      <a class="task-title" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.title)}</a>
      <div class="task-meta">${escapeHtml(t.project)}${t.nextStep ? `　➡️ ${escapeHtml(t.nextStep)}` : ''}</div>
    </div>
    <div class="badges">${badges}</div>
  </div>`;
}

function renderHtml({ date, weekday, generatedAt, calendar, carryover, priorities, decisions, tasksError }) {
  const events = calendar.events;
  const calErrNote = calendar.errors.length
    ? `<div class="warnbar">部分日曆讀取失敗：${escapeHtml(calendar.errors.map((e) => e.calendar).join('、'))}</div>` : '';
  const taskErrNote = tasksError
    ? `<div class="warnbar">任務資料讀取失敗：${escapeHtml(tasksError)}</div>` : '';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>每日早上 8 點半行程與待辦報告</title>
<style>
  :root{--bg:#f5f6f2;--panel:#fff;--ink:#20242a;--muted:#68707c;--line:#d9ded6;--green:#2f6f5e;--blue:#315f8c;--red:#9d3b3b;--yellow:#9b6b1f}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",system-ui,sans-serif;line-height:1.55}
  .wrap{max-width:760px;margin:0 auto;padding:20px 16px 48px}
  .top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap}
  h1{margin:0;font-size:24px;line-height:1.25}
  .subtitle{margin-top:6px;color:var(--muted);font-size:14px}
  .date-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;text-align:right}
  .date-card strong{display:block;font-size:20px}
  .date-card span{display:block;color:var(--muted);font-size:13px}
  .metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:18px}
  .metric{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
  .metric span{display:block;color:var(--muted);font-size:13px}
  .metric strong{display:block;margin-top:4px;font-size:22px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:16px;overflow:hidden}
  .head{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:#fbfcfa}
  .head h2{margin:0;font-size:17px}
  .note{color:var(--muted);font-size:12px}
  .event{display:grid;grid-template-columns:120px 1fr 90px;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);align-items:start}
  .event:last-child{border-bottom:0}
  .time{color:var(--blue);font-weight:700;font-variant-numeric:tabular-nums}
  .event-title{font-weight:700}
  .event-meta{color:var(--muted);font-size:13px;margin-top:2px}
  .task{display:flex;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);align-items:start;flex-wrap:wrap}
  .task:last-child{border-bottom:0}
  .task-title{font-weight:700;color:var(--ink);text-decoration:none}
  .task-title:hover{text-decoration:underline}
  .task-meta{color:var(--muted);font-size:13px;margin-top:2px}
  .badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .chip{display:inline-flex;align-items:center;min-height:22px;padding:2px 8px;border-radius:999px;font-size:12px;background:#edf3ef;color:var(--green);white-space:nowrap}
  .chip.warn{background:#fff4df;color:var(--yellow)}
  .chip.risk{background:#f9e8e8;color:var(--red)}
  .chip.info{background:#eaf2fb;color:var(--blue)}
  .chip.allday{background:#eef0ec;color:var(--muted)}
  .chip.holiday{background:#f1ecf9;color:#6b4ea8}
  .empty{padding:16px;color:var(--muted);font-size:14px;text-align:center}
  .warnbar{background:#fff0f0;border:1px solid #efc3c3;color:#873333;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px}
  .foot{color:var(--muted);font-size:12px;text-align:center;margin-top:8px}
  @media(max-width:560px){.metrics{grid-template-columns:repeat(2,1fr)}.event{grid-template-columns:84px 1fr}.event>div:last-child{grid-column:2}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>今日行程與待辦報告</h1>
      <div class="subtitle">每天早上 8 點半，先把今天的時間、昨天留下來的事情、最該推進的工作排清楚。</div>
    </div>
    <div class="date-card"><strong>${escapeHtml(date)}</strong><span>${escapeHtml(weekday)}｜08:30</span></div>
  </div>

  ${calErrNote}${taskErrNote}

  <div class="metrics">
    <div class="metric"><span>今日行程</span><strong>${events.length}</strong></div>
    <div class="metric"><span>昨日未完成</span><strong>${carryover.length}</strong></div>
    <div class="metric"><span>今日優先</span><strong>${priorities.length}</strong></div>
    <div class="metric"><span>需決策</span><strong>${decisions.length}</strong></div>
  </div>

  <section>
    <div class="head"><h2>今日行程</h2><span class="note">來自 Google Calendar 全部日曆（${calendar.calendars.length} 個）</span></div>
    ${events.length ? events.map(eventRow).join('\n') : '<div class="empty">今天 Google Calendar 上沒有任何行程。</div>'}
  </section>

  <section>
    <div class="head"><h2>昨日未完成與延續事項</h2><span class="note">來自 Notion 總控任務</span></div>
    ${carryover.length ? carryover.map(taskRow).join('\n') : '<div class="empty">沒有延續中的未完成任務。</div>'}
  </section>

  <section>
    <div class="head"><h2>今天建議優先處理</h2><span class="note">逾期或高優先，最多 7 件</span></div>
    ${priorities.length ? priorities.map(taskRow).join('\n') : '<div class="empty">今天沒有逾期或高優先任務。</div>'}
  </section>

  <section>
    <div class="head"><h2>今天需要你決策或確認</h2><span class="note">待確認的新任務或低信心項目</span></div>
    ${decisions.length ? decisions.map(taskRow).join('\n') : '<div class="empty">沒有待決策的項目。</div>'}
  </section>

  <div class="foot">產生時間：${escapeHtml(generatedAt)}（台北時間）・資料即時取自 Google Calendar 與 Notion</div>
</div>
</body>
</html>`;
}
