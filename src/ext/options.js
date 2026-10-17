import { request } from './rpc.js';

const status = document.getElementById('status');
const input = document.getElementById('pair-token');
const submit = document.querySelector('button[type=submit]');
const connection = document.getElementById('connect');
const connectionState = document.getElementById('connection-state');
const check = document.getElementById('check-connection');
const disconnect = document.getElementById('disconnect');
const next = document.getElementById('next-step');
document.getElementById('pair-command').textContent = `npm run pair -- ${chrome.runtime.id}`;
document.getElementById('revoke-command').textContent = `npm run pair -- --revoke ${chrome.runtime.id}`;

function show(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function setPaired(paired) {
  check.hidden = !paired;
  disconnect.hidden = !paired;
  next.hidden = !paired;
  connectionState.textContent = paired ? '已保存配对信息；点击检查，确认本地服务正在运行。' : '尚未连接 · 高亮、批注和导出已经可以使用。';
}

function followHash() { if (location.hash === '#connect') connection.open = true; }
followHash();
window.addEventListener('hashchange', followHash);

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById('copy-status').textContent = '命令已复制。请粘贴到本地服务文件夹的终端中运行。';
      button.textContent = '已复制';
    } catch {
      button.textContent = '请手动复制';
      document.getElementById('copy-status').textContent = '浏览器未允许复制，请直接选中命令文本复制。';
    }
  });
}

request({ type: 'cf-status' }).then(({ paired }) => {
  setPaired(paired);
  next.hidden = true; // 已存凭证不等于此刻已连通服务。
  if (paired) connection.open = true;
}).catch((error) => { connection.open = true; show(error.message, true); });

check.addEventListener('click', async () => {
  check.disabled = true;
  connectionState.textContent = '正在检查本地服务…';
  try {
    const { state } = await request({ type: 'cf-check' });
    const messages = {
      connected: '本地服务已连接。返回文章，刷新后即可配置 AI 或笔记同步。',
      unavailable: '配对信息仍保留，但本地服务没有响应。请运行 npm run server，并保持终端打开。',
      unauthorized: '配对码已失效或被撤销。请重新运行下方配对命令，再粘贴新码连接。',
      unpaired: '尚未配对。按下面的步骤连接，或先返回文章使用批注。',
      incompatible: '本地服务版本不匹配。请下载最新版 companion 服务包后重新启动。',
    };
    connectionState.textContent = messages[state] || '暂时无法验证连接，请检查服务终端后再试。';
    next.hidden = state !== 'connected';
  } catch {
    connectionState.textContent = '扩展通道暂不可用，请重新打开本页后再检查。';
  } finally { check.disabled = false; }
});

document.getElementById('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  show('正在连接本机服务…');
  const token = input.value;
  input.value = '';
  try {
    await request({ type: 'cf-connect', token, consent: document.getElementById('consent').checked });
    setPaired(true);
    connectionState.textContent = '本地服务已连接。';
    show('连接成功。请刷新文章页面，然后在侧栏中配置模型或笔记位置。');
  } catch (error) {
    show(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

disconnect.addEventListener('click', async () => {
  try {
    await request({ type: 'cf-disconnect' });
    setPaired(false);
    show('已清除本扩展配对信息；如需撤销服务授权，请运行下面的撤销命令。');
  } catch (error) { show(error.message, true); }
});
