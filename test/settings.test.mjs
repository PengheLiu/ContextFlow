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

await t('DSH 安装状态显示当前使用的桌面版及其版本', () => {
  const s = make();
  Object.assign(s.agents.find(agent => agent.id === 'dsh'), { source: 'desktop', version: '0.2.1-rc.2' });
  s.wantAgent = 'dsh'; s.syncAgentSel();
  assert.equal(s.$('s-agent').value, 'dsh');
  assert.match(s.$('s-agent').selectedOptions[0].textContent, /DeepSeek Harness · 桌面版 · 已安装/);
  assert.equal(s.$('s-agentInstalled').textContent, '已找到桌面版');
  assert.equal(s.$('s-agentVersion').textContent, '版本：0.2.1-rc.2');
  assert.equal(s.$('s-testAgent').disabled, true, 'desktop discovery must not lift the Safe restriction');
});

await t('DSH 旧命令行与自定义入口显示实际来源', () => {
  const s = make(); s.wantAgent = 'dsh';
  for (const [source, label] of [['cli', '命令行兼容版'], ['explicit', '自定义入口']]) {
    Object.assign(s.agents.find(agent => agent.id === 'dsh'), { source, version: 'fixture' });
    s.syncAgentSel();
    assert.ok(s.$('s-agent').selectedOptions[0].textContent.includes(label));
    assert.equal(s.$('s-agentInstalled').textContent, `已找到${label}`);
  }
});

await t('桌面 DSH 可单独支持禁用工具的连接测试，普通 Safe 权限仍未开放', () => {
  const s = make();
  Object.assign(s.agents.find(agent => agent.id === 'dsh'), {
    source: 'desktop', version: '0.2.1-rc.2', connectionTestSupported: true,
  });
  s.wantAgent = 'dsh'; s.syncAgentSel();
  assert.equal(s.$('s-testAgent').disabled, false);
  assert.match(s.$('s-agentTestStatus').textContent, /独立会话.*禁用全部工具/);
  assert.equal(s.agents.find(agent => agent.id === 'dsh').safeSupport, 'unsupported');
  assert.throws(() => s.patch(), /安全权限边界未验证|完整权限/);
  s.agents.find(agent => agent.id === 'dsh').connectionTestSupported = false;
  s.renderAgentState();
  assert.equal(s.$('s-testAgent').disabled, true);
});

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

