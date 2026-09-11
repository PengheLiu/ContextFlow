// userscript公开版的笔记落盘：File System Access API，用户授权哪个目录就写哪个。
//
// Obsidian 与普通 Markdown **各自记忆一个授权目录**（`default:obsidian` /
// `default:markdown`）：切换笔记类型不丢另一个的授权。旧单目录 `default`
// 的数据在首次访问对应模式时整体迁移（offline-store.moveFileTarget），
// 不产生孤儿行。
import {
  saveFileTarget, getFileTarget, forgetFileTarget, moveFileTarget, getFileArticle,
  saveFileArticle, getFileEventStates, replaceFileEventStates, listOfflineEvents,
  getOfflineArticle,
  getOfflineAsset,
} from '../core/offline-store.js';
import { mergeArticleDocument, mergeDateIndex, initialFileName, hasArticleMarker } from '../core/markdown-sync.js';
import { assetIds, replaceAssetTokens } from '../core/assets.js';

const LEGACY_TARGET = 'default';
const FILE_MODE_KEY = 'contextflow:file-target-mode';
const FILE_MODES = new Set(['obsidian', 'markdown']);
let activeFileMode = null;      // 本次会话内记住用户最后选择的模式

const err = (message, code) => Object.assign(new Error(message), { code });
const normalizeFileMode = (mode) => (FILE_MODES.has(mode) ? mode : 'obsidian');
const targetIdForMode = (mode) => `default:${normalizeFileMode(mode)}`;

const storedFileMode = () => {
  if (FILE_MODES.has(activeFileMode)) return activeFileMode;
  try {
    const mode = globalThis.localStorage?.getItem(FILE_MODE_KEY);
    return FILE_MODES.has(mode) ? mode : null;
  } catch { return null; }
};

const rememberFileMode = (mode) => {
  mode = activeFileMode = normalizeFileMode(mode);
  try { globalThis.localStorage?.setItem(FILE_MODE_KEY, mode); } catch { /* 配额 */ }
  return mode;
};

async function currentFileMode() {
  const stored = storedFileMode();
  if (stored) return stored;
  // 没有模式记录时看旧 target 的模式（迁移场景）
  const legacy = await getFileTarget(LEGACY_TARGET);
  return rememberFileMode(legacy?.mode);
}

async function modeFileTarget(mode) {
  mode = normalizeFileMode(mode);
  const id = targetIdForMode(mode);
  const target = await getFileTarget(id);
  if (target) return target;
  // 旧单目录时代的数据：模式匹配就整体迁移到新模式 id 下
  const legacy = await getFileTarget(LEGACY_TARGET);
  if (!legacy || normalizeFileMode(legacy.mode) !== mode) return null;
  const migrated = { ...legacy, id, mode };
  await moveFileTarget(LEGACY_TARGET, migrated);
  return migrated;
}

const day = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const readFile = async (dir, name) => {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch (e) { if (e.name === 'NotFoundError') return ''; throw e; }
};
const assetEventsForTarget = async (events, dir) => {
  const ids = [...new Set(events.flatMap((event) => [
    ...assetIds(event.value), ...assetIds(event.extra?.supplement),
  ]))];
  if (!ids.length) return events;
  const assets = new Map();
  let folder = await dir.getDirectoryHandle('assets', { create: true });
  folder = await folder.getDirectoryHandle('contextflow', { create: true });
  for (const id of ids) {
    const asset = await getOfflineAsset(id);
    if (!asset?.blob) throw err(`附件不存在：${id}`, 'ASSET_MISSING');
    const ext = asset.mime === 'image/png' ? 'png' : asset.mime === 'image/webp' ? 'webp' : 'jpg';
    const name = `${id}.${ext}`, handle = await folder.getFileHandle(name, { create: true });
    const writable = await handle.createWritable(); await writable.write(asset.blob); await writable.close();
    assets.set(id, encodeURI(`assets/contextflow/${name}`));
  }
  return events.map((event) => ({
    ...event,
    value: replaceAssetTokens(event.value, (id) => assets.get(id)),
    extra: event.extra ? { ...event.extra,
      supplement: replaceAssetTokens(event.extra.supplement, (id) => assets.get(id)) } : event.extra,
  }));
};
const writeFile = async (dir, name, text) => {
  const fh = await dir.getFileHandle(name, { create: true }), w = await fh.createWritable();
  await w.write(text); await w.close();
};

