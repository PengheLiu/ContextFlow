import { createUpdateChecker } from '../core/updates.js';

export const UPDATE_ALARM = 'contextflow:updates';
const CACHE_KEY = 'publishedUpdateCache', STAGED_KEY = 'stagedExtensionUpdate';
const STORE_URL = 'https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm';
const version = value => typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/.test(value)
  && value.split('.').every(part => part.length <= 5 && Number(part) <= 65535);
const newer = (left, right) => {
  if (!version(left) || !version(right)) return false;
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
};

// Runs only in the trusted worker. Public update requests never carry pairing
// credentials, article URLs, browser identities or reading-library contents.
export function createExtensionUpdates({ chrome, fetch = globalThis.fetch, storageReady = Promise.resolve(), createChecker = createUpdateChecker, now = Date.now } = {}) {
  const manifest = chrome.runtime.getManifest(), currentVersion = manifest.version;
  const development = !manifest.update_url;
  let stagedVersion = '', browserStatus = development ? 'development' : 'idle', checkingBrowser = false;
  let pending, stopped = false, ready;
  const checker = createChecker({ currentVersion, kind: 'extension', fetch,
    loadCache: async () => { await storageReady; return (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY]; },
    saveCache: async cache => { await storageReady; await chrome.storage.local.set({ [CACHE_KEY]: cache }); },
    onChange: () => { if (ready) void publish(); }, now,
  });
  const snapshot = () => {
    const state = checker.snapshot();
    const staged = newer(stagedVersion, currentVersion);
    const available = staged || state.state === 'available';
    return { ...state, checking: !!state.checking || checkingBrowser, browserStatus, development, available,
      ...(staged ? { state: 'available', latestVersion: stagedVersion, stagedVersion,
        message: `Chrome 已下载 v${stagedVersion}，等待应用更新。请先保存所有阅读页的内容，再到扩展管理中处理；更新后刷新原文章。` }
        : development ? { message: `${state.message} 当前是开发版，Chrome 商店不会自动更新此副本。` }
          : browserStatus === 'throttled' ? { message: `${state.message} Chrome 暂时限制了商店检查频率，请稍后再试。` }
            : browserStatus === 'unavailable' ? { message: `${state.message} Chrome 商店检查暂不可用，仍可打开扩展管理后重试。` }
            : {}),
    };
  };
  async function publish() {
    if (stopped) return;
    const state = snapshot();
    await Promise.allSettled([
      Promise.resolve().then(() => chrome.action?.setBadgeText?.({ text: state.available ? '↑' : '' })),
      Promise.resolve().then(() => chrome.action?.setBadgeBackgroundColor?.({ color: '#aa5009' })),
      Promise.resolve().then(() => chrome.runtime.sendMessage?.({ type: 'cf-update-state', updates: state })),
      Promise.resolve().then(async () => {
        const tabs = await chrome.tabs?.query?.({}) || [];
        await Promise.allSettled(tabs.filter(tab => tab.id != null).map(tab => chrome.tabs.sendMessage(tab.id, { type: 'cf-update-state', updates: state })));
      }),
    ]);
  }
  async function stage(details) {
    if (stopped || !newer(details?.version, currentVersion)) return;
    stagedVersion = details.version; browserStatus = 'update_available';
    try { await storageReady; await chrome.storage.local.set({ [STAGED_KEY]: stagedVersion }); } catch { /* a live staged update remains visible */ }
    await publish();
  }
  function checkBrowser() {
    if (development || typeof chrome.runtime.requestUpdateCheck !== 'function') return Promise.resolve();
    checkingBrowser = true;
    return new Promise(resolve => {
      let finished = false;
      const finish = async (status, details) => {
        if (finished) return;
        finished = true; clearTimeout(timer); checkingBrowser = false;
        browserStatus = ['throttled', 'no_update', 'update_available'].includes(status) ? status : 'unavailable';
        if (status === 'update_available') {
          if (newer(details?.version, currentVersion)) await stage(details);
          else browserStatus = 'unavailable';
        }
        resolve();
      };
      const timer = setTimeout(() => { void finish('unavailable'); }, 8000);
      try {
        chrome.runtime.requestUpdateCheck((status, details) => {
          const error = chrome.runtime.lastError; // consume callback-only error
          void finish(error ? 'unavailable' : status, details);
        });
      } catch { void finish('unavailable'); }
    });
  }
  async function check({ force = false } = {}) {
    await ready;
    if (pending) return pending;
    pending = (async () => {
      // Chrome already checks its store periodically. Request its own check
      // only for an explicit user action, never on an alarm/worker restart.
      await Promise.allSettled([checker.check({ force }), ...(force ? [checkBrowser()] : [])]);
      await publish(); return snapshot();
    })();
    try { return await pending; } finally { pending = null; }
  }
  async function open(operation = 'details') {
    if (!['details', 'manage', 'store'].includes(operation)) throw new Error('无效的更新操作');
    const url = operation === 'manage' ? `chrome://extensions/?id=${chrome.runtime.id}`
      : operation === 'store' ? STORE_URL : chrome.runtime.getURL('options.html#updates');
    await chrome.tabs.create({ url }); return true;
  }
  const onAlarm = alarm => { if (alarm.name === UPDATE_ALARM) void check(); };
  const onStaged = details => { void stage(details); };
  const onStartup = () => { void check(); };
  chrome.alarms?.onAlarm?.addListener(onAlarm);
  chrome.runtime.onUpdateAvailable?.addListener(onStaged);
  chrome.runtime.onStartup?.addListener(onStartup);
  ready = (async () => {
    try {
      await storageReady;
      const stored = (await chrome.storage.local.get(STAGED_KEY))[STAGED_KEY];
      if (newer(stored, currentVersion)) { stagedVersion = stored; browserStatus = 'update_available'; }
      else if (stored) await chrome.storage.local.remove(STAGED_KEY);
      if (chrome.alarms?.get && chrome.alarms?.create && !await chrome.alarms.get(UPDATE_ALARM)) {
        await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
      }
    } catch { /* manual checks remain available if alarm/cache setup fails */ }
  })();
  return { snapshot, ready, check, open,
    dispose() { stopped = true; checker.dispose(); chrome.alarms?.onAlarm?.removeListener?.(onAlarm);
      chrome.runtime.onUpdateAvailable?.removeListener?.(onStaged); chrome.runtime.onStartup?.removeListener?.(onStartup); },
  };
}

