// 配置界面：翻译后端 + 思源落地目录。
//
// 关键约束：密钥只往服务端写，永不回读。GET /config 只给 apiKeySet / tokenSet 布尔位，
// 界面上密钥输入框留空即表示「不改动已存的值」—— 否则每次打开配置都会把 key 清掉。
// 脚本跑在页面 MAIN world，回读明文等于交给页面 JS。

import { T } from './theme.js';
import { guarded, describeError } from './guard.js';
import { icon } from './icons.js';
import { blocklistEntries, unblockPageKey } from './blocklist.js';

export const SETTINGS_CSS = `
  .set{display:none;margin:0 -18px -28px}.set.on{display:block}
  [hidden]{display:none!important}
  .folio{min-height:100%;font:13px/1.55 ${T.sans};color:${T.ink}}
  .folio-kicker{display:flex;align-items:center;gap:8px;padding:17px 18px 13px;border-bottom:1px solid ${T.lineSoft};
    color:${T.quote};font:700 10.5px/1 ${T.mono};letter-spacing:.14em;text-transform:uppercase}
  .folio-kicker::before{content:'';width:17px;height:2px;background:${T.accent}}

  /* 单页设置册：章节沿同一条阅读流展开，细装订线负责分层，不增加导航。 */
  .chapter-deck{min-width:0;background:${T.paper}}
  .chapter{display:block;padding:25px 18px 22px;border-bottom:1px solid ${T.lineSoft}}
  .chapter:last-child{border-bottom:0;padding-bottom:28px}
  .chapter-head{position:relative;padding:0 0 17px 14px;margin-bottom:19px;border-bottom:1px solid ${T.line}}
  .chapter-head::before{content:'';position:absolute;left:0;top:3px;bottom:18px;width:2px;background:${T.accent}}
  .chapter-eyebrow{display:block;margin-bottom:5px;color:${T.quote};font:700 10.5px/1 ${T.mono};letter-spacing:.12em;text-transform:uppercase}
  .chapter-head h3{margin:0;color:${T.ink};font:650 15px/1.3 ${T.serif};letter-spacing:-.01em}
  .chapter-summary{display:block;margin-top:5px;color:${T.quote};font:11.5px/1.45 ${T.mono};overflow-wrap:anywhere}
  .chapter-intro{margin:0 0 17px;color:${T.inkSoft};font:12.5px/1.62 ${T.serif}}

  .field{display:block;margin:0 0 14px;min-width:0}
  .field-label,.field > legend{display:block;margin:0 0 6px;color:${T.inkSoft};font-size:12px;font-weight:680}
  .field input,.field select{display:block;width:100%;min-width:0;min-height:39px;padding:8px 10px;
    border:1px solid ${T.line};border-radius:6px;background:${T.paperRaised};color:${T.ink};
    font:13px/1.45 ${T.sans};outline:none;transition:border-color .14s,box-shadow .14s,background .14s}
  .field input:hover,.field select:hover{border-color:${T.lineStrong}}
  .field input:focus,.field select:focus{border-color:${T.focusLine};background:${T.paper};box-shadow:0 0 0 3px ${T.focusRing}}
  .field input::placeholder{color:${T.placeholder}}
  .hint{display:block;margin-top:5px;color:${T.quote};font-size:11.5px;line-height:1.55;overflow-wrap:anywhere}
  .hint code{font-family:${T.mono}}
  .field-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:end;margin-bottom:14px}
  .field-row > .field{margin:0}
  .field-row > button,.quiet-action{min-height:39px;padding:7px 10px;border:1px solid ${T.line};border-radius:6px;
    background:${T.paperRaised};font-size:12px;white-space:nowrap}
  .field-row > button:hover,.quiet-action:hover{border-color:${T.lineStrong};background:${T.hover}}
  button[aria-busy=true]{cursor:wait;opacity:.7}

  .disclosure{margin:4px 0 16px;border-top:1px solid ${T.lineSoft};border-bottom:1px solid ${T.lineSoft}}
  .disclosure > summary{display:flex;align-items:center;gap:7px;padding:11px 1px;cursor:pointer;
    color:${T.inkSoft};font-size:12px;font-weight:680;list-style:none}
  .disclosure > summary::-webkit-details-marker{display:none}
  .disclosure > summary::before{content:'+';display:grid;place-items:center;width:16px;height:16px;color:${T.accent};
    font:500 15px/1 ${T.mono};transition:transform .16s ease}
  .disclosure[open] > summary::before{content:'−'}
  .disclosure-body{padding:4px 1px 3px}

  [data-be]{display:none}[data-be].on{display:block}
  .agent-box{padding-top:3px}
  .check-row{display:flex;align-items:flex-start;gap:9px;cursor:pointer}
  .check-row input{width:auto;min-height:0;flex:0 0 auto;margin:3px 0 0;accent-color:${T.accent}}
  .check-copy{font-size:12.5px;color:${T.ink}}
  .check-copy .hint{margin-top:2px}

  .permission-set{min-width:0;margin:0 0 14px;padding:0;border:0}
  .permission-set > legend{margin-bottom:7px}
  .profile{position:relative;border:1px solid ${T.line};border-radius:7px;padding:10px;background:${T.paperRaised}}
  .profile + .profile{margin-top:7px}
  .profile label{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;cursor:pointer}
  .profile input[type=radio]{width:auto;min-height:0;margin:3px 0 0;accent-color:${T.accent}}
  .profile-copy{min-width:0;flex:1}.profile-copy .hint{margin-top:2px}
  .profile .tag{margin-left:auto;border-radius:999px;padding:2px 6px;color:${T.ok};background:${T.sunk};
    font:700 9.5px/1.4 ${T.mono};letter-spacing:.06em}
  .profile .tag.full{color:${T.bad};background:${T.badSoft}}
  .advanced{margin-top:7px;border:1px solid ${T.line};border-radius:7px;padding:0 9px;background:${T.paper}}
  .advanced > summary{cursor:pointer;padding:9px 0;color:${T.inkSoft};font-size:12px;font-weight:680}
  .risk{margin:0 0 9px;padding:9px 10px;border-left:2px solid ${T.bad};background:${T.badSoft};
    color:${T.bad};font-size:11.5px;line-height:1.58}
  .legacy{display:none;margin:0 0 8px;color:${T.bad};font-size:11.5px;font-weight:650}.legacy.on{display:block}
  .ack{display:none;margin:8px 0}.ack.on{display:flex}

  .destination{position:relative;margin:2px 0 17px;padding:12px 11px 12px 14px;border-top:1px solid ${T.line};
    border-bottom:1px solid ${T.line};background:${T.paperRaised}}
  .destination::before{content:'';position:absolute;left:0;top:-1px;width:40px;height:2px;background:${T.accent}}
  .destination strong{display:block;color:${T.ink};font:600 13px/1.35 ${T.serif}}
  .destination span{display:block;margin-top:3px;color:${T.quote};font:11.5px/1.45 ${T.mono};overflow-wrap:anywhere}

  .scope-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:15px 0}
  .scope-action{min-width:0;min-height:72px;padding:10px;border:1px solid ${T.line};border-radius:7px;background:${T.paperRaised};text-align:left}
  .scope-action .ico{width:16px;height:16px;margin-bottom:7px;color:${T.accent}}
  .scope-action strong{display:block;color:${T.ink};font-size:12px;font-weight:680}
  .scope-action span{display:block;margin-top:3px;color:${T.quote};font-size:11px;line-height:1.45}
  .scope-action:hover{border-color:${T.lineStrong};background:${T.hover}}
  .block-list:empty{display:none}
  .block-list{margin-top:17px;padding-top:14px;border-top:1px solid ${T.lineSoft};color:${T.quote};font-size:11.5px}
  .blk{display:flex;align-items:center;gap:8px;margin-top:7px;padding:7px 0;border-bottom:1px solid ${T.lineSoft}}
  .blk code{flex:1;min-width:0;color:${T.inkSoft};font:11px/1.5 ${T.mono};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl}
  .blk button{flex:0 0 auto;padding:4px 7px;font-size:11.5px}

  .save{position:sticky;z-index:3;bottom:-28px;display:flex;align-items:center;justify-content:space-between;gap:10px;
    margin:0;padding:11px 18px 13px;border-top:1px solid ${T.line};background:${T.paper}}
  .save::before{content:'';position:absolute;left:18px;top:-1px;width:40px;height:2px;background:${T.accent}}
  .save > button{flex:0 0 auto;min-height:36px;padding:7px 15px;border:1px solid ${T.accent};
    border-radius:6px;background:${T.accent};color:${T.paperRaised};font-weight:680}
  .save > button:hover{background:${T.accent};color:${T.paperRaised};filter:saturate(1.08) brightness(.94)}
  .msg{min-width:0;color:${T.quote};font-size:11.5px;line-height:1.45}.msg.ok{color:${T.ok}}.msg.bad{color:${T.bad}}

  @container (max-width:310px){
    .set{margin-left:-14px;margin-right:-14px}.folio-kicker{padding-left:14px;padding-right:14px}
    .chapter{padding:20px 14px 22px}.chapter-head{padding-left:12px}.chapter-head h3{font-size:14.5px}
    .field-row{grid-template-columns:minmax(0,1fr)}.field-row > button{width:100%;text-align:center}
    .scope-actions{grid-template-columns:minmax(0,1fr)}.scope-action{min-height:0;display:grid;grid-template-columns:18px 1fr;column-gap:8px}
    .scope-action .ico{grid-row:1/3;margin:2px 0 0}.scope-action span{grid-column:2}
    .save{padding-left:14px;padding-right:14px}
  }
`;

