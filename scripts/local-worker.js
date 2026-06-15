// SevenAM local worker（Claude Code 訂閱額度，LLM_BACKEND=claude-code）。
// 2026-06-13 起 worker 是主要排程引擎：
//   每輪（90 秒）：任務萃取＋指令分流（即時回覆）
//   每 15 分鐘：Next Action 排程掃描；每小時：會議任務／權責候選同步
//   定時報告：08:30 / 10:00 / 13:00 / 17:00 / 20:30（30 分寬限窗，不補發）
//   每晚：22:20 專案提案、22:45 回饋收割
// Render 只保留三個 API 備援 cron（萃取／指令分流／附件解析）：worker 心跳
// 健康時自動讓位，這台機器掛了它們自動接手（附件解析一律在 Render，需要 API 視覺）。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { claudeCodeSelfTest, codexSelfTest } from '../src/llm-backend.js';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const heartbeatUrl = process.env.SEVEN_WORKER_HEARTBEAT_URL || 'https://line-oa-webhook-nn5j.onrender.com/worker/heartbeat';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY || '';
const intervalSeconds = clampNumber(Number(process.env.SEVEN_WORKER_INTERVAL_SECONDS || 90), 30, 900);
const failureBackoffSeconds = 300;
const workerId = `local-${process.env.COMPUTERNAME || 'worker'}`;
// AI 後端：2026-06-15 起 SevenAM 改用 OpenAI Codex（ChatGPT 訂閱額度），與 HOZO 一致。
const workerBackend = String(process.env.SEVEN_WORKER_LLM_BACKEND || 'codex').trim().toLowerCase();
const backendSelfTest = workerBackend === 'codex' ? codexSelfTest : claudeCodeSelfTest;
const backendLoginHint = workerBackend === 'codex'
  ? '在這台電腦的終端機執行 codex 並完成 ChatGPT 訂閱登入'
  : '在這台電腦的終端機執行 claude 並完成 /login';
// 工作時段（台北時間）：時段外不掃描、不心跳；Render 夜間排程也已關閉，全系統休息。
const activeHourStart = clampNumber(Number(process.env.SEVEN_WORKER_ACTIVE_HOUR_START ?? 7), 0, 23);
const activeHourEnd = clampNumber(Number(process.env.SEVEN_WORKER_ACTIVE_HOUR_END ?? 23), 1, 24);

let consecutiveFailures = 0;
let cycles = 0;
let stopping = false;
let lastScheduledActionsAt = 0;
let lastMeetingSyncAt = 0;
let lastResponsibilitySyncAt = 0;
let lastCalendarInviteScanAt = 0;
let lastAttachmentParseAt = 0;
let proposalsRanOn = '';
let feedbackRanOn = '';
const reportRanOn = {};

// 定時報告（2026-06-13 起報告 cron 移出 Render，由 worker 按表呼叫發報 API）。
// 只在 [時間, 時間+30分) 的窗口內發；worker 停機錯過窗口就跳過，不補發過期報告。
const REPORT_TIMETABLE = [
  { name: 'morning', minutes: 8 * 60 + 30 },
  { name: 'followup-morning', minutes: 10 * 60 },
  { name: 'followup-midday', minutes: 13 * 60 },
  { name: 'followup-afternoon', minutes: 17 * 60 },
  { name: 'daily', minutes: 20 * 60 + 30 },
];
const REPORT_GRACE_MINUTES = 30;

process.on('SIGINT', () => { stopping = true; log('SIGINT received; finishing current cycle then exiting.'); });
process.on('SIGTERM', () => { stopping = true; });

log(`SevenAM local worker starting (id=${workerId}, interval=${intervalSeconds}s, backend=${workerBackend})`);

// AI 認證失敗時不再整個退出。改為降級模式：照樣跑不需 AI 的工作
// （行事曆同步、定時報告、Notion 同步、排程動作），只跳過需要 AI 的判讀
// （萃取、指令分流、邀約偵測、提案、回饋），並定期重試恢復。這樣訂閱登入
// 過期時，Google Calendar 與報告等不依賴 AI 的功能不會跟著停擺。
const selfTest = await backendSelfTest();
let claudeAvailable = selfTest.ok;
let lastClaudeRetestAt = Date.now();
if (claudeAvailable) {
  log(`✅ ${workerBackend} 自我檢測通過，訂閱額度可用。`);
} else {
  log(`⚠️ ${workerBackend} 認證失敗：${selfTest.error}`);
  log('進入降級模式：行事曆同步、定時報告、Notion 同步照常跑；任務萃取與指令分流改由 Render API 排程接手。');
  log(`要恢復完整功能（訂閱額度判讀）：${backendLoginHint}，worker 會自動偵測恢復，不需重啟。`);
}
log(`工作時段：台北 ${String(activeHourStart).padStart(2, '0')}:00–${String(activeHourEnd % 24).padStart(2, '0')}:00；時段外暫停所有掃描。`);