await t('配置完整后先展示章节摘要；未保存草稿不会因重新打开被覆盖', async () => {
  const s = make();
  const cfg = { ...s.cfg, translate: { provider: 'openai', baseUrl: 'https://model.test', model: 'saved', apiKeySet: true }, sync: { backend: 'markdown' }, markdown: { dir: '/notes', folder: '/阅读记录' }, obsidian: {}, siyuan: {} };
  let reads = 0;
  s.api.getConfig = async () => { reads++; return cfg; };
  s.api.listFolders = async () => ({ root: '/notes', folders: ['/阅读记录'] });
  s.api.health = async () => ({ serviceVersion: '0.3.3', llmConfigured: true, capabilities: ['llm.draft'] });
  await s.load();
  await s.checkService();
  assert.equal(s.$('s-chapter-translate').open, false);
  assert.equal(s.$('s-chapter-archive').open, false);
  assert.match(s.$('s-serviceStatus').textContent, /已配置/);
  s.$('s-model').value = 'unsaved';
  s.$('s-model').dispatchEvent(new Event('input', { bubbles: true }));
  await s.load();
  assert.equal(reads, 1);
  assert.equal(s.$('s-model').value, 'unsaved');
  assert.match(s.$('s-msg').textContent, /未保存/);
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

await t('手填 Vault 路径优先于探测值，未探测到时仍保留已保存路径', async () => {
  const s = make();
  s.cfg.obsidian = { vaultPath: '/saved/vault' };
  s.api.listVaults = async () => ({ vaults: [] });
  await s.loadVaults();
  assert.equal(s.$('s-vault').value, '/saved/vault');
  s.$('s-vaultPath').value = '~/My Notes';
  assert.equal(s.patch().obsidian.vaultPath, '~/My Notes');
});

await t('上下文长度 0 表示不带正文，保存不能悄悄改回 5000', () => {
  const s = make();
  s.$('s-chunkChars').value = '0';
  assert.equal(s.patch().translate.chunkChars, 0);
  s.$('s-chunkChars').value = '';
  assert.equal(s.patch().translate.chunkChars, 5000);
});

await t('独立连接页隐藏网页停用设置，不调用思源来保存 Markdown 配置', async () => {
  const s = make();
  s.$('s-backend').value = 'markdown';
  let paths = 0;
  s.persist = async () => {};
  s.loadPaths = async () => { paths++; };
  await s.save();
  assert.equal(paths, 0);
});

await t('获取模型在按钮旁和 toast 都报告去重数量，保留当前模型', async () => {
  const s = make();
  s.$('s-model').value = 'b';
  let saves = 0;
  s.persist = async () => { saves++; };
  s.api.listModels = async () => ({ models: ['a', 'b', 'a', '', null] });
  await s.fetchModels();
  assert.equal(saves, 0, '读取列表不能保存任何配置');
  assert.equal(s.$('s-model').value, 'b');
  assert.equal(s.$('s-modelPick').options.length, 3, '含一个未选择占位项');
  assert.match(s.$('s-modelListStatus').textContent, /已获取到 2 个模型/);
  assert.match(s.$('s-toastText').textContent, /已获取到 2 个模型/);
  assert.equal(s.$('s-toast').hidden, false);
  s.$('s-dismissToast').click();
  assert.equal(s.$('s-toast').hidden, true);
  assert.match(s.$('s-modelListStatus').textContent, /已获取到 2 个模型/);
});

await t('原模型不在列表时报告数量但不切换、不保存', async () => {
  const s = make();
  s.$('s-model').value = 'old';
  s.persist = async () => {};
  s.api.listModels = async () => ({ models: ['new-model'] });
  await s.fetchModels();
  assert.equal(s.$('s-model').value, 'old');
  assert.equal(s.$('s-modelPick').value, '');
  assert.match(s.$('s-modelListStatus').textContent, /已获取到 1 个模型/);
  assert.match(s.$('s-toastText').textContent, /当前模型「old」不在列表中，已保留/);
});

await t('空列表和失败会清除旧选项，保留手填模型并给出可见反馈', async () => {
  const s = make();
  s.persist = async () => {};
  s.$('s-model').value = 'manual-model';
  s.$('s-modelPick').innerHTML = '<option>stale</option>';
  s.$('s-modelPickWrap').hidden = false;
  s.api.listModels = async () => ({ models: [] });
  await s.fetchModels();
  assert.equal(s.$('s-model').value, 'manual-model');
  assert.equal(s.$('s-modelPickWrap').hidden, true);
  assert.equal(s.$('s-modelPick').options.length, 0);
  assert.match(s.$('s-modelListStatus').textContent, /获取到 0 个模型/);
  assert.equal(s.$('s-modelListStatus').getAttribute('role'), 'alert');
  s.api.listModels = async () => { throw new Error('网关返回 401'); };
  await s.fetchModels();
  assert.match(s.$('s-toastText').textContent, /获取模型失败.*401/);
  s.api.listModels = async () => ({ models: {} });
  await s.fetchModels();
  assert.match(s.$('s-modelListStatus').textContent, /模型列表无效/);
});

await t('模型获取与选择不校验其他章节，不产生配置写入', async () => {
  const s = make();
  s.$('s-profileFull').checked = true;
  s.$('s-apiKey').value = 'draft-secret';
  s.$('s-baseUrl').value = 'https://model.test';
  s.persist = async () => { throw new Error('不应保存'); };
  let got;
  s.api.listModels = async (draft) => { got = draft; return { models: ['mock-model'] }; };
  await s.fetchModels();
  assert.equal(got.apiKey, 'draft-secret');
  assert.equal('agent' in got, false);
  await s.pickModel('mock-model');
  assert.equal(s.$('s-model').value, 'mock-model');
  assert.equal(s.dirty, true);
  assert.match(s.$('s-msg').textContent, /未保存/);
  assert.equal(s.$('s-apiKey').value, 'draft-secret');
  assert.doesNotMatch(s.$('s-toastText').textContent, /draft-secret/);
});

await t('测试只传连接草稿，填写在响应前改变时不会把新内容误报为已验证', async () => {
  const s = make();
  s.persist = async () => { throw new Error('不应保存'); };
  s.$('s-model').value = 'before';
  s.api.testModel = async (draft) => {
    assert.equal(draft.model, 'before');
    s.$('s-model').value = 'after';
    return { ok: true, model: 'before' };
  };
  await s.testModel();
  assert.match(s.$('s-modelStatus').textContent, /内容已变化/);
  assert.equal(s.$('s-msg').textContent, '', '模型结果不在底栏重复展示');
});

await t('修改目的地后探测目录不会隐式保存或探测旧目录', async () => {
  const s = make();
  s.cfg.markdown = { dir: '/saved' };
  s.$('s-mdDir').value = '/draft';
  s.persist = async () => { throw new Error('不应保存'); };
  s.api.listFolders = async () => { throw new Error('不应探测旧目录'); };
  await s.loadFolders('markdown', true);
  assert.match(s.$('s-msg').textContent, /保存笔记位置后/);
});

await t('模型测试成功与失败都在原位和 toast 显示，失败可重试', async () => {
  const s = make();
  s.persist = async () => {};
  s.api.testModel = async () => { throw new Error('本地服务版本过旧，请重启'); };
  await s.testModel();
  assert.match(s.$('s-modelStatus').textContent, /测试失败.*请重启/);
  assert.equal(s.$('s-modelStatus').getAttribute('role'), 'alert');
  assert.match(s.$('s-toastText').textContent, /测试失败/);
  s.api.testModel = async () => ({ ok: true, model: 'mock-model' });
  await s.testModel();
  assert.match(s.$('s-modelStatus').textContent, /模型连接成功：mock-model/);
  assert.equal(s.$('s-modelStatus').getAttribute('role'), 'status');
  s.api.testModel = async () => ({ error: 'unexpected' });
  await s.testModel();
  assert.match(s.$('s-modelStatus').textContent, /测试结果无效/);
});

await t('获取与测试互斥，双击不重复请求，完成后按钮恢复', async () => {
  const s = make();
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const first = s.modelAction('s-fetchModels', '获取中…', async () => { calls++; await pending; });
  assert.equal(s.$('s-fetchModels').disabled, true);
  assert.equal(s.$('s-testModel').disabled, true);
  await s.modelAction('s-testModel', '测试中…', async () => { calls++; });
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(s.$('s-fetchModels').disabled, false);
  assert.equal(s.$('s-testModel').disabled, false);
});

await t('toast 使用文字而非 HTML，并可独立关闭', () => {
  const s = make();
  s.msg('<img src=x onerror=alert(1)>');
  assert.equal(s.$('s-toast').querySelectorAll('img').length, 0);
  assert.match(s.$('s-toastText').textContent, /<img/);
  s.msg('');
  assert.equal(s.$('s-toast').hidden, true);
});

await t('配置读取期间显示加载状态并合并重复读取，不允许初始化覆盖提前交互', async () => {
  const s=make(); let finish, calls=0;
  const cfg={...s.cfg,translate:{provider:'openai',baseUrl:'https://model.test',model:'saved',apiKeySet:true},sync:{backend:'markdown'},markdown:{dir:'/notes'},obsidian:{},siyuan:{}};
  s.api.getConfig=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const a=s.load(), b=s.load();
  assert.equal(s.form.hidden,true); assert.equal(s.loadingNotice.hidden,false); assert.equal(calls,1);
  finish(cfg); await Promise.all([a,b]);
  assert.equal(s.form.hidden,false); assert.equal(s.loadingNotice.hidden,true);
  assert.equal(s.$('s-chapter-translate').open,false);
});

await t('Agent 安装检测有数量与原位反馈，但不会暗示已登录或切换原选择', async () => {
  const s=make();s.wantAgent='codex';let writes=0;
  s.api.putConfig=async()=>writes++;
  s.api.detectAgents=async()=>({agents:[{id:'claude',label:'Claude Code',available:true,version:'fixture',safeSupport:'best-effort'},{id:'codex',label:'Codex CLI',available:false,safeSupport:'verified'}]});
  await s.detectAgents(true);
  assert.equal(s.$('s-agent').value,'codex');assert.equal(s.$('s-testAgent').disabled,true);
  assert.match(s.$('s-agentDiscoveryStatus').textContent,/检测到 1 个.*安装不代表已登录/);
  assert.match(s.$('s-toastText').textContent,/检测到 1 个/);assert.equal(writes,0);
  s.$('s-agent').value='claude';s.$('s-agent').dispatchEvent(new Event('change'));
  assert.equal(s.$('s-testAgent').disabled,false);assert.match(s.$('s-agentConnection').textContent,/尚未测试/);
});

await t('Agent 测试与配置保存分离，排队/可用/认证失败明确展示并恢复按钮', async () => {
  const s=make();let writes=0,calls=0;
  s.api.putConfig=async()=>writes++;
  s.api.testAgent=async(id,{onProgress})=>{calls++;onProgress({queuedAhead:2});assert.match(s.$('s-agentTestStatus').textContent,/前面 2 个/);return {ok:true,agent:id,scope:'connection-only',checkedAt:Date.now()};};
  await s.testAgent();assert.equal(calls,1);assert.equal(writes,0);
  assert.equal(s.$('s-agentReady').textContent,'可用');assert.match(s.$('s-agentTestStatus').textContent,/认证与模型回应正常/);
  assert.match(s.sh.querySelector('.agent-health').textContent,/不验证笔记读取或完整权限/);
  assert.equal(s.$('s-testAgent').disabled,false);assert.equal(s.$('s-save').disabled,false);
  s.api.testAgent=async()=>{throw Object.assign(new Error('请在终端完成登录'),{code:'AGENT_AUTH'});};
  await s.testAgent();assert.equal(s.$('s-agentReady').textContent,'需处理');assert.equal(s.$('s-agentTestStatus').getAttribute('role'),'alert');
  assert.match(s.$('s-agentTestStatus').textContent,/终端完成登录/);assert.equal(writes,0);
});

await t('取消 Agent 测试后可立即重试，旧结果与清理不能覆盖新测试', async () => {
  const s=make();const runs=[];
  s.api.testAgent=(id,{signal})=>new Promise(resolve=>runs.push({id,signal,resolve}));
  const first=s.testAgent();await s.testAgent();assert.equal(runs.length,1);assert.equal(s.$('s-cancelAgentTest').hidden,false);
  s.cancelAgentTest();assert.equal(runs[0].signal.aborted,true);
  const second=s.testAgent();assert.equal(runs.length,2);
  runs[0].resolve({ok:true,agent:'claude',scope:'connection-only'});await first;
  assert.equal(s.$('s-testAgent').disabled,true);assert.equal(s.agentWorking,true);
  runs[1].resolve({ok:true,agent:'claude',scope:'connection-only'});await second;
  assert.equal(s.$('s-agentReady').textContent,'可用');assert.equal(s.$('s-testAgent').disabled,false);
});

await t('章节用箭头、明确文案及状态；展开不会自动关闭其他章节或重建输入', () => {
  const s=make(),first=s.$('s-chapter-translate'),second=s.$('s-chapter-explain');
  first.open=false;first.disclosure.sync();second.open=false;second.disclosure.sync();
  const input=s.$('s-model');input.value='保留草稿';
  first.querySelector('summary').click();second.querySelector('summary').click();
  assert.equal(first.open,true);assert.equal(second.open,true);assert.equal(s.$('s-model'),input);
  assert.equal(first.querySelector('[data-disclosure-label]').textContent,'收起');
  assert.equal(first.querySelector('summary').getAttribute('aria-expanded'),'true');
  assert.ok(first.querySelector('.chapter-state'));assert.ok(first.querySelector('.chapter-affordance svg'));
});

await t('欢迎页保存后，新设置实例从服务恢复模型和 Agent 测试；不再次调用 AI', async () => {
  const first=make(),checkedAt=Date.now()-60000;
  const cfg={...first.cfg,translate:{provider:'openai',baseUrl:'https://model.test',model:'saved',apiKeySet:true},
    explain:{backend:'agent'},sync:{backend:'markdown'},markdown:{dir:'/notes'},obsidian:{},siyuan:{},
    connectionChecks:{model:{ok:true,checkedAt},agents:{claude:{ok:true,checkedAt}}}};
  let modelCalls=0,agentCalls=0;
  const api={getConfig:async()=>structuredClone(cfg),listFolders:async()=>({folders:[]}),
    testModel:async()=>modelCalls++,testAgent:async()=>agentCalls++};
  first.api=api;await first.load();
  assert.equal(first.$('s-state-translate').textContent,'连接已通过');
  assert.equal(first.$('s-agentReady').textContent,'可用');
  assert.match(first.$('s-modelStatus').textContent,/上次模型测试通过/);
  assert.match(first.$('s-agentConnection').textContent,/已通过 ·/);
  const next=make();next.api=api;await next.load();
  assert.equal(next.modelTest.checkedAt,checkedAt);
  assert.equal(next.agentTests.get('claude').checkedAt,checkedAt);
  assert.equal(modelCalls+agentCalls,0);
  next.$('s-apiKey').value='changed';next.$('s-apiKey').dispatchEvent(new Event('input',{bubbles:true}));
  assert.match(next.$('s-state-translate').textContent,/待测试/);
  next.$('s-agent').value='codex';next.$('s-agent').dispatchEvent(new Event('change',{bubbles:true}));
  assert.match(next.$('s-agentConnection').textContent,/尚未测试/);
});

await t('保存时以服务返回记录为准；改密钥后不保留旧成功，刷新可恢复失败状态', async () => {
  const s=make();s.cfg.translate={apiKeySet:true};
  s.$('s-model').value='saved';s.$('s-baseUrl').value='https://model.test';
  s.applyConnectionChecks({model:{ok:true,checkedAt:1000},agents:{claude:{ok:true,checkedAt:1000}}});
  s.$('s-apiKey').value='changed';
  s.api.putConfig=async()=>({translate:{apiKeySet:true},siyuan:{tokenSet:false},connectionChecks:{model:null,agents:{}}});
  await s.persist({silent:true});
  assert.equal(s.modelTest,null);assert.equal(s.agentTests.size,0);
  assert.match(s.$('s-state-translate').textContent,/待测试/);
  s.applyConnectionChecks({model:{ok:false,checkedAt:2000},agents:{claude:{ok:false,checkedAt:2000}}});
  assert.equal(s.$('s-state-translate').textContent,'连接失败');
  assert.match(s.$('s-agentConnection').textContent,/未通过/);
  assert.equal(s.$('s-agentTestStatus').getAttribute('role'),'alert');
});

await t('简洁回答方式旁的问号可点击展开，Esc 收起并返回焦点；不保存或调用模型', () => {
  const s=make();
  assert.deepEqual([...s.$('s-exBackend').options].map(row=>row.textContent),['LLM','本地 Agent']);
  const trigger=s.$('s-answerHelp'),help=s.$('s-answerHelpContent');
  assert.equal(help.hidden,true);trigger.click();
  assert.equal(help.hidden,false);assert.equal(trigger.getAttribute('aria-expanded'),'true');
  assert.match(help.textContent,/不能主动读取本机笔记/);assert.match(help.textContent,/授权范围/);
  assert.match(help.textContent,/翻译始终/);assert.match(help.textContent,/不验证笔记访问或工具权限/);
  assert.equal(s.dirty,undefined);
  s.$('s-exBackend').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(help.hidden,true);assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.equal(s.sh.activeElement,trigger);
  trigger.click();trigger.click();assert.equal(help.hidden,true);
});

await t('新 Agent 路径可直接测试草稿；通过前不能保存，通过后一次保存全部明确更改',async()=>{
  const s=make(),states=[];let writes=0,tests=0,savedState;
  s.cfg={...s.cfg,explain:{backend:'llm'},translate:{apiKeySet:false},siyuan:{tokenSet:false}};
  s.service={agentTestSupported:true,agentDraftTestSupported:true};
  s.onStateChange=state=>states.push({...state});s.onSaved=()=>{savedState={dirty:s.dirty,saving:s.saving};};
  s.$('s-exBackend').value='agent';s.$('s-exBackend').dispatchEvent(new Event('change',{bubbles:true}));
  s.$('s-agentExecutable').value='/fixture/new-claude';s.$('s-agentExecutable').dispatchEvent(new Event('input',{bubbles:true}));
  assert.equal(s.$('s-testAgent').disabled,false);assert.equal(s.$('s-save').disabled,true);
  assert.throws(()=>s.patch(),e=>e.code==='AGENT_TEST_REQUIRED');
  s.api.testAgent=async(id,{draft})=>{tests++;assert.deepEqual(draft,{executable:'/fixture/new-claude',profile:'safe'});return {ok:true,agent:id,path:'/fixture/new-claude',executable:draft.executable,version:'new',configuredProfile:draft.profile,scope:'connection-only',checkedAt:3000};};
  s.api.putConfig=async patch=>{writes++;return {...s.cfg,...patch,translate:{...patch.translate,apiKeySet:false},siyuan:{...patch.siyuan,tokenSet:false},connectionChecks:{agents:{claude:{ok:true,path:'/fixture/new-claude',version:'new',profile:'safe',checkedAt:3000}}}};};
  await s.testAgent();assert.equal(tests,1);assert.equal(writes,0);assert.equal(s.$('s-save').disabled,false);
  assert.match(s.$('s-agentTestStatus').textContent,/可以保存/);await s.save();
  assert.equal(writes,1);assert.equal(s.dirty,false);assert.equal(s.saving,false);assert.equal(s.$('s-save').disabled,false);
  assert.equal(savedState.dirty,false);assert.equal(states.at(-1).saving,false);assert.equal(states.at(-1).dirty,false);
  assert.ok(states.some(state=>state.agentWorking));assert.ok(states.some(state=>state.saving));
});

await t('Agent id、路径、版本或权限档变化即失效，测试不授予Full与笔记权限',async()=>{
  const s=make();s.cfg.explain={backend:'llm'};s.$('s-exBackend').value='agent';
  s.api.testAgent=async(id,{draft})=>({ok:true,agent:id,path:'/fixture/claude',version:'v1',configuredProfile:draft.profile,scope:'connection-only',checkedAt:4000});
  await s.testAgent();assert.equal(s.agentResult().ok,true);
  s.agents.find(row=>row.id==='claude').version='v2';s.renderAgentState();assert.equal(s.agentResult(),null);assert.equal(s.$('s-save').disabled,true);
  s.agents.find(row=>row.id==='claude').version='v1';
  s.$('s-agentExecutable').value='/fixture/changed';s.$('s-agentExecutable').dispatchEvent(new Event('input',{bubbles:true}));assert.equal(s.agentResult(),null);
  s.$('s-agentExecutable').value='';s.$('s-profileFull').checked=true;s.$('s-profileFull').dispatchEvent(new Event('change',{bubbles:true}));assert.equal(s.agentResult(),null);
  await s.testAgent();assert.equal(s.agentResult().ok,true);assert.throws(()=>s.patch(),e=>e.code==='AGENT_FULL_ACK','connection success cannot acknowledge Full permissions');
  assert.equal(s.$('s-notesDir').value,'');s.$('s-profileSafe').checked=true;s.$('s-agent').value='codex';s.$('s-agent').dispatchEvent(new Event('change',{bubbles:true}));assert.equal(s.agentResult(),null);
});

await t('既有已保存Agent不因只改语言或笔记等无关设置被测试门槛锁住',async()=>{
  const s=make();let writes=0;s.cfg={...s.cfg,explain:{backend:'agent'},translate:{apiKeySet:false},siyuan:{tokenSet:false}};
  s.$('s-exBackend').value='agent';s.$('s-target').value='English';s.$('s-target').dispatchEvent(new Event('input',{bubbles:true}));
  assert.equal(s.needsAgentTest(),false);assert.equal(s.$('s-save').disabled,false);
  s.api.putConfig=async patch=>{writes++;return {...s.cfg,...patch,translate:{...patch.translate,apiKeySet:false},siyuan:{...patch.siyuan,tokenSet:false}};};
  await s.save();assert.equal(writes,1);assert.equal(s.saving,false);
});

await t('测试中再改草稿不能让旧结果变绿或放开保存，失败重试不触碰配置',async()=>{
  const s=make();s.cfg.explain={backend:'llm'};s.$('s-exBackend').value='agent';let finish,writes=0;
  s.api.putConfig=async()=>writes++;s.api.testAgent=()=>new Promise(resolve=>{finish=resolve;});
  const checking=s.testAgent();s.$('s-agentExecutable').value='/fixture/newer';s.$('s-agentExecutable').dispatchEvent(new Event('input',{bubbles:true}));
  finish({ok:true,agent:'claude',path:'/fixture/old',version:'v1',configuredProfile:'safe',scope:'connection-only'});await checking;
  assert.equal(s.agentResult(),null);assert.equal(s.$('s-save').disabled,true);assert.match(s.$('s-toastText').textContent,/当前选择已变化/);assert.equal(writes,0);
  s.api.testAgent=async()=>{throw Object.assign(new Error('请登录后重试'),{code:'AGENT_AUTH'});};await s.testAgent();
  assert.equal(s.$('s-testAgent').disabled,false);assert.equal(s.$('s-save').disabled,true);assert.equal(writes,0);
});

await t('自定义路径允许未检测到的已选Agent测试；旧服务只保留未更改配置的ID测试',async()=>{
  const s=make();s.$('s-agent').value='codex';s.agents.find(row=>row.id==='codex').available=false;
  s.$('s-agentExecutable').value='/fixture/codex';s.renderAgentState();assert.equal(s.$('s-testAgent').disabled,false);
  s.service={agentTestSupported:true,agentDraftTestSupported:false};s.renderAgentState();assert.equal(s.$('s-testAgent').disabled,true);assert.match(s.$('s-agentTestStatus').textContent,/草稿.*更新/);
  s.$('s-agent').value='claude';s.$('s-agentExecutable').value='';s.renderAgentState();assert.equal(s.$('s-testAgent').disabled,false);
});

await t('DSH新路径可以请求重新核实受限测试，但连接成功不会解锁普通Safe',async()=>{
  const s=make();s.cfg.explain={backend:'llm'};s.$('s-exBackend').value='agent';
  s.$('s-agent').value='dsh';s.$('s-agentExecutable').value='/fixture/new-dsh';s.renderAgentState();assert.equal(s.$('s-testAgent').disabled,false);
  s.api.testAgent=async()=>({ok:true,agent:'dsh',label:'DeepSeek Harness',path:'/fixture/new-dsh',version:'fixture',configuredProfile:'safe',safeSupport:'unsupported',connectionTestSupported:true,scope:'connection-only'});
  await s.testAgent();assert.equal(s.agentResult().ok,true);assert.throws(()=>s.patch(),e=>e.code==='AGENT_SAFE_UNSUPPORTED');
  assert.equal(s.$('s-profileFull').checked,false);assert.equal(s.$('s-notesDir').value,'');
});

console.log(`\n${pass} 项通过`);
