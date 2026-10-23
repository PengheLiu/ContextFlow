// 浏览器 公开userscript只通过平台 LLMBridge 使用 AI，不得自建传输层。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { endpointScanSource, PUBLIC_NETWORK_PATTERN } from '../tools/public-skill-policy.mjs';

execFileSync('node', ['tools/build.mjs', '--public'], { env: { ...process.env }, stdio: 'pipe' });
const text = readFileSync('release/public-skill/skill.js', 'utf8');
assert.ok(text.includes('Third-party Markdown and math libraries'));
for (const [name, re] of [
  ['localhost', /(?:127\.0\.0\.1|localhost)/i],
  ['自建网络', PUBLIC_NETWORK_PATTERN],
  ['Authorization', /Authorization|Bearer\s+/],
  ['密钥输入', /API Key|apiKey|API Token/],
  ['本地 AI 路由', /call\(["']\/(?:translate|explain|summary|llm\/models)\b/],
  ['供应商实现', /anthropic-ai\/sdk|api\.anthropic\.com|api\.openai\.com|\/v1\/chat\/completions/],
]) assert.ok(!re.test(name === 'localhost' ? endpointScanSource(text) : text), `公开userscript仍包含 ${name}`);
assert.ok(endpointScanSource('fetch("http://localhost:7317/health")').includes('localhost'));
assert.ok(endpointScanSource('http://127.0.0.1:7317/health').includes('127.0.0.1'));
for (const source of ['fetch("https://example.com")', 'window.fetch(url)', 'globalThis.fetch(url)', 'self.fetch(url)', 'new XMLHttpRequest()', 'new WebSocket(url)', 'new EventSource(url)']) {
  assert.ok(PUBLIC_NETWORK_PATTERN.test(source), `网络 API 仍必须被拦截：${source}`);
}
for (const source of ['parser2.fetch()', 'this.fetch()', 'fetch() { return this.nextToken; }']) assert.ok(!PUBLIC_NETWORK_PATTERN.test(source));
assert.match(text, /LLMBridge\.chat\(/, '必须保留平台静态识别的字面量 LLMBridge.chat(...)');
assert.match(text, /showDirectoryPicker/);
assert.match(text, /createWritable/);
assert.match(text, /浏览器 AI/);
assert.ok(!text.includes('OpenAI 兼容'));
assert.ok(!text.includes('本地 agent（慢'));
console.log('  ok   公开userscript仅通过平台 LLMBridge 使用 AI');
