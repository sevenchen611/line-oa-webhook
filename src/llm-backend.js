// Pluggable LLM backend: 'api' uses the Anthropic API (metered billing),
// 'claude-code' uses the local Claude Code CLI in headless mode (subscription
// quota). Both expose completeJson() with the same contract so the judgment
// brain stays identical across backends.

import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

export function createLlmBackend({ apiKey, model } = {}) {
  const backendName = String(process.env.LLM_BACKEND || 'api').trim().toLowerCase();
  const resolvedModel = model || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

  if (backendName === 'claude-code') {
    return createClaudeCodeBackend({ model: process.env.CLAUDE_CODE_MODEL || '' });
  }
  return createApiBackend({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY || '', model: resolvedModel });
}

function createApiBackend({ apiKey, model }) {
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  return {
    name: 'api',
    model,
    available: Boolean(apiKey),
    async completeJson({ system, userContent, schema, maxTokens = 16000 }) {
      if (!client) {
        throw new Error('ANTHROPIC_API_KEY is not set for the api backend.');
      }
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
        output_config: { format: { type: 'json_schema', schema } },
      });
      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock) {
        throw new Error(`Claude response has no text block (stop_reason: ${response.stop_reason}).`);
      }
      return JSON.parse(textBlock.text);
    },
  };
}

function createClaudeCodeBackend({ model }) {
  return {
    name: 'claude-code',
    model: model || '(claude-code default)',
    available: true,
    async completeJson({ system, userContent, schema, maxTokens }) {
      const prompt = buildClaudeCodePrompt({ system, userContent, schema });

      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const raw = await runClaudeCode(prompt, { model });
        try {
          return parseJsonLoose(raw, schema);
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`claude-code backend returned unparseable JSON: ${lastError?.message || 'unknown'}`);
    },
  };
}

function buildClaudeCodePrompt({ system, userContent, schema }) {
  const userText = Array.isArray(userContent)
    ? userContent.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n')
    : String(userContent || '');

  return [
    '<system-instructions>',
    system,
    '</system-instructions>',
    '',
    '<input>',
    userText,
    '</input>',
    '',
    '## 輸出要求（絕對遵守）',
    '只輸出一個符合以下 JSON Schema 的純 JSON 物件。不要任何前言、說明、markdown 圍欄或結尾文字。',
    JSON.stringify(schema),
  ].join('\n');
}

export function runClaudeCode(prompt, { model = '', timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const cliArgs = ['-p', '--output-format', 'json'];
    if (model) cliArgs.push('--model', model);

    // 在 Claude Code session 內巢狀執行時，繼承的環境變數會讓子行程走錯認證
    // 通道，必須清掉再呼叫。
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE' || key === 'ANTHROPIC_BASE_URL' || key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN' || key === 'CLAUDE_AGENT_SDK_VERSION') {
        delete env[key];
      }
    }

    const child = spawn('claude', cliArgs, {
      env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude-code call timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`claude-code spawn failed: ${error.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          reject(new Error(`claude-code error: ${String(envelope.result || stderr).slice(0, 400)}`));
          return;
        }
        resolve(String(envelope.result || ''));
      } catch {
        reject(new Error(`claude-code produced invalid envelope: ${stdout.slice(0, 200) || stderr.slice(0, 200)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseJsonLoose(text, schema) {
  const cleaned = String(text || '')
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (match) => (match.includes('{') ? match.slice(match.indexOf('{')) : ''))
    .replace(/```[\s\S]*$/, '')
    .trim();

  const candidate = cleaned.startsWith('{') ? cleaned : extractFirstJsonObject(String(text || ''));
  const parsed = JSON.parse(candidate);

  for (const key of schema?.required || []) {
    if (!(key in parsed)) {
      throw new Error(`missing required key: ${key}`);
    }
  }
  return parsed;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error('unterminated JSON object');
}

export async function claudeCodeSelfTest() {
  try {
    const raw = await runClaudeCode('只輸出純 JSON：{"pong": true}', { timeoutMs: 120000 });
    const parsed = parseJsonLoose(raw, { required: ['pong'] });
    return { ok: parsed.pong === true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