export async function chooseFileTarget(mode = 'obsidian') {
  mode = rememberFileMode(mode);
  if (typeof globalThis.showDirectoryPicker !== 'function') throw err('当前浏览器不支持文件夹同步，请使用“下载”', 'FS_UNSUPPORTED');
  const handle = await globalThis.showDirectoryPicker({ id: `contextflow-${mode}-notes`, mode: 'readwrite' });
  await saveFileTarget({ id: targetIdForMode(mode), handle, name: handle.name, mode,
    origin: globalThis.location?.origin || '' });
  return targetStatus(mode);
}

export async function targetStatus(mode) {
  mode = mode ? normalizeFileMode(mode) : await currentFileMode();
  const target = await modeFileTarget(mode);
  if (!target) return { configured: false, supported: typeof globalThis.showDirectoryPicker === 'function', mode };
  const permission = typeof target.handle.queryPermission === 'function'
    ? await target.handle.queryPermission({ mode: 'readwrite' }) : 'prompt';
  return { configured: true, supported: true, name: target.name, mode,
    origin: target.origin, permission };
}

export async function setFileTargetMode(mode) {
  if (!FILE_MODES.has(mode)) throw err('不支持的笔记类型', 'FS_MODE');
  rememberFileMode(mode);
  return targetStatus(mode);
}

export async function authorizeFileTarget(mode) {
  mode = mode ? normalizeFileMode(mode) : await currentFileMode();
  const target = await modeFileTarget(mode);
  if (!target) throw err('请先选择笔记文件夹', 'NO_FILE_TARGET');
  const permission = await target.handle.requestPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw err('未获得文件夹读写权限', 'FS_PERMISSION');
  return targetStatus(mode);
}

export async function clearFileTarget(mode) {
  mode = mode ? normalizeFileMode(mode) : await currentFileMode();
  return forgetFileTarget(targetIdForMode(mode));
}

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
    const mode = await currentFileMode(), targetId = targetIdForMode(mode);
    const target = await modeFileTarget(mode);
    if (!target) throw err(`请先在“配置”中选择${mode === 'obsidian' ? ' Obsidian Vault' : '普通 Markdown 文件夹'}`, 'NO_FILE_TARGET');
    const permission = await target.handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw err('文件夹授权已失效，请在“配置”中重新授权', 'FS_PERMISSION');
    const [article, events, mapping, allStates] = await Promise.all([
      getOfflineArticle(urlKey), listOfflineEvents(urlKey, { includeDeleted: true }),
      getFileArticle(targetId, urlKey), getFileEventStates(targetId, urlKey),
    ]);
    if (!article && !events.length) throw err('当前文章没有可同步的本地记录', 'NO_EVENTS');
    const liveTimes = events.filter((e) => !e.deletedAt).map((e) => e.createdAt || Date.now());
    const firstDay = mapping?.firstDay || day(Math.min(...(liveTimes.length ? liveTimes : [Date.now()])));
    let fileName = mapping?.fileName || await recoverName(target.handle, urlKey)
      || initialFileName(article?.title || events[0]?.title, urlKey);
    const existing = await readFile(target.handle, fileName);
    // 撞上一个不含本文章 marker 的同名文件时，缀上 urlKey 尾部避让，绝不覆盖别人的文章
    if (existing && !hasArticleMarker(existing, urlKey) && !mapping) {
      fileName = fileName.replace(/\.md$/, `-${String(urlKey).replace(/[^a-z0-9]/gi, '').slice(-8)}.md`);
    }
    const before = await readFile(target.handle, fileName);
    const previous = new Map(allStates.map((x) => [x.eventId, x]));
    const exportedEvents = await assetEventsForTarget(events, target.handle);
    const merged = mergeArticleDocument(before, {
      title: article?.title || events[0]?.title,
      url: article?.url || events[0]?.url,
      urlKey,
      firstDay,
    }, exportedEvents, previous);
    if (merged.text !== before) await writeFile(target.handle, fileName, merged.text);
    await saveFileArticle({ targetId, urlKey, fileName, firstDay, updatedAt: Date.now() });
    await replaceFileEventStates(targetId, urlKey, merged.states);
    const indexName = `${firstDay}.md`, oldIndex = await readFile(target.handle, indexName);
    const index = mergeDateIndex(oldIndex, {
      firstDay,
      urlKey,
      title: article?.title || events[0]?.title,
      fileName,
      mode,
    });
    if (index.changed) await writeFile(target.handle, indexName, index.text);
    const changed = merged.inserted + merged.updated + merged.deleted;
    return {
      backend: mode,
      articles: 1,
      inserted: merged.inserted,
      updated: merged.updated,
      deleted: merged.deleted,
      preserved: merged.preserved,
      conflicts: merged.conflicts,
      sourceChanged: merged.sourceChanged,
      files: changed || merged.sourceChanged || index.changed ? [fileName, indexName] : [],
    };
  });
}
