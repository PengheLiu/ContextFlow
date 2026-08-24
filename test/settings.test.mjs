// 设置页的 Agent Safe / Full 交互与风险确认。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event']) global[k] = dom.window[k];
const { Settings } = await import('../src/skill/settings.js');

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

console.log(`\n${pass} 项通过`);
