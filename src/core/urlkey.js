// 文章的稳定身份：同一篇文章无论从哪个入口打开，urlKey 必须一致，
// 高亮 / 翻译 / 解释才能汇进同一条事件流。
//
// 落在这个共享模块里而不是 main.js，是因为它有两个消费方：App（事件归属）
// 与停用名单（blocklist.js，按页面粒度屏蔽）。放 main.js 会让后者反向依赖前者，
// 形成"入口 ↔ 功能"的循环引用。
export function urlKey(href = location.href) {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/);
    if (/(^|\.)arxiv\.org$/.test(u.hostname) && m) return `arxiv:${m[1]}`;
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|spm|from)/.test(p)) u.searchParams.delete(p);
    }
    u.hash = '';
    return (u.origin + u.pathname.replace(/\/+$/, '') + (u.search || '')).toLowerCase();
  } catch { return href; }
}
