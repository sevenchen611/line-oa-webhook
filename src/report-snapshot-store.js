// Render 端報告快照儲存（Postgres）。
//
// worker 在本機算好報告 HTML（它有 Google 金鑰、Render 沒有），POST 到
// /control/reports/snapshot；Render 用本模組把 HTML 存進 Postgres，服務頁面時讀最新一筆。
// 兩邊共用同一個 Render 託管的 DATABASE_URL，所以 worker 不需要直接連 DB。

import pg from 'pg';

const TABLE = 'report_html_snapshots';
let pool = null;
let initPromise = null;

function buildPoolConfig(databaseUrl) {
  const config = { connectionString: databaseUrl, max: 2 };
  const sslEnv = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (['false', 'disable', 'off', '0'].includes(sslEnv)) return config;
  if (!sslEnv && /localhost|127\.0\.0\.1/.test(databaseUrl)) return config;
  config.ssl = { rejectUnauthorized: false };
  return config;
}

async function getPool() {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) return null;
  if (pool) return pool;
  if (!initPromise) {
    pool = new pg.Pool(buildPoolConfig(databaseUrl));
    pool.on('error', (error) => console.error('Report snapshot pool error:', error.message));
    initPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGSERIAL PRIMARY KEY,
        report_type TEXT NOT NULL,
        report_date TEXT NOT NULL DEFAULT '',
        html TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(() => pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_latest ON ${TABLE} (report_type, created_at DESC)
    `)).catch((error) => {
      console.error('Report snapshot table init failed:', error.message);
      throw error;
    });
  }
  await initPromise;
  return pool;
}

export function snapshotStoreEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

// 存一筆快照，並順手清掉同型別 30 天前的舊資料。
export async function saveReportSnapshot({ reportType, reportDate = '', html }) {
  if (!reportType || !html) throw new Error('saveReportSnapshot requires reportType and html.');
  const db = await getPool();
  if (!db) throw new Error('DATABASE_URL is not set; cannot store report snapshot.');
  await db.query(
    `INSERT INTO ${TABLE} (report_type, report_date, html) VALUES ($1, $2, $3)`,
    [reportType, reportDate, html],
  );
  await db.query(
    `DELETE FROM ${TABLE} WHERE report_type = $1 AND created_at < now() - interval '30 days'`,
    [reportType],
  ).catch(() => {});
  return { ok: true, reportType, reportDate };
}

// 取某型別最新一筆快照；找不到回 null。
export async function getLatestReportSnapshot(reportType) {
  const db = await getPool();
  if (!db) return null;
  const result = await db.query(
    `SELECT report_type, report_date, html, created_at
     FROM ${TABLE} WHERE report_type = $1 ORDER BY created_at DESC LIMIT 1`,
    [reportType],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { reportType: row.report_type, reportDate: row.report_date, html: row.html, createdAt: row.created_at };
}
