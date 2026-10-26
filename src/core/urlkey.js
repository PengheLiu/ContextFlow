// 文章的稳定身份：同一篇文章无论从哪个入口打开，urlKey 必须一致，
// 高亮 / 翻译 / 解释才能汇进同一条事件流。
//
// 落在这个共享模块里而不是 main.js，是因为它有两个消费方：App（事件归属）
// 与停用名单（blocklist.js，按页面粒度屏蔽）。放 main.js 会让后者反向依赖前者，
// 形成"入口 ↔ 功能"的循环引用。
const webURL = (href) => {
  try {
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
};
const articleKey = (key) => /^https?:\/\//.test(String(key || '')) || /^arxiv:\d{4}\.\d{4,5}$/.test(String(key || ''));

// Only fragment routers carry article identity. A normal #section or text
// fragment still points into the same document; hash / hashbang routes do not.
const routeFragment = (hash) => /^#!?\//.test(hash) ? hash : '';

export function urlKey(href = globalThis.location?.href || '') {
  if (/^arxiv:\d{4}\.\d{4,5}$/.test(String(href))) return href;
  const u = webURL(href);
  if (!u) return href;
  const m = u.pathname.match(/\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/);
  if (/(^|\.)arxiv\.org$/.test(u.hostname) && m) return `arxiv:${m[1]}`;
  for (const p of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref|spm|from)/.test(p)) u.searchParams.delete(p);
  }
  // URL already normalizes the scheme/host. Paths, query names/values and
  // application routes are case-sensitive and must not be lowercased.
  return u.origin + u.pathname.replace(/\/+$/, '') + u.search + routeFragment(u.hash);
}

/** Exact pre-v2 key, retained only as an alias for evidence-based migration. */
export function legacyUrlKey(href = globalThis.location?.href || '') {
  if (/^arxiv:\d{4}\.\d{4,5}$/.test(String(href))) return href;
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

export function articleIdentity(href = globalThis.location?.href || '') {
  return { key: urlKey(href), legacyKey: legacyUrlKey(href), url: webURL(href)?.href || '' };
}

/**
 * An old URL key may contain several articles. Only the original URL is proof
 * of which article owns an event. Missing/invalid URLs and custom integrations'
 * opaque keys are preserved, never assigned to a guessed case variant.
 */
export function eventIdentityKey(event) {
  const key = String(event?.urlKey || '');
  return articleKey(key) && webURL(event?.url) ? urlKey(event.url) : key;
}

export function canonicalEventIdentity(event) {
  const key = eventIdentityKey(event);
  return key && key !== event?.urlKey ? { ...event, urlKey: key } : event;
}

/** Pure plan: callers apply all moves in one transaction, including outbox. */
export function planArticleIdentityMigration(events, requested = null) {
  const identity = typeof requested === 'string' ? articleIdentity(requested) : requested;
  const byId = new Map(), target = new Map(), evidence = new Set(), blocked = new Set();
  for (const event of events) {
    const rows = byId.get(event.id) || []; rows.push(event); byId.set(event.id, rows);
    const key = eventIdentityKey(event); target.set(event, key);
    if (articleKey(event.urlKey) && webURL(event.url)) evidence.add(event);
  }
  // Event IDs are global on the service. Duplicate IDs must never be silently
  // coalesced during a URL repair, even if their compound IDB keys differ.
  for (const rows of byId.values()) if (rows.length > 1) for (const event of rows) blocked.add(event);
  const children = new Map();
  for (const event of events) if (event.action === 'comment' && event.parentId) {
    const rows = children.get(event.parentId) || []; rows.push(event); children.set(event.parentId, rows);
  }
  // A unique explicit parent link is evidence too. A URL-less highlight can
  // follow its children only when every child with a URL agrees; conflicts
  // stay untouched rather than separating a parent/child pair by guesswork.
  for (const [parentId, rows] of children) {
    const parents = byId.get(parentId);
    if (parents?.length !== 1) { for (const child of rows) blocked.add(child); continue; }
    const parent = parents[0];
    if (blocked.has(parent)) { for (const child of rows) blocked.add(child); continue; }
    if (!evidence.has(parent) && articleKey(parent.urlKey)) {
      const known = rows.filter(child => evidence.has(child) && child.urlKey === parent.urlKey);
      const keys = new Set(known.map(child => target.get(child)));
      if (keys.size === 1) { target.set(parent, [...keys][0]); evidence.add(parent); }
      else if (keys.size > 1) { blocked.add(parent); for (const child of rows) blocked.add(child); }
    }
  }
  for (const event of events) {
    if (!event.parentId || event.action !== 'comment') continue;
    if (blocked.has(event)) continue;
    const parent = byId.get(event.parentId)?.length === 1 ? byId.get(event.parentId)[0] : null;
    if (!parent || blocked.has(parent) || !evidence.has(parent)) continue;
    if (!evidence.has(event) && event.urlKey === parent.urlKey && articleKey(event.urlKey)) {
      target.set(event, target.get(parent)); evidence.add(event);
    } else if (evidence.has(event) && target.get(event) !== target.get(parent)) {
      blocked.add(parent); blocked.add(event);
    }
  }
  for (const event of events) if (event.parentId && byId.get(event.parentId)?.some(parent => blocked.has(parent))) blocked.add(event);
  const relevant = event => !identity || event.urlKey === identity.key || event.urlKey === identity.legacyKey || target.get(event) === identity.key;
  const moves = [], ambiguous = [], groups = new Map();
  for (const event of events) {
    if (!relevant(event)) continue;
    const to = target.get(event);
    if (!groups.has(event.urlKey)) groups.set(event.urlKey, { key: event.urlKey, targets: new Set(), ambiguous: false });
    const group = groups.get(event.urlKey);
    if (blocked.has(event) || articleKey(event.urlKey) && !evidence.has(event)) {
      ambiguous.push({ id: event.id, urlKey: event.urlKey, reason: blocked.has(event) ? 'conflicting-identity' : 'missing-original-url' }); group.ambiguous = true;
    } else {
      group.targets.add(to);
      if (to !== event.urlKey && evidence.has(event)) moves.push({ event, from: event.urlKey, to });
    }
  }
  return { moves, ambiguous, groups: [...groups.values()].map(group => ({ ...group, targets: [...group.targets] })) };
}
