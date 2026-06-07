const reportType = String(process.argv[2] || '').trim();
const controlApiUrl = process.env.CONTROL_API_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/reports/send';
const controlLinePushUrl = process.env.CONTROL_LINE_PUSH_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/line/push';
const controlApiKey = process.env.SEVEN_CONTROL_API_KEY;
const cronJobName = process.env.CRON_JOB_NAME || `cron-${reportType || 'unknown'}`;
const cronAlertsEnabled = !['0', 'false', 'off', 'no'].includes(String(process.env.SEVEN_CRON_ALERTS_ENABLED || 'true').trim().toLowerCase());
const runId = buildRunId();
const startedAt = new Date();

if (!reportType) {
  throw new Error('Missing report type. Usage: node scripts/render-cron-report.js <reportType>');
}

if (!controlApiKey) {
  throw new Error('SEVEN_CONTROL_API_KEY is not set.');
}

logCronEvent('started', {
  controlApiUrl,
  reportType,
});

try {
  const response = await fetch(controlApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'x-seven-control-key': controlApiKey,
      'x-seven-cron-job': cronJobName,
      'x-seven-cron-run-id': runId,
      'x-seven-cron-scheduled-report': reportType,
    },
    body: JSON.stringify({
      reportType,
      cronMeta: {
        jobName: cronJobName,
        runId,
        startedAt: startedAt.toISOString(),
        source: 'render-cron',
      },
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Report push failed: ${response.status} ${responseText}`);
  }

  const finishedAt = new Date();
  logCronEvent('succeeded', {
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    responseText,
  });
} catch (error) {
  const finishedAt = new Date();
  const message = error instanceof Error ? error.message : String(error);

  logCronEvent('failed', {
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    error: message,
  });

  if (cronAlertsEnabled) {
    await sendFailureAlert(message);
  }

  throw error;
}

function logCronEvent(status, details = {}) {
  console.log(JSON.stringify({
    event: 'cron-report',
    status,
    jobName: cronJobName,
    reportType,
    runId,
    startedAt: startedAt.toISOString(),
    timestamp: new Date().toISOString(),
    ...details,
  }));
}

async function sendFailureAlert(errorMessage) {
  const body = {
    useDefaultReportTarget: true,
    text: [
      'Seven Jr. 排程警告',
      `排程：${cronJobName}`,
      `報告：${reportType}`,
      `Run ID：${runId}`,
      `開始時間：${formatTaipeiDateTime(startedAt)}`,
      `錯誤：${truncateText(errorMessage, 800)}`,
      '請到 Render Cron logs 檢查這次執行紀錄。',
    ].join('\n'),
  };

  try {
    const response = await fetch(controlLinePushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-seven-control-key': controlApiKey,
        'x-seven-cron-job': cronJobName,
        'x-seven-cron-run-id': runId,
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    if (!response.ok) {
      console.error(JSON.stringify({
        event: 'cron-report-alert',
        status: 'failed',
        jobName: cronJobName,
        reportType,
        runId,
        responseStatus: response.status,
        responseText,
      }));
      return;
    }

    console.log(JSON.stringify({
      event: 'cron-report-alert',
      status: 'sent',
      jobName: cronJobName,
      reportType,
      runId,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'cron-report-alert',
      status: 'failed',
      jobName: cronJobName,
      reportType,
      runId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function buildRunId() {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    'T',
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
    'Z',
  ].join('');

  return `${cronJobName}-${stamp}`;
}

function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
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
