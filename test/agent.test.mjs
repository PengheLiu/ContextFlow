// 本地 agent 的安全档 / 完整权限参数契约。
//
// Safe 不是一句 prompt：必须由 CLI 参数限制工具面、会话与文件系统。Full 则保留
// 用户主动确认后的原有能力。这里锁住两档差异，以及每家 CLI 踩过的兼容性参数。
import assert from 'node:assert/strict';
import { AGENTS, AGENT_IDS, detect, _argvFor } from '../server/agent.mjs';

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const call = (id, o = {}) => _argvFor(id, {
  sessionId: 'sid', resume: false, notesDir: '', maxTurns: 12, prompt: 'P',
  profile: 'safe', ...o,
});
const argv = (id, profile = 'safe', o = {}) => call(id, { profile, ...o }).argv;
const has = (a, ...seq) => {
  const i = a.indexOf(seq[0]);
  return i >= 0 && seq.every((v, k) => a[i + k] === v);
};

console.log('agent 安全档与完整权限\n');

// ---- Claude Code Safe ----

await t('Claude Safe 使用 dontAsk + safe-mode，而不是绕过权限', () => {
  const a = argv('claude');
  assert.ok(a.includes('--safe-mode'));
  assert.ok(has(a, '--permission-mode', 'dontAsk'));
  assert.ok(!a.includes('bypassPermissions'));
});

await t('Claude Safe 只暴露读取、检索与 Web 工具', () => {
  const a = argv('claude');
  const allow = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
  for (const tool of allow) {
    assert.ok(a.includes(tool), `缺少安全工具 ${tool}`);
  }
  assert.ok(a.includes('--tools'));
  assert.ok(a.includes('--allowedTools'));
  for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Monitor', 'Workflow', 'Agent', 'Task']) {
    assert.ok(a.includes(tool), `拒绝列表缺少 ${tool}`);
  }
});

