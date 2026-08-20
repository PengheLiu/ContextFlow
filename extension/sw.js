// Service worker：**唯一持有 token 的地方**。
//
// 这是扩展载体相对 userscript 的核心优势。userscript 跑在页面 MAIN world，
// 与页面共享 JS 堆，恶意页面理论上能在我方脚本之前 hook fetch 把 token 偷走 ——
// 所以那条路必须开 allowAnyOrigin，等于把唯一防线压在 token 上。
//
// 这里 fetch 发生在 service worker 里，页面碰不到 token，也拿不到这条通道。
// 于是服务端可以关掉 allowAnyOrigin、只白名单 `chrome-extension://<id>`：
// 「所有站点可用」与「白名单最强」第一次可以同时成立。
//
// content script 跑在 ISOLATED world（已实测 CSS.highlights 在那里能正常绘制），
// 所以页面既偷不到 token、也无法伪造发往这里的消息 —— chrome.runtime 通道对页面不可见。

const BASE = 'http://127.0.0.1:7317';

// 构建时由 tools/build.mjs 从 ~/.contextflow/config.json 注入。
// 注意：**只能注入到这个文件**。UI 侧 bundle 必须编译成空串，
// test/extbuild.test.mjs 会断言这一点。
const TOKEN = typeof __CONTEXTFLOW_TOKEN__ === 'string' ? __CONTEXTFLOW_TOKEN__ : '';

const HEADERS = {
  'Content-Type': 'application/json',
  // 安全模型的一半：强制预检。缺了它，Content-Type: text/plain 的简单 POST
  // 不走预检，就能绕过 CORS 往库里塞垃圾。
  'X-ContextFlow': '1',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/** 只放行本项目自己的路径，避免这条通道被当成任意 URL 的代理 */
const OK_PATH = /^\/(health|events|article|translate|explain|jobs|config|llm|agents|obsidian|fs|siyuan|sync)(\/|\?|$)/;

async function forward({ path, init }) {
  if (typeof path !== 'string' || !OK_PATH.test(path)) {
    return { status: 400, body: { error: `路径不被放行：${path}` } };
  }
  try {
    const res = await fetch(BASE + path, {
      method: init?.method || 'GET',
      body: init?.body,
      headers: { ...HEADERS, ...(init?.headers || {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    // 服务没起时给 0，客户端据此走 outbox —— 与 userscript 路径行为一致
    return { status: 0, body: { error: `本地服务不可达：${e.message}` } };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'cf-fetch') return false;
  forward(msg).then(reply);
  return true;                      // 异步 reply，必须返回 true
});

// 点扩展图标 = 打开/收起面板。content script 里监听同一个消息。
chrome.action?.onClicked?.addListener((tab) => {
  if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: 'cf-toggle' }).catch(() => {});
});