let inQuietHours = false;

while (!stopping) {
  if (!isActiveHour()) {
    if (!inQuietHours) {
      inQuietHours = true;
      log(`🌙 進入夜間休息（台北 ${String(activeHourEnd % 24).padStart(2, '0')}:00–${String(activeHourStart).padStart(2, '0')}:00）：暫停工作與心跳，到點自動恢復。`);
    }
    await delay(5 * 60 * 1000);
    continue;
  }
  if (inQuietHours) {
    inQuietHours = false;
    log('☀️ 進入工作時段，恢復掃描。');
    // 先送心跳佔位，讓 Render 早上的排程立刻知道 worker 已接手，避免兩邊搶工作。
    await sendHeartbeat({ cycles, resumedFromQuietHours: true });
  }

  cycles += 1;
  const cycleStartedAt = Date.now();
  let cycleOk = true;

  // 降級模式下每 5 分鐘重試一次 Claude 認證；恢復後自動回到完整模式。
  if (!claudeAvailable && Date.now() - lastClaudeRetestAt >= 5 * 60 * 1000) {
    lastClaudeRetestAt = Date.now();
    const retest = await backendSelfTest();
    if (retest.ok) {
      claudeAvailable = true;
      log(`✅ ${workerBackend} 已恢復，回到完整模式（恢復萃取與指令分流）。`);
    }
  }

  // 需要 Claude 的判讀工作：認證有效才跑；降級時交給 Render API 排程。
  if (claudeAvailable) {
    const extraction = await runChild('llm-task-extraction', ['scripts/llm-task-extraction.js', '--include-outgoing-groups', '--limit', '10']);
    if (!extraction.ok) cycleOk = false;

    const triage = await runChild('codex-command-triage', ['scripts/llm-codex-command-triage.js', '--limit', '5', '--reply']);
    if (!triage.ok) cycleOk = false;

    // 附件解析（需 AI 視覺；圖片走 Codex -i）：每 15 分鐘一次。
    if (Date.now() - lastAttachmentParseAt >= 15 * 60 * 1000) {
      const attachments = await runChild('attachment-parsing', ['scripts/parse-attachments.js', '--limit', '6']);
      if (attachments.ok) lastAttachmentParseAt = Date.now();
    }
  }

  // Next Action 排程掃描（無 LLM）：每 15 分鐘一次。
  if (Date.now() - lastScheduledActionsAt >= 15 * 60 * 1000) {
    const actions = await runChild('scheduled-actions', ['scripts/run-scheduled-actions.js', '--limit', '20']);
    if (actions.ok) lastScheduledActionsAt = Date.now();
    // 行事曆（無 LLM）：同步專案行程候選並建立/追問/過期 Google 事件。
    await runChild('calendar-scan-projects', ['scripts/scan-calendar-candidates.js', '--limit', '40']);
    await runChild('calendar-sync', ['scripts/sync-calendar-events.js', '--limit', '50']);
  }

  // 每小時 Notion 同步（原 Render cron：會議任務、權責候選；皆無 LLM）。
  if (Date.now() - lastMeetingSyncAt >= 60 * 60 * 1000) {
    const meeting = await runChild('meeting-action-sync', ['scripts/sync-meeting-actions.js', '--limit', '50']);
    if (meeting.ok) lastMeetingSyncAt = Date.now();
  }
  if (Date.now() - lastResponsibilitySyncAt >= 60 * 60 * 1000) {
    const responsibility = await runChild('responsibility-sync', ['scripts/sync-responsibility-candidates.js']);
    if (responsibility.ok) lastResponsibilitySyncAt = Date.now();
  }
  // LINE 邀約偵測（有 LLM）：每小時掃描近期對話，產生待確認行事曆候選。
  if (claudeAvailable && Date.now() - lastCalendarInviteScanAt >= 60 * 60 * 1000) {
    const invites = await runChild('calendar-invite-scan', ['scripts/scan-calendar-candidates.js', '--no-projects', '--invites', '--since-hours', '48', '--limit', '20']);
    if (invites.ok) lastCalendarInviteScanAt = Date.now();
  }

  const { date: taipeiDate, minutes: taipeiMinutes } = taipeiNow();

  // 定時報告（原 Render cron）。
  for (const report of REPORT_TIMETABLE) {
    if (reportRanOn[report.name] === taipeiDate) continue;
    if (taipeiMinutes >= report.minutes && taipeiMinutes < report.minutes + REPORT_GRACE_MINUTES) {
      reportRanOn[report.name] = taipeiDate;
      // 早報需先在本機算好快照（Google Calendar 全部日曆＋Notion）並上傳 Render，
      // 之後再發 LINE 連結，使用者點開時快照已就緒。Render 沒有 Google 金鑰，故必須在這裡產生。
      if (report.name === 'morning') {
        await runChild('morning-brief-snapshot', ['scripts/generate-morning-brief.js']);
      }
      await runChild(`report-${report.name}`, ['scripts/render-cron-report.js', report.name]);
    }
  }

  // 夜間批次（原 Render cron：專案提案 22:20、回饋收割 22:45；皆需 Claude）。
  if (claudeAvailable && taipeiMinutes >= 22 * 60 + 20 && proposalsRanOn !== taipeiDate) {
    proposalsRanOn = taipeiDate;
    await runChild('project-proposals', ['scripts/propose-projects.js']);
  }
  if (claudeAvailable && taipeiMinutes >= 22 * 60 + 45 && feedbackRanOn !== taipeiDate) {
    feedbackRanOn = taipeiDate;
    await runChild('extraction-feedback', ['scripts/sync-extraction-feedback.js', '--since-days', '7']);
  }

  // 降級模式不送心跳：讓 Render 的 API 排程接手萃取與指令分流（本機只負責
  // 不需 Claude 的工作，與 Render 不衝突）。
  if (!claudeAvailable) {
    await delay(intervalSeconds * 1000);
    continue;
  }

  if (cycleOk) {
    consecutiveFailures = 0;
    await sendHeartbeat({ cycles, lastCycleMs: Date.now() - cycleStartedAt });
  } else {
    consecutiveFailures += 1;
    log(`⚠️ 本輪有工作失敗（連續失敗 ${consecutiveFailures} 次）${consecutiveFailures >= 3 ? '；暫停心跳，Render 排程將自動接手。' : ''}`);
    if (consecutiveFailures < 3) {
      // 偶發失敗仍送心跳，避免單次網路抖動就讓兩邊搶工作。
      await sendHeartbeat({ cycles, degraded: true });
    }
  }

  const sleepSeconds = consecutiveFailures >= 3 ? failureBackoffSeconds : intervalSeconds;
  await delay(sleepSeconds * 1000);

  if (consecutiveFailures >= 3 && consecutiveFailures % 3 === 0) {
    const retest = await backendSelfTest();
    if (retest.ok) {
      log(`✅ ${workerBackend} 恢復可用，恢復正常節奏。`);
      consecutiveFailures = 0;
    } else {
      log(`${workerBackend} 仍不可用：${retest.error}`);
    }
  }
}