// A small DOM adapter keeps remote strings text-only, and never refreshes or
// reloads an extension in response to a newer version being detected.
export function setupUpdatePage({ root = document, request, version, runtime = globalThis.chrome?.runtime } = {}) {
  const $ = id => root.getElementById(id);
  let working = false, state;
  const render = value => {
    state = value || state || {};
    $('update-current').textContent = `v${version}`;
    $('update-latest').textContent = state.latestVersion ? `v${state.latestVersion}` : '尚未确认';
    $('update-message').textContent = state.checkError ? `${state.message} ${state.checkError}` : state.message || '尚未检查更新';
    $('update-message').dataset.error = String(state.state === 'error' || !!state.checkError);
    $('update-checked').textContent = state.checkedAt ? new Date(state.checkedAt).toLocaleString('zh-CN') : '尚未检查';
    $('check-updates').disabled = working || !!state.checking;
    $('check-updates').textContent = working || state.checking ? '正在检查…' : '检查更新';
    $('update-indicator').hidden = !state.available;
    $('update-indicator').title = state.available ? `有可用更新${state.latestVersion ? ` v${state.latestVersion}` : ''}` : '应用更新';
    $('update-manage').hidden = !state.available || !!state.development;
    $('update-install-help').textContent = state.development
      ? '当前副本以开发版方式加载。请保留阅读记录并使用新的本地插件构建，再在扩展管理中重新加载；Chrome 商店不会替换这个副本。'
      : 'Chrome 会自动安装商店更新。想立即检查，可先保存所有阅读页的内容，再打开扩展管理，开启「开发者模式」并点击「更新」。更新后刷新原文章；不要移除扩展，避免清除阅读库。';
  };
  const refresh = async (force = false) => {
    if (working) return;
    working = true; render();
    try { render(await request({ type: force ? 'cf-check-updates' : 'cf-update-status' })); }
    catch { render({ ...state, state: state?.available ? state.state : 'error', checkError: '无法读取更新状态，请重新打开设置页后重试。' }); }
    finally { working = false; render(); }
  };
  $('check-updates').onclick = () => { void refresh(true); };
  for (const [id, operation] of [['update-manage', 'manage'], ['update-store', 'store']]) $(id).onclick = async () => {
    try { await request({ type: 'cf-open-update', operation }); }
    catch { $('update-message').textContent = '暂时无法打开更新入口，请稍后重试。'; }
  };
  const listener = message => { if (message?.type === 'cf-update-state') render(message.updates); };
  runtime?.onMessage?.addListener(listener);
  void refresh();
  return { refresh, render, dispose: () => runtime?.onMessage?.removeListener?.(listener) };
}
