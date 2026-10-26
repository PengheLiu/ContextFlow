import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, safeStorage, systemPreferences, screen, powerMonitor } from 'electron';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopPaths, nativeManifest, chromeHostFile, atomicJSON, readJSON, HOST_NAME, EXTENSIONS, STORE_URL, WEBSITE } from './platform.mjs';
import { ServiceManager } from './service.mjs';
import { runNativeHost } from './native-host.mjs';
import { diagnosticReport } from './diagnostics.mjs';
import { createRecoveryPoint, listRecoveryPoints, validateRecoveryPoint, loadProtectedSecret, restoreStoppedDesktop } from './recovery.mjs';
import { LocalDiscovery } from './discovery.mjs';
import { journeyView, updateJourney } from './journey.mjs';
import { openReadingInChrome } from './browser.mjs';
import { createVisibility } from './visibility.mjs';
import { launchIdentity, needsInstanceNotice } from './instance.mjs';
import { loadTrayIcon } from './tray-icon.mjs';
import { createMenuBar, readMenuBarGeometry } from './menu-bar.mjs';
import { trayMenuTemplate } from './tray-menu.mjs';
import { approveBrowserPairing } from './pairing-approval.mjs';
import { browserPairingState, requireBrowserPairings } from './pairing-state.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const development = !app.isPackaged;
const preview = development || readJSON(join(process.resourcesPath, 'desktop-build.json')).channel === 'preview';
const smoke = development && process.env.CONTEXTFLOW_DESKTOP_SMOKE === '1';
const paths = desktopPaths();
if (smoke) {
  if (!process.env.CONTEXTFLOW_DESKTOP_TEST_STATE || !process.env.CONTEXTFLOW_DIR) throw new Error('冒烟测试必须使用隔离目录');
  const override = process.env.CONTEXTFLOW_DESKTOP_TEST_STATE;
  Object.assign(paths, { state: override, bridge: join(override, 'desktop-bridge.json'), secret: join(override, 'secret-key.bin'),
    preferences: join(override, 'desktop.json'), logs: join(override, 'logs') });
}
app.setPath('userData', paths.state);
const identity = launchIdentity({ executable: app.getPath('exe'), version: app.getVersion(),
  build: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url)))
    .update(JSON.stringify(readJSON(join(process.resourcesPath, 'desktop-build.json')))).digest('hex') });