await t('Claude Safe 隔离 MCP、自定义命令、Chrome 与持久会话', () => {
  const a = argv('claude');
  assert.ok(has(a, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'));
  for (const flag of ['--disable-slash-commands', '--no-chrome', '--no-session-persistence']) {
    assert.ok(a.includes(flag), `缺少 ${flag}`);
  }
  assert.ok(!a.includes('--session-id'));
  assert.ok(!a.includes('--resume'));
});

await t('Claude Safe 即使请求 resume 也不续接旧 Full 会话', () => {
  const a = argv('claude', 'safe', { resume: true });
  assert.ok(!a.includes('--resume'));
  assert.ok(!a.includes('sid'));
});

// ---- Claude Code Full ----

await t('Claude Full 保留 bypassPermissions，不伪装成安全档', () => {
  const a = argv('claude', 'full');
  assert.ok(has(a, '--permission-mode', 'bypassPermissions'));
  for (const flag of ['--safe-mode', '--tools', '--allowedTools', '--disallowedTools', '--strict-mcp-config']) {
    assert.ok(!a.includes(flag), `Full 不应带 ${flag}`);
  }
});

await t('Claude Full 首轮建会话，续接使用 resume', () => {
  assert.ok(has(argv('claude', 'full'), '--session-id', 'sid'));
  const a = argv('claude', 'full', { resume: true });
  assert.ok(has(a, '--resume', 'sid'));
  assert.ok(!a.includes('--session-id'));
});

// ---- Codex ----

await t('Codex Safe 使用只读沙箱、临时会话与忽略规则', () => {
  const a = argv('codex');
  assert.ok(has(a, '--sandbox', 'read-only'));
  assert.ok(a.includes('--ephemeral'));
  assert.ok(a.includes('--ignore-rules'));
  assert.ok(a.includes('--skip-git-repo-check'));
});

await t('Codex Safe 不续接旧 Full thread', () => {
  const a = argv('codex', 'safe', { resume: true, sessionId: 'S1' });
  assert.ok(!has(a, 'exec', 'resume'));
  assert.ok(!a.includes('S1'));
});

await t('Codex Full 继承用户沙箱配置并可续接', () => {
  const first = argv('codex', 'full');
  assert.ok(!first.includes('--sandbox'));
  assert.ok(!first.includes('--ephemeral'));
  assert.ok(!first.includes('--ignore-rules'));
  const resumed = argv('codex', 'full', { resume: true, sessionId: 'S1' });
  assert.ok(has(resumed, 'exec', 'resume', 'S1'));
});

await t('Codex 两档都保留用户认证配置与临时目录兼容参数', () => {
  for (const profile of ['safe', 'full']) {
    const a = argv('codex', profile);
    assert.ok(a.includes('--skip-git-repo-check'));
    assert.ok(!a.includes('--ignore-user-config'));
  }
});

// ---- 不支持 Safe 的 agent ----

await t('dsh / Gemini 拒绝 Safe，不用系统提示冒充沙箱', () => {
  for (const id of ['dsh', 'gemini']) {
    assert.throws(() => call(id), (e) => e.code === 'AGENT_SAFE_UNSUPPORTED');
  }
});

await t('dsh / Gemini 仅在 Full 下可调用，prompt 走 argv', () => {
  const d = call('dsh', { profile: 'full', prompt: '这段在讲什么' });
  assert.equal(d.stdin, false);
  assert.ok(d.argv.includes('这段在讲什么'));
  assert.ok(!d.argv.includes('-'));
  const g = call('gemini', { profile: 'full', prompt: 'Q' });
  assert.equal(g.stdin, false);
  assert.ok(g.argv.includes('Q'));
});

await t('dsh Full 续接带上 session id', () => {
  const d = call('dsh', { profile: 'full', resume: true, sessionId: 'S9', prompt: 'x' });
  assert.ok(has(d.argv, '--resume', 'S9'));
});

// ---- 两档共享的运行约束 ----

await t('Claude 轮数有上限，长 prompt 走 stdin 不进 argv', () => {
  const c = call('claude', { maxTurns: 7, prompt: '整篇正文'.repeat(10000) });
  assert.ok(has(c.argv, '--max-turns', '7'));
  assert.ok(!c.argv.some((x) => x.length > 500));
  assert.equal(c.stdin, true);
  assert.equal(call('codex').stdin, true);
});

await t('笔记目录只有显式配置后才加入', () => {
  assert.ok(!argv('claude').includes('--add-dir'));
  const a = argv('claude', 'safe', { notesDir: '/notes' });
  assert.ok(has(a, '--add-dir', '/notes'));
  assert.equal(a.filter((x) => x === '--add-dir').length, 1);
});

await t('未知 agent 抛错而不是静默降级', () =>
  assert.throws(() => call('nope'), /未知 agent/));

await t('每个 agent 声明实测状态与 Safe 支持级别', () => {
  for (const id of AGENT_IDS) {
    const a = AGENTS[id];
    assert.equal(typeof a.verified, 'boolean', `${id} 缺 verified`);
    assert.ok(['verified', 'best-effort', 'unsupported'].includes(a.safeSupport),
      `${id} 的 safeSupport 无效`);
    assert.ok(a.label && a.bin, `${id} 缺 label/bin`);
  }
});

// 探测结果要缓存：打开配置不应每次都启动四个进程。
await t('detect() 缓存结果，第二次不再起进程', async () => {
  const a = await detect();
  const t0 = Date.now();
  const b = await detect();
  assert.equal(a, b);
  assert.ok(Date.now() - t0 < 50);
  for (const row of b) assert.equal(row.safeSupport, AGENTS[row.id].safeSupport);
});

await t('detect(true) 绕过缓存', async () => {
  const a = await detect();
  const b = await detect(true);
  assert.notEqual(a, b);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
});

console.log(`\n${pass} 项通过`);
