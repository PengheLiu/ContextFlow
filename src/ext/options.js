import { request } from './rpc.js';

const status = document.getElementById('status');
const input = document.getElementById('pair-token');
const submit = document.querySelector('button[type=submit]');
document.getElementById('pair-command').textContent = `npm run pair -- ${chrome.runtime.id}`;
document.getElementById('revoke-command').textContent = `npm run pair -- --revoke ${chrome.runtime.id}`;

function show(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

request({ type: 'cf-status' }).then(({ paired }) => {
  show(paired ? '已保存配对信息。若连接失败，可重新生成并验证配对码。' : '尚未配对；可先使用离线标注。');
}).catch((error) => show(error.message, true));

document.getElementById('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  show('正在连接本机服务…');
  const token = input.value;
  input.value = '';
  try {
    await request({ type: 'cf-connect', token, consent: document.getElementById('consent').checked });
    show('连接成功。请刷新文章页面，然后在侧栏中配置模型和笔记位置。');
  } catch (error) {
    show(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('disconnect').addEventListener('click', async () => {
  try {
    await request({ type: 'cf-disconnect' });
    show('已清除本扩展配对信息；如需撤销服务授权，请运行下面的撤销命令。');
  } catch (error) { show(error.message, true); }
});
