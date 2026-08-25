// ContextFlow 浏览器 公开版完整发布闸。
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const file = process.argv[2] || 'release/public-skill/skill.js';
const dir = join(file, '..'), text = readFileSync(file, 'utf8');
const allowed = ['README.md', 'SHA256SUMS', 'manifest.json', 'skill.js'];
const actual = readdirSync(dir).sort(), hits = [];
if (JSON.stringify(actual) !== JSON.stringify(allowed)) hits.push(`发布目录文件不符合 allowlist：${actual.join(',')}`);
for (const name of actual) if (lstatSync(join(dir, name)).isSymbolicLink()) hits.push(`禁止符号链接：${name}`);
let localToken = '';
try { localToken = JSON.parse(readFileSync(join(homedir(), '.contextflow/config.json'), 'utf8')).token || ''; } catch {}
if (localToken && text.includes(localToken)) hits.push('包含本机 ContextFlow token');
for (const [name, re] of [
  ['Bearer/token', /Bearer\s+[A-Za-z0-9_-]{20,}|(?:sk|sk-ant)-[A-Za-z0-9_-]{12,}/],
  ['个人绝对路径', /\/Users\/[A-Za-z0-9._-]+\//],
  ['localhost', /(?:127\.0\.0\.1|localhost)/i],
  ['自建网络', /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|new\s+EventSource/],
  ['密钥配置', /API Key|apiKey|API Token/],
  ['本地服务路由', /call\(["']\/(?:translate|explain|summary|llm\/models)\b/],
  ['供应商实现', /anthropic-ai\/sdk|api\.anthropic\.com|api\.openai\.com|\/v1\/chat\/completions/],
  ['MCP/思源实现', /MCPBridge|mcpServers|SIYUAN_TOKEN|kernel API/],
]) if (re.test(text)) hits.push(name);
if ((text.match(/LLMBridge\.chat\(/g) || []).length !== 1) hits.push('必须恰好一个 LLMBridge.chat(...) 直接调用');
for (const required of ['showDirectoryPicker', 'createWritable', 'indexedDB', 'navigator.clipboard']) {
  if (!text.includes(required)) hits.push(`缺少能力：${required}`);
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
if (manifest.version !== pkg.version || !text.includes(`v${pkg.version}`)) hits.push('package/manifest/banner 版本不一致');
if (manifest.artifact?.sha256 !== digest || manifest.artifact?.bytes !== readFileSync(file).length) hits.push('manifest artifact 摘要不一致');
const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
for (const line of sums) {
  const [hash, name] = line.split(/\s{2}/); const target = join(dir, basename(name || ''));
  if (createHash('sha256').update(readFileSync(target)).digest('hex') !== hash) hits.push(`SHA256SUMS 不匹配：${name}`);
}
if (hits.length) { console.error(`✗ ${file} 不可发布：${hits.join('、')}`); process.exit(1); }
console.log(`✓ ${file} v${manifest.version} 发布闸通过 · sha256 ${digest}`);
