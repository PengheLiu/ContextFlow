// 配置界面：翻译后端 + 思源落地目录。
//
// 关键约束：密钥只往服务端写，永不回读。GET /config 只给 apiKeySet / tokenSet 布尔位，
// 界面上密钥输入框留空即表示「不改动已存的值」—— 否则每次打开配置都会把 key 清掉。
// 脚本跑在页面 MAIN world，回读明文等于交给页面 JS。

import { T } from './theme.js';
import { guarded, describeError } from './guard.js';
import { icon } from './icons.js';
import { blocklistEntries, unblockPageKey } from './blocklist.js';
import { companionInfo } from '../core/companion-info.js';
import { wireDisclosure } from '../core/disclosure.js';

export const SETTINGS_CSS = `
  .set{display:none;margin:0 -18px -28px}.set.on{display:block}
  [hidden]{display:none!important}
  .folio{min-height:100%;font:13px/1.55 ${T.sans};color:${T.ink}}
  .folio-kicker{display:flex;align-items:center;gap:8px;padding:17px 18px 13px;border-bottom:1px solid ${T.lineSoft};
    color:${T.quote};font:700 10.5px/1 ${T.mono};letter-spacing:.14em;text-transform:uppercase}
  .folio-kicker::before{content:'';width:17px;height:2px;background:${T.accent}}

  /* Fixed-height headers establish four clear destinations. Content, not the
     heading, animates; status remains readable even while a chapter is closed. */
  .chapter-deck{min-width:0;display:grid;gap:12px;padding:14px 12px 22px;background:${T.sunk}}
  .chapter{display:block;min-width:0;padding:0;border:1px solid ${T.line};border-radius:9px;background:${T.paperRaised};overflow:clip}
  .chapter[data-expanded=true]{border-color:${T.lineStrong}}
  .chapter-head{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:start;gap:9px;position:relative;padding:16px 13px;margin:0;cursor:pointer;list-style:none}
  .chapter-head::-webkit-details-marker{display:none}
  .chapter-head:focus-visible{outline:2px solid ${T.focusLine};outline-offset:-3px;border-radius:8px}
  .chapter-icon{color:${T.quote};padding-top:3px}.chapter-icon .ico{width:19px;height:19px}
  .chapter[data-expanded=true] .chapter-icon{color:${T.accent}}
  .chapter-copy{min-width:0}.chapter-meta{display:flex;flex-direction:column;align-items:flex-end;gap:7px;min-width:0}
  .chapter-state{display:inline-flex;border-radius:4px;padding:2px 5px;background:${T.sunk};color:${T.quote};font-size:10.5px;line-height:1.5;white-space:nowrap}
  .chapter-state[data-state=ok]{background:${T.accentWash};color:${T.ok}}.chapter-state[data-state=bad]{background:${T.badSoft};color:${T.bad}}
  .chapter-affordance{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${T.quote}}
  .chapter-affordance .ico{width:12px;height:12px;transition:transform .18s ease}
  .chapter[data-expanded=true] .chapter-affordance .ico{transform:rotate(90deg)}
  .chapter-body{display:flow-root;padding:16px 14px 19px;border-top:1px solid ${T.lineSoft};overflow-anchor:none}
  .chapter-eyebrow{display:block;margin-bottom:5px;color:${T.quote};font:700 10.5px/1 ${T.mono};letter-spacing:.12em;text-transform:uppercase}
  .chapter-head h3{margin:0;color:${T.ink};font:650 13.5px/1.5 ${T.sans}}
  .chapter-summary{display:block;margin-top:4px;color:${T.quote};font:11.5px/1.5 ${T.sans};overflow-wrap:anywhere}
  .settings-status{margin:14px 18px 0;padding:11px 12px;background:${T.paperRaised};border:1px solid ${T.line};border-radius:6px;color:${T.quote};font-size:12px}
  .settings-status.bad{color:${T.bad};border-left:3px solid ${T.bad}}
  .chapter-intro{margin:0 0 17px;color:${T.inkSoft};font:12.5px/1.62 ${T.serif}}

  .field{display:block;margin:0 0 14px;min-width:0}
  .field-label,.field > legend{display:block;margin:0 0 6px;color:${T.inkSoft};font-size:12px;font-weight:680}
  .field-heading{display:flex;align-items:center;gap:6px;margin-bottom:6px}.field-heading .field-label{margin:0}
  .answer-help-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:4px;border:0;border-radius:5px;background:transparent;color:${T.quote};cursor:pointer}
  .answer-help-button .ico{width:17px;height:17px}.answer-help-button:hover,.answer-help-button[aria-expanded=true]{color:${T.accent};background:${T.accentWash}}
  .answer-help-button:focus-visible{outline:2px solid ${T.focusLine};outline-offset:1px}
  .answer-help{margin:10px 0 0;padding:12px;border:1px solid ${T.line};border-radius:7px;background:${T.paper};font-size:12px;color:${T.inkSoft};line-height:1.65}
  .answer-help h4{margin:0 0 8px;font-size:12px;color:${T.ink}}.answer-help dl{margin:0}.answer-help dt{font-weight:680;color:${T.ink}}
  .answer-help dd{margin:2px 0 10px}.answer-help dd:last-child{margin-bottom:0}.answer-help p{margin:10px 0 0;padding-top:9px;border-top:1px solid ${T.lineSoft};color:${T.quote};font-size:11.5px}
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
  .disclosure > summary::before{content:'';width:6px;height:6px;margin:0 5px 0 3px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .18s ease}
  .disclosure[data-expanded=true] > summary::before{transform:rotate(45deg)}
  .disclosure-body{padding:4px 1px 3px}

  [data-be]{display:none}[data-be].on{display:block}
  .agent-box{padding-top:3px}
  .agent-health{padding:12px;margin:12px 0 17px;border:1px solid ${T.line};border-radius:7px;background:${T.paper}}
  .agent-health-title{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:12px;margin-bottom:10px}
  .agent-checks{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;font-size:12px;margin:0 0 10px}
  .agent-checks dt{color:${T.quote}}.agent-checks dd{margin:0;overflow-wrap:anywhere;color:${T.inkSoft}}
  .agent-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.agent-actions button{min-height:34px}
  .agent-health .model-feedback{margin:10px 0 0}.agent-version{font-size:11px;color:${T.quote};overflow-wrap:anywhere}
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
  .model-feedback{margin:0 0 14px;overflow-wrap:anywhere}.model-feedback:empty{display:none}
  .model-feedback.ok{color:${T.ok}}.model-feedback.bad{color:${T.bad}}
  .settings-toast{position:fixed;z-index:10;right:16px;bottom:64px;width:max-content;max-width:min(430px,calc(100% - 32px));
    display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border:1px solid ${T.line};border-left:3px solid ${T.ok};
    border-radius:7px;background:${T.paperRaised};color:${T.ink};box-shadow:${T.shadowControl};font:12px/1.6 ${T.sans};overflow-wrap:anywhere}
  .settings-toast.bad{border-left-color:${T.bad}}
  .settings-toast > span{min-width:0;flex:1}.settings-toast > button{flex:0 0 auto;min-width:24px;min-height:24px;padding:0;border:0;background:transparent;color:${T.quote};font-size:18px}

  @container (max-width:310px){
    .set{margin-left:-14px;margin-right:-14px}.folio-kicker{padding-left:14px;padding-right:14px}
    .chapter-deck{padding:12px 8px 18px;gap:10px}.chapter-head{padding:13px 10px;grid-template-columns:minmax(0,1fr) auto;gap:7px}.chapter-icon{display:none}.chapter-head h3{font-size:13px}.chapter-body{padding:13px 10px 16px}
    .field-row{grid-template-columns:minmax(0,1fr)}.field-row > button{width:100%;text-align:center}
    .scope-actions{grid-template-columns:minmax(0,1fr)}.scope-action{min-height:0;display:grid;grid-template-columns:18px 1fr;column-gap:8px}
    .scope-action .ico{grid-row:1/3;margin:2px 0 0}.scope-action span{grid-column:2}
    .save{padding-left:14px;padding-right:14px}
  }
  @media(prefers-reduced-motion:reduce){.chapter-affordance .ico,.disclosure>summary::before{transition:none}}
`;

