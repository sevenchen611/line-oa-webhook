// SevenAM 早上 8:30 晨報產生器（worker 端，2026-06-14）。
//
// worker 有 Google 金鑰、Render 沒有；所以晨報 HTML 在這台機器算好，
// 再 POST 給 Render 的 /control/reports/snapshot 存進 Postgres，由 Render 服務頁面。
//
// 用法：
//   node scripts/generate-morning-brief.js            產生並上傳快照到 Render
//   node scripts/generate-morning-brief.js --dry-run  只在本機產生預覽檔，不上傳
//   node scripts/generate-morning-brief.js --print     額外印出摘要 JSON

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildMorningBrief } from './morning-brief.js';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const print = args.has('--print');

const controlApiKey = process.env.SEVEN_CONTROL_API_KEY || '';
// 由 CONTROL_API_URL 推導 snapshot 端點（同一個 Render origin）。
const snapshotUrl = process.env.SEVEN_REPORT_SNAPSHOT_URL
  || deriveSnapshotUrl(process.env.CONTROL_API_URL)
  || 'https://line-oa-webhook-nn5j.onrender.com/control/reports/snapshot';

try {
  const { html, reportDate, summary } = await buildMorningBrief();

  if (print) console.log(JSON.stringify(summary, null, 2));

  if (dryRun) {
    const out = 'reports/morning-brief-preview.html';
    writeFileSync(out, html, 'utf8');
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', reportDate, out, summary }, null, 2));
    process.exit(0);
  }

  if (!controlApiKey) {
    console.error(JSON.stringify({ ok: false, error: 'SEVEN_CONTROL_API_KEY is not set; cannot upload snapshot.' }));
    process.exit(1);
  }

  const response = await fetch(snapshotUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-seven-control-key': controlApiKey },
    body: JSON.stringify({ reportType: 'morning', reportDate, html }),
    signal: AbortSignal.timeout(45000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(JSON.stringify({ ok: false, status: response.status, body: text.slice(0, 300) }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, reportDate, uploaded: true, summary }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}

function deriveSnapshotUrl(controlApiUrl) {
  if (!controlApiUrl) return '';
  try {
    return new URL('/control/reports/snapshot', controlApiUrl).toString();
  } catch {
    return '';
  }
}

function loadEnvFile(pathname) {
  if (!existsSync(pathname)) return;
  for (const line of readFileSync(pathname, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
