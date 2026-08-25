import {
  saveFileTarget, getFileTarget, forgetFileTarget, getFileArticle, saveFileArticle,
  getFileEventStates, replaceFileEventStates, listOfflineEvents, getOfflineArticle,
} from '../core/offline-store.js';
import { mergeArticleDocument, mergeDateIndex, initialFileName, hasArticleMarker } from '../core/markdown-sync.js';

const TARGET = 'default';
const err = (message, code) => Object.assign(new Error(message), { code });
const day = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const readFile = async (dir, name) => {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch (e) { if (e.name === 'NotFoundError') return ''; throw e; }
};
const writeFile = async (dir, name, text) => {
  const fh = await dir.getFileHandle(name, { create: true }), w = await fh.createWritable();
  await w.write(text); await w.close();
};

export async function chooseFileTarget(mode = 'obsidian') {
  if (typeof globalThis.showDirectoryPicker !== 'function') throw err('当前浏览器不支持文件夹同步，请使用“下载”', 'FS_UNSUPPORTED');
  const handle = await globalThis.showDirectoryPicker({ id: 'contextflow-notes', mode: 'readwrite' });
  await saveFileTarget({ id: TARGET, handle, name: handle.name, mode,
    origin: globalThis.location?.origin || '' });
  return targetStatus();
}
export async function targetStatus() {
  const target = await getFileTarget(TARGET);
  if (!target) return { configured: false, supported: typeof globalThis.showDirectoryPicker === 'function' };
  const permission = typeof target.handle.queryPermission === 'function'
    ? await target.handle.queryPermission({ mode: 'readwrite' }) : 'prompt';
  return { configured: true, supported: true, name: target.name, mode: target.mode,
    origin: target.origin, permission };
}
export async function authorizeFileTarget() {
  const target = await getFileTarget(TARGET);
  if (!target) throw err('请先选择笔记文件夹', 'NO_FILE_TARGET');
  const permission = await target.handle.requestPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw err('未获得文件夹读写权限', 'FS_PERMISSION');
  return targetStatus();
}
export const clearFileTarget = () => forgetFileTarget(TARGET);

let mutex = Promise.resolve();
const locked = (fn) => {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request('contextflow-file-sync', fn);
  const next = mutex.then(fn, fn); mutex = next.catch(() => {}); return next;
};

async function recoverName(dir, urlKey) {
  if (!dir.values) return null;
  for await (const h of dir.values()) {
    if (h.kind !== 'file' || !h.name.endsWith('.md')) continue;
    const text = await (await h.getFile()).text();
    if (hasArticleMarker(text, urlKey)) return h.name;
  }
  return null;
}

export async function syncToFileTarget(urlKey) {
  return locked(async () => {
    const target = await getFileTarget(TARGET);
    if (!target) throw err('请先在“配置”中选择 Obsidian Vault 或 Markdown 文件夹', 'NO_FILE_TARGET');
    const permission = await target.handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw err('文件夹授权已失效，请在“配置”中重新授权', 'FS_PERMISSION');
    const [article, events, mapping, allStates] = await Promise.all([
      getOfflineArticle(urlKey), listOfflineEvents(urlKey, { includeDeleted: true }),
      getFileArticle(TARGET, urlKey), getFileEventStates(TARGET, urlKey),
    ]);
    if (!article && !events.length) throw err('当前文章没有可同步的本地记录', 'NO_EVENTS');
    const liveTimes = events.filter((e) => !e.deletedAt).map((e) => e.createdAt || Date.now());
    const firstDay = mapping?.firstDay || day(Math.min(...(liveTimes.length ? liveTimes : [Date.now()])));
    let fileName = mapping?.fileName || await recoverName(target.handle, urlKey)
      || initialFileName(article?.title || events[0]?.title, urlKey);
    // 不覆盖同名的别篇文件。
    const existing = await readFile(target.handle, fileName);
    if (existing && !hasArticleMarker(existing, urlKey) && !mapping) {
      fileName = fileName.replace(/\.md$/, `-${String(urlKey).replace(/[^a-z0-9]/gi, '').slice(-8)}.md`);
    }
    const before = await readFile(target.handle, fileName);
    const previous = new Map(allStates.map((x) => [x.eventId, x]));
    const merged = mergeArticleDocument(before, {
      title: article?.title || events[0]?.title, url: article?.url || events[0]?.url,
      urlKey, firstDay,
    }, events, previous);
    if (merged.text !== before) await writeFile(target.handle, fileName, merged.text);
    await saveFileArticle({ targetId: TARGET, urlKey, fileName, firstDay, updatedAt: Date.now() });
    await replaceFileEventStates(TARGET, urlKey, merged.states);
    const indexName = `${firstDay}.md`, oldIndex = await readFile(target.handle, indexName);
    const index = mergeDateIndex(oldIndex, { firstDay, urlKey,
      title: article?.title || events[0]?.title, fileName, mode: target.mode });
    if (index.changed) await writeFile(target.handle, indexName, index.text);
    const changed = merged.inserted + merged.updated + merged.deleted;
    return { backend: target.mode, articles: 1, inserted: merged.inserted,
      updated: merged.updated, deleted: merged.deleted, preserved: merged.preserved,
      conflicts: merged.conflicts, files: changed || index.changed ? [fileName, indexName] : [] };
  });
}
