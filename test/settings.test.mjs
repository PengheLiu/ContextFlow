// 设置页的 Agent Safe / Full 交互与风险确认。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event']) global[k] = dom.window[k];
const { Settings, SETTINGS_CSS } = await import('../src/skill/settings.js');
const sCss = () => SETTINGS_CSS;

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const make = () => {
  document.body.innerHTML = '<div id="host"></div>';
  const sh = document.getElementById('host').attachShadow({ mode: 'open' });
  const mount = document.createElement('div'); sh.appendChild(mount);
  const s = new Settings(sh, mount, {});
  s.cfg = {
    agent: {
      id: 'claude', profile: 'safe', profileSource: 'user', fullAccessAcknowledged: false,
      fullWarning: '风险文案', fullWarningVersion: 1, fullWarningHash: 'hash-v1',
    },
  };
  s.wantAgent = 'claude';
  s.agents = [
    { id: 'claude', label: 'Claude Code', available: true, verified: true, safeSupport: 'best-effort' },
    { id: 'codex', label: 'Codex CLI', available: true, verified: true, safeSupport: 'verified' },
    { id: 'dsh', label: 'DeepSeek Harness', available: true, verified: false, safeSupport: 'unsupported' },
  ];
  s.syncAgentSel();
  s.$('s-profileSafe').checked = true;
  s.syncProfileUi();
  return s;
};

console.log('设置页 Agent 权限\n');

await t('默认安全档可直接保存且不生成完整权限确认', () => {
  const s = make();
  const p = s.patch();
  assert.equal(p.agent.profile, 'safe');
  assert.equal(p.agent.profileSource, 'user');
  assert.ok(!('fullAccessAcknowledgement' in p.agent));
});

await t('完整权限藏在高级能力内并显示风险确认', () => {
  const s = make();
  s.$('s-profileFull').checked = true;
  s.syncProfileUi();
  assert.equal(s.$('s-advanced').open, true);
  assert.equal(s.$('s-fullAckWrap').classList.contains('on'), true);
  assert.throws(() => s.patch(), (e) => e.code === 'AGENT_FULL_ACK');
});

await t('勾选后二次确认绑定 agent、版本和警告 hash', () => {
  const s = make();
  s.$('s-profileFull').checked = true;
  s.$('s-fullAck').checked = true;
  const p = s.patch();
  assert.deepEqual(p.agent.fullAccessAcknowledgement, {
    version: 1, agentId: 'claude', acceptedAt: p.agent.fullAccessAcknowledgement.acceptedAt,
    warningHash: 'hash-v1',
  });
  assert.ok(Number.isFinite(p.agent.fullAccessAcknowledgement.acceptedAt));
});

await t('已有有效 Full 确认不重复要求勾选', () => {
  const s = make();
  s.cfg.agent.profile = 'full';
  s.cfg.agent.fullAccessAcknowledged = true;
  s.$('s-profileFull').checked = true;
  s.syncProfileUi();
  assert.equal(s.$('s-fullAckWrap').classList.contains('on'), false);
  assert.doesNotThrow(() => s.patch());
});

await t('换 agent 后已有确认失效', () => {
  const s = make();
  s.cfg.agent.profile = 'full';
  s.cfg.agent.fullAccessAcknowledged = true;
  s.$('s-agent').value = 'codex';
  s.$('s-profileFull').checked = true;
  s.syncProfileUi();
  assert.equal(s.$('s-fullAckWrap').classList.contains('on'), true);
  assert.throws(() => s.patch(), (e) => e.code === 'AGENT_FULL_ACK');
});

await t('dsh 在 Safe 下拒绝保存并展开高级说明', () => {
  const s = make();
  s.$('s-agent').value = 'dsh';
  s.syncProfileUi();
  assert.equal(s.$('s-advanced').open, true);
  assert.match(s.$('s-profileHint').textContent, /安全权限边界未验证/);
  assert.throws(() => s.patch(), (e) => e.code === 'AGENT_SAFE_UNSUPPORTED');
});

await t('legacy Full 保持可用但持续红色警告', () => {
  const s = make();
  s.cfg.agent.profile = 'full';
  s.cfg.agent.profileSource = 'legacy-migrated';
  s.$('s-profileFull').checked = true;
  s.syncProfileUi();
  assert.equal(s.$('s-legacyFull').classList.contains('on'), true);
  assert.equal(s.patch().agent.profile, 'full');
});


