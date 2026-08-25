// 浏览器 公开userscript只通过平台 LLMBridge 使用 AI，不得自建传输层。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

execFileSync('node', ['tools/build.mjs', '--public'], { env: { ...process.env }, stdio: 'pipe' });
const text = readFileSync('release/public-skill/skill.js', 'utf8');
for (const [name, re] of [
  ['localhost', /(?:127\.0\.0\.1|localhost)/i],
  ['自建网络', /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|new\s+EventSource/],
  ['Authorization', /Authorization|Bearer\s+/],
  ['密钥输入', /API Key|apiKey|API Token/],
  ['本地 AI 路由', /call\(["']\/(?:translate|explain|summary|llm\/models)\b/],
  ['供应商实现', /anthropic-ai\/sdk|api\.anthropic\.com|api\.openai\.com|\/v1\/chat\/completions/],
]) assert.ok(!re.test(text), `公开userscript仍包含 ${name}`);
assert.match(text, /LLMBridge\.chat\(/, '必须保留平台静态识别的字面量 LLMBridge.chat(...)');
assert.match(text, /showDirectoryPicker/);
assert.match(text, /createWritable/);
assert.match(text, /浏览器 AI/);
assert.ok(!text.includes('OpenAI 兼容'));
assert.ok(!text.includes('本地 agent（慢'));
console.log('  ok   公开userscript仅通过平台 LLMBridge 使用 AI');
