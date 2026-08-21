// 配置界面：翻译后端 + 思源落地目录。
//
// 关键约束：密钥只往服务端写，永不回读。GET /config 只给 apiKeySet / tokenSet 布尔位，
// 界面上密钥输入框留空即表示「不改动已存的值」—— 否则每次打开配置都会把 key 清掉。
// 脚本跑在页面 MAIN world，回读明文等于交给页面 JS。

import { T } from './theme.js';
import { guarded, describeError } from './guard.js';

export const SETTINGS_CSS = `
  .set{display:none} .set.on{display:block}
  .grp{margin-bottom:18px}
  .grp > h4{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.09em;
            text-transform:uppercase;color:${T.quote}}
  .f{margin-bottom:9px}
  .f > label{display:block;font-size:11.5px;color:${T.inkSoft};margin-bottom:3px}
  .f input,.f select{width:100%;border:1px solid ${T.line};border-radius:7px;
      background:${T.paper};color:${T.ink};font:12.5px/1.5 ${T.sans};
      padding:6px 8px;outline:none}
  .f input:focus,.f select:focus{border-color:#d7cfbe;box-shadow:0 0 0 3px rgba(180,83,9,.07)}
  .f .hint{font-size:11px;color:${T.quote};margin-top:3px}
  .f2{display:flex;gap:6px;align-items:flex-end}
  .f2 > .f{flex:1;margin-bottom:0}
  .f2 > button{border:1px solid ${T.line};padding:6px 10px;font-size:12px;white-space:nowrap}
  .save{display:flex;align-items:center;gap:8px;
        padding-top:12px;border-top:1px solid ${T.line}}
  .save > button{border:1px solid ${T.line};background:${T.sunk};padding:6px 14px;font-weight:600}
  .save > button:hover{background:#ece7dd}
  .msg{font-size:11.5px}
  [data-be]{display:none}
  [data-be].on{display:block}
  .chk{display:flex;align-items:flex-start;gap:7px;cursor:pointer}
  .chk input{width:auto;flex:0 0 auto;margin:2px 0 0;accent-color:${T.accent}}
  .chk .t{font-size:12.5px;color:${T.ink}}
  .chk .t .hint{margin-top:2px}
`;

