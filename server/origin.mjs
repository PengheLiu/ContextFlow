// CORS origin 白名单匹配。
//
// 单独成文件是为了让**实现与测试共用同一份**。此前 test/origin.test.mjs 抄了一份
// 一模一样的逻辑，那意味着"改了实现但忘了改测试"时测试照样全绿 ——
// 而这里是主防线（DESIGN.md §0），放宽了任何网页都能读写全部阅读记录。

/** 正则元字符转义，用于把白名单里的字面量拼进正则 */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 合法 Origin 只可能是 scheme://host[:port] —— 没有路径、没有 query、没有 fragment。
// 先按形状卡一道，从结构上堵死 'https://evil.com#.github.io' 这类混淆匹配。
export const ORIGIN_RE = /^https?:\/\/[a-z0-9._-]+(:\d{1,5})?$/i;

// 浏览器扩展的 Origin。**扩展路线的价值就在这一条**：token 在 service worker 里、
// 页面碰不到，所以可以关掉 allowAnyOrigin、只白名单一个扩展 id ——
// 「所有站点可用」与「白名单最强」第一次同时成立。
//
// id 是 32 位、字母表恰好是 a–p（SHA-256 前 16 字节按半字节映射而来），
// 卡死这个形状，'chrome-extension://evil' 之类过不来。
export const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

/**
 * `*` 只代表**单个 host 段**（不含 . / :），因此
 *   'https://*.github.io'  匹配 https://lph.github.io
 *                          不匹配 https://a.b.github.io（多段）
 *                          不匹配 https://evil.com#.github.io（形状校验已拦）
 * 这也让 'https://*' 无法再充当「放开全网」的暗门 —— 那件事必须显式设 allowAnyOrigin。
 *
 * @param {{allowAnyOrigin?:boolean, allowedOrigins?:string[]}} cfg
 */
export function originAllowed(cfg, origin) {
  if (cfg?.allowAnyOrigin) return true;
  const list = cfg?.allowedOrigins || [];

  // 扩展 origin 必须**精确匹配**，不参与 * 通配 —— 'chrome-extension://*' 一旦
  // 被当成通配就等于放行任意扩展，那正是这条路线要避免的
  if (EXT_ORIGIN_RE.test(origin)) return list.includes(origin);

  if (!ORIGIN_RE.test(origin)) return false;
  return list.some((p) => {
    if (p === origin) return true;
    if (!p.includes('*')) return false;
    // 扩展 id 不允许被通配，所以带 * 的模式一律不作用于 chrome-extension://
    if (p.startsWith('chrome-extension://')) return false;
    return new RegExp(`^${p.split('*').map(escapeRe).join('[^./:]*')}$`).test(origin);
  });
}
