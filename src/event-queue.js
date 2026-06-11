import { createHash } from 'node:crypto';
import pg from 'pg';

const QUEUE_TABLE = 'line_event_queue';
const RETRY_DELAYS_SECONDS = [30, 60, 300, 900, 1800, 3600, 7200];
const DONE_ROW_RETENTION_DAYS = 14;
const STALE_PROCESSING_MINUTES = 5;

export function createEventQueue({
  databaseUrl,
  processEvent,
  onDeadEvent,
  pollIntervalMs = 5000,
  batchSize = 5,
  maxAttempts = RETRY_DELAYS_SECONDS.length + 1,
}) {
  const enabled = Boolean(databaseUrl);
  let pool = null;
  let initialized = false;
  let draining = false;
  let kickRequested = false;
  let pollTimer = null;
  let cleanupTimer = null;

  async function init() {
    if (!enabled || initialized) {
      return;
    }

    pool = new pg.Pool(buildPoolConfig(databaseUrl));
    pool.on('error', (error) => {
      console.error('Event queue pool error:', error.message);
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${QUEUE_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        event JSONB NOT NULL,
        raw_body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${QUEUE_TABLE}_claim
      ON ${QUEUE_TABLE} (status, available_at, id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        worker_id TEXT PRIMARY KEY,
        beat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        meta JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    await recoverStaleProcessingRows();
    await cleanupDoneRows();

    initialized = true;
    pollTimer = setInterval(() => {
      drain().catch((error) => console.error('Event queue drain failed:', error.message));
    }, pollIntervalMs);
    pollTimer.unref?.();
    cleanupTimer = setInterval(() => {
      cleanupDoneRows().catch((error) => console.error('Event queue cleanup failed:', error.message));
    }, 6 * 60 * 60 * 1000);
    cleanupTimer.unref?.();

    console.log('Event queue initialized. Webhook events will be stored in Postgres before Notion processing.');
    kick();
  }

  async function enqueue(events, rawBody) {
    if (!enabled || !initialized) {
      throw new Error('Event queue is not initialized.');
    }

    let inserted = 0;
    for (const event of events) {
      const result = await pool.query(
        `INSERT INTO ${QUEUE_TABLE} (event_key, event, raw_body)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (event_key) DO NOTHING`,
        [buildEventKey(event), JSON.stringify(event), rawBody],
      );
      inserted += result.rowCount || 0;
    }

    if (inserted > 0) {
      kick();
    }
    return inserted;
  }

  function kick() {
    if (!initialized) {
      return;
    }
    kickRequested = true;
    setImmediate(() => {
      drain().catch((error) => console.error('Event queue drain failed:', error.message));
    });
  }

  async function drain() {
    if (!initialized || draining) {
      return;
    }
    draining = true;
    try {
      do {
        kickRequested = false;
        let rows;
        do {
          rows = await claimBatch();
          for (const row of rows) {
            await processRow(row);
          }
        } while (rows.length > 0);
      } while (kickRequested);
    } finally {
      draining = false;
    }
  }

  async function claimBatch() {
    const result = await pool.query(
      `UPDATE ${QUEUE_TABLE}
       SET status = 'processing', updated_at = now()
       WHERE id IN (
         SELECT id FROM ${QUEUE_TABLE}
         WHERE status = 'pending' AND available_at <= now()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, event_key, event, raw_body, attempts`,
      [batchSize],
    );
    return result.rows;
  }

  async function processRow(row) {
    try {
      await processEvent(row.event, row.raw_body);
      await pool.query(
        `UPDATE ${QUEUE_TABLE}
         SET status = 'done', last_error = '', updated_at = now(), processed_at = now()
         WHERE id = $1`,
        [row.id],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = row.attempts + 1;

      if (attempts >= maxAttempts) {
        await pool.query(
          `UPDATE ${QUEUE_TABLE}
           SET status = 'dead', attempts = $2, last_error = $3, updated_at = now()
           WHERE id = $1`,
          [row.id, attempts, clampError(message)],
        );
        console.error(`Event queue item ${row.event_key} moved to dead letter after ${attempts} attempts: ${message}`);
        if (onDeadEvent) {
          try {
            await onDeadEvent({ eventKey: row.event_key, attempts, lastError: message, event: row.event });
          } catch (alertError) {
            console.error('Event queue dead letter alert failed:', alertError.message);
          }
        }
        return;
      }

      const delaySeconds = RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
      await pool.query(
        `UPDATE ${QUEUE_TABLE}
         SET status = 'pending', attempts = $2, last_error = $3,
             available_at = now() + ($4 || ' seconds')::interval, updated_at = now()
         WHERE id = $1`,
        [row.id, attempts, clampError(message), String(delaySeconds)],
      );
      console.error(`Event queue item ${row.event_key} failed (attempt ${attempts}/${maxAttempts}), retrying in ${delaySeconds}s: ${message}`);
    }
  }

  async function recoverStaleProcessingRows() {
    const result = await pool.query(
      `UPDATE ${QUEUE_TABLE}
       SET status = 'pending', updated_at = now()
       WHERE status = 'processing' AND updated_at < now() - interval '${STALE_PROCESSING_MINUTES} minutes'`,
    );
    if (result.rowCount > 0) {
      console.warn(`Event queue recovered ${result.rowCount} stale processing row(s) after restart.`);
    }
  }

  async function cleanupDoneRows() {
    await pool.query(
      `DELETE FROM ${QUEUE_TABLE}
       WHERE status = 'done' AND processed_at < now() - interval '${DONE_ROW_RETENTION_DAYS} days'`,
    );
  }

  async function stats() {
    if (!enabled) {
      return { enabled: false };
    }
    if (!initialized) {
      return { enabled: true, initialized: false };
    }
    try {
      const result = await pool.query(
        `SELECT status, count(*)::int AS count FROM ${QUEUE_TABLE} GROUP BY status`,
      );
      const counts = {};
      for (const row of result.rows) {
        counts[row.status] = row.count;
      }
      return { enabled: true, initialized: true, counts };
    } catch (error) {
      return { enabled: true, initialized: true, error: error.message };
    }
  }

  async function setWorkerHeartbeat(workerId, meta = {}) {
    if (!initialized) throw new Error('Event queue is not initialized.');
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, beat_at, meta)
       VALUES ($1, now(), $2::jsonb)
       ON CONFLICT (worker_id) DO UPDATE SET beat_at = now(), meta = $2::jsonb`,
      [workerId, JSON.stringify(meta)],
    );
  }

  async function getLatestWorkerHeartbeat() {
    if (!initialized) return null;
    const result = await pool.query(
      `SELECT worker_id, beat_at, meta,
              EXTRACT(EPOCH FROM (now() - beat_at))::int AS age_seconds
       FROM worker_heartbeats
       ORDER BY beat_at DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return { workerId: row.worker_id, beatAt: row.beat_at, ageSeconds: row.age_seconds, meta: row.meta };
  }

  return { enabled, init, enqueue, stats, setWorkerHeartbeat, getLatestWorkerHeartbeat };
}

function buildEventKey(event) {
  if (event?.webhookEventId) {
    return `evt-${event.webhookEventId}`;
  }
  if (event?.message?.id) {
    return `msg-${event.message.id}`;
  }
  return `hash-${createHash('sha256').update(JSON.stringify(event || {})).digest('hex')}`;
}

function buildPoolConfig(databaseUrl) {
  const config = { connectionString: databaseUrl, max: 3 };
  const sslEnv = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (['false', 'disable', 'off', '0'].includes(sslEnv)) {
    return config;
  }
  if (!sslEnv && /localhost|127\.0\.0\.1/.test(databaseUrl)) {
    return config;
  }
  config.ssl = { rejectUnauthorized: false };
  return config;
}

function clampError(message) {
  return String(message || '').slice(0, 2000);
}
