// ContextFlow 一次性探针 —— 判定 MV3 ISOLATED world 的能力边界。
//
// 要回答的核心问题：**在 ISOLATED world 注册的 CSS.highlights 会不会在页面上真的画出来？**
//   会   → 扩展做成「单个 ISOLATED 脚本 + service worker」：没有跨 world 的桥、
//          页面既偷不到 token 也伪造不了消息，最干净
//   不会 → UI 必须跑在 MAIN world，另加一个 ISOLATED 中继做 postMessage 桥接
//
// 这一项**只能靠眼睛**：`::highlight()` 是否绘制在 JS 里不可观测
// （没有 getComputedStyle(el, '::highlight(x)') 这种 API）。所以面板里放两句一模一样
// 的话：上面那句用 ISOLATED 注册的 ::highlight() 上色，下面那句用普通 <mark> 作对照。
// 两句看起来一样 → ISOLATED 可行。
//
// 品牌版 Chrome 拒绝 --load-extension（"is not allowed in Google Chrome"），
// 所以这个判定没法在命令行里自动跑，只能装一次看一眼。

(() => {
  if (document.documentElement.dataset.cfProbe) return;   // 防重复注入
  document.documentElement.dataset.cfProbe = '1';

  const checks = [];
  const add = (name, pass, note = '') => checks.push({ name, pass, note });

  // ---- 1. 确认真的在 ISOLATED world ----
  const hasRuntime = !!(typeof chrome !== 'undefined' && chrome.runtime?.id);
  add('chrome.runtime 可用（= 确实在 ISOLATED world）', hasRuntime,
    hasRuntime ? `id: ${chrome.runtime.id}` : '拿不到 → 可能被配成了 MAIN world');

  // ---- 2. 本项目依赖的几个 DOM 能力 ----
  add('CSS.highlights 存在', typeof CSS !== 'undefined' && !!CSS.highlights);
  add('Highlight 构造器存在', typeof Highlight === 'function');
  add('attachShadow（UI 隔离）', typeof Element.prototype.attachShadow === 'function');
  add('getSelection（划词）', typeof getSelection === 'function' && !!getSelection());
  add('MutationObserver（重锚触发）', typeof MutationObserver === 'function');
  add('caretPositionFromPoint 或 caretRangeFromPoint（高亮命中测试）',
    !!(document.caretPositionFromPoint || document.caretRangeFromPoint));
  add('localStorage（镜像 / outbox / 界面偏好）', (() => {
    try { localStorage.setItem('cf-probe', '1'); localStorage.removeItem('cf-probe'); return true; }
    catch { return false; }
  })());

  // ---- 3. 面板 ----
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647';
  document.documentElement.appendChild(host);
  const sh = host.attachShadow({ mode: 'open' });

  const SENT = 'ContextFlow 探针：这一行应当有底色';
  sh.innerHTML = `
    <style>
      :host{all:initial}
      .card{font:13px/1.6 -apple-system,"PingFang SC",sans-serif;color:#1c1a17;
            background:#fdfcf9;border:1px solid #e2ddd2;border-radius:10px;
            box-shadow:0 8px 28px -8px rgba(28,26,23,.28);width:420px;overflow:hidden}
      h1{margin:0;padding:9px 12px;font-size:12px;letter-spacing:.06em;
         background:#f4f1ea;border-bottom:1px solid #e9e4d9;color:#5b544a}
      ul{margin:0;padding:8px 12px;list-style:none}
      li{display:flex;gap:7px;padding:2px 0}
      .m{flex:0 0 auto;font-weight:700}
      .y{color:#1a7f37} .n{color:#b3261e}
      .nt{color:#8a8175;font-size:11.5px}
      .key{margin:6px 12px 10px;padding:9px 10px;background:#fff;border:1px dashed #d9d3c6;
           border-radius:8px}
      .key b{display:block;font-size:11.5px;color:#b45309;margin-bottom:6px}
      .row{padding:3px 0}
      .lbl{font-size:11px;color:#8a8175}
      /* 关键一项：ISOLATED world 注册的 highlight */
      ::highlight(cf-probe-hl){background:#ffd60a;color:#1c1a17}
      mark.ctl{background:#ffd60a;color:#1c1a17}
      .verdict{margin:0 12px 10px;padding:8px 10px;border-radius:8px;font-size:12px;
               background:#f4f1ea;color:#5b544a}
      code{font:11.5px ui-monospace,Menlo,monospace;background:#f0ece3;padding:1px 4px;
           border-radius:4px;word-break:break-all}
    </style>
    <div class="card">
      <h1>ContextFlow · MV3 能力探针</h1>
      <ul id="list"></ul>
      <div class="key">
        <b>关键一项：下面两行看起来一样吗？</b>
        <div class="row"><span class="lbl">A（ISOLATED 注册的 ::highlight）</span>
          <div id="hl">${SENT}</div></div>
        <div class="row"><span class="lbl">B（普通 mark，对照）</span>
          <div><mark class="ctl">${SENT}</mark></div>
      </div>
      <div class="verdict">
        A 有底色 → ISOLATED world 可以直接渲染高亮，扩展做成单脚本即可。<br>
        A 没底色 → 需要 MAIN world + 中继。<br>
        <span class="lbl">把这个面板截图给我就行。</span>
      </div>
    </div>`;

  const listEl = sh.getElementById('list');
  const paint = () => {
    listEl.innerHTML = checks.map((c) =>
      `<li><span class="m ${c.pass ? 'y' : 'n'}">${c.pass ? '✓' : '✕'}</span>`
      + `<span>${c.name}${c.note ? ` <span class="nt">— ${c.note}</span>` : ''}</span></li>`).join('');
  };
  paint();

  // ---- 4. 在 ISOLATED world 里注册 highlight，作用于面板内的 A 行 ----
  // 注意：range 取的是 shadow root 里的节点。若 shadow 内不生效，再退一步试页面正文。
  try {
    const target = sh.getElementById('hl');
    const r = new Range();
    r.selectNodeContents(target);
    CSS.highlights.set('cf-probe-hl', new Highlight(r));
    add('CSS.highlights.set() 未抛异常', CSS.highlights.has('cf-probe-hl'),
      `registry size: ${CSS.highlights.size}`);
  } catch (e) {
    add('CSS.highlights.set() 未抛异常', false, String(e).slice(0, 90));
  }
  paint();

  // ---- 5. 经 SW 打本地服务：看连通性与服务端看到的 Origin ----
  if (hasRuntime) {
    chrome.runtime.sendMessage({ type: 'probe-fetch' }, (res) => {
      if (chrome.runtime.lastError) {
        add('SW → 127.0.0.1:7317', false, chrome.runtime.lastError.message);
      } else if (!res?.ok) {
        add('SW → 127.0.0.1:7317', false, res?.error || '未知错误');
      } else {
        // 403 也是有用信息：服务端拒绝时会说明它看到的 Origin，那就是要写进白名单的串
        add(`SW → 127.0.0.1:7317（HTTP ${res.status}）`, res.status === 200,
          res.status === 200 ? '服务已放行' : res.body);
      }
      add('要写进 allowedOrigins 的串', true, `chrome-extension://${chrome.runtime.id}`);
      paint();
    });
  }
})();
