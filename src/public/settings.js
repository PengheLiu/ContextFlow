// 浏览器 公开userscript的配置页：AI 走 LLMBridge（无需密钥），笔记写用户授权的本地文件夹。
//
// 版式与面板同一套「纸面」语言：编号章节（SERVICE / ARCHIVE）、信息气泡、
// 文件夹状态卡。状态卡把「选没选、什么类型、授权是否有效」放在一行里，
// 而不是让用户在几个按钮之间猜。
import { T } from '../skill/theme.js';
import { icon, brandMark } from '../skill/icons.js';
import {
  chooseFileTarget, targetStatus, authorizeFileTarget, clearFileTarget, setFileTargetMode,
} from './file-sync.js';

export const SETTINGS_CSS = `
  .set{display:none;padding:18px 0 8px}.set.on{display:block}
  .local-info{counter-reset:cf-setting;color:${T.inkSoft};font:13px/1.58 ${T.sans}}
  .setting-section{counter-increment:cf-setting;position:relative;padding:0 0 27px;margin:0 0 25px;border-bottom:1px solid ${T.lineSoft}}
  .setting-section:last-child{margin-bottom:0;border-bottom:0}
  .section-head{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:start;gap:10px;margin-bottom:17px}
  .section-no{padding-top:3px;color:${T.accent};font:700 12px/1 ${T.sans};letter-spacing:.08em;font-variant-numeric:tabular-nums}
  .section-no::before{content:'0' counter(cf-setting)}
  .section-copy{min-width:0}.eyebrow{display:block;margin-bottom:4px;color:${T.quote};font-size:12px;font-weight:720;letter-spacing:.12em}
  .section-copy h3{margin:0;color:${T.ink};font:650 16px/1.25 ${T.serif};letter-spacing:-.01em}
  .section-rule{grid-column:2/-1;height:1px;margin-top:10px;background:${T.line}}
  .info-tip{position:relative;display:inline-flex;z-index:5}
  .info-btn{width:27px;height:27px;padding:0;display:grid;place-items:center;border:1px solid ${T.line};border-radius:50%;background:transparent;color:${T.quote};cursor:help}
  .info-btn .ico{width:14px;height:14px}.info-btn:hover,.info-btn:focus-visible{border-color:${T.lineStrong};background:${T.hover};color:${T.ink}}
  .info-pop{position:absolute;right:0;top:calc(100% + 9px);width:276px;max-width:calc(100vw - 50px);padding:11px 12px;
    border:1px solid ${T.line};border-radius:7px;background:${T.paperRaised};color:${T.inkSoft};font:12.5px/1.62 ${T.sans};
    box-shadow:${T.shadowControl};opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-3px);transition:opacity .14s ease,transform .14s ease,visibility .14s ease}
  .info-pop::before{content:'';position:absolute;right:9px;bottom:100%;width:7px;height:7px;background:${T.paperRaised};border-left:1px solid ${T.line};border-top:1px solid ${T.line};transform:translateY(4px) rotate(45deg)}
  .info-tip:hover .info-pop,.info-tip:focus-within .info-pop{opacity:1;visibility:visible;transform:none}
  .service-line{display:flex;align-items:center;gap:11px;padding:11px 0 10px;border-top:1px solid ${T.lineSoft};border-bottom:1px solid ${T.lineSoft}}
  .service-mark{width:29px;height:29px;display:grid;place-items:center;flex:0 0 auto;border:1px solid ${T.lineStrong};border-radius:4px;background:${T.paperRaised}}
  .service-mark .mk{width:17px;height:17px}.service-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:1px}
  .service-copy strong{color:${T.ink};font-size:13px;font-weight:680}.service-copy span{color:${T.quote};font-size:12px}
  .bridge-state{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;color:${T.ok};font-size:12px;font-weight:650}
  .bridge-state::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 12%,transparent)}
  .bridge-state.bad{color:${T.bad}}
  .field{display:block;margin:0}.field-label{display:block;margin:0 0 6px;color:${T.inkSoft};font-size:12.5px;font-weight:650}
  .field select{width:100%;min-height:40px;padding:8px 10px;border:1px solid ${T.line};border-radius:6px;background:${T.paperRaised};color:${T.ink};font:13px/1.4 ${T.sans};outline:none;transition:border-color .14s,box-shadow .14s,background .14s}
  .field select:hover{border-color:${T.lineStrong}}.field select:focus{border-color:${T.focusLine};background:${T.paper};box-shadow:0 0 0 3px ${T.focusRing}}
  .fs-status{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr) 20px;align-items:center;gap:10px;margin-top:14px;padding:12px 0;border-top:1px solid ${T.line};border-bottom:1px solid ${T.line};min-width:0}
  .fs-status::before{content:'';position:absolute;left:0;top:-1px;width:42px;height:2px;background:${T.lineStrong}}
  .fs-icon{display:grid;place-items:center;width:30px;height:30px;color:${T.quote}}.fs-icon .ico{width:18px;height:18px}
  .fs-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.fs-status .name{min-width:0;color:${T.ink};font:600 13px/1.35 ${T.serif};overflow-wrap:anywhere}
  .fs-status .meta{color:${T.quote};font-size:12px;line-height:1.4;overflow-wrap:anywhere}.fs-check{display:none;color:${T.ok}}.fs-check .ico{width:17px;height:17px}
  .fs-status.is-ready::before{background:${T.ok}}.fs-status.is-ready .fs-icon,.fs-status.is-ready .fs-check{color:${T.ok}}.fs-status.is-ready .fs-check{display:grid}
  .fs-status.is-error::before{background:${T.bad}}.fs-status.is-error .fs-icon,.fs-status.is-error .name{color:${T.bad}}
  .fs-actions{display:flex;align-items:center;gap:7px;margin-top:12px}.fs-actions button{min-height:34px;border:1px solid ${T.line};border-radius:6px;background:transparent;padding:6px 10px;color:${T.inkSoft};font-size:12.5px}
  .fs-actions button:hover{border-color:${T.lineStrong};background:${T.hover};color:${T.ink}}
  .fs-actions #fs-choose{border-color:${T.accent};background:${T.accent};color:${T.paperRaised};font-weight:670}.fs-actions #fs-choose:hover{border-color:${T.accent};background:${T.accent};color:${T.paperRaised};filter:saturate(1.08) brightness(.94)}
  .fs-actions #fs-forget{margin-left:auto;border-color:transparent;color:${T.quote}}.fs-actions #fs-forget:hover{color:${T.bad};background:${T.badSoft}}
  .fs-actions button:disabled{cursor:not-allowed;opacity:.45;transform:none}
  @container (max-width:310px){.section-head{grid-template-columns:24px minmax(0,1fr) auto}.section-no{font-size:12px}.info-pop{width:230px}.service-line{align-items:flex-start;flex-wrap:wrap}.bridge-state{margin-left:40px}.fs-actions{align-items:stretch;flex-wrap:wrap}.fs-actions #fs-forget{margin-left:0}}
`;

