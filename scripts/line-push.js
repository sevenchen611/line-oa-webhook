import { existsSync, readFileSync } from 'node:fs';

loadEnvFile('.env');
loadEnvFile('../env.txt');

const controlApiKey = process.env.SEVEN_CONTROL_API_KEY;
const pushUrl = process.env.CONTROL_LINE_PUSH_URL || 'https://line-oa-webhook-nn5j.onrender.com/control/line/push';

const targetType = String(process.argv[2] || '').trim();
const targetId = String(process.argv[3] || '').trim();
const text = process.argv.slice(4).join(' ').trim();

if (!controlApiKey) {
  fail('SEVEN_CONTROL_API_KEY is not set.');
}

if (!['user', 'group', 'room'].includes(targetType)) {
  fail('Usage: npm run line:push -- <user|group|room> <targetId> <message>');
}

if (!targetId) {
  fail('Missing targetId.');
}

if (!text) {
  fail('Missing message text.');
}

const response = await fetch(pushUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'x-seven-control-key': controlApiKey,
  },
  body: JSON.stringify({ targetType, targetId, text }),
});

const responseText = await response.text();
if (!response.ok) {
  throw new Error(`LINE push failed: ${response.status} ${responseText}`);
}

console.log(JSON.stringify({ ok: true, targetType, targetId }, null, 2));

function loadEnvFile(pathname) {
  if (!existsSync(pathname)) {
    return;
  }

  const envFile = readFileSync(pathname, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