const FORM = `
  <div class="folio">
    <div class="folio-kicker">Settings</div>
    <div class="chapter-deck">
        <section class="chapter" id="s-chapter-translate">
          <header class="chapter-head"><span class="chapter-eyebrow">Reading Voice</span><h3>翻译</h3><span class="chapter-summary" id="s-summary-translate"></span></header>
          <p class="chapter-intro">决定译文如何说，也决定它需要读到多少原文。</p>
          <label class="field"><span class="field-label">接口类型</span>
            <select id="s-provider"><option value="openai">OpenAI 兼容（/v1/chat/completions）</option><option value="anthropic">Anthropic（官方 SDK / 兼容网关）</option></select></label>
          <div class="field-row"><label class="field"><span class="field-label">模型</span><input id="s-model" spellcheck="false" placeholder="点右侧获取可选模型"></label>
            <button id="s-fetchModels" type="button" title="从上游拉取可选模型">获取模型</button></div>
          <div class="field" id="s-modelPickWrap" hidden><label class="field-label" for="s-modelPick">可选模型</label><select id="s-modelPick"></select></div>
          <label class="field"><span class="field-label">目标语言</span><input id="s-target" placeholder="简体中文"></label>
          <details class="disclosure" id="s-translateAdvanced"><summary>连接与上下文</summary><div class="disclosure-body">
            <label class="field"><span class="field-label">Base URL</span><input id="s-baseUrl" placeholder="https://api.anthropic.com" spellcheck="false"></label>
            <label class="field"><span class="field-label">API Key</span><input id="s-apiKey" type="password" spellcheck="false" autocomplete="off" aria-describedby="s-keyHint"><span class="hint" id="s-keyHint"></span></label>
            <label class="field check-row"><input type="checkbox" id="s-thinking"><span class="check-copy">开启 think 模式<span class="hint">翻译通常不需要推理；开启后会增加延迟与费用，不支持时自动退回。</span></span></label>
            <label class="field"><span class="field-label">原文段上下文长度</span><input id="s-chunkChars" type="number" min="0" step="500" placeholder="5000"><span class="hint">按字符数分段，只喂到覆盖当前选区为止；填 <code>0</code> 则不带正文。</span></label>
          </div></details>
        </section>

        <section class="chapter" id="s-chapter-explain">
          <header class="chapter-head"><span class="chapter-eyebrow">Thinking Partner</span><h3>解释</h3><span class="chapter-summary" id="s-summary-explain"></span></header>
          <p class="chapter-intro">选择快速回答，或让本地 Agent 带着你的笔记一起思考。</p>
          <label class="field"><span class="field-label">回答方式</span><select id="s-exBackend"><option value="llm">LLM（快，几秒）</option><option value="agent">本地 Agent（慢，但能读你的笔记）</option></select></label>
          <div class="agent-box" id="s-agentBox" hidden>
            <div class="field-row"><label class="field"><span class="field-label">本地 Agent</span><select id="s-agent"><option value="">（点检测）</option></select></label><button id="s-detectAgent" type="button" title="探测本机已安装的 agent">检测</button></div>
            <label class="field"><span class="field-label">允许读取的笔记库</span><input id="s-notesDir" placeholder="/path/to/notes（留空则不授权目录）"><span class="hint">Safe 档只授予指定目录的只读访问。</span></label>
            <fieldset class="permission-set field"><legend>Agent 权限</legend>
              <div class="profile"><label><input type="radio" name="agent-profile" id="s-profileSafe" value="safe"><span class="profile-copy">安全<span class="hint">只读文件与检索；隔离写入、命令、MCP 和持久会话。</span></span><span class="tag">SAFE</span></label></div>
              <div class="legacy" id="s-legacyFull">升级前行为已保留：当前为完整权限。建议切回安全档。</div>
              <details class="advanced" id="s-advanced"><summary>高级能力</summary>
                <div class="profile"><label><input type="radio" name="agent-profile" id="s-profileFull" value="full"><span class="profile-copy">完整权限<span class="hint">继承本地 Agent 的文件、命令、Git、MCP 与网络能力。</span></span><span class="tag full">FULL</span></label></div>
                <div class="risk" id="s-fullWarning"></div>
                <label class="check-row ack" id="s-fullAckWrap"><input type="checkbox" id="s-fullAck"><span class="check-copy">我理解网页和笔记内容可能包含 Prompt Injection，并确认开启完整权限</span></label>
              </details>
              <span class="hint" id="s-profileHint"></span>
            </fieldset>
          </div>
        </section>

        <section class="chapter" id="s-chapter-archive">
          <header class="chapter-head"><span class="chapter-eyebrow">Knowledge Home</span><h3>归档</h3><span class="chapter-summary" id="s-summary-archive"></span></header>
          <p class="chapter-intro">每篇文章持续写回同一份文档，目的地始终由你掌握。</p>
          <label class="field"><span class="field-label">笔记后端</span><select id="s-backend"><option value="markdown">本地 Markdown（零依赖）</option><option value="obsidian">Obsidian（直接写 Vault）</option><option value="siyuan">思源笔记（Kernel API）</option></select></label>
          <div class="destination" id="s-destination" role="status" aria-live="polite"><strong>本地 Markdown</strong><span>读取配置中…</span></div>
          <div data-be="obsidian">
            <div class="field-row"><label class="field"><span class="field-label">Vault</span><select id="s-vault"></select></label><button id="s-reloadVault" type="button" title="重新探测本机 Vault">探测</button></div>
            <div class="field-row"><label class="field"><span class="field-label">Vault 内目录</span><select id="s-obsFolder"></select></label><button id="s-reloadObsDir" type="button" title="探测 Vault 内已有目录">探测</button></div>
            <label class="field"><span class="field-label">或新建目录（填了以此为准）</span><input id="s-obsFolderCustom" placeholder="/阅读记录" spellcheck="false"><span class="hint">直接写入 Vault，不需要额外安装 Obsidian 插件。</span></label>
          </div>
          <div data-be="markdown">
            <label class="field"><span class="field-label">导出根目录</span><input id="s-mdDir" placeholder="~/ContextFlow" spellcheck="false"></label>
            <div class="field-row"><label class="field"><span class="field-label">子目录</span><select id="s-mdFolder"></select></label><button id="s-reloadMdDir" type="button" title="探测已有子目录">探测</button></div>
            <label class="field"><span class="field-label">或新建目录（填了以此为准）</span><input id="s-mdFolderCustom" placeholder="/阅读记录" spellcheck="false"><span class="hint">按天生成标准 Markdown 文件，不依赖任何笔记软件。</span></label>
          </div>
          <div data-be="siyuan">
            <label class="field"><span class="field-label">Kernel 地址</span><input id="s-origin" placeholder="http://127.0.0.1:6806" spellcheck="false"></label>
            <label class="field"><span class="field-label">API Token</span><input id="s-syToken" type="password" spellcheck="false" autocomplete="off" aria-describedby="s-syHint"><span class="hint" id="s-syHint"></span></label>
            <div class="field-row"><label class="field"><span class="field-label">笔记本</span><select id="s-notebook"></select></label><button id="s-reloadNb" type="button" title="重新拉取笔记本与目录">刷新</button></div>
            <label class="field"><span class="field-label">落地目录</span><select id="s-path"></select></label>
            <label class="field"><span class="field-label">或自定义目录（填了以此为准）</span><input id="s-pathCustom" placeholder="/阅读记录" spellcheck="false"></label>
          </div>
        </section>

        <section class="chapter" id="s-chapter-scope">
          <header class="chapter-head"><span class="chapter-eyebrow">Reading Boundary</span><h3>可用范围</h3><span class="chapter-summary" id="s-summary-scope"></span></header>
          <p class="chapter-intro">不是每个网页都需要阅读工具。把干扰挡在当前页面，或整个站点之外。</p>
          <div class="scope-actions">
            <button class="scope-action" id="s-blockPage" type="button">${icon('power')}<strong>仅停用此页面</strong><span>其他页面照常使用</span></button>
            <button class="scope-action" id="s-blockSite" type="button">${icon('power')}<strong>停用整个站点</strong><span>同一来源下都不再启动</span></button>
          </div>
          <span class="hint">名单只保存在本站点的浏览器本地，不会写入服务端或笔记库。重新运行脚本或点扩展图标可恢复。</span>
          <div class="block-list" id="s-blockList"></div>
        </section>
    </div>
    <div class="save"><span class="msg" id="s-msg" role="status" aria-live="polite" aria-atomic="true"></span><button id="s-save" type="button">保存更改</button></div>
  </div>
`;

