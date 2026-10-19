import { request } from './rpc.js';
import { companionCommands } from './setup-commands.js';
import * as api from '../core/api.js';
import { Settings, SETTINGS_CSS } from '../skill/settings.js';
import { BASE } from '../skill/theme.js';

const $ = (id) => document.getElementById(id);
const input = $('pair-token');
const submit = document.querySelector('button[type=submit]');
const connection = $('connect');
const commands = companionCommands(chrome.runtime.id);
for (const [id, command] of Object.entries({
  'directory-command': commands.check, 'install-command': commands.setup,
  'pair-command': commands.pair, 'revoke-command': commands.revoke,
  'restart-command': commands.restart, 'service-command': commands.service,
})) $(id).textContent = command;
const version = chrome.runtime.getManifest().version;
$('download-companion').href = 'https://github.com/PengheLiu/ContextFlow/releases/download/v' + version + '/contextflow-companion-' + version + '.zip';
$('download-companion').textContent = '下载本地服务包 v' + version;

api.setTransport((path, init = {}) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ status: 0, body: { error: '本地服务响应超时，请检查连接后重试' } }), 25000);
  chrome.runtime.sendMessage({ type: 'cf-fetch', path, init: { method: init.method, body: init.body } }, (result) => {
    clearTimeout(timer);
    const error = chrome.runtime.lastError;
    resolve(error ? { status: 0, body: { error: '扩展通道断开，请重新打开本页' } } : result || { status: 0, body: { error: '本地服务未响应' } });
  });
}));

let paired = false;
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
  $('setup-progress').textContent = model
    ? '模型配置已保存（尚需主动测试连接）；笔记目的地见「归档」。'
    : '本地服务已连接；模型尚未配齐。只同步笔记可跳过 AI，直接设置「归档」。';
  request({ type: 'cf-configuration-changed' }).catch(() => {});
}
async function configuration() {
  if (!settings) {
    const shadow = $('configuration').attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BASE + SETTINGS_CSS + ':host{display:block}.folio{border:1px solid var(--cf-line);border-radius:8px;background:var(--cf-paper)}.save{bottom:0}.folio-kicker{display:none}';
    const mount = document.createElement('div');
    shadow.append(style, mount);
    settings = new Settings(shadow, mount, api, null, { standalone: true, onSaved: progress });
  }
  if (!settings.cfg) {
    await settings.load();
    if (settings.cfg) progress(settings.cfg);
  }
}
function savedPairing(value) {
  paired = value;
  $('check-connection').hidden = !value;
  $('disconnect').hidden = !value;
}
async function connectionView(state) {
  const connected = state === 'connected';
  $('first-setup').hidden = connected || (paired && state !== 'incompatible');
  $('pair-section').hidden = connected || (paired && state === 'unavailable');
  $('restart-help').hidden = !(paired && state === 'unavailable');
  $('next-step').hidden = !connected;
  const messages = {
    connected: '本地服务已连接。现在可直接配置模型与笔记。',
    unavailable: '配对信息仍保留，但本地服务没有响应。只需重新启动服务，不用重新配对。',
    unauthorized: '配对码已失效或被撤销。展开下方「已有服务，或需要重新生成配对码？」后生成新码。',
    unpaired: '尚未连接 · 高亮、批注和导出已经可以使用。',
    incompatible: '本地服务响应不兼容，请使用本页提供的服务包更新。',
  };
  $('connection-state').textContent = messages[state] || '暂时无法确认连接，请检查服务终端后重试。';
  if (state === 'unauthorized') $('repair-pairing').open = true;
  if (connected) await configuration();
}
async function checkConnection() {
  if (checking || !paired) return;
  checking = true;
  $('check-connection').disabled = true;
  $('connection-state').textContent = '正在检查本地服务…';
  try { await connectionView((await request({ type: 'cf-check' })).state); }
  catch { $('connection-state').textContent = '扩展通道暂不可用，请重新打开本页后再检查。'; }
  finally {
    checking = false;
    lastCheck = Date.now();
    $('check-connection').disabled = false;
  }
}
function followHash() { if (location.hash === '#connect') connection.open = true; }
followHash();
window.addEventListener('hashchange', followHash);
window.addEventListener('focus', () => { if (Date.now() - lastCheck > 5000) checkConnection(); });
$('check-connection').addEventListener('click', checkConnection);

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
    savedPairing(true);
    await connectionView('connected');
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
    settings = null;
    // Keep the existing ShadowRoot; reuse it on a later pairing rather than attach twice.
    const host = $('configuration');
    if (host.shadowRoot) host.replaceWith(Object.assign(document.createElement('div'), { id: 'configuration' }));
    await connectionView('unpaired');
    show('已清除本扩展配对信息，笔记与模型配置未删除；撤销服务授权请使用下方命令。');
  } catch (error) { show(error.message, true); }
});
request({ type: 'cf-status' }).then(async ({ paired: stored }) => {
  savedPairing(stored);
  if (stored) { connection.open = true; await checkConnection(); }
  else await connectionView('unpaired');
}).catch((error) => { connection.open = true; show(error.message, true); });
