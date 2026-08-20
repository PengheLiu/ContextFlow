// 本地 agent 适配层。
//
// 权限姿态已改为**不做任何裁剪**：用户本地的 agent 有什么能力就用什么能力。
// 所以这里断言的不再是"锁死了什么"，而是：
//   · 确实没有下发工具名单（否则无头模式下会把没预授权的工具静默拒掉，
//     表现为"选了 agent 却什么都做不了"）
//   · 那些为了"能跑起来"而必需的参数没被弄丢 —— 它们每一个都是踩出来的：
//     codex 在 /tmp 不加 --skip-git-repo-check 会拒绝启动；
//     加了 --ignore-user-config 会把认证路由剥掉，直连 api.openai.com 拿 401。
import assert from 'node:assert/strict';
import { AGENTS, AGENT_IDS, _argvFor } from '../server/agent.mjs';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const call = (id, o = {}) => _argvFor(id, {
  sessionId: 'sid', resume: false, notesDir: '', maxTurns: 12, prompt: 'P', ...o,
});
const claudeArgv = (o = {}) => call('claude', o).argv;
const codexArgv = (o = {}) => call('codex', o).argv;
const has = (a, ...seq) => {
  const i = a.indexOf(seq[0]);
  return i >= 0 && seq.every((v, k) => a[i + k] === v);
};

console.log('agent 适配层\n');

// ---- 不做能力裁剪 ----

t('不下发工具白名单/拒绝名单', () => {
  const a = claudeArgv();
  assert.ok(!a.includes('--allowedTools'), 'argv 里仍有 --allowedTools');
  assert.ok(!a.includes('--disallowedTools'), 'argv 里仍有 --disallowedTools');
});

// dontAsk 下未预授权的工具会被静默拒绝，等于"有能力却用不了"
t('权限模式是 bypassPermissions，不是 dontAsk', () => {
  assert.ok(has(claudeArgv(), '--permission-mode', 'bypassPermissions'));
  assert.ok(!claudeArgv().includes('dontAsk'));
});

t('不剥用户自己的 MCP', () =>
  assert.ok(!claudeArgv().includes('--strict-mcp-config')));

t('codex 不指定沙箱，用用户 config.toml 自己的设置', () => {
  const a = codexArgv();
  assert.ok(!a.includes('--sandbox'), 'argv 里仍有 --sandbox');
});

// ---- 必需参数（每一个都是踩出来的）----

t('codex 带 --skip-git-repo-check（cwd 是 /tmp，否则拒绝启动）', () =>
  assert.ok(codexArgv().includes('--skip-git-repo-check')));

t('codex 不带 --ignore-user-config（会剥掉认证路由，直连拿 401）', () =>
  assert.ok(!codexArgv().includes('--ignore-user-config')));

t('轮数有上限（防一次查询把额度烧干）', () =>
  assert.ok(has(claudeArgv({ maxTurns: 7 }), '--max-turns', '7')));

t('prompt 不进 argv（全文分段后仍可能很长，会撞 ARG_MAX）', () => {
  const a = claudeArgv({ prompt: '整篇正文'.repeat(10000) });
  assert.ok(!a.some((x) => x.length > 500), 'argv 里出现了超长参数');
  assert.ok(a.includes('-p'));
});

t('claude / codex 的 prompt 走 stdin', () => {
  assert.equal(call('claude').stdin, true);
  assert.equal(call('codex').stdin, true);
  assert.ok(codexArgv().includes('-'));
});

// dsh 没有 stdin 契约，之前塞一个字面 '-' 给它，它把 '-' 当成了提问内容，
// 回了一句"你的消息是空的"。每家的传递方式必须显式声明。
t('dsh / gemini 的 prompt 走 argv，且真的带上了 prompt', () => {
  const d = call('dsh', { prompt: '这段在讲什么' });
  assert.equal(d.stdin, false);
  assert.ok(d.argv.includes('这段在讲什么'), 'dsh 的 argv 里没有 prompt');
  assert.ok(!d.argv.includes('-'), "dsh 不认字面 '-'");
  const g = call('gemini', { prompt: 'Q' });
  assert.equal(g.stdin, false);
  assert.ok(g.argv.includes('Q'));
});

t('dsh 续接带上 --resume 与会话 id', () => {
  const d = call('dsh', { resume: true, sessionId: 'S9', prompt: 'x' });
  assert.ok(has(d.argv, '--resume', 'S9'));
});

// ---- 目录授权 ----

t('不给笔记目录时不出现 --add-dir', () =>
  assert.ok(!claudeArgv().includes('--add-dir')));

t('给了才授权，且只授权那一个', () => {
  const a = claudeArgv({ notesDir: '/notes' });
  assert.ok(has(a, '--add-dir', '/notes'));
  assert.equal(a.filter((x) => x === '--add-dir').length, 1);
});

// ---- 会话续接 ----

t('首轮用 --session-id，续接用 --resume', () => {
  assert.ok(has(claudeArgv({ resume: false }), '--session-id', 'sid'));
  const r = claudeArgv({ resume: true });
  assert.ok(has(r, '--resume', 'sid'));
  assert.ok(!r.includes('--session-id'));
});

t('codex 续接走 exec resume', () =>
  assert.ok(has(codexArgv({ sessionId: 'S1', resume: true }), 'exec', 'resume', 'S1')));

// ---- 元信息 ----

t('未知 agent 抛错而不是静默降级', () =>
  assert.throws(() => _argvFor('nope', { sessionId: 's', maxTurns: 1 }), /未知 agent/));

t('每个 agent 都申报了是否已实测（界面据此提示）', () => {
  for (const id of AGENT_IDS) {
    assert.equal(typeof AGENTS[id].verified, 'boolean', `${id} 缺 verified`);
    assert.ok(AGENTS[id].label && AGENTS[id].bin, `${id} 缺 label/bin`);
  }
});

console.log(`\n${pass} 项通过`);
