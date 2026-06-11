import { spawn } from 'node:child_process';

const separatorIndex = process.argv.indexOf('--');
const command = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : [];

if (command.length === 0) {
  throw new Error('Usage: node scripts/run-cron-with-alert.js -- <command> [args...]');
}

const projectEnvPrefix = resolveProjectEnvPrefix();
const controlHeaderPrefix = (process.env.AM_CONTROL_HEADER_PREFIX || projectEnvPrefix).toLowerCase();
const controlApiKey = process.env.AM_CONTROL_API_KEY || process.env[`${projectEnvPrefix}_CONTROL_API_KEY`] || '';
const controlLinePushUrl = process.env.CONTROL_LINE_PUSH_URL || '';
const cronJobName = process.env.CRON_JOB_NAME || command.join(' ');
const alertsEnabled = !['0', 'false', 'off', 'no'].includes(
  String(process.env.AM_CRON_ALERTS_ENABLED ?? process.env[`${projectEnvPrefix}_CRON_ALERTS_ENABLED`] ?? 'true').trim().toLowerCase(),
);
const startedAt = new Date();

// 雙模式切換：本機 worker 心跳新鮮時，Render cron 讓位（避免重複處理與重複計費）。
const skipIfWorkerActive = !['', '0', 'false', 'off', 'no'].includes(String(process.env.AM_SKIP_IF_WORKER_ACTIVE || '').trim().toLowerCase());
const workerStatusUrl = process.env.AM_WORKER_STATUS_URL || '';
if (skipIfWorkerActive && workerStatusUrl) {
  try {
    const response = await fetch(workerStatusUrl, { signal: AbortSignal.timeout(15000) });
    const status = await response.json();
    if (status.workerActive) {
      console.log(JSON.stringify({
        event: 'cron-wrapper',
        status: 'skipped-worker-active',
        jobName: cronJobName,
        heartbeat: status.heartbeat || null,
      }));
      process.exit(0);
    }
  } catch (error) {
    console.warn(`Worker status check failed (${error.message}); running cron normally.`);
  }
}

const executable = command[0] === 'node' ? process.execPath : command[0];
const child = spawn(executable, command.slice(1), {
  stdio: ['inherit', 'inherit', 'pipe'],
});

let stderrTail = '';
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  stderrTail = `${stderrTail}${chunk}`.slice(-2000);
});

child.on('close', async (code) => {
  if (code === 0) {
    process.exit(0);
  }

  console.error(JSON.stringify({
    event: 'cron-wrapper',
    status: 'failed',
    jobName: cronJobName,
    exitCode: code,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  }));

  if (alertsEnabled) {
    await sendFailureAlert(code);
  }
  process.exit(code ?? 1);
});

child.on('error', async (error) => {
  console.error(JSON.stringify({
    event: 'cron-wrapper',
    status: 'spawn-failed',
    jobName: cronJobName,
    error: error.message,
  }));
  if (alertsEnabled) {
    stderrTail = error.message;
    await sendFailureAlert(-1);
  }
  process.exit(1);
});

async function sendFailureAlert(exitCode) {
  if (!controlLinePushUrl || !controlApiKey) {
    console.error('Cron alert skipped: CONTROL_LINE_PUSH_URL or control API key is not set.');
    return;
  }

  const actorName = process.env.AM_OUTGOING_ACTOR_NAME || process.env[`${projectEnvPrefix}_OUTGOING_ACTOR_NAME`] || `${projectEnvPrefix} Jr.`;
  const body = {
    useDefaultReportTarget: true,
    text: [
      `${actorName} 排程警告`,
      `排程：${cronJobName}`,
      `結束代碼：${exitCode}`,
      `開始時間：${formatTaipeiDateTime(startedAt)}`,
      `錯誤輸出（結尾）：${stderrTail.trim().slice(-600) || '（無）'}`,
      '請到 Render Cron logs 檢查這次執行紀錄。',
    ].join('\n'),
  };

  try {
    const response = await fetch(controlLinePushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        [`x-${controlHeaderPrefix}-control-key`]: controlApiKey,
        [`x-${controlHeaderPrefix}-cron-job`]: cronJobName,
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    console.error(JSON.stringify({
      event: 'cron-wrapper-alert',
      status: response.ok ? 'sent' : 'failed',
      jobName: cronJobName,
      responseStatus: response.status,
      ...(response.ok ? {} : { responseText: responseText.slice(0, 500) }),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'cron-wrapper-alert',
      status: 'failed',
      jobName: cronJobName,
      error: error.message,
    }));
  }
}

function resolveProjectEnvPrefix() {
  const explicit = String(process.env.AM_PROJECT_ENV_PREFIX || '').trim();
  if (explicit) return explicit.toUpperCase();
  if (process.env.SEVEN_CONTROL_API_KEY) return 'SEVEN';
  if (process.env.HOZO_CONTROL_API_KEY) return 'HOZO';
  return 'SEVEN';
}

function formatTaipeiDateTime(value) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value instanceof Date ? value : new Date(value));
}
