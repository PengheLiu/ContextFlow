// 浏览器端离线事实库：事件与待发送操作在同一个 IndexedDB 事务里提交。
// localStorage 只保留迁移兼容与小型 UI 偏好，不再承担并发写入正确性。

const DB_NAME = 'contextflow-offline';
const DB_VERSION = 1;
const LEASE_MS = 30_000;
const now = () => Date.now();
const uid = () => globalThis.crypto?.randomUUID?.()
  || `${now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let dbPromise;
const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
});

export function available() { return typeof indexedDB !== 'undefined'; }

export function openOfflineStore() {
  if (!available()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const events = db.createObjectStore('events', { keyPath: ['urlKey', 'id'] });
      events.createIndex('urlKey', 'urlKey');
      events.createIndex('action', 'action');
      events.createIndex('updatedAt', 'updatedAt');
      const ops = db.createObjectStore('operations', { keyPath: 'opId' });
      ops.createIndex('state', 'state');
      ops.createIndex('coalesceKey', 'coalesceKey', { unique: true });
      ops.createIndex('leaseUntil', 'leaseUntil');
      ops.createIndex('createdAt', 'createdAt');
      const articles = db.createObjectStore('articles', { keyPath: 'urlKey' });
      articles.createIndex('lastUsedAt', 'lastUsedAt');
      articles.createIndex('byteLength', 'byteLength');
      db.createObjectStore('meta', { keyPath: 'name' });
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
  const stamped = events.map((e) => mutationStamp(e, { deleted: true }));
  await saveOfflineEvents(stamped);
  return stamped;
}

export async function listOfflineEvents(urlKey, { includeDeleted = false } = {}) {
  const db = await openOfflineStore();
  if (!db) return [];
  const tx = db.transaction('events', 'readonly');
  const rows = await req(tx.objectStore('events').index('urlKey').getAll(urlKey));
  await done(tx);
  return includeDeleted ? rows : rows.filter((e) => !e.deletedAt);
}

/** 原子 claim；多个 tab 最多各拿到不同操作。 */
export async function claimOperations(owner, limit = 100, leaseMs = LEASE_MS) {
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
  const db = await openOfflineStore();
  if (!db) return 0;
  const tx = db.transaction('operations', 'readonly');
  const rows = await req(tx.objectStore('operations').getAll());
  await done(tx);
  return rows.filter((o) => !urlKey || o.urlKey === urlKey).length;
}

/** 远端结果（含 tombstone）写回本地，但不产生出站操作。 */
export async function applyRemoteEvents(events) {
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

export async function migrateLegacyOutbox(legacyEvents = []) {
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