const FORM = `
  <div class="grp">
    <h4>翻译</h4>
    <div class="f">
      <label>接口类型</label>
      <select id="s-provider">
        <option value="openai">OpenAI 兼容（/v1/chat/completions）</option>
        <option value="anthropic">Anthropic（官方 SDK / 兼容网关）</option>
      </select>
    </div>
    <div class="f">
      <label>Base URL</label>
      <input id="s-baseUrl" placeholder="https://api.anthropic.com" spellcheck="false">
    </div>
    <div class="f">
      <label>API Key</label>
      <input id="s-apiKey" type="password" spellcheck="false" autocomplete="off">
      <div class="hint" id="s-keyHint"></div>
    </div>
    <div class="f2">
      <div class="f">
        <label>模型</label>
        <input id="s-model" spellcheck="false" placeholder="点右侧「获取可选模型」">
      </div>
      <button id="s-fetchModels" title="从上游拉取可选模型">获取可选模型</button>
    </div>
    <div class="f" id="s-modelPickWrap" style="display:none">
      <select id="s-modelPick"></select>
    </div>
    <div class="f">
      <label>目标语言</label>
      <input id="s-target" placeholder="简体中文">
    </div>
    <div class="f">
      <label class="chk">
        <input type="checkbox" id="s-thinking">
        <span class="t">开启 think 模式
          <div class="hint">翻译任务通常不需要推理，会明显增加延迟与费用。
            上游若不支持该参数会自动退回不开。</div>
        </span>
      </label>
    </div>
    <div class="f">
      <label>原文段上下文长度</label>
      <input id="s-chunkChars" type="number" min="0" step="500" placeholder="5000">
      <div class="hint">正文按这个字符数分段喂给模型，只喂到覆盖当前选区为止。
        填 <code>0</code> 则不带正文上下文。</div>
    </div>
  </div>

  <div class="grp">
    <h4>解释</h4>
    <div class="f">
      <label>后端</label>
      <select id="s-exBackend">
        <option value="llm">LLM（快，几秒）</option>
        <option value="agent">本地 agent（慢，几十秒，但能读你的笔记）</option>
      </select>
    </div>
    <div id="s-agentBox" style="display:none">
      <div class="f2">
        <div class="f">
          <label>agent</label>
          <select id="s-agent"><option value="">（点检测）</option></select>
        </div>
        <button id="s-detectAgent" title="探测本机已安装的 agent">检测</button>
      </div>
      <div class="f">
        <label>笔记库</label>
        <input id="s-notesDir" placeholder="/path/to/notes（留空则不授予任何目录）">
      </div>
    </div>
  </div>

  <div class="grp">
    <h4>同步到笔记库</h4>
    <div class="f">
      <label>后端</label>
      <select id="s-backend">
        <option value="markdown">本地 Markdown（零依赖）</option>
        <option value="obsidian">Obsidian（直接写 vault 文件）</option>
        <option value="siyuan">思源笔记（kernel API）</option>
      </select>
    </div>

    <!-- Obsidian -->
    <div data-be="obsidian">
      <div class="f2">
        <div class="f">
          <label>Vault</label>
          <select id="s-vault"></select>
        </div>
        <button id="s-reloadVault" title="重新探测本机 vault">探测</button>
      </div>
      <div class="f2">
        <div class="f">
          <label>vault 内目录</label>
          <select id="s-obsFolder"></select>
        </div>
        <button id="s-reloadObsDir" title="探测 vault 内已有目录">探测</button>
      </div>
      <div class="f">
        <label>或新建目录（填了以此为准）</label>
        <input id="s-obsFolderCustom" placeholder="/阅读记录" spellcheck="false">
        <div class="hint">不需要装任何 Obsidian 插件，直接写 .md 文件，Obsidian 会自动收录</div>
      </div>
    </div>

    <!-- 本地 Markdown -->
    <div data-be="markdown">
      <div class="f">
        <label>导出根目录</label>
        <input id="s-mdDir" placeholder="~/ContextFlow" spellcheck="false">
      </div>
      <div class="f2">
        <div class="f">
          <label>子目录</label>
          <select id="s-mdFolder"></select>
        </div>
        <button id="s-reloadMdDir" title="探测已有子目录">探测</button>
      </div>
      <div class="f">
        <label>或新建目录（填了以此为准）</label>
        <input id="s-mdFolderCustom" placeholder="/阅读记录" spellcheck="false">
        <div class="hint">不依赖任何笔记软件，按天生成 <code>YYYY-MM-DD.md</code></div>
      </div>
    </div>

    <!-- 思源 -->
    <div data-be="siyuan">
      <div class="f">
        <label>kernel 地址</label>
        <input id="s-origin" placeholder="http://127.0.0.1:6806" spellcheck="false">
      </div>
      <div class="f">
        <label>API Token</label>
        <input id="s-syToken" type="password" spellcheck="false" autocomplete="off">
        <div class="hint" id="s-syHint"></div>
      </div>
      <div class="f2">
        <div class="f">
          <label>笔记本</label>
          <select id="s-notebook"></select>
        </div>
        <button id="s-reloadNb" title="重新拉取笔记本与目录">刷新</button>
      </div>
      <div class="f">
        <label>落地目录</label>
        <select id="s-path"></select>
      </div>
      <div class="f">
        <label>或自定义目录（填了以此为准）</label>
        <input id="s-pathCustom" placeholder="/阅读记录" spellcheck="false">
      </div>
    </div>
  </div>

  <div class="save">
    <button id="s-save">保存</button>
    <span class="msg" id="s-msg"></span>
  </div>
`;

