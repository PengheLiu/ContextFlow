import { request } from './rpc.js';
import { companionCommands } from './setup-commands.js';
import * as api from '../core/api.js';
import { Settings, SETTINGS_CSS } from '../skill/settings.js';
import { BASE } from '../skill/theme.js';
import { wireDisclosure } from '../core/disclosure.js';
import { ReadingLibrary } from './library.js';
import { setupSupport } from './support.js';

const $ = (id) => document.getElementById(id);
const input = $('pair-token');
const submit = document.querySelector('button[type=submit]');
const connection = $('connect');
const advanced = $('advanced-connection');
const setupKey = 'desktopSetup';
let setupTouched = false, connecting = false;
let desktopSetup = { version: 1, consent: false, downloadViewedAt: 0 };
wireDisclosure(connection,{bodyClass:'connection-content',duration:200});
const commands = companionCommands(chrome.runtime.id);
const readingHelp = () => {
  const visible = location.hash === '#reading-help';
  $('reading-help').hidden = !visible;
  if (visible) $('reading-help').scrollIntoView({ block: 'start' });
};
readingHelp();
addEventListener('hashchange', readingHelp);
for (const [id, command] of Object.entries({
  'directory-command': commands.check, 'install-command': commands.setup,
  'pair-command': commands.pair, 'revoke-command': commands.revoke,
  'restart-command': commands.restart, 'service-command': commands.service,
})) $(id).textContent = command;
const version = chrome.runtime.getManifest().version;
setupSupport({request,version});
let library;
function libraryView() {
  const selected=location.hash==='#library';
  const support=location.hash==='#support';
  document.body.dataset.view=selected ? 'library' : support ? 'support' : location.hash==='#connect' ? 'connect' : 'start';
  $('support').hidden=!support;
  $('reading-library').hidden=!selected;
  document.title=selected ? '我的阅读库 · ContextFlow' : support ? '帮助与诊断 · ContextFlow' : location.hash==='#connect' ? '连接你的 AI 与笔记 · ContextFlow' : '欢迎使用 ContextFlow · 从第一条批注开始';
  for(const link of document.querySelectorAll('.page-nav a')) {
    if(link.dataset.view===(selected ? 'library' : support ? 'support' : location.hash==='#connect' ? 'connect' : 'start'))link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  if(selected && !library) {
    library=new ReadingLibrary($('reading-library'),{version,flush:()=>request({type:'cf-flush-reading'})});
    library.action(()=>library.refresh());
  } else if(selected && !library.busy) library.action(()=>library.refresh());
}
libraryView();window.addEventListener('hashchange',libraryView);
const companionDownload = 'https://github.com/PengheLiu/ContextFlow/releases/download/v' + version + '/contextflow-companion-' + version + '.zip';
$('download-companion').href = companionDownload;
$('update-companion').href = companionDownload;
$('download-companion').textContent = '下载本地服务包 v' + version;

function desktopProgress() {
  $('desktop-consent').checked = desktopSetup.consent;
  $('desktop-consent').disabled = connecting;
  $('connect-desktop').disabled = connecting || !desktopSetup.consent;
  $('desktop-consent-help').textContent = desktopSetup.consent
    ? '说明已确认；只有你点击连接，才会向桌面端申请授权。'
    : '先确认数据使用说明；桌面端仍会单独征求授权。';
  $('journey-download').dataset.visited = String(!!desktopSetup.downloadViewedAt);
  if (desktopSetup.downloadViewedAt) {
    $('download-progress').textContent = '下载页已打开过。安装并启动桌面端后，回这里继续；这不代表安装已经完成。';
    $('download-desktop').textContent = '再次打开下载页 ↗';
  }
}
async function saveDesktopProgress() {
  try { await chrome.storage.local.set({ [setupKey]: desktopSetup }); }
  catch { $('desktop-consent-help').textContent = '引导进度未能保存；不影响本次连接，下次打开需要重新确认。'; }
}
// Only resume non-sensitive local onboarding choices. Pairing codes, API keys
// and personal paths never go into this record or the public download URL.
desktopProgress();
chrome.storage.local.get(setupKey).then(stored => {
  const value = stored[setupKey];
  if (setupTouched || value?.version !== 1) return;
  desktopSetup = { version: 1, consent: value.consent === true,
    downloadViewedAt: Number.isFinite(value.downloadViewedAt) && value.downloadViewedAt > 0 ? value.downloadViewedAt : 0 };
  desktopProgress();
}).catch(() => {});
$('desktop-consent').addEventListener('change', () => {
  setupTouched = true; desktopSetup.consent = $('desktop-consent').checked;
  desktopProgress(); saveDesktopProgress();
});
$('download-desktop').addEventListener('click', () => {
  setupTouched = true; desktopSetup.downloadViewedAt = Date.now();
  desktopProgress(); saveDesktopProgress();
});
$('jump-connect').addEventListener('click', () => {
  $('journey-connect').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('desktop-consent').focus({ preventScroll: true });
});

api.setTransport((path, init = {}) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ status: 0, body: { error: '本地服务响应超时，请检查连接后重试' } }), 25000);
  chrome.runtime.sendMessage({ type: 'cf-fetch', path, init: { method: init.method, body: init.body } }, (result) => {
    clearTimeout(timer);
    const error = chrome.runtime.lastError;
    resolve(error ? { status: 0, body: { error: '扩展通道断开，请重新打开本页' } } : result || { status: 0, body: { error: '本地服务未响应' } });
  });
}));

