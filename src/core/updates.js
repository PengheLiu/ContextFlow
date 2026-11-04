// Public release metadata only. Never send article, account or device data.
export const UPDATE_FEED_URL = 'https://pengheliu.github.io/ContextFlow/updates.json';
export const UPDATE_DOWNLOAD_URL = 'https://pengheliu.github.io/ContextFlow/download.html';
export const UPDATE_STORE_URL = 'https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm';
const RELEASE_ROOT = 'https://github.com/PengheLiu/ContextFlow/releases/tag/v';
const MAX_BYTES = 64 * 1024;
const INTERVAL = 6 * 60 * 60 * 1000;
const platforms = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const parts = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && value.split('.').every(part => part.length <= 5 && Number(part) <= 65535) ? value.split('.').map(Number) : null;

export function compareVersions(left, right) {
  const a = parts(left), b = parts(right);
  if (!a || !b) throw new Error('更新版本格式无效');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function validateUpdateFeed(value) {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.desktop) || !record(value.extension)) throw new Error('更新清单格式无效');
  const row = (input, kind) => {
    if (!record(input) || !parts(input.version) || input.url !== (kind === 'extension' ? UPDATE_STORE_URL : UPDATE_DOWNLOAD_URL)
      || input.releaseNotesUrl !== `${RELEASE_ROOT}${input.version}`) throw new Error('更新清单来源或版本无效');
    return { version: input.version, url: input.url, releaseNotesUrl: input.releaseNotesUrl };
  };
  const desktop = {};
  for (const [platform, input] of Object.entries(value.desktop)) {
    if (!platforms.has(platform)) throw new Error('更新清单平台无效');
    desktop[platform] = row(input, 'desktop');
  }
  return { schemaVersion: 1, extension: row(value.extension, 'extension'), desktop };
}

export function getUpdateState({ feed, currentVersion, kind, platform, architecture, checkedAt = Date.now() }) {
  if (!parts(currentVersion) || !['desktop', 'extension'].includes(kind)) throw new Error('当前版本或更新类型无效');
  const checked = validateUpdateFeed(feed);
  const latest = kind === 'extension' ? checked.extension : checked.desktop[`${platform}-${architecture}`];
  if (!latest) return { state: 'unsupported', currentVersion, checkedAt, checking: false,
    message: '尚无适用于当前系统和芯片的公开安装包。' };
  const compared = compareVersions(latest.version, currentVersion);
  return { state: compared > 0 ? 'available' : 'current', currentVersion, latestVersion: latest.version,
    url: latest.url, releaseNotesUrl: latest.releaseNotesUrl, checkedAt, checking: false,
    message: compared > 0 ? `发现新版本 v${latest.version}。${kind === 'extension' ? 'Chrome 会自动分发更新；请先保存未完成的批注。' : '可前往官网下载，完成当前任务后覆盖安装。'}`
      : compared < 0 ? '未发现比当前版本更新的已发布版本。' : '当前已是最新公开版本。' };
}

async function readFeed(response) {
  if (!response?.ok) throw new Error('更新源暂不可用');
  if (response.redirected || response.url && response.url !== UPDATE_FEED_URL) throw new Error('更新清单来源无效');
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error('更新清单过大');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) throw new Error('更新清单过大');
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  } else text = await response.text();
  if (typeof text !== 'string' || text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('更新清单过大');
  return validateUpdateFeed(JSON.parse(text));
}

export function createUpdateChecker({ currentVersion, kind, platform, architecture, fetch: fetcher = globalThis.fetch,
  loadCache, saveCache, onChange, now = Date.now, minIntervalMs = INTERVAL, timeoutMs = 10000 } = {}) {
  if (!parts(currentVersion) || !['desktop', 'extension'].includes(kind)) throw new Error('当前版本或更新类型无效');
  let state = { state: 'idle', currentVersion, checking: false, checkedAt: null, message: '尚未检查更新' };
  let loaded = false, inFlight, disposed = false, controller;
  const snapshot = () => ({ ...state });
  const emit = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    try { onChange?.(snapshot()); } catch { /* A view cannot break the checker. */ }
  };
  const fromFeed = (feed, checkedAt) => getUpdateState({ feed, currentVersion, kind, platform, architecture, checkedAt });
  const check = ({ force = false } = {}) => {
    if (disposed) return Promise.resolve(snapshot());
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (!loaded) {
        loaded = true;
        try {
          const cached = await loadCache?.();
          if (cached?.schemaVersion === 1 && Number.isSafeInteger(cached.checkedAt) && cached.checkedAt > 0 && cached.checkedAt <= now()) {
            emit({ ...fromFeed(cached.feed, cached.checkedAt), stale: now() - cached.checkedAt >= minIntervalMs });
          }
        } catch { /* Corrupt caches never block a network check. */ }
      }
      if (disposed) return snapshot();
      if (!force && state.checkedAt && now() >= state.checkedAt && now() - state.checkedAt < minIntervalMs) return snapshot();
      emit({ checking: true, checkError: null });
      let timer;
      controller = new AbortController();
      try {
        const feed = await Promise.race([
          Promise.resolve().then(() => fetcher(UPDATE_FEED_URL, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal })).then(readFeed),
          new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('检查超时')); }, timeoutMs); }),
        ]);
        if (disposed) return snapshot();
        const checkedAt = now();
        emit({ ...fromFeed(feed, checkedAt), stale: false, checkError: null });
        try { await saveCache?.({ schemaVersion: 1, checkedAt, feed }); } catch { /* The valid check is useful even if caching fails. */ }
      } catch {
        emit({ ...(state.checkedAt ? {} : { state: 'error', message: '暂时无法检查更新，请稍后重试。' }),
          checking: false, stale: !!state.checkedAt, checkError: '暂时无法检查更新，请稍后重试。' });
      } finally { clearTimeout(timer); controller = null; }
      return snapshot();
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  return { snapshot, check, dispose() { disposed = true; controller?.abort(); } };
}