export class Settings {
  constructor(_sh, mount) {
    this.mount = mount;
    mount.innerHTML = `<div class="local-info">
      <section class="setting-section">
        <div class="section-head">
          <span class="section-no" aria-hidden="true"></span>
          <div class="section-copy"><span class="eyebrow">SERVICE</span><h3>AI 服务</h3></div>
          <span class="info-tip">
            <button class="info-btn" type="button" aria-label="查看 AI 服务说明" aria-describedby="ai-help">${icon('help')}</button>
            <span class="info-pop" id="ai-help" role="tooltip">翻译、解释与速览由 浏览器 AI 处理。仅在调用功能时发送必要内容，不需要另填模型密钥。</span>
          </span>
          <span class="section-rule"></span>
        </div>
        <div class="service-line">
          <span class="service-mark">${brandMark()}</span>
          <span class="service-copy"><strong>浏览器 LLMBridge</strong><span>随浏览器提供的 AI 通道</span></span>
          <span class="bridge-state" id="bridge-state"></span>
        </div>
      </section>

      <section class="setting-section">
        <div class="section-head">
          <span class="section-no" aria-hidden="true"></span>
          <div class="section-copy"><span class="eyebrow">ARCHIVE</span><h3>笔记同步</h3></div>
          <span class="info-tip">
            <button class="info-btn" type="button" aria-label="查看笔记同步说明" aria-describedby="sync-help">${icon('help')}</button>
            <span class="info-pop" id="sync-help" role="tooltip">Obsidian 与普通 Markdown 各自记忆目录。前者使用双链，后者使用标准相对链接；忘记目录不会删除已写文件。</span>
          </span>
          <span class="section-rule"></span>
        </div>
        <label class="field">
          <span class="field-label">笔记类型</span>
          <select id="fs-mode"><option value="obsidian">Obsidian Vault / 文件夹</option><option value="markdown">普通 Markdown 文件夹</option></select>
        </label>
        <div id="fs-status" class="fs-status is-empty" role="status" aria-live="polite">
          <span class="fs-icon" aria-hidden="true">${icon('folder')}</span>
          <span class="fs-copy"><strong class="name">尚未选择文件夹</strong><span class="meta">请选择保存位置</span></span>
          <span class="fs-check" aria-hidden="true">${icon('check')}</span>
        </div>
        <div class="fs-actions"><button id="fs-choose">选择文件夹</button><button id="fs-auth" style="display:none">重新授权</button><button id="fs-forget" style="display:none">忘记</button></div>
      </section>
    </div>`;
    mount.querySelector('#fs-mode').onchange = () => this.changeMode();
    mount.querySelector('#fs-choose').onclick = () => this.choose();
    mount.querySelector('#fs-auth').onclick = () => this.auth();
    mount.querySelector('#fs-forget').onclick = () => this.forget();
  }

