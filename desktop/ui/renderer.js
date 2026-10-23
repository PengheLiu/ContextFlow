import * as api from '../../src/core/api.js';
import { Settings, SETTINGS_CSS } from '../../src/skill/settings.js';
import { BASE } from '../../src/skill/theme.js';
import { STEPS, productState } from './product-state.js';
import { destinationIdentity } from '../../src/core/destination.js';
import { installInputModality } from './focus.js';

const ICONS = {
  home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',
  spark: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z"/>',
  folder: '<path d="M3 7h7l2 2h9v11H3z"/><path d="M3 7V4h7l2 3h8v2"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  reading: '<path d="M12 6C8 3 4 4 2 5v15c3-1 7-1 10 1 3-2 7-2 10-1V5c-2-1-6-2-10 1zM12 6v15"/><path d="M5 9h4M5 12h4M16 9h3M16 12h3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
const DESKTOP_FORM_CSS = `:host{display:block}.folio-kicker{display:none}.chapter-deck{padding:0;background:none;gap:16px}.save{bottom:0;border-radius:8px;margin-top:16px}.folio{font-size:14px}.chapter-head{padding:18px 16px}.chapter-body{padding:20px 18px 22px}.desktop-field-picker{align-self:flex-start;justify-self:start;padding:7px 10px;margin-top:3px;font-size:11px;border:1px solid #d0ddcc;border-radius:6px;background:#f2f6ee;color:#365c41;cursor:pointer;min-height:34px}.desktop-field-picker:focus-visible{outline:3px solid #6c9775;outline-offset:2px}.chapter[data-expanded=true]{border-color:#c8d7c3}.chapter[data-expanded=true] .chapter-icon,.answer-help-button{color:#52745b}.save>button{background:#52745b;border-color:#52745b;color:#fff}.save>button:hover{background:#365c41;color:#fff}.save::before{background:#52745b}.settings-toast{position:sticky;bottom:70px;left:auto;right:auto;transform:none;margin:14px 0 0;max-width:none}.settings-toast.bad{background:#fff0e9;color:#923f2d}.settings-status{margin-bottom:14px}.settings-status:not(.bad){display:none}.chapter-state[data-state=ok]{background:#eaf2e8;color:#3b6845}.chapter-intro{font-family:inherit}@media(max-width:650px){.chapter-head{padding:14px 12px}.chapter-body{padding:16px 12px}.chapter-meta{max-width:150px}.save{padding:12px}}`;

export function startDesktopUI({ desktop = window.contextflowDesktop, serviceAPI = api, root = document, poll = true } = {}) {
  const win = root.defaultView, $ = id => root.getElementById(id);
  const disposeInputModality = installInputModality({ root });
  serviceAPI.setTransport?.((path, init) => desktop.request(path, { method: init?.method, body: init?.body }));
  let current, cfg, settings, loadingSettings, refreshing, refreshAgain = false, activePage = 'home', initialized = false, disposed = false;
  let pairingSignature = '', recoverySignature = '', discoverySignature = '', explicitPageRequested = false;
  const busyButtons = new Set();
  let refreshQueued = false;
  function requestRefresh() {
    if (disposed || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; if (!disposed) refresh(); });
  }
  const make = (tag, className, text) => { const el = root.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  for (const placeholder of root.querySelectorAll('[data-icon]')) placeholder.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[placeholder.dataset.icon] || ICONS.info}</svg>`;
  for (const button of root.querySelectorAll('nav [data-page]')) button.setAttribute('aria-label', button.textContent.trim());
  function notice(message, error = false) {
    $('toast').hidden = false; $('toast').dataset.error = String(error);
    $('toast').setAttribute('role', error ? 'alert' : 'status'); $('toast-message').textContent = message;
  }
  $('dismiss-toast').onclick = () => { $('toast').hidden = true; };
  const skipLink = root.querySelector('.skip-link');
  const skipFocus = event => {
    if (event.target === skipLink && root.documentElement.dataset.inputModality !== 'keyboard') skipLink.blur();
  };
  root.addEventListener('focusin', skipFocus);
  if (root.activeElement === skipLink) skipLink.blur();
  if (skipLink) skipLink.onclick = event => { event.preventDefault(); $('main').focus({ preventScroll: true }); };
  async function perform(button, operation) {
    if (button.disabled || disposed) return;
    busyButtons.add(button); button.disabled = true; button.setAttribute('aria-busy', 'true');
    try { await operation(); } catch (error) { notice(error.message || '操作未完成，请重试。', true); }
    finally { busyButtons.delete(button); button.disabled = false; button.removeAttribute('aria-busy'); if (!disposed) await refresh(); }
  }
  function badge(id, text, state = '') { $(id).textContent = text; $(id).dataset.state = state; }
  function mode() { return activePage === 'notes' || activePage === 'setup' && current?.journey?.step === 'notes' ? 'notes' : 'ai'; }
  function showDraft() {
    const dirty = !!settings?.dirty;
    if (settings) settings.form.dataset.dirty = String(dirty);
    $('draft-note').dataset.dirty = String(dirty);
    $('draft-note').textContent = dirty ? '有未保存的更改。切换页面会保留草稿；「保存更改」会提交 AI 与笔记的全部未保存改动。' : 'AI 与笔记共用一份配置。切换页面保留草稿；「保存更改」会提交所有未保存的改动。';
    renderConfirmation(); renderJourney();
  }
  async function configuration({ force = false } = {}) {
    const running = current?.service?.state === 'running'; $('settings-unavailable').hidden = running;
    if (!running) return;
    if (loadingSettings) return loadingSettings;
    if (!settings) {
      const shadow = $('configuration').attachShadow({ mode: 'open' }), style = make('style');
      style.textContent = BASE + SETTINGS_CSS + DESKTOP_FORM_CSS + `.chapter,.profile,.agent-health,.advanced,.field input,.field select{background:#fff;border-color:#dce3dc}.chapter-body{border-color:#e3e9e0}.field input:focus,.field select:focus{border-color:#6c9775;box-shadow:0 0 0 3px #d8e7d3}.check-row input,.profile input[type=radio]{accent-color:#52745b}.destination{display:none}.save{background:#f8f9f7;border-color:#dce3dc}.desktop-form:not([data-dirty=true]) .save{display:none}.answer-help-button:hover,.answer-help-button[aria-expanded=true]{color:#365c41;background:#eaf2e8}.settings-toast{position:static;inset:auto;transform:none;margin:14px 0 0;max-width:100%;width:auto;overflow-wrap:anywhere}`;
      const mount = make('div'); shadow.append(style, mount);
      const settingsAPI = { ...serviceAPI, getConfig: async () => cfg || serviceAPI.getConfig() };
      settings = new Settings(shadow, mount, settingsAPI, null, { standalone: true, desktop: true,
        chooseFolder: target => desktop.chooseFolder(target), chooseAgent: () => desktop.chooseAgent(),
        onSaved: saved => { cfg = saved; notice('更改已保存，Chrome 扩展与桌面端使用同一份配置。'); showDraft(); },
        onStateChange: () => {
          showDraft();
          if (settings && !settings.dirty && !settings.saving && !settings.modelWorking && !settings.agentWorking) requestRefresh();
        },
      });
      for (const event of ['input', 'change']) mount.addEventListener(event, () => queueMicrotask(showDraft));
    }
    if (!settings.cfg || force && !settings.dirty && !settings.modelWorking && !settings.agentWorking && !settings.saving && !settings.detecting && !settings.sh.activeElement?.matches('input,select,button')) {
      loadingSettings = settings.load();
      try { await loadingSettings; } finally { loadingSettings = null; }
    }
    settings.setPresentation(mode()); showDraft();
  }
  function parkWorkspace() { if ($('settings-workspace').parentElement !== $('workspace-parking')) $('workspace-parking').append($('settings-workspace')); }
  async function placeWorkspace({ force = false } = {}) {
    let target;
    if (activePage === 'ai') target = 'ai-slot';
    if (activePage === 'notes') target = 'notes-slot';
    if (activePage === 'setup' && ['tools', 'notes'].includes(current?.journey?.step)) target = `setup-${current.journey.step}-slot`;
    if (!target) { parkWorkspace(); return; }
    if ($('settings-workspace').parentElement !== $(target)) $(target).append($('settings-workspace'));
    const notes = mode() === 'notes'; $('agent-discovery').hidden = notes; $('note-discovery').hidden = !notes; $('note-confirmation').hidden = !notes;
    if (notes && $('settings-workspace').firstElementChild !== $('note-confirmation')) $('settings-workspace').prepend($('note-confirmation'));
    await configuration({ force });
  }
  async function page(name, { focus = true, force = false } = {}) {
    if (!['home', 'setup', 'ai', 'notes', 'support'].includes(name)) return;
    activePage = name;
    for (const section of root.querySelectorAll('main>section[data-view]')) section.hidden = section.dataset.view !== name;
    for (const button of root.querySelectorAll('nav [data-page]')) {
      if (button.dataset.page === (name === 'setup' ? 'home' : name)) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    await placeWorkspace({ force });
    $('main').scrollTop = 0;
    if (focus) root.querySelector(`[data-view="${name}"] h1`)?.focus({ preventScroll: true });
  }
  async function journey(patch) {
    const updated = await desktop.onboarding(patch);
    if (updated?.step) current.journey = updated;
    else current.journey = { ...current.journey, ...patch };
    await refresh();
  }
  function currentStep() { const step = current?.journey?.step; return STEPS.includes(step) ? step : 'connect'; }
  async function goStep(step) { await journey({ step, dismissed: false }); renderJourney(); await page('setup'); }
  for (const button of root.querySelectorAll('[data-page]')) button.onclick = () => perform(button, () => page(button.dataset.page, { force: true }));
  for (const button of root.querySelectorAll('[data-step]')) button.onclick = () => perform(button, () => goStep(button.dataset.step));
  $('resume-setup').onclick = () => perform($('resume-setup'), () => goStep(currentStep()));
  $('defer-setup').onclick = () => perform($('defer-setup'), async () => { await journey({ dismissed: true }); await page('home'); notice('准备进度已保留，随时可从「继续首次准备」接着设置。'); });
  $('setup-back').onclick = () => perform($('setup-back'), () => goStep(STEPS[Math.max(0, STEPS.indexOf(currentStep()) - 1)]));
  $('setup-skip').onclick = () => perform($('setup-skip'), () => goStep(STEPS[Math.min(3, STEPS.indexOf(currentStep()) + 1)]));
  $('setup-next').onclick = () => perform($('setup-next'), async () => {
    const state = productState(current, cfg), step = currentStep();
    if (step === 'connect' && !state.browser.ok || step === 'tools' && (!state.ai.ok || settings?.dirty || settings?.saving || settings?.agentWorking || settings?.modelWorking) || step === 'notes' && (!state.notes.confirmed || settings?.dirty || settings?.saving)) throw new Error('请先完成当前步骤，或点击「暂时跳过」稍后再配置。');
    if (currentStep() === 'finish') { await journey({ dismissed: true }); await page('home'); await desktop.action('practice'); }
    else await goStep(STEPS[STEPS.indexOf(currentStep()) + 1]);
  });
  async function action(name) {
    const result = await desktop.action(name);
    if (name === 'diagnostics' && result) notice('脱敏诊断已导出；未包含文章、网址、密钥或原始日志。');
    if (name === 'browser') notice('已打开连接指引。请在 Chrome 的目标用户配置中发起连接，再回到桌面端确认授权。');
    return result;
  }
  for (const button of root.querySelectorAll('[data-action]')) button.onclick = () => perform(button, () => action(button.dataset.action));
  for (const button of root.querySelectorAll('[data-discover]')) button.onclick = () => perform(button, async () => { await desktop.discover({ fresh: true }); notice('已重新检查本机工具；发现结果不代表已经授权或测试通过。'); });
  $('home-primary').onclick = () => perform($('home-primary'), async () => {
    const kind = productState(current, cfg).action.kind;
    if (['setup', 'notes', 'ai', 'support'].includes(kind)) { await page(kind); if (kind === 'support') $('service-controls').open = true; }
    else if (kind !== 'none') await action(kind);
  });
  $('open-at-login').onchange = () => perform($('open-at-login'), async () => { await desktop.preferences({ openAtLogin: $('open-at-login').checked }); notice('登录启动设置已更新。'); });
  $('create-recovery').onclick = () => perform($('create-recovery'), async () => { await desktop.recovery('create'); notice('本机恢复点已创建，本地服务已重新启动。浏览器离线记录与笔记目的地文件不在恢复点范围内。'); });
  $('confirm-notes').onclick = () => perform($('confirm-notes'), async () => {
    if (settings?.dirty || settings?.saving || !productState(current, cfg).notes.destination) throw new Error('请先保存笔记位置，再确认使用。');
    await journey({ notesConfirmed: true, expectedDestination: destinationIdentity(cfg) }); notice('保存位置已确认，尚未自动写入。请在网页侧栏点击「同步」，完成真实写入验证。');
    if (!$('verify-sync').hidden) $('verify-sync').focus();
  });
  $('edit-notes').onclick = () => perform($('edit-notes'), async () => {
    await configuration(); if (!settings?.cfg) throw new Error('请先恢复本地连接。');
    const chapter = settings.$('s-chapter-archive'); chapter.open = true; chapter.disclosure?.sync();
    const field = settings.$(settings.$('s-backend').value === 'obsidian' ? 's-vaultPath' : settings.$('s-backend').value === 'siyuan' ? 's-origin' : 's-mdDir');
    field.focus(); field.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  });

  function renderConfirmation() {
    if (!current) return;
    const notes = productState(current, cfg).notes, dirty = !!settings?.dirty;
    $('note-confirm-title').textContent = notes.verified ? '当前位置已验证写入' : notes.confirmed ? '位置已确认，下一步在网页同步' : '确认保存位置';
    $('note-confirm-detail').textContent = dirty ? '有尚未保存的改动。请先保存，再确认最终位置。' : notes.detail;
    $('note-confirm-path').textContent = notes.destination ? `${notes.destination.name} · ${notes.destination.path}${notes.destination.folder ? ` · ${notes.destination.folder}` : ''}` : '尚未保存有效的笔记目的地。';
    $('confirm-notes').hidden = notes.confirmed && !dirty;
    $('confirm-notes').disabled = !productState(current, cfg).running || dirty || !!settings?.saving || !notes.destination;
    $('verify-sync').hidden = !notes.confirmed || dirty;
    $('verify-sync').textContent = notes.verified ? '回到阅读页面' : '去网页验证同步';
  }
  function renderJourney() {
    if (!current) return;
    const step = currentStep(), index = STEPS.indexOf(step), state = productState(current, cfg);
    for (const button of root.querySelectorAll('[data-step]')) {
      if (button.dataset.step === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
      button.dataset.complete = String(button.dataset.step === 'connect' ? state.browser.ok : button.dataset.step === 'tools' ? state.ai.ok : button.dataset.step === 'notes' ? state.notes.confirmed : false);
    }
    for (const name of STEPS) $(`setup-${name}`).hidden = name !== step;
    $('setup-back').disabled = index === 0;
    $('setup-skip').hidden = step === 'finish';
    $('setup-skip').textContent = step === 'connect' ? '暂不连接' : step === 'tools' ? '稍后配置 AI' : '稍后选择位置';
    $('setup-next').textContent = step === 'finish' ? '完成，去练习阅读' : '继续';
    const formBusy = !!(settings?.saving || settings?.agentWorking || settings?.modelWorking);
    const blocked = step === 'connect' ? !state.browser.ok : step === 'tools' ? !state.ai.ok || !!settings?.dirty || formBusy : step === 'notes' ? !state.notes.confirmed || !!settings?.dirty || formBusy : false;
    $('setup-next').disabled = blocked || busyButtons.has($('setup-next'));
    const hint = $('setup-next-hint');
    if (hint) {
      hint.hidden = !blocked;
      hint.textContent = formBusy ? '正在完成测试或保存，请稍候…' : step === 'tools' ? settings?.dirty ? '测试当前选择并保存更改后，即可继续。' : '请先测试所选回答方式；也可以选择「稍后配置 AI」。'
        : step === 'notes' ? settings?.dirty ? '先保存当前笔记位置，再确认使用。' : '请确认保存位置；确认不会自动写入笔记。' : '请先在 Chrome 扩展中发起连接并授权。';
    }
    $('setup-browser-status').textContent = state.running ? state.browser.count ? `${state.browser.label}。可以继续选择 AI。` : current.bridgeReady ? '本地连接已准备好，等待你在 Chrome 中发起授权。' : current.packaged ? '浏览器桥接尚未就绪，请在「设置与帮助」检查。' : '开发运行不注册浏览器桥接。端到端连接请使用打包后的桌面应用。' : current.service?.message || '等待本地连接准备完成…';
    $('setup-browser-status').dataset.error = String(!state.running && !state.preparing);
    const summary = $('finish-summary'); summary.replaceChildren();
    for (const [label, value, ok] of [['浏览器', state.browser.label, state.browser.ok], ['AI 回答（可选）', state.ai.label, state.ai.ok], ['笔记保存（可选）', state.notes.label, state.notes.verified]]) {
      const row = make('div', 'finish-row'); row.append(make('span', '', label)); const status = make('span', 'badge', value); status.dataset.state = ok ? 'ok' : ''; row.append(status); summary.append(row);
    }
    $('resume-setup').textContent = current.journey?.dismissed ? '继续首次准备' : '返回首次准备';
  }
  function renderPairings(rows) {
    const signature = JSON.stringify(rows); if (signature === pairingSignature) return;
    pairingSignature = signature; const list = $('pairings'); list.replaceChildren();
    if (!rows.length) { list.append(make('p', 'empty-state', '还没有已授权的浏览器。基础批注与下载不需要连接。')); return; }
    for (const row of rows) {
      const article = make('article', 'pairing-row'), copy = make('div'), button = make('button', '', '撤销');
      copy.append(make('strong', '', row.label), make('small', '', `安装编号 ${row.instanceId?.slice(0, 8) || '旧版'} · ${new Date(row.updatedAt).toLocaleDateString()}`));
      button.type = 'button'; button.setAttribute('aria-label', `撤销 ${row.label} 的服务访问权限`);
      button.onclick = () => perform(button, async () => { await desktop.revoke(row.id, row.instanceId); notice('此浏览器的服务访问权限已撤销，阅读记录与笔记保留。'); });
      article.append(copy, button); list.append(article);
    }
  }
  function renderRecovery(rows) {
    const signature = JSON.stringify(rows); if (signature === recoverySignature) return;
    recoverySignature = signature; $('recovery-points').replaceChildren();
    for (const row of rows) {
      const article = make('article', 'pairing-row'), title = make('div', '', new Date(row.createdAt).toLocaleString()), button = make('button', '', '恢复');
      button.type = 'button'; button.onclick = () => perform(button, async () => {
        if (await desktop.recovery('restore', row.id)) {
          settings = null; loadingSettings = null; const replacement = make('div'); replacement.id = 'configuration'; $('configuration').replaceWith(replacement);
          notice('已恢复本机数据。请重新核对模型连接与笔记目的地；浏览器授权和已写入笔记不回退。');
        }
      }); article.append(title, button); $('recovery-points').append(article);
    }
  }
  async function chooseCandidate(kind, row) {
    await configuration(); if (!settings?.cfg) throw new Error('请等待本地连接就绪，再选择。');
    if (settings.saving || settings.modelWorking || settings.agentWorking) throw new Error('请先完成当前保存或测试，再切换工具。');
    const field = (id, value, event = 'input') => { const el = settings.$(id); el.value = value; el.dispatchEvent(new win.Event(event, { bubbles: true })); return el; };
    if (kind === 'agents') {
      settings.agents = current.discovery.agents.items; settings.wantAgent = row.id; settings.syncAgentSel();
      field('s-exBackend', 'agent', 'change'); field('s-agent', row.id, 'change');
      // A discovered binary is not a user-entered override. The test resolves
      // that Agent again, rather than forcing a save before it can be tested.
      field('s-agentExecutable', ''); settings.$('s-testAgent').focus();
      notice(`已选择 ${row.label}。请先测试连接，通过后保存；没有自动授权笔记目录或提升权限。`);
    } else {
      field('s-backend', row.backend || 'obsidian', 'change');
      const el = field(row.backend === 'markdown' ? 's-mdDir' : 's-vaultPath', row.path); el.focus();
      notice(`已填入「${row.name}」。请保存，再确认使用这个位置；尚未写入笔记。`);
    }
    showDraft();
  }
  function renderDiscovery() {
    const signature = JSON.stringify([current.discovery, current.service?.state]); if (signature === discoverySignature) return;
    discoverySignature = signature;
    for (const [kind, id] of [['agents', 'agent-candidates'], ['notes', 'note-candidates']]) {
      const list = $(id), discovery = current.discovery?.[kind] || { state: 'idle', items: [] }; list.replaceChildren();
      const rows = (discovery.items || []).filter(row => kind === 'agents' ? row.available : row.path);
      if (discovery.state === 'error') list.append(make('p', 'empty-state', `自动检查未完成：${discovery.error || '请稍后重试。'} 你仍可在下方手动配置。`));
      else if (!rows.length) list.append(make('p', 'empty-state', !productState(current, cfg).running ? '等待本地连接准备完成…' : ['idle', 'running'].includes(discovery.state) ? '正在检查本机已登记的安装，不读取笔记正文…' : kind === 'agents' ? '暂未找到已安装的 Agent。可以使用模型 API，或稍后安装并登录 Agent 再检查。' : '暂未发现 Obsidian 笔记库。可以选择 Markdown 文件夹，或手动选择已有笔记库。'));
      for (const row of rows) {
        const article = make('article', 'candidate-row'), copy = make('div', 'candidate-copy'), button = make('button', '', kind === 'agents' ? '填入 AI 设置' : '选用此位置');
        copy.append(make('strong', '', kind === 'agents' ? row.label : row.name));
        copy.append(make('small', '', kind === 'agents' ? `已发现${row.version ? ` · ${row.version}` : ''} · 尚需你选择并测试` : `${row.path}${row.open ? ' · 当前打开' : ''}`));
        button.type = 'button'; button.disabled = !productState(current, cfg).running;
        button.setAttribute('aria-label', kind === 'agents' ? `将 ${row.label} 填入 AI 设置` : `选用笔记位置 ${row.name}`);
        button.onclick = () => perform(button, () => chooseCandidate(kind, row)); article.append(copy, button); list.append(article);
      }
    }
    for (const button of root.querySelectorAll('[data-discover]')) button.disabled = !productState(current, cfg).running || ['agents', 'notes'].some(key => current.discovery?.[key]?.state === 'running');
  }
  async function refresh() {
    if (disposed) return;
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        current = await desktop.status();
        if (current.service?.state === 'running') cfg = current.configuration || await serviceAPI.getConfig();
        const state = productState(current, cfg);
        $('version').textContent = `v${current.version} · ${current.platform === 'win32' ? 'Windows' : 'macOS'} ${current.architecture}`;
        $('sidebar-status').textContent = state.running ? '本地连接正常' : state.preparing ? '正在准备本地连接' : '本地连接需要处理'; $('sidebar-dot').classList.toggle('ready', state.running);
        badge('service-badge', state.running ? '运行中' : state.preparing ? '准备中' : current.service?.state === 'external' ? '检测到旧服务' : '需要处理', state.running ? 'ok' : state.preparing ? '' : 'bad');
        $('service-message').textContent = current.service?.message || '正在准备本地连接…';
        $('start-service').disabled = state.running || state.preparing; $('takeover').hidden = current.service?.state !== 'external' || current.platform !== 'darwin';
        $('open-at-login').checked = !!current.preferences?.openAtLogin;
        const menuPlacement = current.systemIntegration?.trayPlacement;
        $('menu-bar-status').textContent = current.platform === 'darwin'
          ? ['obscured', 'offscreen'].includes(menuPlacement) ? '菜单栏图标可能被刘海或屏幕边界遮挡。可从 Dock 打开；若使用菜单栏管理工具，请将 ContextFlow 设为始终显示。'
            : '点击右上角的 ContextFlow 图标可查看服务与任务状态，或重新打开窗口。若菜单栏空间不足，可从 Dock 打开。'
          : '可从系统托盘查看状态或重新打开窗口。Windows 可能将图标放入任务栏的隐藏图标区域。';
        $('bridge-status').textContent = current.bridgeReady ? '浏览器桥接已注册。每个 Chrome 用户配置需要独立发起连接并授权。' : current.packaged ? '浏览器桥接注册未成功，请重新打开应用或导出诊断。' : '开发运行不修改浏览器注册。端到端配对请使用打包后的应用。';
        $('home-title').textContent = state.action.title; $('home-detail').textContent = state.action.detail;
        $('home-primary').textContent = state.action.label; $('home-primary').disabled = state.action.kind === 'none';
        badge('browser-badge', state.browser.label, state.browser.ok ? 'ok' : ''); $('browser-summary').textContent = state.browser.detail;
        badge('model-badge', state.ai.label, state.ai.ok ? 'ok' : state.ai.checked && state.running ? 'bad' : ''); $('model-summary').textContent = state.ai.detail;
        badge('notes-badge', state.notes.label, state.notes.verified ? 'ok' : ''); $('notes-summary').textContent = state.notes.detail;
        $('update-status').textContent = current.updates?.message || '可以手动检查经过签名发布的新版本。';
        renderPairings(current.pairings || []); renderRecovery(current.recoveryPoints || []); renderDiscovery(); renderJourney(); renderConfirmation();
        if (!initialized) { initialized = true; if (!explicitPageRequested) await page(current.journey?.dismissed ? 'home' : 'setup', { focus: false }); }
        else if (['ai', 'notes', 'setup'].includes(activePage)) await placeWorkspace();
      } catch (error) { notice(error.message || '无法读取本地状态，请稍后重试。', true); }
    })();
    try { await refreshing; } finally { refreshing = null; if (refreshAgain) { refreshAgain = false; queueMicrotask(refresh); } }
  }
  const unsubscribeStatus = desktop.onStatusChange?.(requestRefresh);
  const unsubscribeNavigate = desktop.onNavigate?.(name => {
    if (name !== 'support' || disposed) return;
    explicitPageRequested = true;
    page(name).catch(error => notice(error.message, true));
  });
  const onFocus = async () => { await refresh(); if (['ai', 'notes', 'setup'].includes(activePage)) await placeWorkspace({ force: true }); };
  win.addEventListener('focus', onFocus);
  const timer = poll ? win.setInterval(() => { if (!root.hidden) refresh(); }, desktop.onStatusChange ? 15000 : 1000) : null;
  const ready = refresh();
  return { ready, refresh, page, get settings() { return settings; }, get state() { return current; },
    dispose() { disposed = true; if (timer) win.clearInterval(timer); unsubscribeStatus?.(); unsubscribeNavigate?.(); disposeInputModality(); root.removeEventListener('focusin', skipFocus); win.removeEventListener('focus', onFocus); if (settings) { clearTimeout(settings.toastTimer); clearTimeout(settings.messageTimer); } },
  };
}
if (typeof window !== 'undefined' && window.contextflowDesktop) startDesktopUI();