const FORM = `
  <div class="folio">
    <div class="folio-kicker">Settings</div>
    <div id="s-serviceStatus" class="settings-status" role="status">只有点击「保存更改」才会写入配置。获取模型和测试连接不会保存。</div>
    <div class="chapter-deck">
        <details class="chapter" id="s-chapter-translate" open>
          <summary class="chapter-head"><h3>AI 模型与翻译</h3><span class="chapter-summary" id="s-summary-translate">配置自己的模型服务</span></summary>
          <p class="chapter-intro">模型连接供翻译、LLM 解释与速览共用。只同步笔记可以跳过本节，无需购买模型服务。</p>
          <label class="field"><span class="field-label">接口类型</span>
            <select id="s-provider"><option value="openai">OpenAI 兼容（/v1/chat/completions）</option><option value="anthropic">Anthropic（官方 SDK / 兼容网关）</option></select></label>
          <div class="field-row"><label class="field"><span class="field-label">模型</span><input id="s-model" spellcheck="false" placeholder="点右侧获取可选模型"></label>
            <button id="s-fetchModels" type="button" title="从上游拉取可选模型">获取模型</button></div>
          <p id="s-modelListStatus" class="hint model-feedback" role="status" aria-live="polite" aria-atomic="true"></p>
          <div class="field" id="s-modelPickWrap" hidden><label class="field-label" for="s-modelPick">可选模型</label><select id="s-modelPick"></select></div>
          <label class="field"><span class="field-label">目标语言</span><input id="s-target" placeholder="简体中文"></label>
          <details class="disclosure" id="s-translateAdvanced"><summary>连接与上下文</summary><div class="disclosure-body">
            <label class="field"><span class="field-label">Base URL</span><input id="s-baseUrl" placeholder="https://api.anthropic.com" spellcheck="false"></label>
            <label class="field"><span class="field-label">API Key</span><input id="s-apiKey" type="password" spellcheck="false" autocomplete="off" aria-describedby="s-keyHint"><span class="hint" id="s-keyHint"></span></label>
            <label class="field check-row"><input type="checkbox" id="s-thinking"><span class="check-copy">开启 think 模式<span class="hint">翻译通常不需要推理；开启后会增加延迟与费用，不支持时自动退回。</span></span></label>
            <label class="field"><span class="field-label">原文段上下文长度</span><input id="s-chunkChars" type="number" min="0" step="500" placeholder="5000"><span class="hint">按字符数分段，只喂到覆盖当前选区为止；填 <code>0</code> 则不带正文。</span></label>
          </div></details>
          <button class="quiet-action" id="s-testModel" type="button">测试模型连接</button>
          <p id="s-modelStatus" class="hint model-feedback" role="status" aria-live="polite" aria-atomic="true"></p>
          <span class="hint">仅测试当前填写内容，不保存配置。会发送固定短消息，可能产生少量费用；不会发送文章或笔记。测试成功后请点击「保存更改」。</span>
        </details>

        <details class="chapter" id="s-chapter-explain">
          <summary class="chapter-head"><h3>解释与 Agent</h3><span class="chapter-summary" id="s-summary-explain">模型回答或本地 Agent</span></summary>
          <p class="chapter-intro">选择直接调用模型，或使用本地 Agent 的工具能力。</p>
          <div class="field">
            <div class="field-heading"><label class="field-label" for="s-exBackend">回答方式</label><button class="answer-help-button" id="s-answerHelp" type="button" aria-label="了解两种回答方式的能力范围" aria-expanded="false" aria-controls="s-answerHelpContent">${icon('help')}</button></div>
            <select id="s-exBackend"><option value="llm">LLM</option><option value="agent">本地 Agent</option></select>
            <section class="answer-help" id="s-answerHelpContent" role="region" aria-labelledby="s-answerHelpTitle" hidden>
              <h4 id="s-answerHelpTitle">两种回答方式有什么不同？</h4>
              <dl><dt>LLM · 直接回答</dt><dd>使用上方配置的模型，根据选中文字与提供的文章上下文生成回答。通常更快；不能主动读取本机笔记，也不能执行本地工具。</dd>
              <dt>本地 Agent · 工具辅助</dt><dd>调用本机已安装并登录的 CLI，可在授权范围内检索笔记、使用工具。Safe 档限制写入与命令，笔记目录需单独授权；Full 档可使用文件写入、命令等高级能力，需确认风险。具体隔离边界取决于 CLI，通常耗时更长。</dd></dl>
              <p>此选择用于解释与文章速览；翻译始终使用上方的 LLM。两种方式都可能产生模型费用。连接测试仅验证实际回答，不验证笔记访问或工具权限。</p>
            </section>
          </div>
          <div class="agent-box" id="s-agentBox" hidden>
            <div class="field-row"><label class="field"><span class="field-label">本地 Agent</span><select id="s-agent"><option value="">先检测安装，再选择 Agent</option></select></label><button id="s-detectAgent" type="button" title="只检查本机安装，不调用模型">检测安装</button></div>
            <p id="s-agentDiscoveryStatus" class="hint model-feedback" role="status" aria-live="polite"></p>
            <div class="agent-health">
              <div class="agent-health-title"><strong id="s-agentName">选择要使用的 Agent</strong><span class="chapter-state" id="s-agentReady">待选择</span></div>
              <dl class="agent-checks"><dt>程序安装</dt><dd id="s-agentInstalled">尚未检测</dd><dt>实际回答</dt><dd id="s-agentConnection">尚未测试</dd></dl>
              <div class="agent-version" id="s-agentVersion"></div>
              <div class="agent-actions"><button class="quiet-action" id="s-testAgent" type="button" disabled>测试 Agent 连接</button><button class="quiet-action" id="s-cancelAgentTest" type="button" hidden>取消测试</button></div>
              <p id="s-agentTestStatus" class="hint model-feedback" role="status" aria-live="polite" aria-atomic="true"></p>
              <span class="hint">仅向所选 Agent 发送固定短消息，验证登录与模型回答；不发送文章或笔记、不保存配置，可能产生少量费用。测试不验证笔记读取或完整权限。</span>
            </div>
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
        </details>

        <details class="chapter" id="s-chapter-archive">
          <summary class="chapter-head"><h3>笔记同步</h3><span class="chapter-summary" id="s-summary-archive">选择保存位置</span></summary>
          <p class="chapter-intro">每篇文章持续写回同一份文档，目的地始终由你掌握。</p>
          <label class="field"><span class="field-label">笔记后端</span><select id="s-backend"><option value="markdown">本地 Markdown（零依赖）</option><option value="obsidian">Obsidian（直接写 Vault）</option><option value="siyuan">思源笔记（Kernel API）</option></select></label>
          <div class="destination" id="s-destination" role="status" aria-live="polite"><strong>本地 Markdown</strong><span>读取配置中…</span></div>
          <div data-be="obsidian">
            <div class="field-row"><label class="field"><span class="field-label">Vault</span><select id="s-vault"></select></label><button id="s-reloadVault" type="button" title="重新探测本机 Vault">探测</button></div>
            <label class="field"><span class="field-label">或手填 Vault 根目录（填了以此为准）</span><input id="s-vaultPath" spellcheck="false" placeholder="完整路径，例如 ~/Documents/MyVault"><span class="hint">未探测到、使用便携版或自定义目录时可手填。请选 Vault 本身，不是它的阅读记录子目录。</span></label>
            <div class="field-row"><label class="field"><span class="field-label">Vault 内目录</span><select id="s-obsFolder"></select></label><button id="s-reloadObsDir" type="button" title="探测 Vault 内已有目录">探测</button></div>
            <label class="field"><span class="field-label">或新建目录（填了以此为准）</span><input id="s-obsFolderCustom" placeholder="/阅读记录" spellcheck="false"><span class="hint">直接写入 Vault，不需要额外安装 Obsidian 插件。</span></label>
          </div>
          <div data-be="markdown">
            <label class="field"><span class="field-label">导出根目录</span><input id="s-mdDir" placeholder="~/ContextFlow" spellcheck="false"></label>
            <div class="field-row"><label class="field"><span class="field-label">子目录</span><select id="s-mdFolder"></select></label><button id="s-reloadMdDir" type="button" title="探测已有子目录">探测</button></div>
            <label class="field"><span class="field-label">或新建目录（填了以此为准）</span><input id="s-mdFolderCustom" placeholder="/阅读记录" spellcheck="false"><span class="hint">每篇文章持续更新同一份 Markdown，不依赖笔记软件。保存配置后，在文章侧栏点击「同步」才会写入。</span></label>
          </div>
          <div data-be="siyuan">
            <label class="field"><span class="field-label">Kernel 地址</span><input id="s-origin" placeholder="http://127.0.0.1:6806" spellcheck="false"></label>
            <label class="field"><span class="field-label">API Token</span><input id="s-syToken" type="password" spellcheck="false" autocomplete="off" aria-describedby="s-syHint"><span class="hint" id="s-syHint"></span></label>
            <div class="field-row"><label class="field"><span class="field-label">笔记本</span><select id="s-notebook"></select></label><button id="s-reloadNb" type="button" title="重新拉取笔记本与目录">刷新</button></div>
            <label class="field"><span class="field-label">落地目录</span><select id="s-path"></select></label>
            <label class="field"><span class="field-label">或自定义目录（填了以此为准）</span><input id="s-pathCustom" placeholder="/阅读记录" spellcheck="false"></label>
          </div>
        </details>

        <details class="chapter" id="s-chapter-scope">
          <summary class="chapter-head"><h3>网站与页面权限</h3><span class="chapter-summary" id="s-summary-scope">管理停用范围</span></summary>
          <p class="chapter-intro">不是每个网页都需要阅读工具。把干扰挡在当前页面，或整个站点之外。</p>
          <div class="scope-actions">
            <button class="scope-action" id="s-blockPage" type="button">${icon('power')}<strong>仅停用此页面</strong><span>其他页面照常使用</span></button>
            <button class="scope-action" id="s-blockSite" type="button">${icon('power')}<strong>停用整个站点</strong><span>同一来源下都不再启动</span></button>
          </div>
          <span class="hint">名单只保存在本站点的浏览器本地，不会写入服务端或笔记库。重新运行脚本或点扩展图标可恢复。</span>
          <div class="block-list" id="s-blockList"></div>
        </details>
    </div>
    <div class="save"><span class="msg" id="s-msg" role="status" aria-live="polite" aria-atomic="true"></span><button id="s-save" type="button">保存更改</button></div>
    <div id="s-toast" class="settings-toast" hidden><span id="s-toastText"></span><button id="s-dismissToast" type="button" aria-label="关闭提示">×</button></div>
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
  constructor(sh, mount, api, onBlock = null, options = {}) {
    this.sh = sh; this.api = api; this.onBlock = onBlock;
    this.onSaved = options.onSaved;
    mount.innerHTML = FORM;
    this.form = mount.querySelector('.folio');
    this.loadingNotice = document.createElement('p');
    this.loadingNotice.textContent = '正在读取本地配置…';
    this.loadingNotice.setAttribute('role', 'status'); this.loadingNotice.hidden = true;
    mount.append(this.loadingNotice);
    this.$ = (id) => sh.getElementById(id);
    const chapterIcons = {translate:'translate',explain:'explain',archive:'folder',scope:'power'};
    for (const chapter of mount.querySelectorAll('.chapter')) {
      const name=chapter.id.replace('s-chapter-',''), summary=[...chapter.children].find(child=>child.tagName==='SUMMARY');
      const copy=document.createElement('span'); copy.className='chapter-copy'; copy.append(...summary.childNodes);
      summary.innerHTML=`<span class="chapter-icon">${icon(chapterIcons[name])}</span>`;
      summary.append(copy);
      const meta=document.createElement('span');meta.className='chapter-meta';
      meta.innerHTML=`<span class="chapter-state" id="s-state-${name}">待配置</span><span class="chapter-affordance"><span data-disclosure-label>展开</span>${icon('chevron-right')}</span>`;
      summary.append(meta);wireDisclosure(chapter,{bodyClass:'chapter-body'});
    }
    for(const disclosure of mount.querySelectorAll('.disclosure')) wireDisclosure(disclosure);
    if (options.standalone) this.$('s-chapter-scope').hidden = true;

    // 所有交互都过 guard：handler 里抛异常时，界面上必须看得见。
    // 起因是「点检测没反应」——我把 this.api 写成了 this.h.api，onclick 抛
    // TypeError 后一切静默，用户只看到按钮毫无反应，连个线索都没有。
    const on = (id, evt, fn) => { this.$(id)[evt] = this.guard(fn); };


    on('s-fetchModels', 'onclick', () => this.modelAction('s-fetchModels', '获取中…', () => this.fetchModels()));
    on('s-testModel', 'onclick', () => this.modelAction('s-testModel', '测试中…', () => this.testModel()));
    on('s-dismissToast', 'onclick', () => this.dismissToast());
    on('s-detectAgent', 'onclick', () => this.detectAgents(true));
    on('s-testAgent', 'onclick', () => this.testAgent());
    on('s-cancelAgentTest', 'onclick', () => this.cancelAgentTest());
    on('s-answerHelp', 'onclick', () => this.toggleAnswerHelp());
    this.form.addEventListener('keydown', event => {
      if(event.key==='Escape' && !this.$('s-answerHelpContent').hidden) {
        event.preventDefault();event.stopPropagation();this.toggleAnswerHelp(false);this.$('s-answerHelp').focus();
      }
    });
    on('s-exBackend', 'onchange', () => {
      if(this.agentWorking) this.cancelAgentTest();
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
      this.renderAgentState();
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
    on('s-reloadObsDir', 'onclick', () => this.busy('s-reloadObsDir', '探测中…', () => this.loadFolders('obsidian', true, true)));
    on('s-reloadMdDir', 'onclick', () => this.busy('s-reloadMdDir', '探测中…', () => this.loadFolders('markdown', true, true)));
    on('s-vault', 'onchange', async () => { this.$('s-vaultPath').value = ''; await this.loadFolders('obsidian'); this.refreshSummaries(); });
    for (const id of ['s-mdDir', 's-mdFolder', 's-mdFolderCustom', 's-obsFolder',
      's-obsFolderCustom', 's-vaultPath', 's-notebook', 's-path', 's-pathCustom']) {
      const el = this.$(id);
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => this.refreshSummaries());
    }
    for (const event of ['input', 'change']) mount.addEventListener(event, (e) => {
      if (e.target.matches('input,select')) this.markDirty();
      if (['s-provider', 's-model', 's-baseUrl', 's-apiKey'].includes(e.target.id)) {
        this.modelFeedback('s-modelStatus', '连接内容已修改，请重新测试。', null);
        this.$('s-modelPickWrap').hidden = true;
        this.refreshSummaries();
      }
    });
  }


  toggleAnswerHelp(open = this.$('s-answerHelpContent').hidden) {
    this.$('s-answerHelpContent').hidden = !open;
    this.$('s-answerHelp').setAttribute('aria-expanded', String(open));
  }

  // Read the companion's configuration-bound record, never localStorage. Older
  // companions omit it; checkService explains the missing cross-page support.
  applyConnectionChecks(checks, { model = true } = {}) {
    if (!checks) return;
    if (model) {
      const result=checks.model;
      this.modelTest=result && typeof result.ok==='boolean' && Number.isFinite(result.checkedAt)
        ? { ...result, fingerprint:JSON.stringify(this.modelDraft()) } : null;
      this.modelFeedback('s-modelStatus',this.modelTest ? `上次模型测试${result.ok ? '通过' : '未通过'} · ${checkTime(result.checkedAt)}。${result.ok ? '仅代表当时的连接结果，需要时可重新测试。' : '请检查模型服务与密钥后重新测试。'}` : '当前连接尚未测试。测试不会保存配置。',this.modelTest ? !result.ok : null);
    }
    this.agentTests=new Map();
    for(const [id,result] of Object.entries(checks.agents || {})) {
      if(typeof result?.ok!=='boolean' || !Number.isFinite(result.checkedAt)) continue;
      this.agentTests.set(id,{...result,message:`${this.agents?.find(a=>a.id===id)?.label || id} 上次连接测试${result.ok ? '通过' : '未通过'} · ${checkTime(result.checkedAt)}。${result.ok ? '仅验证当时的登录与模型回应，不代表工具或笔记权限。' : '请确认 CLI 登录与默认模型可用后重新测试。'}`});
    }
    this.renderAgentState();this.refreshSummaries();
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
        ? [this.$('s-vaultPath').value || this.$('s-vault').selectedOptions?.[0]?.textContent || this.$('s-vault').value,
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
    const modelReady = !!(this.$('s-model').value.trim() && (this.$('s-apiKey').value.trim() || this.cfg?.translate?.apiKeySet)
      && (this.$('s-provider').value === 'anthropic' || this.$('s-baseUrl').value.trim()));
    const tested = this.modelTest?.fingerprint === JSON.stringify(this.modelDraft());
    this.chapterState('translate', tested ? this.modelTest.ok ? '连接已通过' : '连接失败' : modelReady ? '已填写 · 待测试' : '待配置', tested ? this.modelTest.ok ? 'ok':'bad' : '');
    const result = this.agentTests?.get(this.$('s-agent').value);
    this.chapterState('explain', !isAgent ? '使用模型连接' : this.agentWorking ? '测试中' : result?.ok ? '连接已通过' : result ? '测试未通过' : selected?.available ? '已安装 · 待测试' : '待检测',
      isAgent && result ? result.ok ? 'ok' : 'bad' : '');
    this.chapterState('archive', destination ? '已选择位置' : '待配置');
    this.chapterState('scope', pageCount ? `${pageCount} 个已停用` : '当前可用');
    const dest = this.$('s-destination');
    dest.querySelector('strong').textContent = backendName;
    dest.querySelector('span').textContent = destination || '尚未选择位置';
  }

  chapterState(name, text, state = '') {
    const el=this.$(`s-state-${name}`); if(!el)return;
    el.textContent=text;el.dataset.state=state;
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

  async modelAction(id, label, fn) {
    if (this.modelWorking || this.saving || this.agentWorking) return;
    this.modelWorking = true;
    this.renderAgentState();
    const other = this.$(id === 's-fetchModels' ? 's-testModel' : 's-fetchModels');
    const save = this.$('s-save'), saveDisabled = save.disabled;
    other.disabled = true;
    save.disabled = true;
    try { return await this.busy(id, label, fn); }
    finally { other.disabled = false; save.disabled = saveDisabled; this.modelWorking = false; this.renderAgentState(); }
  }

  modelFeedback(id, text, bad = false) {
    const el = this.$(id);
    el.textContent = text;
    el.className = `hint model-feedback${text && bad !== null ? (bad ? ' bad' : ' ok') : ''}`;
    el.setAttribute('role', bad ? 'alert' : 'status');
  }

  async testModel() {
    this.modelFeedback('s-modelStatus', '正在验证模型，请稍候…', null);
    const draft = this.modelDraft();
    try {
      const result = await this.api.testModel(draft);
      if (result?.ok !== true || !result.model) throw new Error('本地服务返回的测试结果无效，请更新并重启配套服务后重试');
      const changed = JSON.stringify(draft) !== JSON.stringify(this.modelDraft());
      if(!changed) this.modelTest={ok:true,checkedAt:result.checkedAt || Date.now(),fingerprint:JSON.stringify(draft)};
      const text = changed ? `模型 ${result.model} 测试成功，但填写内容已变化，请重新测试。`
        : `模型连接成功：${result.model}。仅验证本次模型连接，不代表 Agent 已就绪；如有配置更改，请点击「保存更改」。`;
      this.modelFeedback('s-modelStatus', text, changed ? null : false);
      this.msg(text, false, { footer: false });
      this.refreshSummaries();
      return result;
    } catch (error) {
      this.modelTest={ok:false,fingerprint:JSON.stringify(draft)};
      const text = `测试失败：${describeError(error)}`;
      this.modelFeedback('s-modelStatus', text, true);
      this.msg(text, true, { footer: false });
      this.refreshSummaries();
    }
  }

  /** 选择只是修改草稿；保存规则与其余字段一致。 */
  async pickModel(name) {
    this.$('s-model').value = name;
    this.markDirty();
    this.refreshSummaries();
    this.modelFeedback('s-modelStatus', '模型已更改，请测试连接并保存。', null);
  }

  modelDraft() {
    const draft = { provider: this.$('s-provider').value, baseUrl: this.$('s-baseUrl').value.trim(), model: this.$('s-model').value.trim() };
    const key = this.$('s-apiKey').value.trim();
    if (key) draft.apiKey = key;
    return draft;
  }

  markDirty() {
    this.dirty = true;
    const el = this.$('s-msg');
    clearTimeout(this.messageTimer);
    el.textContent = '有未保存的更改';
    el.className = 'msg';
    el.setAttribute('role', 'status');
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

  msg(text, bad = false, { footer = true } = {}) {
    clearTimeout(this.messageTimer);
    this.dismissToast();
    const el = this.$('s-msg');
    if (footer) {
      el.textContent = text;
      el.className = `msg ${bad ? 'bad' : 'ok'}`;
      el.setAttribute('role', bad ? 'alert' : 'status');
    }
    if (text) {
      const toast = this.$('s-toast');
      this.$('s-toastText').textContent = text;
      toast.className = `settings-toast${bad ? ' bad' : ''}`;
      toast.hidden = false;
      this.toastTimer = setTimeout(() => this.dismissToast(), bad ? 10000 : 6000);
      this.toastTimer.unref?.();
    }
    // Setup failures must remain visible while the user fixes the input.
    if (footer && text && !bad) {
      this.messageTimer = setTimeout(() => { el.textContent = ''; }, 12000);
      this.messageTimer.unref?.();
    }
  }

  dismissToast() {
    clearTimeout(this.toastTimer);
    this.$('s-toast').hidden = true;
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
    if (b === 'obsidian' && !this._vaultsLoaded) this.loadVaults().then(() => this.loadFolders('obsidian'));
    if (b === 'markdown' && !this._mdLoaded) {
      this._mdLoaded = true; this.loadFolders('markdown');
    }
    if (b === 'siyuan' && !this._nbLoaded && this.cfg?.siyuan?.tokenSet) this.loadSiyuan();
  }

  async loadVaults(verbose = false) {
    const sel = this.$('s-vault');
    try {
      const { vaults } = await this.api.listVaults();
      this._vaultsLoaded = true;
      if (!vaults.length) {
        const saved = this.cfg?.obsidian?.vaultPath || '';
        sel.innerHTML = `<option value="${esc(saved)}">${saved ? esc(saved) : '（未探测到，请在下方手填根目录）'}</option>`;
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
  async loadFolders(backend, verbose = false) {
    const sel = this.$(backend === 'obsidian' ? 's-obsFolder' : 's-mdFolder');
    const want = backend === 'obsidian' ? this.cfg?.obsidian?.folder : this.cfg?.markdown?.folder;
    try {
      const draftRoot = backend === 'obsidian' ? this.$('s-vaultPath').value.trim() || this.$('s-vault').value : this.$('s-mdDir').value.trim();
      const savedRoot = backend === 'obsidian' ? this.cfg?.obsidian?.vaultPath : this.cfg?.markdown?.dir;
      if (draftRoot !== savedRoot) {
        if (verbose) this.msg('保存笔记位置后再探测子目录；也可直接填写子目录。', true);
        return;
      }
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
    if (this.dirty) return; // 收起再打开设置不丢弃尚未保存的内容。
    if (this.loading) return this.loading;
    this.form.hidden = true; this.loadingNotice.hidden = false;
    this.loading = this.loadConfig();
    try { return await this.loading; }
    finally { this.loading = null; this.form.hidden = false; this.loadingNotice.hidden = true; }
  }

  async loadConfig() {
    try {
      const c = await this.api.getConfig();
      if (this.dirty) return;
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
        : '填写你选择的模型服务所提供的 API key；不是上一步的本机配对码。';
      if (!this.chaptersInitialized) {
        this.$('s-translateAdvanced').open = !c.translate.apiKeySet || !c.translate.model || (c.translate.provider === 'openai' && !c.translate.baseUrl);
        this.$('s-chapter-translate').open = this.$('s-translateAdvanced').open;
        this.chaptersInitialized = true;
      }
      for(const el of this.sh.querySelectorAll('.chapter,.disclosure')) el.disclosure?.sync();

      this.$('s-backend').value = c.sync?.backend || 'markdown';
      this.$('s-mdDir').value = c.markdown?.dir || '';
      this.$('s-vaultPath').value = c.obsidian?.vaultPath || '';
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
      this.applyConnectionChecks(c.connectionChecks);
      this.refreshSummaries();
      this.checkService();
    } catch (e) {
      this.msg(`读取配置失败：${e.message}`, true);
    }
  }

  async loadSiyuan(verbose = false) {
    const sel = this.$('s-notebook');
    try {
      if (this.$('s-origin').value.trim() !== this.cfg?.siyuan?.origin || this.$('s-syToken').value.trim()) {
        if (verbose) this.msg('请先保存思源连接，再刷新笔记本。', true);
        return;
      }
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
    const legacy = full && this.preservesLegacyFull();
    const selected = this.agents?.find((a) => a.id === this.$('s-agent').value);
    const unsupported = selected?.safeSupport === 'unsupported';
    this.$('s-advanced').open = full || legacy || unsupported;
    this.$('s-legacyFull').classList.toggle('on', legacy);
    const alreadyAcknowledged = this.cfg?.agent?.profile === 'full' && this.cfg?.agent?.fullAccessAcknowledged
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
    if (this.detecting || this.agentWorking || this.saving) return;
    this.detecting = true;
    this.renderAgentState();
    this.modelFeedback('s-agentDiscoveryStatus','正在检测本机安装，不会调用模型…',null);
    try {
      const { agents, connectionChecks } = await this.api.detectAgents(verbose);
      if (!Array.isArray(agents)) throw new Error('服务未返回有效的安装列表，请更新配套服务');
      for(const id of this.agentTests?.keys() || []) {
        const before=this.agents?.find(a=>a.id===id) || this.agentTests.get(id),after=agents.find(a=>a.id===id);
        if(!after?.available || ['version','path'].some(key=>before[key]!==after[key]) || after.safeSupport==='unsupported') this.agentTests.delete(id);
      }
      this.agents = agents;
      this.syncAgentSel();
      this.applyConnectionChecks(connectionChecks,{model:false});
      const ok = agents.filter((a) => a.available);
      const text=ok.length ? `检测到 ${ok.length} 个已安装的 Agent：${ok.map(a=>a.label).join('、')}。安装不代表已登录，请选择后测试连接。`
        : '未检测到已安装的 Agent。请先安装 CLI，再点击「检测安装」；终端别名不会被本地服务识别。';
      this.modelFeedback('s-agentDiscoveryStatus',text,ok.length ? null : true);
      if (verbose) {
        this.msg(text,!ok.length,{footer:false});
      }
    } catch (e) {
      // 自动探测失败不该弹提示：服务没起时面板本来就会显示"离线"
      const text=`检测安装失败：${e.message}`;
      this.modelFeedback('s-agentDiscoveryStatus',text,true);
      if (verbose) this.msg(text, true,{footer:false});
    } finally { this.detecting=false;this.renderAgentState();this.refreshSummaries(); }
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
        : '<option value="">先检测安装，再选择 Agent</option>';
      sel.value = this.wantAgent || '';
      this.renderAgentState();
      return;
    }
    sel.innerHTML = '<option value="">选择要使用的 Agent</option>' + list.map((a) => `<option value="${esc(a.id)}"${a.available || a.id === this.wantAgent ? '' : ' disabled'}>`
      + `${esc(a.label)}${a.available ? ' · 已安装' : ' · 未安装'}</option>`).join('');
    if(this.wantAgent && !list.some(a=>a.id===this.wantAgent)) sel.insertAdjacentHTML('beforeend',`<option value="${esc(this.wantAgent)}">${esc(this.wantAgent)} · 未检测到</option>`);
    sel.value=this.wantAgent || '';
    this.renderAgentState();
    this.syncProfileUi();
    this.refreshSummaries();
  }

  renderAgentState() {
    const id=this.$('s-agent').value, selected=this.agents?.find(a=>a.id===id), result=this.agentTests?.get(id);
    this.$('s-agentName').textContent=selected?.label || id || '选择要使用的 Agent';
    this.$('s-agentInstalled').textContent=this.detecting ? '正在检测…' : selected ? selected.available ? '已找到可执行程序' : '未找到可执行程序' : '尚未检测';
    this.$('s-agentConnection').textContent=this.agentWorking ? '正在验证实际回答…' : result?.ok ? `已通过${result.checkedAt ? ` · ${checkTime(result.checkedAt)}` : ' · 登录与模型回应正常'}` : result ? result.canceled ? '已取消，可重新测试' : '未通过，请按下方提示处理' : '尚未测试 · 安装不等于可用';
    this.$('s-agentVersion').textContent=selected?.version ? `版本：${selected.version}` : '';
    const badge=this.$('s-agentReady');
    badge.textContent=this.agentWorking ? '测试中' : result?.ok ? '可用' : result ? result.canceled ? '已取消' : '需处理' : selected?.available ? '待测试' : '待检测';
    badge.dataset.state=result && !this.agentWorking ? result.ok ? 'ok' : result.canceled ? '' : 'bad' : '';
    const button=this.$('s-testAgent');
    const outdated=this.service?.agentTestSupported===false;
    button.disabled=this.saving || this.detecting || this.agentWorking || this.modelWorking || outdated || !selected?.available || selected?.safeSupport==='unsupported';
    button.setAttribute('aria-busy',String(!!this.agentWorking));
    button.textContent=this.agentWorking ? '测试中…' : '测试 Agent 连接';
    this.$('s-cancelAgentTest').hidden=!this.agentWorking;
    this.$('s-detectAgent').disabled=!!(this.detecting || this.agentWorking || this.saving);
    this.$('s-detectAgent').textContent=this.detecting ? '检测中…' : '检测安装';
    this.$('s-detectAgent').setAttribute('aria-busy',String(!!this.detecting));
    this.$('s-agent').disabled=!!this.agentWorking;
    if(!this.modelWorking) for(const id of ['s-fetchModels','s-testModel']) this.$(id).disabled=!!(this.agentWorking || this.saving);
    if(!this.agentWorking) this.modelFeedback('s-agentTestStatus',outdated ? '当前本地服务暂不支持 Agent 连接测试，请更新并重启配套服务。无需重新配对，已有配置保留。' : result?.message || (selected?.safeSupport==='unsupported'
      ? '此 Agent 暂不支持受限连接测试，不能安全验证。不会为测试自动开启完整权限，请改选支持安全档的 Agent。' : ''),result && !result.ok && !result.canceled ? true : result?.ok ? false : null);
  }

  async testAgent() {
    if(this.agentWorking || this.saving || this.detecting || this.modelWorking) return;
    const id=this.$('s-agent').value, selected=this.agents?.find(a=>a.id===id);
    if(!selected?.available) { this.modelFeedback('s-agentTestStatus','请先检测安装，并选择已安装的 Agent。',true);return; }
    this.agentWorking=true;
    const controller=this.agentController=new AbortController();
    this.$('s-save').disabled=true;
    this.renderAgentState();this.refreshSummaries();
    this.modelFeedback('s-agentTestStatus','正在提交固定短消息测试…',null);
    this.agentTests ??= new Map();
    try {
      const result=await this.api.testAgent(id,{signal:controller.signal,onProgress:job=>{
        if(!controller.signal.aborted) this.modelFeedback('s-agentTestStatus',job.queuedAhead ? `测试排队中，前面 ${job.queuedAhead} 个任务。可取消，不会重复提交。`
          : job.progress ? `${job.progress}${job.progress.includes('实际回答') ? '最多 45 秒，可随时取消。' : '可随时取消。'}` : '正在准备连接测试，可随时取消。',null);
      }});
      if(controller.signal.aborted) return;
      if(result?.ok!==true || result.agent!==id || result.scope!=='connection-only') throw new Error('测试结果无效，请更新并重启本地服务');
      const message=`${selected.label} 连接测试通过 · ${new Date(result.checkedAt || Date.now()).toLocaleTimeString('zh-CN',{hour12:false})}。认证与模型回应正常。`;
      this.agentTests.set(id,{ok:true,checkedAt:result.checkedAt || Date.now(),path:selected.path,version:selected.version,message}); this.msg(message,false,{footer:false});
    } catch(error) {
      if(controller.signal.aborted || error.code==='ABORTED') return;
      const message=`Agent 测试失败：${describeError(error)}`;
      this.agentTests.set(id,{ok:false,message}); this.msg(message,true,{footer:false});
    } finally {
      if(this.agentController===controller) {
        this.agentController=null;this.agentWorking=false;this.$('s-save').disabled=!!this.modelWorking;
        this.renderAgentState();this.refreshSummaries();
      }
    }
  }

  cancelAgentTest() {
    if(!this.agentWorking)return;
    const id=this.$('s-agent').value;
    this.agentController?.abort();this.agentController=null;this.agentWorking=false;
    this.agentTests ??= new Map();this.agentTests.set(id,{ok:false,canceled:true,message:'测试已取消，原配置与已有阅读记录保持不变。需要时可重新测试。'});
    this.$('s-save').disabled=!!this.modelWorking;
    this.renderAgentState();this.refreshSummaries();
  }

  async fetchModels() {
    // 先把当前填的 url/key/provider 存下来，否则拉的是旧配置对应的上游
    this.modelFeedback('s-modelListStatus', '正在获取可选模型，请稍候…', null);
    this.$('s-modelPickWrap').hidden = true;
    this.$('s-modelPick').innerHTML = '';
    try {
      const draft = this.modelDraft();
      const response = await this.api.listModels(draft);
      if (JSON.stringify(draft) !== JSON.stringify(this.modelDraft())) {
        this.modelFeedback('s-modelListStatus', '连接内容已变化，请重新获取模型。', null);
        return;
      }
      if (!Array.isArray(response?.models)) throw new Error('本地服务返回的模型列表无效，请更新并重启配套服务后重试');
      const models = [...new Set(response.models.filter((m) => typeof m === 'string').map((m) => m.trim()).filter(Boolean))];
      if (!models.length) {
        const text = '获取到 0 个模型，上游未返回可选列表；也可手动填写模型名称。';
        this.modelFeedback('s-modelListStatus', text, true);
        this.msg(text, true, { footer: false });
        return;
      }
      const pick = this.$('s-modelPick');
      pick.innerHTML = '<option value="">选择模型（不会自动保存）</option>' + models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      this.$('s-modelPickWrap').hidden = false;

      // 关键：填充后下拉默认选中第一项，但 change 事件只在**用户改变**选项时触发。
      // 不在这里主动同步，界面就会出现「下拉显示 A、输入框还是 B」，
      // 且用户点中那个已选项时 change 也不会触发，永远同步不上。
      const cur = this.$('s-model').value.trim();
      const hit = models.includes(cur);
      pick.value = hit ? cur : '';
      const text = `已获取到 ${models.length} 个模型。`
        + (!hit && cur ? `当前模型「${cur}」不在列表中，已保留，可继续手动使用。`
          : hit ? `当前模型「${cur}」已保留；切换模型后需保存更改。` : '请选择需要的模型，再保存更改。');
      this.modelFeedback('s-modelListStatus', text);
      this.msg(text, false, { footer: false });
    } catch (e) {
      const text = `获取模型失败：${describeError(e)}`;
      this.modelFeedback('s-modelListStatus', text, true);
      this.msg(text, true, { footer: false });
    }
  }

  preservesLegacyFull() {
    const previous = this.cfg?.agent;
    return previous?.profile === 'full' && previous.profileSource === 'legacy-migrated'
      && previous.id === this.$('s-agent').value.trim();
  }

  /** 收集表单 → PATCH。密钥留空即不提交该字段。 */
  patch() {
    const profile = this.$('s-profileFull').checked ? 'full' : 'safe';
    const agentId = this.$('s-agent').value.trim();
    const previous = this.cfg?.agent || {};
    const acknowledged = previous.fullAccessAcknowledged && previous.profile === 'full'
      && previous.id === agentId;
    let fullAccessAcknowledgement;
    if (profile === 'full' && !acknowledged && !this.preservesLegacyFull()) {
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
        chunkChars: this.$('s-chunkChars').value === '' ? 5000 : Math.max(0, Number(this.$('s-chunkChars').value) || 0),
      },
      explain: { backend: this.$('s-exBackend').value },
      agent: {
        id: agentId,
        notesDir: this.$('s-notesDir').value.trim(),
        profile,
        profileSource: profile === 'full' && this.preservesLegacyFull() ? 'legacy-migrated' : 'user',
        ...(fullAccessAcknowledgement ? { fullAccessAcknowledgement } : {}),
      },
      sync: { backend: this.$('s-backend').value },
      obsidian: {
        vaultPath: this.$('s-vaultPath').value.trim() || this.$('s-vault').value.trim(),
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
    const testedModel=this.modelTest?.fingerprint === JSON.stringify(this.modelDraft());
    this.cfg = await this.api.putConfig(this.patch());
    // 提交后清空密钥输入框，占位符改为「已配置」
    for (const [id, set] of [['s-apiKey', this.cfg.translate.apiKeySet], ['s-syToken', this.cfg.siyuan.tokenSet]]) {
      this.$(id).value = '';
      this.$(id).placeholder = set ? '已配置（留空不改）' : '未配置';
    }
    if(this.cfg.connectionChecks) this.applyConnectionChecks(this.cfg.connectionChecks);
    else if(testedModel) this.modelTest.fingerprint=JSON.stringify(this.modelDraft());
    this.refreshSummaries();
    this.onSaved?.(this.cfg);
    this.dirty = false;
    this.checkService();
    if (!silent) this.msg('已保存');
    return this.cfg;
  }

  async save() {
    if (this.saving || this.modelWorking || this.agentWorking) return;
    this.saving = true;
    const controls = [...this.sh.querySelectorAll('.folio input,.folio select,.folio button')].map(el => [el, el.disabled]);
    for (const [el] of controls) el.disabled = true;
    try { await this.persist(); if (this.$('s-backend').value === 'siyuan') await this.loadSiyuan(); }
    catch (e) { this.msg(`保存失败：${e.message}`, true); }
    finally { for (const [el, disabled] of controls) el.disabled = disabled; this.saving = false;this.renderAgentState(); }
  }

  async checkService() {
    if (!this.api.health) return;
    const check = this.serviceCheck = (this.serviceCheck || 0) + 1;
    const el = this.$('s-serviceStatus');
    try {
      const service = companionInfo(await this.api.health());
      if (this.serviceCheck !== check) return;
      this.service=service;this.renderAgentState();
      el.classList.toggle('bad', !service.modelDraftSupported);
      el.textContent = service.modelDraftSupported
        ? `本地服务 ${service.serviceVersion || ''} 已连接。模型${service.llmConfigured ? '已配置' : '尚未配齐'}。${service.connectionChecksSupported ? '连接测试记录在欢迎页与阅读页间共用。' : '当前服务不支持跨页面保留测试记录，请更新并重启配套服务；无需重新配对。'}获取与测试不会保存配置，修改后请点击「保存更改」。`
        : `本地服务 ${service.serviceVersion || '版本未知'} 需更新并重启，暂不支持当前模型测试。批注与导出不受影响；更新服务无需重新配对。`;
    } catch {
      if (this.serviceCheck !== check) return;
      el.classList.add('bad');
      el.textContent = '本地服务暂不可达，请检查连接。当前填写内容保留，不会自动保存。';
    }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const checkTime = time => new Date(time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const normPath = (p) => {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '') || '/';
};