  async load() {
    const direct = typeof LLMBridge === 'undefined' ? null : LLMBridge;
    const el = this.mount.querySelector('#bridge-state'),
      ok = typeof direct?.chat === 'function'
        || typeof globalThis.LLMBridge?.chat === 'function'
        || typeof globalThis.window?.LLMBridge?.chat === 'function';
    el.textContent = ok ? '可用' : '不可用';
    el.classList.toggle('bad', !ok);
    await this.renderTarget();
  }

  showTargetStatus(name, meta = '', state = 'empty') {
    const el = this.mount.querySelector('#fs-status');
    el.className = `fs-status is-${state}`;
    el.querySelector('.name').textContent = name;
    el.querySelector('.meta').textContent = meta;
  }

  async renderTarget() {
    const s = await targetStatus(), choose = this.mount.querySelector('#fs-choose');
    const isObsidian = s.mode === 'obsidian', type = isObsidian ? 'Obsidian Vault' : 'Markdown';
    this.mount.querySelector('#fs-mode').value = s.mode;
    if (!s.supported) {
      this.showTargetStatus('当前浏览器不支持文件夹同步', '请使用底部“下载”保存 Markdown', 'error');
    } else if (!s.configured) {
      this.showTargetStatus(`尚未选择${isObsidian ? ' Vault' : '文件夹'}`, `请为${type}选择保存位置`, 'empty');
    } else {
      const permission = { granted: '已授权', prompt: '待授权', denied: '未授权' }[s.permission] || s.permission;
      this.showTargetStatus(s.name || '未命名文件夹', `${type} · ${permission}`, 'ready');
    }
    choose.textContent = s.configured ? (isObsidian ? '更换 Vault' : '更换文件夹') : (isObsidian ? '选择 Vault' : '选择文件夹');
    choose.disabled = !s.supported;
    this.mount.querySelector('#fs-auth').style.display = s.configured && s.permission !== 'granted' ? '' : 'none';
    this.mount.querySelector('#fs-forget').style.display = s.configured ? '' : 'none';
  }

  async changeMode() {
    const select = this.mount.querySelector('#fs-mode');
    try {
      await setFileTargetMode(select.value);
      await this.renderTarget();
    } catch (e) {
      this.showTargetStatus('切换笔记类型失败', e.message, 'error');
    }
  }

  async choose() {
    try {
      await chooseFileTarget(this.mount.querySelector('#fs-mode').value);
      await this.renderTarget();
    } catch (e) {
      // 用户在目录选择器里点「取消」不是错误
      if (e.name !== 'AbortError') this.showTargetStatus('文件夹选择失败', e.message, 'error');
    }
  }

  async auth() {
    try {
      await authorizeFileTarget(this.mount.querySelector('#fs-mode').value);
      await this.renderTarget();
    } catch (e) {
      this.showTargetStatus('未获得读写权限', e.message, 'error');
    }
  }

  async forget() {
    await clearFileTarget(this.mount.querySelector('#fs-mode').value);
    await this.renderTarget();
  }
}