export class Settings {
  /** @param {ShadowRoot} sh  @param {HTMLElement} mount  @param {object} api */
  constructor(sh, mount, api) {
    this.sh = sh; this.api = api;
    mount.innerHTML = FORM;
    this.$ = (id) => sh.getElementById(id);

    // 所有交互都过 guard：handler 里抛异常时，界面上必须看得见。
    // 起因是「点检测没反应」——我把 this.api 写成了 this.h.api，onclick 抛
    // TypeError 后一切静默，用户只看到按钮毫无反应，连个线索都没有。
    const on = (id, evt, fn) => { this.$(id)[evt] = this.guard(fn); };

    on('s-fetchModels', 'onclick', () => this.fetchModels());
    on('s-detectAgent', 'onclick', () => this.detectAgents(true));
    on('s-exBackend', 'onchange', () => {
      this.toggleAgentBox();
      // 切到 agent 且还没探测过时自动探一次 —— 否则下拉是空的，用户不知道要点检测
      if (this.$('s-exBackend').value === 'agent' && !this.agents) this.detectAgents(false);
    });
    on('s-reloadNb', 'onclick', () => this.loadSiyuan(true));
    on('s-save', 'onclick', () => this.save());
    this.$('s-modelPick').onchange = (e) => this.pickModel(e.target.value);
    this.$('s-notebook').onchange = () => this.loadPaths();
    this.$('s-provider').onchange = () => this.syncProviderDefaults();
    this.$('s-backend').onchange = () => this.showBackend();
    this.$('s-reloadVault').onclick = () => this.loadVaults(true);
    this.$('s-reloadObsDir').onclick = () => this.loadFolders('obsidian', true);
    this.$('s-reloadMdDir').onclick = () => this.loadFolders('markdown', true);
    this.$('s-vault').onchange = () => this.loadFolders('obsidian', false, true);
  }

  /** 选中下拉项 → 回填输入框并立即落盘（用户预期「选了就生效」，不该再要求点保存） */
  async pickModel(name) {
    this.$('s-model').value = name;
    try { await this.persist({ silent: true }); this.msg(`已选用 ${name}`); }
    catch (e) { this.msg(`保存失败：${e.message}`, true); }
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
    this.$('s-modelPickWrap').style.display = 'none';
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
      this.syncAgentSel();
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
    } catch (e) {
      sel.innerHTML = '<option value="">（拉取失败）</option>';
    }
  }

  toggleAgentBox() {
    const on = this.$('s-exBackend').value === 'agent';
    this.$('s-agentBox').style.display = on ? 'block' : 'none';
  }

  /**
   * 探测本机可用的 agent。
   * @param {boolean} verbose 手动点「检测」时给反馈；自动探测时保持安静
   */
  /**
   * @param {boolean} verbose 手动点「检测」：给反馈，并绕过服务端缓存
   *   （用户刚装了新 agent 就指望这个）。自动探测时保持安静并吃缓存。
   */
  async detectAgents(verbose) {
    const btn = this.$('s-detectAgent');
    const old = btn.textContent;
    if (verbose) btn.textContent = '检测中…';
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
    btn.textContent = old;
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
    sel.onchange = this.guard(() => { this.wantAgent = sel.value; });
  }

  async fetchModels() {
    const btn = this.$('s-fetchModels');
    const old = btn.textContent;
    btn.textContent = '拉取中…';
    // 先把当前填的 url/key/provider 存下来，否则拉的是旧配置对应的上游
    try {
      await this.persist({ silent: true });
      const { models } = await this.api.listModels();
      if (!models.length) { this.msg('上游未返回任何模型', true); return; }
      const pick = this.$('s-modelPick');
      pick.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      this.$('s-modelPickWrap').style.display = 'block';

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
    } finally {
      btn.textContent = old;
    }
  }

  /** 收集表单 → PATCH。密钥留空即不提交该字段。 */
  patch() {
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
        id: this.$('s-agent').value.trim(),
        notesDir: this.$('s-notesDir').value.trim(),
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