const isHost = process.argv.some(value => /^chrome-extension:\/\/[a-p]{32}\/?$/.test(value));
if (isHost) {
  await runNativeHost({ app, paths, development: preview });
} else if (!app.requestSingleInstanceLock({ ...identity, hidden: process.argv.includes('--hidden') })) {
  if (smoke) app.exit(0);
  else app.whenReady().then(async () => {
    if (needsInstanceNotice(identity, readJSON(paths.bridge))) {
      if (process.platform === 'darwin') await app.dock.show();
      await dialog.showMessageBox({ type: 'info', buttons: ['知道了'],
        message: '另一个版本的 ContextFlow 仍在运行',
        detail: '刚安装的版本尚未启动。请先在正在运行的 ContextFlow 中选择「退出 ContextFlow」，再从应用程序文件夹打开新版。已保存的配置与笔记会保留；不要在任务运行中强制结束进程。' });
    }
    app.quit();
  }).catch(() => app.exit(1));
} else if (smoke && process.argv.includes('--contextflow-smoke-secondary')) {
  // A smoke secondary must never own a core, even if the primary disappeared.
  app.exit(42);
} else {
  let window, tray, menuBar, statusTimer, service, bridge, discovery, lastConfig = {}, quitting = false, pairing = false, bridgeReady = false, recovering = false, exitPending = false;
  let pendingShow = false, secondInstanceEvents = 0;
  let healthResponding = true, healthRefresh, nativeMenu;
  const visibility = createVisibility({ app, getTray: () => menuBar?.getTray() || tray });
  let preferences, preferencesWarning = '';
  try {
    preferences = readJSON(paths.preferences, { openAtLogin: false });
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('Invalid preferences');
  } catch {
    preferences = { openAtLogin: false };
    preferencesWarning = '启动偏好无法读取，原文件已保留；首次准备进度暂不可用。配置与阅读记录没有重置，可在设置与帮助中检查或恢复。';
  }
  const updateState = { state: 'manual', message: '桌面端通过官网下载更新。任务结束后退出旧版，再覆盖安装；现有配置与阅读数据保留。Chrome 扩展由商店单独更新。' };
  const core = app.isPackaged ? join(process.resourcesPath, 'core') : join(ROOT, 'build', 'core');
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    : join(ROOT, 'build', 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const { pairExtension, listPairings } = await import(pathToFileURL(join(core, 'server', 'extension-pairing.mjs')));
  const { destinationKey, destinationIdentity } = await import(pathToFileURL(join(core, 'server', 'sync-status.mjs')));
  const { terminateTree } = await import(pathToFileURL(join(core, 'server', 'platform.mjs')));
  const { transformSecrets } = await import(pathToFileURL(join(core, 'server', 'secrets.mjs')));
  const { acquireDataOwner } = await import(pathToFileURL(join(core, 'src', 'core', 'data-owner.mjs')));
  const execute = promisify(execFile);

  function show() {
    if (quitting) return;
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({ width: 1080, height: 780, minWidth: 820, minHeight: 620, show: false,
        title: 'ContextFlow', backgroundColor: '#fbfaf7', autoHideMenuBar: true,
        webPreferences: { preload: join(ROOT, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.on('close', event => { if (!quitting) { event.preventDefault(); visibility.closeToBackground(window); } });
      window.loadFile(join(ROOT, 'ui', 'index.html'));
      window.once('ready-to-show', () => { visibility.present(window, { focus: !smoke }).catch(() => {}); });
    } else { visibility.present(window, { focus: !smoke }).catch(() => {}); }
  }
  function trusted(event) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url.split('#')[0] !== pathToFileURL(join(ROOT, 'ui', 'index.html')).href) throw new Error('不可信的桌面请求来源');
  }
  function handler(name, fn) { ipcMain.handle(`desktop:${name}`, (event, ...args) => { trusted(event); return fn(...args); }); }
  async function state() {
    let snapshot = service.snapshot();
    if (snapshot.state === 'running') {
      // One server-side config reference binds settings and all receipts. Two
      // separate HTTP reads could mix old/new targets after a browser save.
      const child = service.child;
      const frame = await service.request('/desktop/state', {}, { timeoutMs: 8000 });
      snapshot = service.snapshot();
      if (service.child === child && snapshot.state === 'running' && !quitting) {
        const health = frame.status === 200 ? frame.body.health : null;
        if (health?.desktopManaged && frame.body.configuration) lastConfig = frame.body.configuration;
        service.lastHealth = health?.desktopManaged ? health : null;
        healthResponding = !!service.lastHealth;
        trayMenu();
        snapshot = service.snapshot();
        if (!service.lastHealth) snapshot = { ...snapshot, state: 'unavailable', message: '本地连接暂未响应。阅读记录保留；请稍后重试或到设置中检查。' };
      } else if (snapshot.state === 'running') {
        snapshot = { ...snapshot, state: 'unavailable', message: '本地连接正在更新，请稍候…' };
      }
    }
    return { version: app.getVersion(), platform: process.platform, architecture: process.arch, service: snapshot,
      ...browserPairingState(() => listPairings(paths.data)), bridgeReady, preferences, updates: updateState, dataDir: paths.data,
      discovery: discovery.snapshot(), journey: journeyView(preferences, destinationKey(lastConfig), service.lastHealth?.syncStatus, destinationIdentity(lastConfig)),
      recoveryPoints: await listRecoveryPoints(paths), packaged: app.isPackaged,
      systemIntegration: systemIntegration(), configuration: snapshot.state === 'running' ? lastConfig : null,
      readingStatus: service.lastHealth?.readingStatus || null, startupWarning: preferencesWarning };
  }
  function systemIntegration() {
    return { ...(menuBar?.snapshot() || { trayAvailable: false, trayPlacement: 'unavailable' }),
      dockVisible: process.platform === 'darwin' ? app.dock.isVisible() : null,
      windowVisible: !!window && !window.isDestroyed() && window.isVisible(),
      windowCount: BrowserWindow.getAllWindows().length, secondInstanceEvents };
  }
  async function confirmExit() {
    if (await service.busy()) {
      show();
      const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['继续运行', '停止任务并退出'], defaultId: 0,
        cancelId: 0, message: '仍有任务执行或排队', detail: '退出会取消当前任务；已保存的阅读记录会保留。' });
      if (choice.response !== 1) return false;
    }
    return true;
  }
  function trayMenu() {
    if (!menuBar || !service) return;
    const snapshot = service.snapshot();
    if (snapshot.state === 'running' && !healthResponding) snapshot.state = 'unavailable';
    const template = trayMenuTemplate({ service: snapshot, onOpen: show,
      onSettings: () => {
        show();
        if (!window || window.isDestroyed()) return;
        const navigate = () => { if (!window.isDestroyed()) window.webContents.send('desktop:page', 'support'); };
        if (window.webContents.isLoading()) window.webContents.once('did-finish-load', navigate); else navigate();
      },
      onRestart: () => service.restart().catch(error => dialog.showErrorBox('暂时无法重启', error.message)), onQuit: () => app.quit() });
    if (!nativeMenu) {
      nativeMenu = Menu.buildFromTemplate(template);
      nativeMenu.on('menu-will-show', () => { refreshNativeStatus().catch(() => {}); });
    } else {
      // Update the existing native menu, including while it is being shown.
      // Replacing it on a health tick would dismiss the user's open menu.
      for (const item of template) if (item.id) {
        const existing = nativeMenu.getMenuItemById(item.id);
        if (existing) { existing.label = item.label; existing.enabled = item.enabled !== false; }
      }
    }
    menuBar.setMenu(nativeMenu, `ContextFlow · ${template.find(item => item.id === 'service-status').label}`);
  }
  async function refreshNativeStatus() {
    if (quitting || healthRefresh) return healthRefresh;
    healthRefresh = (async () => {
      if (service?.state === 'running') {
        const child = service.child, health = await service.health();
        if (!quitting && service.child === child && service.state === 'running') {
          const changed = healthResponding !== !!health?.desktopManaged;
          healthResponding = !!health?.desktopManaged;
          service.lastHealth = healthResponding ? health : null;
          trayMenu();
          if (changed) service.emit('changed');
        }
      }
      await menuBar?.refresh({ repair: true });
    })();
    try { await healthRefresh; } finally { healthRefresh = null; }
  }
  async function registerHost() {
    // Production executables load this app directly. A development Electron
    // binary has no fixed app entrypoint, so never register it as a valid host.
    if (!app.isPackaged || (process.platform === 'darwin' && !app.isInApplicationsFolder())) return false;
    const file = chromeHostFile({ resources: process.resourcesPath });
    atomicJSON(file, nativeManifest(app.getPath('exe'), { development: preview }));
    if (process.platform === 'win32') await execute('reg.exe', ['add',
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true });
    return true;
  }
  async function startBridge() {
    const secret = randomBytes(32).toString('base64url');
    bridge = createServer(async (req, res) => {
      const reply = (code, value) => { if (res.destroyed || res.writableEnded) return; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (req.method !== 'POST' || !['/pair', '/status'].includes(req.url) || req.headers.origin || req.headers.authorization !== `Bearer ${secret}`) return reply(403, { ok: false, error: '连接未授权' });
      // Local authenticated diagnostics only. No configuration, secrets, file
      // paths, note content, or ability to stop/relaunch a process is exposed.
      if (req.url === '/status') return reply(200, { ok: true, version: app.getVersion(), build: identity.build,
        pid: process.pid, corePid: service.child?.pid || null, service: service.state, ...systemIntegration() });
      try { requireBrowserPairings(() => listPairings(paths.data)); }
      catch (error) { return reply(409, { ok: false, code: error.code, error: error.message }); }
      if (pairing) return reply(409, { ok: false, error: '已有连接申请，请先在桌面端处理。' });
      let ownsPairing = false;
      try {
        let buffer = '', length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 4096) throw new Error('连接请求过大'); buffer += chunk.toString('utf8'); }
        const request = JSON.parse(buffer);
        if (!(preview ? EXTENSIONS : EXTENSIONS.slice(0, 1)).includes(request.id) || !/^[A-Za-z0-9_-]{16,80}$/.test(request.instanceId || '')) throw new Error('不支持的浏览器连接');
        if (service.state !== 'running') throw new Error('请先在桌面端启动服务或处理旧服务占用，再重试连接。');
        if (pairing) return reply(409, { ok: false, error: '已有连接申请，请先在桌面端处理。' });
        pairing = true; ownsPairing = true; show();
        const label = String(request.label || 'Chrome').replace(/[\r\n]/g, ' ').slice(0, 80);
        const approval = await approveBrowserPairing({ request: req, response: res,
          ask: signal => dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '允许连接'], defaultId: 0, cancelId: 0, signal,
            message: '允许这个浏览器连接 ContextFlow？', detail: `${label}\n安装编号：${request.instanceId.slice(0, 8)}\n\n连接后，选中的文章内容会在使用 AI 时发送至你配置的模型或 Agent，笔记会保存到你选择的位置。\n\n请在 65 秒内确认；超时后请回到扩展重新连接。` }),
          grant: () => {
            if (quitting || service.state !== 'running') throw new Error('桌面服务已停止，未授予浏览器权限。请重新打开桌面端后再连接。');
            return pairExtension(request.id, { instanceId: request.instanceId, label, directory: paths.data });
          } });
        reply(200, approval.ok ? { ...approval, protocolVersion: 1, baseUrl: `http://127.0.0.1:${service.port}` } : approval);
      } catch (error) { reply(400, { ok: false, error: error.message }); }
      finally { if (ownsPairing) pairing = false; }
    });
    await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', resolve); });
    atomicJSON(paths.bridge, { port: bridge.address().port, secret, pid: process.pid, ...identity });
  }

  app.on('second-instance', (_event, _args, _directory, additionalData) => {
    secondInstanceEvents++;
    if (additionalData?.hidden === true) return;
    if (service) show(); else pendingShow = true;
  });
  app.on('activate', () => { if (service) show(); else pendingShow = true; });
  app.on('window-all-closed', () => {});
  process.once('SIGTERM', () => app.quit());
  process.once('SIGINT', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (recovering || exitPending) return;
    exitPending = true;
    (async () => {
      if (service && !await confirmExit()) return;
      await service?.stop(); quitting = true;
      if (readJSON(paths.bridge).pid === process.pid) { try { unlinkSync(paths.bridge); } catch {} }
      clearInterval(statusTimer); bridge?.close(); menuBar?.destroy();
      // Native Dock/activation transitions must not strand a utility process
      // after its core and bridge are already closed. All owned work has ended.
      const exitFallback = setTimeout(() => app.exit(0), 3000); exitFallback.unref();
      app.quit();
    })().catch(error => dialog.showErrorBox('无法完成退出', error.message)).finally(() => { exitPending = false; });
  });

  app.whenReady().then(async () => {
  app.setAppUserModelId('io.github.pengheliu.contextflow');
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'ContextFlow', submenu: [ { role: 'about', label: '关于 ContextFlow' },
        { type: 'separator' }, { label: '打开 ContextFlow', click: show },
        { role: 'hide', label: '隐藏 ContextFlow' }, { type: 'separator' },
        { label: '退出 ContextFlow', accelerator: 'Command+Q', click: () => app.quit() } ] },
      { role: 'editMenu', label: '编辑' },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { label: '打开 ContextFlow', click: show }] },
    ]));
    if (app.isPackaged && !app.isInApplicationsFolder()) {
      const choice = await dialog.showMessageBox({ type: 'info', buttons: ['安装到应用程序', '退出'], defaultId: 0, cancelId: 1,
        message: '先安装 ContextFlow，再开始使用',
        detail: '请将应用安装到应用程序文件夹，避免临时构建或磁盘映像卸载后无法连接。替换旧应用不会删除配置或笔记。' });
      if (choice.response !== 0) { quitting = true; app.quit(); return; }
      const moved = app.moveToApplicationsFolder({ conflictHandler: conflict => {
        if (conflict === 'existsAndRunning') return false;
        return dialog.showMessageBoxSync({ type: 'question', buttons: ['取消', '替换旧应用'], defaultId: 0, cancelId: 0,
          message: '替换已安装的 ContextFlow？', detail: '原应用会移到废纸篓；配置与阅读数据保留。' }) === 1;
      } });
      if (!moved) dialog.showErrorBox('尚未完成安装', '请先退出旧版，再将 ContextFlow 拖入应用程序文件夹后打开。');
      quitting = true; app.quit(); return;
    }
  }
  if (app.isPackaged) preferences.openAtLogin = app.getLoginItemSettings({ path: app.getPath('exe'), args: ['--hidden'] }).openAtLogin;
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const credentials = smoke ? { key: randomBytes(32).toString('base64') } : loadProtectedSecret(paths, safeStorage);
  const secretKey = credentials.key;
  service = new ServiceManager({ paths, runtime, core, secretKey, terminateTree });
  if (credentials.blockedReason) service.blockedReason = credentials.blockedReason;
  const request = async (path, init, options) => {
    const result = await service.request(path, init, options);
    if (path === '/config' && result.status === 200) lastConfig = result.body;
    return result;
  };
  discovery = new LocalDiscovery({ request });
  handler('status', state);
  handler('request', request);
  handler('discover', options => {
    if (options != null && (typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'fresh') ||
      ('fresh' in options && typeof options.fresh !== 'boolean'))) throw new Error('无效的检测选项');
    if (service.state !== 'running') throw new Error('本地连接尚未准备好，请稍后重试。');
    return discovery.run(options || {}).finally(() => service.emit('changed'));
  });
  handler('onboarding', async patch => {
    if (patch?.notesConfirmed === true) {
      const result = await request('/config');
      if (result.status !== 200) throw new Error('请在本地连接恢复后确认笔记位置。');
    }
    preferences = updateJourney(preferences, patch, destinationKey(lastConfig), destinationIdentity(lastConfig));
    atomicJSON(paths.preferences, preferences);
    return journeyView(preferences, destinationKey(lastConfig), service.lastHealth?.syncStatus, destinationIdentity(lastConfig));
  });
  handler('revoke', (id, instanceId) => {
    if (!requireBrowserPairings(() => listPairings(paths.data)).some(row => row.id === id && row.instanceId === instanceId)) throw new Error('连接记录不存在');
    pairExtension(id, { revoke: true, instanceId, legacyOnly: !instanceId, directory: paths.data }); return true;
  });
  handler('preferences', patch => {
    if (typeof patch?.openAtLogin !== 'boolean' || Object.keys(patch).length !== 1) throw new Error('无效的启动设置');
    if (!app.isPackaged) throw new Error('登录启动仅在安装后的桌面版启用。');
    app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, path: app.getPath('exe'), args: ['--hidden'] });
    preferences = { ...preferences, openAtLogin: app.getLoginItemSettings({ path: app.getPath('exe'), args: ['--hidden'] }).openAtLogin };
    atomicJSON(paths.preferences, preferences); return preferences;
  });
  handler('folder', async target => {
    const keys = { markdown: ['markdown', 'dir'], obsidian: ['obsidian', 'vaultPath'], agent: ['agent', 'notesDir'], 'codex-config': ['agent', 'codexHome'] };
    if (!keys[target]) throw new Error('无效的目录用途');
    const selected = await dialog.showOpenDialog(window, target === 'codex-config'
      ? { title: '选择 Codex 登录与模型配置目录', properties: ['openDirectory'] }
      : { title: '选择 ContextFlow 使用的文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled) return null;
    return selected.filePaths[0];
  });
  handler('agent-path', async () => {
    const selected = await dialog.showOpenDialog(window, { title: '选择所用 Agent 的可执行程序', properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Agent executable', extensions: ['exe', 'cmd'] }] } : {}) });
    return selected.canceled ? null : selected.filePaths[0];
  });
  handler('action', async action => {
    if (recovering && ['start', 'restart', 'stop', 'takeover'].includes(action)) throw new Error('恢复点操作正在进行，请稍候。');
    if (['start', 'restart'].includes(action) && service.blockedReason && !service.child && !smoke) {
      const unlocked = loadProtectedSecret(paths, safeStorage);
      service.secretKey = unlocked.key; service.blockedReason = unlocked.blockedReason;
      if (!service.blockedReason) service.port = Number(readJSON(join(paths.data, 'config.json')).port) || 7317;
    }
    if (action === 'start') { await service.start(); return state(); }
    if (action === 'restart') { await service.restart(); return state(); }
    if (action === 'stop') { if (await service.busy()) throw new Error('请先完成或取消排队中的任务，再停止服务。'); await service.stop(); return state(); }
    if (action === 'store') return shell.openExternal(STORE_URL);
    if (action === 'website') return shell.openExternal(WEBSITE);
    if (action === 'download') return shell.openExternal(`${WEBSITE}download.html`);
    if (action === 'practice') return openReadingInChrome(`${WEBSITE}demo.html`, { execute });
    if (action === 'browser') {
      // Do not guess a Chrome profile or enumerate browsing data. Pairing must
      // originate in the extension instance the user actually wants to grant.
      const choice = await dialog.showMessageBox(window, { type: 'info', buttons: ['知道了', '打开安装与连接指南'], defaultId: 0,
        message: '回到 Chrome，继续连接', detail: '在已安装的 ContextFlow 扩展中打开「连接与设置」，点击「连接桌面端」，再在这里确认授权。如果你有多个 Chrome 用户配置，请选择用于阅读的那个。' });
      if (choice.response === 1) return shell.openExternal(`${WEBSITE}download.html#connect`);
      return true;
    }
    if (action === 'data') return shell.openPath(paths.data);
    if (action === 'logs') return shell.openPath(paths.logs);
    if (action === 'recovery-protection') {
      const folder = join(paths.state, 'recovery-protection');
      if (!existsSync(folder)) throw new Error('尚无故障保护副本。它只在恢复操作前创建，不是普通阅读备份。');
      return shell.openPath(folder);
    }
    if (action === 'takeover') {
      if (service.state !== 'external' || process.platform !== 'darwin') throw new Error('请在原来的终端停止旧服务，然后点击启动。');
      const plist = join(app.getPath('home'), 'Library', 'LaunchAgents', 'com.contextflow.server.plist');
      if (!existsSync(plist)) throw new Error('没有找到可接管的 ContextFlow 登录项，请在原终端停止服务。');
      const health = await service.health(readJSON(join(paths.data, 'config.json')).token || '');
      if (!health?.ok || health.jobs?.running || health.jobs?.queued) throw new Error('旧服务身份未确认或仍有任务，请先处理后重试。');
      const decision = await dialog.showMessageBox(window, { buttons: ['取消', '接管服务'], defaultId: 0, cancelId: 0,
        message: '改由桌面端管理本地服务？', detail: '将停用旧的 ContextFlow 登录项，原有配置和阅读数据保留。之后请通过桌面端启动服务。' });
      if (decision.response !== 1) return false;
      await execute('/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.contextflow.server`]);
      renameSync(plist, `${plist}.desktop-backup`);
      await service.start(); return state();
    }
    if (action === 'diagnostics') {
      const file = await dialog.showSaveDialog(window, { defaultPath: `ContextFlow-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (file.canceled) return false;
      const report = diagnosticReport(await state());
      writeFileSync(file.filePath, JSON.stringify(report, null, 2), { mode: 0o600 }); return true;
    }
    throw new Error('不支持的桌面操作');
  });
  handler('updates', async action => {
    // The first desktop release uses explicit, signed installer downloads.
    // Do not stop a working service for an unverified Squirrel/NSIS hand-off.
    if (action === 'check') return updateState;
    throw new Error('请从官网下载匹配版本，任务结束后退出旧版并覆盖安装。此版本不执行应用内自动安装。');
  });
  handler('recovery', async (action, id) => {
    if (recovering) throw new Error('恢复点操作正在进行，请稍候。');
    if (smoke) throw new Error('测试模式不使用系统凭据恢复点。');
    if (!['create', 'restore'].includes(action)) throw new Error('无效的恢复点操作');
    if (action === 'create' && (!service.child || service.state !== 'running')) throw new Error('创建新恢复点需要先启动桌面端管理的服务；启动失败时仍可选择已有恢复点。');
    if (service.state === 'external') throw new Error('请先正常退出其他 ContextFlow 服务，再进行恢复。');
    if (service.child && await service.busy()) throw new Error('请先完成或取消当前任务，再创建或恢复。');
    recovering = true;
    try {
      if (action === 'restore') {
        await validateRecoveryPoint(paths, id);
        const answer = await dialog.showMessageBox(window, { buttons: ['取消', '创建保护副本并恢复'], defaultId: 0, cancelId: 0,
          message: '恢复本机数据到这个时间点？', detail: '请先正常退出其他终端运行的旧版服务；历史 CLI 不支持数据占用锁，不能仅凭端口检测证明它已退出。\n\n恢复前会原样保护当前文件（包括损坏或缺失状态），验证失败会尝试回滚。只恢复本机服务记录、图片和配置，不回退浏览器授权或已写入笔记。恢复点仅适用于当前电脑的系统账号。' });
        if (answer.response !== 1) return false;
        return await restoreStoppedDesktop(paths, id, { service, safeStorage, appVersion: app.getVersion(),
          decodeConfig: (config, key) => transformSecrets(config, 'decode', key), acquireOwner: acquireDataOwner });
      }
      await service.stop();
      await service.startDone;
      if (await service.health()) throw new Error('仍有服务占用，未创建不一致的恢复点。');
      const owner = acquireDataOwner(paths.data, { kind: 'recovery' });
      let before;
      try { before = await createRecoveryPoint(paths, { appVersion: app.getVersion(),
        sealConfig: cfg => transformSecrets(transformSecrets(cfg, 'decode', service.secretKey), 'encode', service.secretKey) }); }
      finally { owner.release(); }
      await service.start();
      if (service.state !== 'running') throw new Error('恢复点已保存，但服务尚未重新启动。请检查本地连接。');
      return { ok: true, protectedBy: before.id };
    } catch (error) {
      if (action === 'create') await service.start();
      throw error;
    } finally { recovering = false; }
  });
  service.on('status', snapshot => { if (snapshot.state !== 'running') healthResponding = true; trayMenu(); });
  let stateNotice;
  service.on('changed', () => {
    if (stateNotice || quitting) return;
    stateNotice = setTimeout(() => {
      stateNotice = null;
      refreshNativeStatus().catch(() => {});
      if (window && !window.isDestroyed()) window.webContents.send('desktop:changed');
    }, 40);
  });
  service.on('status', snapshot => {
    if (snapshot.state === 'running') {
      request('/config').catch(() => {});
      if (!smoke) discovery.run().catch(() => {}).finally(() => service.emit('changed'));
    }
  });
  // Paint the first usable window before waiting for a core process or local
  // probes. Normal background login starts remain quiet unless setup is pending.
  service.update('starting', '正在为阅读准备本地连接…');
  try {
    const icon = loadTrayIcon({ nativeImage, directory: join(ROOT, 'ui'), warn: message => console.warn(message) });
    const helper = app.isPackaged ? join(process.resourcesPath, 'native', 'menu-bar') : join(ROOT, 'build', 'native', 'menu-bar');
    // userData does not isolate NSUserDefaults. Smoke uses a unique item and
    // only a volatile registration domain, never the installed item's key.
    const trayPreferences = smoke ? { registerDefaults: values => systemPreferences.registerDefaults(values),
      setUserDefault: () => { throw new Error('Smoke cannot persist menu-bar preferences'); } } : systemPreferences;
    menuBar = createMenuBar({ Tray, icon, systemPreferences: trayPreferences, ...(smoke ? { guid: randomUUID() } : {}), onOpen: show,
      readGeometry: () => readMenuBarGeometry(helper),
      onChange: () => { if (window && !window.isDestroyed()) window.webContents.send('desktop:changed'); } });
    tray = menuBar.getTray(); trayMenu();
    await menuBar.refresh({ reloadGeometry: true, repair: true });
    if (quitting) return;
    tray = menuBar.getTray();
    const displayChanged = () => menuBar.refresh({ reloadGeometry: true, repair: true }).catch(() => {});
    screen.on('display-added', displayChanged); screen.on('display-removed', displayChanged); screen.on('display-metrics-changed', displayChanged);
    powerMonitor.on('resume', () => { displayChanged(); refreshNativeStatus().catch(() => {}); });
    statusTimer = setInterval(() => refreshNativeStatus().catch(() => {}), 10000); statusTimer.unref();
  } catch (error) { console.warn('System tray unavailable:', error.message); }
  if (quitting) return;
  if (pendingShow || !process.argv.includes('--hidden') || !preferences.onboarding?.dismissed || smoke || !visibility.trayAvailable()
    || process.platform === 'darwin' && menuBar?.snapshot().trayPlacement !== 'clear') show();
  else if (process.platform === 'darwin') {
    // Cold login starts have no previous window/Dock transition to rely on.
    // Establish an independent launcher without waiting on LSUIElement.
    visibility.ensureLauncher().catch(() => show());
    const launcherCheck = setTimeout(() => { if (!quitting && !app.dock.isVisible()) show(); }, 1500); launcherCheck.unref();
  }
  if (!smoke) {
    try { bridgeReady = await registerHost(); } catch { bridgeReady = false; }
    if (quitting) return;
    await startBridge();
    if (quitting) { bridge?.close(); return; }
  }
  if (quitting) return;
  await service.start();
  if ((process.argv.includes('--hidden') && service.state !== 'running') || smoke) show();

  if (smoke) {
    // Tests opt in explicitly and use only disposable state; never evaluate
    // remote code or attach to the user's signed-in Chrome profile.
    const { runSmoke } = await import('./smoke.mjs');
    try { await runSmoke({ window, service, paths, discovery, lifecycle: {
      snapshot: systemIntegration, closeWindow: () => window.close(), reopenFromTray: () => menuBar.openFromMenu(),
      activate: () => app.emit('activate'), appPath: app.getAppPath(),
    } }); app.quit(); }
    catch (error) { console.error(error); quitting = true; clearInterval(statusTimer); await service.stop().catch(() => {}); menuBar?.destroy(); app.exit(1); }
  }
  }).catch(error => {
    console.error('Desktop startup failed:', error.message);
    if (!smoke) dialog.showErrorBox('ContextFlow 无法启动', error.message);
    app.exit(1);
  });
}