await t('legacy Full 更换 Agent 后显示并提交新的风险确认', () => {
  const s = make();
  s.cfg.agent.profile = 'full';
  s.cfg.agent.profileSource = 'legacy-migrated';
  s.$('s-profileFull').checked = true;
  s.$('s-agent').value = 'codex';
  s.$('s-agent').dispatchEvent(new Event('change'));
  assert.equal(s.$('s-legacyFull').classList.contains('on'), false);
  assert.equal(s.$('s-fullAckWrap').classList.contains('on'), true);
  assert.throws(() => s.patch(), (e) => e.code === 'AGENT_FULL_ACK');
  s.$('s-fullAck').checked = true;
  const p = s.patch();
  assert.equal(p.agent.profileSource, 'user');
  assert.equal(p.agent.fullAccessAcknowledgement.agentId, 'codex');
  s.$('s-agent').value = 'claude';
  s.$('s-agent').dispatchEvent(new Event('change'));
  assert.equal(s.$('s-fullAckWrap').classList.contains('on'), false);
  assert.equal(s.patch().agent.profileSource, 'legacy-migrated');
});

await t('四个设置章节在同一页面连续展示', () => {
  const s = make();
  const chapters = [...s.sh.querySelectorAll('.chapter')];
  assert.deepEqual(chapters.map((el) => el.id), [
    's-chapter-translate', 's-chapter-explain', 's-chapter-archive', 's-chapter-scope',
  ]);
  assert.equal(chapters.every((el) => !el.hidden), true);
  assert.equal(s.sh.querySelectorAll('[role="tab"], [role="tabpanel"]').length, 0);
});

await t('表单控件均有可访问标签，消息区可播报', () => {
  const s = make();
  for (const el of s.sh.querySelectorAll('.folio input,.folio select')) {
    assert.ok(el.closest('label') || s.sh.querySelector(`label[for="${el.id}"]`), `${el.id} 缺少标签`);
  }
  assert.equal(s.$('s-msg').getAttribute('aria-live'), 'polite');
  s.msg('保存失败', true);
  assert.equal(s.$('s-msg').getAttribute('role'), 'alert');
});

await t('只写密钥留空时不进入 patch', () => {
  const s = make();
  s.$('s-apiKey').value = '';
  s.$('s-syToken').value = '';
  const p = s.patch();
  assert.equal('apiKey' in p.translate, false);
  assert.equal('token' in p.siyuan, false);
});

await t('摘要随 provider、模型、Agent 和归档后端更新', () => {
  const s = make();
  s.cfg.translate = { apiKeySet: true, apiKeyFromEnv: false };
  s.$('s-provider').value = 'anthropic';
  s.$('s-model').value = 'claude-model';
  s.$('s-exBackend').value = 'agent';
  s.$('s-agent').value = 'claude';
  s.$('s-backend').value = 'markdown';
  s.$('s-mdDir').value = '/notes';
  s.$('s-mdFolder').innerHTML = '<option value="/read">/read</option>';
  s.refreshSummaries();
  assert.match(s.$('s-summary-translate').textContent, /Anthropic · claude-model · 密钥已配置/);
  assert.match(s.$('s-summary-explain').textContent, /Claude Code · Safe/);
  assert.match(s.$('s-summary-archive').textContent, /本地 Markdown · \/notes/);
});

await t('探测动作暴露 busy 状态并在失败后恢复', async () => {
  const s = make();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const run = s.busy('s-fetchModels', '获取中…', async () => { await wait; throw new Error('boom'); });
  assert.equal(s.$('s-fetchModels').disabled, true);
  assert.equal(s.$('s-fetchModels').getAttribute('aria-busy'), 'true');
  release();
  await assert.rejects(run, /boom/);
  assert.equal(s.$('s-fetchModels').disabled, false);
  assert.equal(s.$('s-fetchModels').hasAttribute('aria-busy'), false);
  assert.equal(s.$('s-fetchModels').textContent, '获取模型');
});

await t('停用按钮把范围准确委托给 App', () => {
  const scopes = [];
  document.body.innerHTML = '<div id="host"></div>';
  const sh = document.getElementById('host').attachShadow({ mode: 'open' });
  const mount = document.createElement('div'); sh.appendChild(mount);
  const s = new Settings(sh, mount, {}, (scope) => scopes.push(scope));
  s.$('s-blockPage').click();
  s.$('s-blockSite').click();
  assert.deepEqual(scopes, ['page', 'site']);
});

await t('样式含窄面板断点且没有章节 tab，风险态只用主题 token', () => {
  const css = sCss();
  assert.doesNotMatch(css, /chapter-tab|role=tab/);
  assert.match(css, /@container \(max-width:310px\)/);
  assert.doesNotMatch(css, /#fff8eb|#fee2e2|#eaf5ed/);
});


await t('Agent 下拉只展示名称版本，不暴露内部验证标签', () => {
  const s = make();
  assert.ok(!s.$('s-agent').textContent.includes('未实测'));
  assert.match(s.$('s-agent').textContent, /DeepSeek Harness/);
  s.$('s-agent').value = 'dsh';
  s.syncProfileUi();
  assert.match(s.$('s-profileHint').textContent, /安全权限边界未验证/);
});

console.log(`\n${pass} 项通过`);
