// 24/7 local worker: runs extraction + command triage on the Claude Code
// subscription (LLM_BACKEND=claude-code) and heartbeats to Render so the
// hourly/15-min crons stand down while this machine is healthy.
// If the machine, CLI auth, or quota dies, heartbeats stop and Render's
// API-billed crons take over automatically.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { claudeCodeSelfTest } from '../src/llm-backend.js';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const heartbeatUrl = process.env.SEVEN_WORKER_HEARTBEAT_URL || 'https://line-oa-webhook-nn5j.onrender.com/worker/heartbeat';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY || '';
const intervalSeconds = clampNumber(Number(process.env.SEVEN_WORKER_INTERVAL_SECONDS || 90), 30, 900);
const failureBackoffSeconds = 300;
const workerId = `local-${process.env.COMPUTERNAME || 'worker'}`;

let consecutiveFailures = 0;
let cycles = 0;
let stopping = false;

process.on('SIGINT', () => { stopping = true; log('SIGINT received; finishing current cycle then exiting.'); });
process.on('SIGTERM', () => { stopping = true; });

log(`SevenAM local worker starting (id=${workerId}, interval=${intervalSeconds}s, backend=claude-code)`);

const selfTest = await claudeCodeSelfTest();
if (!selfTest.ok) {
  log(`❌ Claude Code CLI 自我檢測失敗：${selfTest.error}`);
  log('請在這台電腦的終端機執行 claude 並完成 /login（瀏覽器登入訂閱帳號），然後重啟 worker。');
  log('在此之前 Render 的 API 排程會照常運作，系統不會中斷。');
  process.exit(2);
}
log('✅ Claude Code CLI 自我檢測通過，訂閱額度可用。');

while (!stopping) {
  cycles += 1;
  const cycleStartedAt = Date.now();
  let cycleOk = true;

  const extraction = await runChild('llm-task-extraction', ['scripts/llm-task-extraction.js', '--include-outgoing-groups', '--limit', '10']);
  if (!extraction.ok) cycleOk = false;

  const triage = await runChild('codex-command-triage', ['scripts/llm-codex-command-triage.js', '--limit', '5', '--reply']);
  if (!triage.ok) cycleOk = false;

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
    const retest = await claudeCodeSelfTest();
    if (retest.ok) {
      log('✅ Claude Code 恢復可用，恢復正常節奏。');
      consecutiveFailures = 0;
    } else {
      log(`Claude Code 仍不可用：${retest.error}`);
    }
  }
}

log('Worker stopped.');

function runChild(label, scriptArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, scriptArgs, {
      cwd: process.cwd(),
      env: { ...process.env, LLM_BACKEND: 'claude-code' },
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
