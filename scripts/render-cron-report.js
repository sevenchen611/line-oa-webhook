const reportType = String(process.argv[2] || '').trim();
const controlApiUrl = process.env.CONTROL_API_URL || '';
const controlLinePushUrl = process.env.CONTROL_LINE_PUSH_URL || '';
const projectEnvPrefix = resolveProjectEnvPrefix();
const controlHeaderPrefix = resolveControlHeaderPrefix(projectEnvPrefix);
const controlApiKey = process.env.AM_CONTROL_API_KEY || process.env[`${projectEnvPrefix}_CONTROL_API_KEY`];
const cronJobName = process.env.CRON_JOB_NAME || `cron-${reportType || 'unknown'}`;
const cronAlertsEnabled = booleanEnv('AM_CRON_ALERTS_ENABLED', `${projectEnvPrefix}_CRON_ALERTS_ENABLED`, true);
const cronHealthPingEnabled = booleanEnv('AM_CRON_HEALTH_PING_ENABLED', `${projectEnvPrefix}_CRON_HEALTH_PING_ENABLED`, true);
const controlHealthUrl = process.env.CONTROL_HEALTH_URL || deriveControlHealthUrl(controlApiUrl);
const retryDelaysMs = parseRetryDelays(process.env.AM_CRON_RETRY_DELAYS_MS || process.env[`${projectEnvPrefix}_CRON_RETRY_DELAYS_MS`] || '10000,30000,60000');
const requestTimeoutMs = positiveIntegerEnv('AM_CRON_REQUEST_TIMEOUT_MS', `${projectEnvPrefix}_CRON_REQUEST_TIMEOUT_MS`, 45000);
const runId = buildRunId();
const startedAt = new Date();

if (!reportType) {
  throw new Error('Missing report type. Usage: node scripts/render-cron-report.js <reportType>');
}

if (!controlApiKey) {
  throw new Error(`AM_CONTROL_API_KEY or ${projectEnvPrefix}_CONTROL_API_KEY is not set.`);
}
if (!controlApiUrl) {
  throw new Error('CONTROL_API_URL is not set.');
}

logCronEvent('started', {
  controlApiUrl,
  reportType,
  projectEnvPrefix,
  controlHeaderPrefix,
  retryDelaysMs,
  requestTimeoutMs,
});

try {
  if (cronHealthPingEnabled) {
    await runWithRetry('health-ping', async () => {
      if (!controlHealthUrl) {
        logCronEvent('health-skipped', {
          reason: 'CONTROL_HEALTH_URL is not set and could not be derived.',
        });
        return '';
      }

      return fetchTextWithTimeout(controlHealthUrl, {
        method: 'GET',
        headers: cronHeaders(false),
      });
    });
  }

  const responseText = await runWithRetry('report-send', async () => fetchTextWithTimeout(controlApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cronHeaders(true),
    },
    body: JSON.stringify({
      reportType,
      cronMeta: {
        jobName: cronJobName,
        runId,
        startedAt: startedAt.toISOString(),
        source: 'render-cron',
        retryPolicy: {
          retryDelaysMs,
          requestTimeoutMs,
        },
      },
    }),
  }));

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
  const actorName = process.env.AM_OUTGOING_ACTOR_NAME || process.env[`${projectEnvPrefix}_OUTGOING_ACTOR_NAME`] || `${projectEnvPrefix} Jr.`;
  const body = {
    useDefaultReportTarget: true,
    text: [
      `${actorName} 排程警告`,
      `排程：${cronJobName}`,
      `報告：${reportType}`,
      `Run ID：${runId}`,
      `開始時間：${formatTaipeiDateTime(startedAt)}`,
      `重試設定：${retryDelaysMs.join('ms, ')}ms`,
      `錯誤：${truncateText(errorMessage, 800)}`,
      '請到 Render Cron logs 檢查這次執行紀錄。',
    ].join('\n'),
  };

  try {
    const response = await fetch(controlLinePushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...cronHeaders(false),
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

async function runWithRetry(operation, callback) {
  const maxAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logCronEvent('attempt-started', {
        operation,
        attempt,
        maxAttempts,
      });
      const result = await callback();
      logCronEvent('attempt-succeeded', {
        operation,
        attempt,
        maxAttempts,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableError(error);
      const nextDelayMs = retryDelaysMs[attempt - 1];

      logCronEvent('attempt-failed', {
        operation,
        attempt,
        maxAttempts,
        retryable,
        nextDelayMs: retryable ? nextDelayMs : undefined,
        error: message,
      });

      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      await delay(nextDelayMs);
    }
  }

  throw new Error(`${operation} failed without a captured error.`);
}

async function fetchTextWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new HttpStatusError(`HTTP request failed: ${response.status} ${truncateText(responseText, 1200)}`, response.status, responseText);
    }
    return responseText;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${requestTimeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cronHeaders(includeReportType) {
  return {
    [`x-${controlHeaderPrefix}-control-key`]: controlApiKey,
    [`x-${controlHeaderPrefix}-cron-job`]: cronJobName,
    [`x-${controlHeaderPrefix}-cron-run-id`]: runId,
    ...(includeReportType ? { [`x-${controlHeaderPrefix}-cron-scheduled-report`]: reportType } : {}),
  };
}

function isRetryableError(error) {
  if (error instanceof HttpStatusError) {
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  }
  return true;
}

function resolveProjectEnvPrefix() {
  const explicit = String(process.env.AM_PROJECT_ENV_PREFIX || '').trim();
  if (explicit) return explicit.toUpperCase();
  if (process.env.SEVEN_CONTROL_API_KEY) return 'SEVEN';
  if (process.env.HOZO_CONTROL_API_KEY) return 'HOZO';
  return 'HOZO';
}

function resolveControlHeaderPrefix(envPrefix) {
  const explicit = String(process.env.AM_CONTROL_HEADER_PREFIX || '').trim();
  if (explicit) return explicit.toLowerCase();
  return envPrefix.toLowerCase();
}

function deriveControlHealthUrl(url) {
  try {
    return new URL('/control/health', url).toString();
  } catch {
    return '';
  }
}

function parseRetryDelays(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item >= 0);
}

function booleanEnv(primaryName, fallbackName, defaultValue) {
  const raw = process.env[primaryName] ?? process.env[fallbackName];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

function positiveIntegerEnv(primaryName, fallbackName, defaultValue) {
  const raw = process.env[primaryName] ?? process.env[fallbackName];
  const parsed = Number.parseInt(String(raw || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class HttpStatusError extends Error {
  constructor(message, status, responseText) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.responseText = responseText;
  }
}
