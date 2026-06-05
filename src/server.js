import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

loadDotenv();

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET;

if (!channelAccessToken || !channelSecret) {
  console.warn('Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET.');
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'POST' || pathname !== '/webhook/line') {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const rawBody = await readBody(req);
  const signature = req.headers['x-line-signature'];

  if (!isValidLineSignature(rawBody, signature)) {
    return sendJson(res, 401, { error: 'Invalid signature' });
  }

  try {
    const body = JSON.parse(rawBody);
    await Promise.all((body.events || []).map(handleEvent));
    return sendText(res, 200, 'OK');
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message?.type !== 'text') {
    return;
  }

  await replyMessage(event.replyToken, {
    type: 'text',
    text: `收到：${event.message.text}`,
  });
}

async function replyMessage(replyToken, message) {
  if (!channelAccessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  }

  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      replyToken,
      messages: [message],
    }),
  });

  if (!response.ok) {
    throw new Error(`LINE reply failed: ${response.status} ${await response.text()}`);
  }
}

function isValidLineSignature(rawBody, signature) {
  if (!channelSecret || typeof signature !== 'string') {
    return false;
  }

  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return expected === signature;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
  res.end(text);
}

function loadDotenv() {
  if (!existsSync('.env')) {
    return;
  }

  const envFile = readFileSync('.env', 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) {
      continue;
    }

    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const port = Number(process.env.PORT || 3000);

server.listen(port, () => {
  console.log(`LINE webhook server is listening on port ${port}`);
});
