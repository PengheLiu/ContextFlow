// 探针的 service worker：代 content script 发请求。
// 目的是看清两件事：SW 能不能连到本地服务，以及服务端看到的 Origin 是什么
// （403 的响应体会把它回显出来，那正是要写进 allowedOrigins 的字符串）。
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'probe-fetch') return false;
  fetch('http://127.0.0.1:7317/health', {
    headers: { 'X-ContextFlow': '1', 'Content-Type': 'application/json' },
  })
    .then(async (r) => reply({ ok: true, status: r.status, body: (await r.text()).slice(0, 300) }))
    .catch((e) => reply({ ok: false, error: String(e).slice(0, 200) }));
  return true;      // 异步 reply
});
