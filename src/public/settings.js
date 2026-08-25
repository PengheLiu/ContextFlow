// 浏览器 公开userscript：AI 走 LLMBridge，笔记直接写用户授权的本地文件夹。
import { T } from '../skill/theme.js';
import { chooseFileTarget, targetStatus, authorizeFileTarget, clearFileTarget } from './file-sync.js';

export const SETTINGS_CSS = `
  .set{display:none}.set.on{display:block}.local-info{padding:18px;border:1px solid ${T.line};
    border-radius:${T.radius};background:${T.sunk};color:${T.inkSoft};font-size:12.5px;line-height:1.7}
  .local-info h4{margin:0 0 8px;color:${T.ink};font-size:14px}.local-info p{margin:6px 0}
  .local-info select{width:100%;padding:7px;border:1px solid ${T.line};border-radius:7px;background:${T.paper}}
  .bridge-state{display:inline-block;margin:7px 5px 7px 0;padding:2px 8px;border-radius:999px;
    background:#e7f3ea;color:#287044;font-size:11px}.bridge-state.bad{background:#fee9e7;color:#b3261e}
  .fs-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.fs-actions button{border:1px solid ${T.line};background:${T.paper}}
`;

export class Settings {
  constructor(_sh, mount) {
    this.mount = mount;
    mount.innerHTML = `<div class="local-info">
      <h4>公开userscript · 浏览器 AI</h4>
      <p>翻译、解释与速览由 浏览器 LLMBridge 提供；必要正文分块、选区和相关历史会发送给 浏览器 AI。无需填写密钥，也不连接 ContextFlow 自有服务器。</p>
      <span class="bridge-state" id="bridge-state"></span>
      <h4 style="margin-top:14px">同步到个人笔记</h4>
      <select id="fs-mode"><option value="obsidian">Obsidian Vault / 文件夹</option><option value="markdown">普通 Markdown 文件夹</option></select>
      <p id="fs-status">尚未选择文件夹</p>
      <div class="fs-actions"><button id="fs-choose">选择文件夹</button><button id="fs-auth">重新授权</button><button id="fs-forget">忘记文件夹</button></div>
      <p>一篇文章一个文档，并在首次阅读日建立索引。目录授权按当前网站保存，在新网站可能需要重新选择同一文件夹。</p>
      <p>忘记文件夹只清除浏览器授权，不删除已写文件；清理站点数据会移除本地阅读记录和目录授权。</p>
      <p>隐私：必要正文分块、选区和相关历史会通过 浏览器 LLMBridge 发送；ContextFlow 不连接自有服务器，也不要求用户提供模型凭证。</p>
    </div>`;
    mount.querySelector('#fs-choose').onclick = () => this.choose();
    mount.querySelector('#fs-auth').onclick = () => this.auth();
    mount.querySelector('#fs-forget').onclick = () => this.forget();
  }
  async load() {
    const direct = typeof LLMBridge === 'undefined' ? null : LLMBridge;
    const el = this.mount.querySelector('#bridge-state'), ok = typeof direct?.chat === 'function'
      || typeof globalThis.LLMBridge?.chat === 'function' || typeof globalThis.window?.LLMBridge?.chat === 'function';
    el.textContent = ok ? 'LLMBridge 可用' : 'LLMBridge 不可用'; el.classList.toggle('bad', !ok);
    await this.renderTarget();
  }
  async renderTarget() {
    const s = await targetStatus(), el = this.mount.querySelector('#fs-status');
    if (!s.supported) el.textContent = '浏览器不支持文件夹同步，请使用底部“下载”';
    else if (!s.configured) el.textContent = '尚未选择文件夹';
    else el.textContent = `${s.name} · ${s.mode === 'obsidian' ? 'Obsidian' : 'Markdown'} · 权限 ${s.permission}`;
    this.mount.querySelector('#fs-auth').style.display = s.configured && s.permission !== 'granted' ? '' : 'none';
    this.mount.querySelector('#fs-forget').style.display = s.configured ? '' : 'none';
  }
  async choose() {
    try { await chooseFileTarget(this.mount.querySelector('#fs-mode').value); await this.renderTarget(); }
    catch (e) { if (e.name !== 'AbortError') this.mount.querySelector('#fs-status').textContent = e.message; }
  }
  async auth() { try { await authorizeFileTarget(); await this.renderTarget(); }
    catch (e) { this.mount.querySelector('#fs-status').textContent = e.message; } }
  async forget() { await clearFileTarget(); await this.renderTarget(); }
}