log('Worker stopped.');

function runChild(label, scriptArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, scriptArgs, {
      cwd: process.cwd(),
      env: { ...process.env, LLM_BACKEND: workerBackend },
      windowsHide: true,
    });

    let tail = '';
    child.stdout.on('data', (chunk) => { tail = `${tail}${chunk}`.slice(-2000); });
    child.stderr.on('data', (chunk) => {
      tail = `${tail}${chunk}`.slice(-2000);
      process.stderr.write(`[${label}] ${chunk}`);
    });
    child.on('error', (error) => {
      log(`[${label}] spawn failed: ${error.message}`);
      resolve({ ok: false });
    });
    child.on('close', (code) => {
      const summaryMatch = tail.match(/"createdTasks": (\d+)|"done": (\d+)/);
      log(`[${label}] exit=${code}${summaryMatch ? ` (${summaryMatch[0].replace(/"/g, '')})` : ''}`);
      resolve({ ok: code === 0 });
    });
  });
}

async function sendHeartbeat(meta) {
  if (!controlApiKey) {
    log('SEVEN_CONTROL_API_KEY missing; heartbeat skipped (Render crons will keep running).');
    return;
  }
  try {
    const response = await fetch(heartbeatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-seven-control-key': controlApiKey },
      body: JSON.stringify({ workerId, meta }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      log(`Heartbeat rejected: ${response.status}`);
    }
  } catch (error) {
    log(`Heartbeat failed: ${error.message}`);
  }
}

function taipeiNow() {
  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const [date, time] = formatted.split(' ');
  const [hour, minute] = time.split(':').map(Number);
  return { date, minutes: hour * 60 + minute };
}

function isActiveHour() {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date()));
  return hour >= activeHourStart && hour < activeHourEnd;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
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