let paired = false;
let pairingSource = '';
let settings;
let checking = false;
let lastCheck = 0;
function show(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}
function progress(cfg) {
  const t = cfg.translate;
  const model = t.apiKeySet && t.model && (t.provider === 'anthropic' || t.baseUrl);
  const checked=cfg.connectionChecks?.model;
  const modelStatus=checked ? checked.ok ? '模型配置已保存，连接测试已通过' : '模型配置已保存，上次连接测试未通过' : '模型配置已保存（尚未测试当前连接）';
  $('setup-progress').textContent = model
    ? `${modelStatus}；笔记目的地见「笔记同步」。`
    : '本地服务已连接；模型尚未配齐。只同步笔记可跳过 AI，直接设置「笔记同步」。';
  request({ type: 'cf-configuration-changed' }).catch(() => {});
}
async function configuration({ refresh = false } = {}) {
  if (!settings) {
    const shadow = $('configuration').attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BASE + SETTINGS_CSS + ':host{display:block}.folio{border:1px solid var(--cf-line);border-radius:8px;background:var(--cf-paper)}.save{bottom:0}.folio-kicker{display:none}';
    const mount = document.createElement('div');
    shadow.append(style, mount);
    settings = new Settings(shadow, mount, api, null, { standalone: true, onSaved: progress });
  }
  if (!settings.cfg || (refresh && !settings.dirty && !settings.saving && !settings.modelWorking && !settings.agentWorking)) {
    if (settings.cfg) await settings.loadConfig();
    else await settings.load();
    if (settings.cfg) progress(settings.cfg);
  }
  await settings.checkService();
}
function savedPairing(value, source = pairingSource) {
  paired = value;
  pairingSource = value ? source : '';
  $('check-connection').hidden = !value;
  $('disconnect').hidden = !value;
  $('connection-tools').hidden = !value;
}
async function connectionView(state, service) {
  const connected = state === 'connected' || state === 'update-required';
  const legacy = paired && pairingSource !== 'desktop';
  $('update-help').hidden = state !== 'update-required';
  $('service-version').textContent = service?.serviceVersion || '版本未知';
  $('desktop-connect').hidden = connected;
  $('first-setup').hidden = connected || (paired && state !== 'incompatible');
  $('pair-section').hidden = connected || (paired && state === 'unavailable');
  $('restart-help').hidden = !(paired && state === 'unavailable');
  $('next-step').hidden = !connected;
  const messages = {
    connected: '本地服务已连接。现在可直接配置模型与笔记。',
    unavailable: '配对信息仍保留，但本地服务没有响应。无需重新安装扩展或重新配对。',
    unauthorized: legacy ? '配对码已失效或被撤销。请在高级与兼容方式中恢复连接。' : '浏览器授权已失效或被撤销。请重新连接，并在桌面端批准本次申请。',
    unpaired: '尚未连接 · 高亮、批注和导出已经可以使用。',
    incompatible: '本地连接响应不兼容。请核对桌面端与扩展版本后重试。',
    'update-required': '服务已连接，但版本能力不足：请更新并重启本地服务。现有配对、批注和笔记保留。',
  };
  $('connection-state').textContent = messages[state] || '暂时无法确认连接。请检查本地应用状态后重试。';
  const next = {
    unpaired: '先从官网下载并打开桌面端，再回来连接。基础批注和导出现在就能用。',
    connected: '模型、Agent 与笔记各自确认和测试；之后回到文章继续阅读。',
    unavailable: legacy ? '打开原来的命令行服务；下方已展开恢复步骤。也可以安装桌面端并按提示迁移。' : '请打开 ContextFlow 桌面端，等服务就绪后点击「检查本地服务连接」。',
    unauthorized: legacy ? '已有配对码不能继续使用。旧服务步骤已展开；桌面端用户也可以在上方重新连接。' : '原有批注和笔记保留。重新授权不会自动调用模型或读取笔记。',
    incompatible: '更新桌面端后检查连接。使用旧命令行服务的用户请查看下方兼容方式。',
    'update-required': '连接和数据保留。先更新本地端，再测试模型或修改配置。',
  };
  $('connection-next').textContent = next[state] || '基础阅读仍可用。可以稍后重试，或前往帮助与诊断。';
  $('connection-label').textContent=connected ? '本地服务已连接' : state==='unpaired' ? '按需开启' : '连接需要处理';
  $('connection-summary').textContent=connected ? '模型、Agent 与笔记分开配置；展开查看各自状态' : '基础批注无需配置，AI 与笔记同步按需连接';
  connection.dataset.connectionState=state;
  if (legacy && ['unauthorized', 'unavailable', 'incompatible'].includes(state)) advanced.open = true;
  if (legacy && state === 'unauthorized') $('repair-pairing').open = true;
  if (connected) await configuration({ refresh: true });
}
async function checkConnection() {
  if (checking || !paired) return;
  checking = true;
  $('check-connection').disabled = true;
  $('connection-state').textContent = '正在检查本地服务…';
  try { const result = await request({ type: 'cf-check' }); await connectionView(result.state, result.service); }
  catch { $('connection-state').textContent = '扩展通道暂不可用，请重新打开本页后再检查。'; }
  finally {
    checking = false;
    lastCheck = Date.now();
    $('check-connection').disabled = false;
  }
}
function followHash() { if (location.hash === '#connect') { connection.open = true;connection.disclosure.sync(); } }
followHash();
window.addEventListener('hashchange', followHash);
window.addEventListener('focus', () => { if (Date.now() - lastCheck > 5000) checkConnection(); });
$('check-connection').addEventListener('click', checkConnection);
$('connect-desktop').addEventListener('click', async () => {
  const button = $('connect-desktop');
  if (button.disabled || connecting || !$('desktop-consent').checked) return;
  connecting = true; desktopProgress(); button.setAttribute('aria-busy', 'true');
  button.textContent = '等待桌面端批准…';
  $('desktop-status').dataset.error = 'false';
  $('desktop-status').textContent = '请切到 ContextFlow 桌面端，核对申请并点击「允许连接」。取消后可以重新申请。';
  try {
    await request({ type: 'cf-connect-native', consent: $('desktop-consent').checked });
    savedPairing(true, 'desktop');
    const result = await request({ type: 'cf-check' });
    await connectionView(result.state, result.service);
    if (result.state === 'connected' || result.state === 'update-required') {
      $('desktop-status').textContent = '桌面端已连接。配置和测试记录会在插件与桌面端共用。';
      $('next-step').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } else { $('desktop-status').textContent = '授权已保存，但本地服务尚未就绪。请检查桌面端后重试连接检查。'; }
  } catch (error) { $('desktop-status').dataset.error = 'true'; $('desktop-status').textContent = error.message; }
  finally { connecting = false; button.textContent = '连接桌面端'; button.removeAttribute('aria-busy'); desktopProgress(); }
});

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(button.dataset.copy).textContent);
      $('copy-status').textContent = '命令已复制。先进入服务文件夹再粘贴；目录或 Node.js 版本不对会停止，不执行 npm。';
      button.textContent = '已复制';
    } catch {
      button.textContent = '请手动复制';
      $('copy-status').textContent = '浏览器未允许复制，请直接选中完整命令复制。';
    }
  });
}
input.addEventListener('input', () => { input.value = input.value.trim(); });
input.addEventListener('paste', (event) => {
  const code = event.clipboardData?.getData('text')?.trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(code || '')) { event.preventDefault(); input.value = code; }
});
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  show('正在连接本机服务…');
  try {
    await request({ type: 'cf-connect', token: input.value.trim(), consent: $('consent').checked });
    input.value = '';
    savedPairing(true, 'companion');
    const result = await request({ type: 'cf-check' });
    await connectionView(result.state, result.service);
    show('连接成功，配对码已安全保存。');
    $('next-step').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (error) {
    show(error.message, true); // Retain input on failure so a stopped service can be started and retried.
  } finally { submit.disabled = false; }
});
$('disconnect').addEventListener('click', async () => {
  try {
    await request({ type: 'cf-disconnect' });
    savedPairing(false);
    desktopSetup.consent = false; desktopProgress(); await saveDesktopProgress();
    settings = null;
    // Keep the existing ShadowRoot; reuse it on a later pairing rather than attach twice.
    const host = $('configuration');
    if (host.shadowRoot) host.replaceWith(Object.assign(document.createElement('div'), { id: 'configuration' }));
    await connectionView('unpaired');
    $('desktop-status').dataset.error = 'false';
    $('desktop-status').textContent = '已断开本扩展连接，笔记与模型配置未删除。桌面端授权可在「设置与帮助 → 浏览器授权」中撤销。';
  } catch (error) { show(error.message, true); }
});
request({ type: 'cf-status' }).then(async ({ paired: stored, source }) => {
  savedPairing(stored, source);
  if (stored) { await checkConnection(); }
  else await connectionView('unpaired');
}).catch((error) => { connection.open = true; show(error.message, true); });
