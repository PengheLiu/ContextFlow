// 浏览器端离线事实库：事件与待发送操作在同一个 IndexedDB 事务里提交。
// localStorage 只保留迁移兼容与小型 UI 偏好，不再承担并发写入正确性。
import { referencedAssets, MAX_BACKUP_BYTES } from './reading-library.js';

const DB_NAME = 'contextflow-offline';
const DB_VERSION = 4;
const LEASE_MS = 30_000;
const ARTICLE_MAX_CHARS = 400_000;
const ARTICLE_MAX_COUNT = 12;
const ARTICLE_MAX_BYTES = 8 * 1024 * 1024;
const ASSET_MAX_BYTES = 8 * 1024 * 1024;
const ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const now = () => Date.now();
const uid = () => globalThis.crypto?.randomUUID?.()
  || `${now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let dbPromise;
let offlineTransport;

export function setOfflineTransport(transport) {
  offlineTransport = transport;
}
const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
});

export function available() { return !!offlineTransport || typeof indexedDB !== 'undefined'; }

export function openOfflineStore() {
  if (offlineTransport) throw new Error('扩展数据必须通过私有存储通道访问');
  if (!available()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (event) => {
      const db = r.result;
      if (!db.objectStoreNames.contains('events')) {
        const events = db.createObjectStore('events', { keyPath: ['urlKey', 'id'] });
        events.createIndex('urlKey', 'urlKey'); events.createIndex('action', 'action');
        events.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('operations')) {
        const ops = db.createObjectStore('operations', { keyPath: 'opId' });
        ops.createIndex('state', 'state'); ops.createIndex('coalesceKey', 'coalesceKey', { unique: true });
        ops.createIndex('leaseUntil', 'leaseUntil'); ops.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('articles')) {
        const articles = db.createObjectStore('articles', { keyPath: 'urlKey' });
        articles.createIndex('lastUsedAt', 'lastUsedAt'); articles.createIndex('byteLength', 'byteLength');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('targets')) db.createObjectStore('targets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fileArticles')) {
        db.createObjectStore('fileArticles', { keyPath: ['targetId', 'urlKey'] });
      }
      if (event.oldVersion < 3 && db.objectStoreNames.contains('fileEvents')) db.deleteObjectStore('fileEvents');
      if (!db.objectStoreNames.contains('fileEvents')) {
        db.createObjectStore('fileEvents', { keyPath: ['targetId', 'urlKey', 'eventId'] });
      }
      if (!db.objectStoreNames.contains('assets')) {
        const assets = db.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('uploadedAt', 'uploadedAt'); assets.createIndex('createdAt', 'createdAt');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

export function mutationStamp(event, { deleted = false, at = now(), mutationId = uid() } = {}) {
  return {
    ...event,
    updatedAt: Math.max(Number(event?.updatedAt) || 0, at),
    mutationId,
    ...(deleted ? { deletedAt: Number(event?.deletedAt) || at } : {}),
  };
}

const opFor = (event, kind = event.deletedAt ? 'delete' : 'upsert') => ({
  version: 1,
  opId: uid(),
  kind,
  coalesceKey: `event:${event.id}`,
  urlKey: event.urlKey,
  entityId: event.id,
  payload: event,
  createdAt: now(),
  updatedAt: event.updatedAt || now(),
  state: 'queued',
  attempts: 0,
  lastError: '',
  leaseUntil: 0,
  lease: null,
});

/** 保存事件并按 id 合并出站操作；delete 覆盖更早的 upsert。 */
export async function saveOfflineEvents(events, { queue = true } = {}) {
  if (offlineTransport) return offlineTransport('saveOfflineEvents', [events, { queue }]);
  const db = await openOfflineStore();
  if (!db || !events?.length) return events || [];
  const tx = db.transaction(['events', 'operations'], 'readwrite');
  const es = tx.objectStore('events');
  const os = tx.objectStore('operations');
  const oi = os.index('coalesceKey');
  for (const raw of events) {
    const event = raw.updatedAt && raw.mutationId ? raw : mutationStamp(raw);
    es.put(event);
    if (!queue) continue;
    const key = `event:${event.id}`;
    const old = await req(oi.get(key));
    // 正在发送的批次不能原地改写，否则旧 lease 成功后会删掉新操作。
    // 改用新的 op；unique index 需要先移除旧 key，因此 sending 操作解除 coalesce。
    if (old?.state === 'sending') {
      old.coalesceKey = `sending:${old.opId}`;
      os.put(old);
    } else if (old) {
      os.delete(old.opId);
    }
    os.put(opFor(event));
  }
  await done(tx);
  return events;
}

export async function tombstoneOfflineEvents(events) {
  if (offlineTransport) return offlineTransport('tombstoneOfflineEvents', [events]);
  const stamped = events.map((e) => mutationStamp(e, { deleted: true }));
  await saveOfflineEvents(stamped);
  return stamped;
}

export async function listOfflineEvents(urlKey, { includeDeleted = false } = {}) {
  if (offlineTransport) return offlineTransport('listOfflineEvents', [urlKey, { includeDeleted }]);
  const db = await openOfflineStore();
  if (!db) return [];
  const tx = db.transaction('events', 'readonly');
  const rows = await req(tx.objectStore('events').index('urlKey').getAll(urlKey));
  await done(tx);
  return includeDeleted ? rows : rows.filter((e) => !e.deletedAt);
}

// Only trusted extension pages call these directly. They are deliberately NOT
// included in the content-script RPC allowlist: a reading page has no need to
// request an entire cross-site library or restore an archive.
export async function readingLibrarySnapshot({ withAssets = false } = {}) {
  const db=await openOfflineStore();
  if(!db)throw new Error('浏览器私有存储不可用');
  const tx=db.transaction(['events','assets'],'readonly');
  const events=await req(tx.objectStore('events').getAll()),assets=[];
  if(withAssets) {
    const live=events.filter(e=>!e.deletedAt);
    let bytes=new Blob([JSON.stringify(live)]).size;
    if(bytes>MAX_BACKUP_BYTES)throw new Error('完整备份超过 32 MB 安全上限，请先按文章导出 Markdown；原记录不受影响');
    for(const id of referencedAssets(live)) {
      const asset=await req(tx.objectStore('assets').get(id));
      bytes+=Math.ceil((asset?.blob?.size || 0)/3)*4;
      if(bytes>MAX_BACKUP_BYTES)throw new Error('完整备份超过 32 MB 安全上限，请先按文章导出 Markdown；原记录不受影响');
      if(asset)assets.push(asset);
    }
  }
  await done(tx);
  return {events,assets};
}

// Trusted extension pages only. Counts never include URLs, event contents,
// queue errors or image names; do not expose this via the web-page RPC bridge.
export async function offlineStorageStats() {
  const db = await openOfflineStore();
  if (!db) throw new Error('私有存储不可用');
  const tx = db.transaction(['events', 'operations', 'assets'], 'readonly');
  const complete = done(tx);
  const counts = await Promise.all(['events', 'operations', 'assets'].map(name => req(tx.objectStore(name).count())));
  await complete;
  return { storedRows: counts[0], pendingOperations: counts[1], images: counts[2] };
}

/** Add missing entities only; even local tombstones win. All writes are atomic.
 * The caller must fully validate the untrusted file before opening this tx. */
export async function restoreReadingLibrary({ events, assets }) {
  const db=await openOfflineStore();
  if(!db)throw new Error('浏览器私有存储不可用');
  const tx=db.transaction(['events','assets','operations'],'readwrite');
  const completed=done(tx),es=tx.objectStore('events'),as=tx.objectStore('assets'),os=tx.objectStore('operations');
  let added=0,skipped=0;
  try {
    // Existing IDs (including a different urlKey) must never be duplicated in
    // the service's global event id space or in the unique operation index.
    const existing=await req(es.getAll()),ids=new Set(existing.map(e=>e.id));
    const deleted=new Set(existing.filter(e=>e.deletedAt).map(e=>e.id));
    for(const event of events) {
      if(ids.has(event.id) || (event.parentId && deleted.has(event.parentId))) { skipped++;continue; }
      const stamped=event.updatedAt && event.mutationId ? event : mutationStamp(event);
      es.add(stamped);os.put(opFor(stamped));ids.add(event.id);added++;
    }
    for(const asset of assets)if(!await req(as.get(asset.id)))as.add({...asset,uploadedAt:0});
    await completed;return {added,skipped};
  } catch(error) { try{tx.abort();}catch{} await completed.catch(()=>{});throw error; }
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, '0')).join('');

/** 图片 Blob 独立于事件保存；事件正文里只出现 64 位内容哈希。 */
export async function saveOfflineAsset(file, over = {}) {
  if (offlineTransport) return offlineTransport('saveOfflineAsset', [file, { name: file?.name, ...over }]);
  const mime = String(over.mime || file?.type || '').toLowerCase();
  if (!ASSET_TYPES.has(mime)) throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
  const source = file instanceof Blob ? file : new Blob([file], { type: mime });
  if (!source.size) throw new Error('图片内容为空');
  if (source.size > ASSET_MAX_BYTES) throw new Error('图片不能超过 8 MB');
  const bytes = await source.arrayBuffer();
  if (!globalThis.crypto?.subtle) throw new Error('当前页面无法计算图片指纹');
  const id = hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const db = await openOfflineStore();
  const row = {
    id, mime, size: source.size, name: String(over.name || file?.name || 'image'),
    blob: new Blob([bytes], { type: mime }), createdAt: Number(over.createdAt) || now(),
    uploadedAt: Number(over.uploadedAt) || 0,
  };
  if (!db) return row;
  const tx = db.transaction('assets', 'readwrite'), os = tx.objectStore('assets');
  const old = await req(os.get(id));
  if (old?.uploadedAt) row.uploadedAt = old.uploadedAt;
  os.put(row); await done(tx);
  return row;
}

export async function getOfflineAsset(id) {
  if (offlineTransport) return offlineTransport('getOfflineAsset', [id]);
  const db = await openOfflineStore();
  if (!db) return null;
  const tx = db.transaction('assets', 'readonly');
  const row = await req(tx.objectStore('assets').get(id)); await done(tx);
  return row || null;
}

export async function listPendingAssets(limit = 20) {
  if (offlineTransport) return offlineTransport('listPendingAssets', [limit]);
  const db = await openOfflineStore();
  if (!db) return [];
  const tx = db.transaction('assets', 'readonly');
  const rows = await req(tx.objectStore('assets').getAll()); await done(tx);
  return rows.filter((row) => !row.uploadedAt).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
}

export async function markOfflineAssetUploaded(id, at = now()) {
  if (offlineTransport) return offlineTransport('markOfflineAssetUploaded', [id, at]);
  const db = await openOfflineStore();
  if (!db) return;
  const tx = db.transaction('assets', 'readwrite'), os = tx.objectStore('assets');
  const row = await req(os.get(id));
  if (row) os.put({ ...row, uploadedAt: at });
  await done(tx);
}

/** 原子 claim；多个 tab 最多各拿到不同操作。 */
export async function claimOperations(owner, limit = 100, leaseMs = LEASE_MS) {
  if (offlineTransport) return offlineTransport('claimOperations', [owner, limit, leaseMs]);
  const db = await openOfflineStore();
  if (!db) return [];
  const tx = db.transaction('operations', 'readwrite');
  const os = tx.objectStore('operations');
  const rows = await req(os.getAll());
  const at = now(), claimed = [];
  for (const op of rows.sort((a, b) => a.createdAt - b.createdAt)) {
    if (claimed.length >= limit) break;
    if (op.state === 'deferred' || op.state === 'ready') continue;
    if (op.state === 'sending' && op.leaseUntil > at) continue;
    const token = uid();
    const next = { ...op, state: 'sending', leaseUntil: at + leaseMs,
      lease: { owner, token, until: at + leaseMs } };
    os.put(next); claimed.push(next);
  }
  await done(tx);
  return claimed;
}

export async function acknowledgeOperations(claimed) {
  if (offlineTransport) return offlineTransport('acknowledgeOperations', [claimed]);
  const db = await openOfflineStore();
  if (!db || !claimed.length) return;
  const tx = db.transaction('operations', 'readwrite');
  const os = tx.objectStore('operations');
  for (const sent of claimed) {
    const cur = await req(os.get(sent.opId));
    if (cur?.lease?.token === sent.lease?.token) os.delete(sent.opId);
  }
  await done(tx);
}

export async function releaseOperations(claimed, error) {
  if (offlineTransport) return offlineTransport('releaseOperations', [claimed, String(error?.message || error || '')]);
  const db = await openOfflineStore();
  if (!db || !claimed.length) return;
  const tx = db.transaction('operations', 'readwrite');
  const os = tx.objectStore('operations');
  for (const sent of claimed) {
    const cur = await req(os.get(sent.opId));
    if (cur?.lease?.token !== sent.lease?.token) continue;
    os.put({ ...cur, state: 'queued', attempts: (cur.attempts || 0) + 1,
      lastError: String(error?.message || error || ''), leaseUntil: 0, lease: null });
  }
  await done(tx);
}

export async function operationCount(urlKey) {
  if (offlineTransport) return offlineTransport('operationCount', [urlKey]);
  const db = await openOfflineStore();
  if (!db) return 0;
  const tx = db.transaction('operations', 'readonly');
  const rows = await req(tx.objectStore('operations').getAll());
  await done(tx);
  return rows.filter((o) => !urlKey || o.urlKey === urlKey).length;
}

/** 远端结果（含 tombstone）写回本地，但不产生出站操作。 */
export async function applyRemoteEvents(events) {
  if (offlineTransport) return offlineTransport('applyRemoteEvents', [events]);
  const db = await openOfflineStore();
  if (!db || !events?.length) return;
  const tx = db.transaction('events', 'readwrite');
  const os = tx.objectStore('events');
  for (const e of events) {
    const old = await req(os.get([e.urlKey, e.id]));
    if (!old || compareMutation(e, old) >= 0) os.put(e);
  }
  await done(tx);
}

export function compareMutation(a, b) {
  const ta = Number(a?.updatedAt || a?.createdAt || 0);
  const tb = Number(b?.updatedAt || b?.createdAt || 0);
  if (ta !== tb) return ta - tb;
  const da = a?.deletedAt ? 1 : 0, db = b?.deletedAt ? 1 : 0;
  if (da !== db) return da - db; // 同时间 delete wins
  return String(a?.mutationId || '').localeCompare(String(b?.mutationId || ''));
}

const textHash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 0x01000193) >>> 0;
  return `${s.length}:${h.toString(16)}`;
};

/** 正文只存在浏览器本地，供公开userscript的 LLMBridge 上下文使用。 */
export async function putOfflineArticle({ urlKey, title = '', url = '', text = '' }) {
  if (offlineTransport) return offlineTransport('putOfflineArticle', [{ urlKey, title, url, text }]);
  const db = await openOfflineStore();
  const raw = String(text || '');
  const body = raw.slice(0, ARTICLE_MAX_CHARS);
  const hash = textHash(body);
  if (!db) return { hash, changed: false, chars: body.length, truncated: raw.length > body.length };
  const tx = db.transaction('articles', 'readwrite');
  const os = tx.objectStore('articles');
  const old = await req(os.get(urlKey));
  const at = now();
  const row = {
    urlKey, title, url, text: body, hash, byteLength: new Blob([body]).size,
    originalChars: raw.length, storedChars: body.length, truncated: raw.length > body.length,
    updatedAt: old?.hash === hash ? old.updatedAt : at, lastUsedAt: at,
  };
  os.put(row);
  await done(tx);
  await pruneOfflineArticles(urlKey);
  return { hash, changed: old?.hash !== hash, chars: body.length, truncated: raw.length > body.length };
}

export async function getOfflineArticle(urlKey) {
  if (offlineTransport) return offlineTransport('getOfflineArticle', [urlKey]);
  const db = await openOfflineStore();
  if (!db) return null;
  const tx = db.transaction('articles', 'readwrite');
  const os = tx.objectStore('articles');
  const row = await req(os.get(urlKey));
  if (row) { row.lastUsedAt = now(); os.put(row); }
  await done(tx);
  return row || null;
}

async function pruneOfflineArticles(protect) {
  const db = await openOfflineStore();
  if (!db) return;
  const tx = db.transaction('articles', 'readwrite');
  const os = tx.objectStore('articles');
  const rows = await req(os.getAll());
  let bytes = rows.reduce((n, x) => n + (x.byteLength || 0), 0), count = rows.length;
  for (const row of rows.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))) {
    if ((count <= ARTICLE_MAX_COUNT && bytes <= ARTICLE_MAX_BYTES) || row.urlKey === protect) continue;
    os.delete(row.urlKey); count--; bytes -= row.byteLength || 0;
  }
  await done(tx);
}

export async function saveFileTarget(target) {
  const db = await openOfflineStore(); if (!db) return null;
  const tx = db.transaction('targets', 'readwrite');
  tx.objectStore('targets').put({ ...target, updatedAt: now() }); await done(tx);
  return target;
}
export async function getFileTarget(id = 'default', origin = globalThis.location?.origin || '') {
  const db = await openOfflineStore(); if (!db) return null;
  const tx = db.transaction('targets', 'readonly');
  const row = await req(tx.objectStore('targets').get(id)); await done(tx);
  return row && (!origin || row.origin === origin) ? row : null;
}
/**
 * 把一个 target（含其 fileArticles / fileEvents）整体搬到新 id 下。
 * 用于双目录（Obsidian / Markdown 各记一个授权）从旧单目录迁移：旧数据
 * 原地改 targetId，不留孤儿行，也不需要逐条重建。
 */
export async function moveFileTarget(fromId, target) {
  const db = await openOfflineStore();
  if (!db) return null;
  const tx = db.transaction(['targets', 'fileArticles', 'fileEvents'], 'readwrite');
  const targets = tx.objectStore('targets'), articles = tx.objectStore('fileArticles'),
    events = tx.objectStore('fileEvents');
  const articleRows = articles.getAll(), eventRows = events.getAll();
  targets.put({ ...target, updatedAt: now() });
  targets.delete(fromId);
  for (const row of await req(articleRows)) {
    if (row.targetId !== fromId) continue;
    articles.delete([fromId, row.urlKey]);
    articles.put({ ...row, targetId: target.id });
  }
  for (const row of await req(eventRows)) {
    if (row.targetId !== fromId) continue;
    events.delete([fromId, row.urlKey, row.eventId]);
    events.put({ ...row, targetId: target.id });
  }
  await done(tx);
  return target;
}

export async function forgetFileTarget(id = 'default') {
  const db = await openOfflineStore(); if (!db) return;
  const tx = db.transaction(['targets', 'fileArticles', 'fileEvents'], 'readwrite');
  tx.objectStore('targets').delete(id);
  for (const row of await req(tx.objectStore('fileArticles').getAll())) if (row.targetId === id) tx.objectStore('fileArticles').delete([id, row.urlKey]);
  for (const row of await req(tx.objectStore('fileEvents').getAll())) if (row.targetId === id) tx.objectStore('fileEvents').delete([id, row.urlKey, row.eventId]);
  await done(tx);
}
export async function getFileArticle(targetId, urlKey) {
  const db = await openOfflineStore(); if (!db) return null;
  const tx = db.transaction('fileArticles', 'readonly');
  const row = await req(tx.objectStore('fileArticles').get([targetId, urlKey])); await done(tx); return row || null;
}
export async function saveFileArticle(row) {
  const db = await openOfflineStore(); if (!db) return;
  const tx = db.transaction('fileArticles', 'readwrite'); tx.objectStore('fileArticles').put(row); await done(tx);
}
export async function getFileEventStates(targetId, urlKey) {
  const db = await openOfflineStore(); if (!db) return [];
  const tx = db.transaction('fileEvents', 'readonly'); const rows = await req(tx.objectStore('fileEvents').getAll()); await done(tx);
  return rows.filter((x) => x.targetId === targetId && (!urlKey || x.urlKey === urlKey));
}
/** 成功写盘后原子替换该文章的同步状态，退休已处理的 tombstone/冲突。 */
export async function replaceFileEventStates(targetId, urlKey, states) {
  const db = await openOfflineStore(); if (!db) return;
  const tx = db.transaction('fileEvents', 'readwrite'), os = tx.objectStore('fileEvents');
  for (const row of await req(os.getAll())) {
    if (row.targetId === targetId && row.urlKey === urlKey) os.delete([row.targetId, row.urlKey, row.eventId]);
  }
  for (const state of states) os.put({ targetId, urlKey, ...state });
  await done(tx);
}

export async function migrateLegacyOutbox(legacyEvents = []) {
  if (offlineTransport) return offlineTransport('migrateLegacyOutbox', [legacyEvents]);
  const db = await openOfflineStore();
  if (!db) return false;
  const marker = 'migrated:legacy-outbox';
  const check = db.transaction('meta', 'readonly');
  const exists = await req(check.objectStore('meta').get(marker));
  await done(check);
  if (exists) return false;
  const valid = legacyEvents.filter((e) => e?.id && e?.urlKey && e?.action);
  const tx = db.transaction(['events', 'operations', 'meta'], 'readwrite');
  const es = tx.objectStore('events'), os = tx.objectStore('operations');
  const latest = new Map();
  for (const e of valid) latest.set(e.id, mutationStamp(e,
    { at: Number(e.deletedAt || e.updatedAt || e.createdAt) || now() }));
  for (const e of latest.values()) { es.put(e); os.put(opFor(e)); }
  tx.objectStore('meta').put({ name: marker, at: now(), count: latest.size });
  await done(tx);
  return true;
}

/** 当前文章旧镜像的幂等迁移；成功后才写 marker，旧键暂留作降级回退。 */
export async function migrateArticleMirror(urlKey, legacyEvents = []) {
  if (offlineTransport) return offlineTransport('migrateArticleMirror', [urlKey, legacyEvents]);
  const db = await openOfflineStore();
  if (!db) return false;
  const marker = `migrated:${urlKey}`;
  const check = db.transaction('meta', 'readonly');
  const exists = await req(check.objectStore('meta').get(marker));
  await done(check);
  if (exists) return false;
  const stamped = legacyEvents.filter((e) => e?.id && e?.urlKey)
    .map((e) => e.updatedAt && e.mutationId ? e
      : mutationStamp(e, { at: Number(e.deletedAt || e.createdAt) || now() }));
  const tx = db.transaction(['events', 'meta'], 'readwrite');
  const es = tx.objectStore('events');
  for (const e of stamped) es.put(e);
  tx.objectStore('meta').put({ name: marker, at: now(), count: stamped.length });
  await done(tx);
  return true;
}