export class Settings {
  // Panel 用这枚能力标记启用非公开版的设置外壳；公开 Settings 不声明它，
  // 因而仍保留原来的标题与阅读底栏。
  static folio = true;

  /**
   * @param {ShadowRoot} sh  @param {HTMLElement} mount  @param {object} api
   * @param {(scope:'page'|'site')=>void} [onBlock] 停用当前页面/站点（就地撤下，见 main.js）
   */
  constructor(sh, mount, api, onBlock = null) {
    this.sh = sh; this.api = api; this.onBlock = onBlock;
    mount.innerHTML = FORM;
    this.$ = (id) => sh.getElementById(id);

    // 所有交互都过 guard：handler 里抛异常时，界面上必须看得见。
    // 起因是「点检测没反应」——我把 this.api 写成了 this.h.api，onclick 抛
    // TypeError 后一切静默，用户只看到按钮毫无反应，连个线索都没有。
    const on = (id, evt, fn) => { this.$(id)[evt] = this.guard(fn); };


    on('s-fetchModels', 'onclick', () => this.busy('s-fetchModels', '获取中…', () => this.fetchModels()));
    on('s-detectAgent', 'onclick', () => this.busy('s-detectAgent', '检测中…', () => this.detectAgents(true)));
    on('s-exBackend', 'onchange', () => {
      this.toggleAgentBox();
      this.refreshSummaries();
      // 切到 agent 且还没探测过时自动探一次 —— 否则下拉是空的，用户不知道要点检测
      if (this.$('s-exBackend').value === 'agent' && !this.agents) this.detectAgents(false);
    });
    on('s-profileSafe', 'onchange', () => { this.syncProfileUi(); this.refreshSummaries(); });
    on('s-profileFull', 'onchange', () => { this.syncProfileUi(); this.refreshSummaries(); });
    on('s-agent', 'onchange', () => {
      this.wantAgent = this.$('s-agent').value;
      this.syncProfileUi();
      this.refreshSummaries();
    });
    on('s-reloadNb', 'onclick', () => this.busy('s-reloadNb', '刷新中…', () => this.loadSiyuan(true)));
    on('s-blockPage', 'onclick', () => this.onBlock?.('page'));
    on('s-blockSite', 'onclick', () => this.onBlock?.('site'));
    on('s-save', 'onclick', () => this.save());
    on('s-modelPick', 'onchange', (e) => this.pickModel(e.target.value));
    on('s-notebook', 'onchange', () => this.loadPaths());
    on('s-provider', 'onchange', () => { this.syncProviderDefaults(); this.refreshSummaries(); });
    on('s-model', 'oninput', () => this.refreshSummaries());
    on('s-backend', 'onchange', () => { this.showBackend(); this.refreshSummaries(); });
    on('s-reloadVault', 'onclick', () => this.busy('s-reloadVault', '探测中…', () => this.loadVaults(true)));
    on('s-reloadObsDir', 'onclick', () => this.busy('s-reloadObsDir', '探测中…', () => this.loadFolders('obsidian', true)));
    on('s-reloadMdDir', 'onclick', () => this.busy('s-reloadMdDir', '探测中…', () => this.loadFolders('markdown', true)));
    on('s-vault', 'onchange', () => { this.loadFolders('obsidian', false, true); this.refreshSummaries(); });
    for (const id of ['s-mdDir', 's-mdFolder', 's-mdFolderCustom', 's-obsFolder',
      's-obsFolderCustom', 's-notebook', 's-path', 's-pathCustom']) {
      const el = this.$(id);
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => this.refreshSummaries());
    }
  }


  refreshSummaries() {
    const provider = this.$('s-provider').value === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
    const model = this.$('s-model').value.trim() || '未选模型';
    const keyState = this.cfg?.translate?.apiKeySet
      ? (this.cfg.translate.apiKeyFromEnv ? '环境变量密钥' : '密钥已配置') : '密钥未配置';
    const translate = `${provider} · ${model} · ${keyState}`;

    const isAgent = this.$('s-exBackend').value === 'agent';
    const selected = this.agents?.find((a) => a.id === this.$('s-agent').value);
    const agent = selected?.label || this.$('s-agent').value || this.wantAgent || '未选择 Agent';
    const profile = this.$('s-profileFull').checked ? 'Full' : 'Safe';
    const explain = isAgent ? `${agent} · ${profile}` : 'LLM · 快速回答';

    const backend = this.$('s-backend').value;
    const backendName = { markdown: '本地 Markdown', obsidian: 'Obsidian', siyuan: '思源笔记' }[backend] || backend;
    const destination = backend === 'markdown'
      ? [this.$('s-mdDir').value, this.$('s-mdFolderCustom').value || this.$('s-mdFolder').value].filter(Boolean).join(' · ')
      : backend === 'obsidian'
        ? [this.$('s-vault').selectedOptions?.[0]?.textContent || this.$('s-vault').value,
          this.$('s-obsFolderCustom').value || this.$('s-obsFolder').value].filter(Boolean).join(' · ')
        : [this.$('s-notebook').selectedOptions?.[0]?.textContent || this.$('s-notebook').value,
          this.$('s-pathCustom').value || this.$('s-path').value].filter(Boolean).join(' · ');
    const archive = `${backendName}${destination ? ` · ${destination}` : ' · 尚未选择位置'}`;

    const pageCount = blocklistEntries().pages.length;
    const scope = pageCount ? `当前可用 · 本站另有 ${pageCount} 个页面停用` : '当前页面可用';
    const values = { translate, explain, archive, scope };
    for (const [name, value] of Object.entries(values)) {
      this.$(`s-summary-${name}`).textContent = value;
    }
    const dest = this.$('s-destination');
    dest.querySelector('strong').textContent = backendName;
    dest.querySelector('span').textContent = destination || '尚未选择位置';
  }

  async busy(id, label, fn) {
    const button = this.$(id), old = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (label) button.textContent = label;
    try { return await fn(); }
    finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = old;
    }
  }

  /** 选中下拉项 → 回填输入框并立即落盘（用户预期「选了就生效」，不该再要求点保存） */
  async pickModel(name) {
    this.$('s-model').value = name;
    try { await this.persist({ silent: true }); this.msg(`已选用 ${name}`); }
    catch (e) { this.msg(`保存失败：${e.message}`, true); }
  }

  /**
   * 本站点的页面级停用清单。
   * 站点级停用是看不到的 —— 整站停用后插件不再启动，设置页自然无从打开；
   * 它的解除走恢复卡片（见 blocklist.js），这里列出的永远只是其他页面。
   * code 用 direction:rtl 截断时保住尾部：开头一大段是本站 origin，路径才有分辨力。
   */
  syncBlocklist() {
    const box = this.$('s-blockList');
    const { pages } = blocklistEntries();
    if (!box || !pages.length) {
      if (box) box.innerHTML = '';
      this.refreshSummaries?.();
      return;
    }
    box.innerHTML = `本站点已停用的页面：` + pages.map((p) => `<div class="blk">
      <code title="${esc(p.key)}">${esc(p.key.replace(/^https?:\/\/[^/]+/, '') || '/')}</code>
      <button type="button" data-k="${esc(p.key)}">恢复</button>
    </div>`).join('');
    for (const b of box.querySelectorAll('button[data-k]')) {
      b.onclick = this.guard(() => { unblockPageKey(b.dataset.k); this.syncBlocklist(); });
    }
    this.refreshSummaries();
  }

  /** 把 handler 里的异常摊到消息条上（实现见 guard.js） */
  guard(fn) { return guarded(fn, (e) => this.onHandlerError(e)); }

  onHandlerError(e) {
    this.msg(describeError(e), true);
    console.error('[ContextFlow] 配置面板出错：', e);
  }

  msg(text, bad = false) {
    const el = this.$('s-msg');
    el.textContent = text;
    el.className = `msg ${bad ? 'bad' : 'ok'}`;
    el.setAttribute('role', bad ? 'alert' : 'status');
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
  }

  /** 切换接口类型时把 Base URL 的占位改成对应默认值（不覆盖用户已填的） */
  syncProviderDefaults() {
    const p = this.$('s-provider').value;
    const box = this.$('s-baseUrl');
    // OpenAI 兼容网关没有通用默认地址，只给占位提示，不猜
    box.placeholder = p === 'openai'
      ? 'https://api.deepseek.com  （或你的内网网关）'
      : 'https://api.anthropic.com';
    if (!box.value && p === 'anthropic') box.value = 'https://api.anthropic.com';
    // 换了后端，之前拉的模型列表不再适用
    this.$('s-modelPickWrap').hidden = true;
  }

  /** 只显示当前后端相关的字段 */
  showBackend() {
    const b = this.$('s-backend').value;
    for (const el of this.sh.querySelectorAll('[data-be]')) {
      el.classList.toggle('on', el.dataset.be === b);
    }
    if (b === 'obsidian' && !this._vaultsLoaded) {
      this.loadVaults().then(() => this.loadFolders('obsidian'));
    }
    if (b === 'markdown' && !this._mdLoaded) {
      this._mdLoaded = true; this.loadFolders('markdown');
    }
    if (b === 'siyuan' && !this._nbLoaded) this.loadSiyuan();
  }

  async loadVaults(verbose = false) {
    const sel = this.$('s-vault');
    try {
      const { vaults } = await this.api.listVaults();
      this._vaultsLoaded = true;
      if (!vaults.length) {
        sel.innerHTML = '<option value="">（未探测到 vault，请手填路径）</option>';
        if (verbose) this.msg('本机未找到 Obsidian vault', true);
        return;
      }
      sel.innerHTML = vaults.map((v) =>
        `<option value="${esc(v.path)}">${esc(v.name)}${v.open ? '（当前打开）' : ''}</option>`).join('');
      const want = this.cfg?.obsidian?.vaultPath;
      if (want && vaults.some((v) => v.path === want)) sel.value = want;
      this.refreshSummaries();
      if (verbose) this.msg(`探测到 ${vaults.length} 个 vault`);
    } catch (e) {
      sel.innerHTML = '<option value="">（探测失败）</option>';
      this.msg(`探测 vault 失败：${e.message}`, true);
    }
  }

  /**
   * 拉取文件型后端的已有目录。
   * 必须先落盘再拉 —— 服务端根目录取自配置，不接受客户端传路径。
   * @param save 换 vault 后需要先保存才能按新 vault 探测
   */
  async loadFolders(backend, verbose = false, save = false) {
    const sel = this.$(backend === 'obsidian' ? 's-obsFolder' : 's-mdFolder');
    const want = backend === 'obsidian' ? this.cfg?.obsidian?.folder : this.cfg?.markdown?.folder;
    try {
      if (save) await this.persist({ silent: true });
      const { folders, root } = await this.api.listFolders(backend);
      const opts = want && !folders.includes(want) ? [want, ...folders] : folders;
      sel.innerHTML = opts.map((f) =>
        `<option value="${esc(f)}">${esc(f === '/' ? '/（根目录）' : f)}</option>`).join('');
      if (want) sel.value = want;
      this.refreshSummaries();
      if (verbose) this.msg(`${root} 下探测到 ${folders.length} 个目录`);
    } catch (e) {
      sel.innerHTML = `<option value="${esc(want || '/阅读记录')}">${esc(want || '/阅读记录')}</option>`;
      if (verbose) this.msg(`探测目录失败：${e.message}`, true);
    }
  }

  async load() {
    try {
      const c = await this.api.getConfig();
      this.cfg = c;
      this.$('s-provider').value = c.translate.provider;
      this.$('s-baseUrl').value = c.translate.baseUrl || '';
      this.$('s-model').value = c.translate.model || '';
      this.$('s-target').value = c.translate.target || '';
      this.$('s-thinking').checked = !!c.translate.thinking;
      this.$('s-chunkChars').value = c.translate.chunkChars ?? 5000;
      this.$('s-exBackend').value = c.explain?.backend || 'llm';
      this.$('s-notesDir').value = c.agent?.notesDir || '';
      this.wantAgent = c.agent?.id || '';
      this.$('s-profileSafe').checked = (c.agent?.profile || 'safe') === 'safe';
      this.$('s-profileFull').checked = c.agent?.profile === 'full';
      this.$('s-fullWarning').textContent = c.agent?.fullWarning || '';
      this.$('s-fullAck').checked = false;
      this.syncAgentSel();
      this.syncProfileUi();
      this.toggleAgentBox();
      // 自动探测：服务端有缓存（10 分钟），所以这在每个页面上都近乎免费。
      // 不这么做的话，配置早就存好了，界面上却永远显示"未检测"——
      // 用户会以为换个页面就得重新配一次。不 await，别拖慢面板显示。
      if ((c.explain?.backend || 'llm') === 'agent' && !this.agents) this.detectAgents(false);
      this.$('s-apiKey').value = '';
      this.$('s-apiKey').placeholder = c.translate.apiKeySet
        ? (c.translate.apiKeyFromEnv ? '来自环境变量（留空不改）' : '已配置（留空不改）')
        : '未配置';
      this.$('s-keyHint').textContent = c.translate.apiKeySet
        ? '只写不读：服务端不会回传明文'
        : '未配置时 /translate 返回 503';

      this.$('s-backend').value = c.sync?.backend || 'markdown';
      this.$('s-mdDir').value = c.markdown?.dir || '';
      this.$('s-obsFolderCustom').value = '';
      this.$('s-mdFolderCustom').value = '';
      this.$('s-origin').value = c.siyuan.origin || '';
      this.$('s-syToken').value = '';
      this.$('s-syToken').placeholder = c.siyuan.tokenSet ? '已配置（留空不改）' : '未配置';
      this.$('s-syHint').textContent = '在思源「设置 → 关于 → API token」查看';
      this.$('s-pathCustom').value = '';
      this.syncProviderDefaults();
      this.showBackend();
      this.syncBlocklist();
      this.refreshSummaries();
    } catch (e) {
      this.msg(`读取配置失败：${e.message}`, true);
    }
  }

  async loadSiyuan(verbose = false) {
    const sel = this.$('s-notebook');
    try {
      const { notebooks } = await this.api.listNotebooks();
      this._nbLoaded = true;
      sel.innerHTML = notebooks.map((n) =>
        `<option value="${n.id}">${esc(n.name)}</option>`).join('');
      sel.value = this.cfg?.siyuan.notebookId || notebooks[0]?.id || '';
      await this.loadPaths();
      this.refreshSummaries();
      if (verbose) this.msg(`已拉取 ${notebooks.length} 个笔记本`);
    } catch (e) {
      sel.innerHTML = '<option value="">（思源不可达）</option>';
      this.msg(`拉取笔记本失败：${e.message}`, true);
    }
  }

  async loadPaths() {
    const sel = this.$('s-path');
    const nb = this.$('s-notebook').value;
    if (!nb) return;
    try {
      const { paths } = await this.api.listPaths(nb);
      const want = this.cfg?.siyuan.docPathPrefix;
      const opts = paths.includes(want) || !want ? paths : [want, ...paths];
      sel.innerHTML = opts.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      if (want) sel.value = want;
      this.refreshSummaries();
    } catch (e) {
      sel.innerHTML = '<option value="">（拉取失败）</option>';
    }
  }

  toggleAgentBox() {
    const on = this.$('s-exBackend').value === 'agent';
    this.$('s-agentBox').hidden = !on;
  }

  syncProfileUi() {
    const full = this.$('s-profileFull').checked;
    const legacy = full && this.cfg?.agent?.profileSource === 'legacy-migrated';
    const selected = this.agents?.find((a) => a.id === this.$('s-agent').value);
    const unsupported = selected?.safeSupport === 'unsupported';
    this.$('s-advanced').open = full || legacy || unsupported;
    this.$('s-legacyFull').classList.toggle('on', legacy);
    const alreadyAcknowledged = this.cfg?.agent?.fullAccessAcknowledged
      && this.cfg?.agent?.id === this.$('s-agent').value;
    const needAck = full && !legacy && !alreadyAcknowledged;
    this.$('s-fullAckWrap').classList.toggle('on', needAck);
    if (!needAck) this.$('s-fullAck').checked = false;
    this.$('s-profileHint').textContent = unsupported
      ? `${selected.label} 的安全权限边界未验证，只能在高级完整权限中使用。`
      : selected?.safeSupport === 'best-effort'
        ? `${selected.label} 安全档为多层限制；本机 CLI 更新后建议重新检测。`
        : '';
  }

  /**
   * 探测本机可用的 agent。
   * @param {boolean} verbose 手动点「检测」：给反馈，并绕过服务端缓存
   *   （用户刚装了新 agent 就指望这个）。自动探测时保持安静并吃缓存。
   */
  async detectAgents(verbose) {
    try {
      const { agents } = await this.api.detectAgents(verbose);
      this.agents = agents;
      this.syncAgentSel();
      const ok = agents.filter((a) => a.available);
      if (verbose) {
        this.msg(ok.length
          ? `发现 ${ok.length} 个：${ok.map((a) => a.label).join('、')}`
          : '没找到已安装的 agent（claude / codex / dsh / gemini）', !ok.length);
      }
    } catch (e) {
      // 自动探测失败不该弹提示：服务没起时面板本来就会显示"离线"
      if (verbose) this.msg(`检测失败：${e.message}`, true);
    }
  }

  /** 把探测结果填进下拉，并保住配置里已选的那个 */
  syncAgentSel() {
    const sel = this.$('s-agent');
    const list = this.agents || [];
    if (!list.length) {
      // 还没探测过：至少把已配置的值留住，别在保存时被清空。
      // 措辞刻意用"读取中"而不是"未检测"—— 配置是存着的，说"未检测"会让人
      // 以为换页面就得重配一次（那正是这一版要修的误解）。
      sel.innerHTML = this.wantAgent
        ? `<option value="${esc(this.wantAgent)}">${esc(this.wantAgent)}（读取中…）</option>`
        : '<option value="">（点检测）</option>';
      sel.value = this.wantAgent || '';
      return;
    }
    sel.innerHTML = list.map((a) => {
      const risk = a.verified ? '' : ' · 未实测';
      return `<option value="${esc(a.id)}"${a.available ? '' : ' disabled'}>`
        + `${esc(a.label)}${a.available ? ` ${esc(a.version)}` : '（未安装）'}${risk}</option>`;
    }).join('');
    // 已配置的优先；否则挑第一个可用的，且偏向 OS 级沙箱那个
    const pick = list.find((a) => a.id === this.wantAgent && a.available)
      || list.find((a) => a.available && a.verified)
      || list.find((a) => a.available);
    if (pick) { sel.value = pick.id; this.wantAgent = pick.id; }
    this.syncProfileUi();
    this.refreshSummaries();
  }

  async fetchModels() {
    // 先把当前填的 url/key/provider 存下来，否则拉的是旧配置对应的上游
    try {
      await this.persist({ silent: true });
      const { models } = await this.api.listModels();
      if (!models.length) { this.msg('上游未返回任何模型', true); return; }
      const pick = this.$('s-modelPick');
      pick.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      this.$('s-modelPickWrap').hidden = false;

      // 关键：填充后下拉默认选中第一项，但 change 事件只在**用户改变**选项时触发。
      // 不在这里主动同步，界面就会出现「下拉显示 A、输入框还是 B」，
      // 且用户点中那个已选项时 change 也不会触发，永远同步不上。
      const cur = this.$('s-model').value.trim();
      const hit = models.includes(cur);
      pick.value = hit ? cur : models[0];
      await this.pickModel(pick.value);
      if (!hit && cur) {
        this.msg(`「${cur}」不在该网关的模型列表中，已切为 ${pick.value}`);
      } else {
        this.msg(`拉取到 ${models.length} 个模型，当前 ${pick.value}`);
      }
    } catch (e) {
      this.msg(`获取模型失败：${e.message}`, true);
    }
  }

  /** 收集表单 → PATCH。密钥留空即不提交该字段。 */
  patch() {
    const profile = this.$('s-profileFull').checked ? 'full' : 'safe';
    const agentId = this.$('s-agent').value.trim();
    const previous = this.cfg?.agent || {};
    const acknowledged = previous.fullAccessAcknowledged && previous.profile === 'full'
      && previous.id === agentId;
    let fullAccessAcknowledgement;
    if (profile === 'full' && !acknowledged && previous.profileSource !== 'legacy-migrated') {
      if (!this.$('s-fullAck').checked) {
        throw Object.assign(new Error('请先勾选完整权限风险确认'), { code: 'AGENT_FULL_ACK' });
      }
      fullAccessAcknowledgement = {
        version: previous.fullWarningVersion,
        agentId,
        acceptedAt: Date.now(),
        warningHash: previous.fullWarningHash,
      };
    }
    const selected = this.agents?.find((a) => a.id === agentId);
    if (profile === 'safe' && selected?.safeSupport === 'unsupported') {
      throw Object.assign(new Error(`${selected.label} 不支持安全档，请改选 Claude Code / Codex 或在高级能力中确认完整权限`),
        { code: 'AGENT_SAFE_UNSUPPORTED' });
    }
    const p = {
      translate: {
        provider: this.$('s-provider').value,
        baseUrl: this.$('s-baseUrl').value.trim(),
        model: this.$('s-model').value.trim(),
        target: this.$('s-target').value.trim() || '简体中文',
        thinking: this.$('s-thinking').checked,
        // 空着按默认 5000，而不是当成 0 —— 后者会静默关掉正文上下文
        chunkChars: Math.max(0, Number(this.$('s-chunkChars').value) || 5000),
      },
      explain: { backend: this.$('s-exBackend').value },
      agent: {
        id: agentId,
        notesDir: this.$('s-notesDir').value.trim(),
        profile,
        profileSource: profile === 'full' && previous.profileSource === 'legacy-migrated'
          && previous.id === agentId ? 'legacy-migrated' : 'user',
        ...(fullAccessAcknowledgement ? { fullAccessAcknowledgement } : {}),
      },
      sync: { backend: this.$('s-backend').value },
      obsidian: {
        vaultPath: this.$('s-vault').value.trim(),
        folder: normPath(this.$('s-obsFolderCustom').value.trim()
          || this.$('s-obsFolder').value || '/阅读记录'),
      },
      markdown: {
        dir: this.$('s-mdDir').value.trim(),
        folder: normPath(this.$('s-mdFolderCustom').value.trim()
          || this.$('s-mdFolder').value || '/阅读记录'),
      },
      siyuan: {
        origin: this.$('s-origin').value.trim(),
        notebookId: this.$('s-notebook').value,
        docPathPrefix: normPath(this.$('s-pathCustom').value.trim() || this.$('s-path').value),
      },
    };
    const k = this.$('s-apiKey').value.trim();
    if (k) p.translate.apiKey = k;
    const t = this.$('s-syToken').value.trim();
    if (t) p.siyuan.token = t;
    return p;
  }

  async persist({ silent = false } = {}) {
    this.cfg = await this.api.putConfig(this.patch());
    // 提交后清空密钥输入框，占位符改为「已配置」
    for (const [id, set] of [['s-apiKey', this.cfg.translate.apiKeySet], ['s-syToken', this.cfg.siyuan.tokenSet]]) {
      this.$(id).value = '';
      this.$(id).placeholder = set ? '已配置（留空不改）' : '未配置';
    }
    this.refreshSummaries();
    if (!silent) this.msg('已保存');
    return this.cfg;
  }

  async save() {
    try { await this.persist(); await this.loadPaths(); }
    catch (e) { this.msg(`保存失败：${e.message}`, true); }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const normPath = (p) => {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '') || '/';
};
