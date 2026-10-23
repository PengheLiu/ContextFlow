import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVisibility } from '../desktop/visibility.mjs';
import { launchIdentity, sameLaunch, needsInstanceNotice } from '../desktop/instance.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ platform = 'darwin', dock = false, show } = {}) {
  let tray = { isDestroyed: () => false, getBounds: () => ({ x: 28, y: 0, width: 22, height: 22 }) };
  let visible = true, minimized = false, destroyed = false;
  const calls = [], service = Object.freeze({ state: 'running', pid: 2468 });
  const app = { dock: {
    isVisible: () => dock,
    show: () => { calls.push('dock:show'); return show ? show(() => { dock = true; }) : Promise.resolve().then(() => { dock = true; }); },
    hide: () => assert.fail('关闭窗口不得移除独立的 Dock 入口'),
  }, quit: () => assert.fail('关闭窗口不等于退出应用或服务') };
  const window = {
    isDestroyed: () => destroyed, isMinimized: () => minimized,
    show: () => { visible = true; calls.push('show'); }, showInactive: () => { visible = true; calls.push('showInactive'); },
    focus: () => calls.push('focus'), restore: () => { minimized = false; calls.push('restore'); },
    hide: () => { visible = false; calls.push('hide'); }, minimize: () => { minimized = true; calls.push('minimize'); },
    close: () => assert.fail('应隐藏既有窗口而不是关闭或销毁'), destroy: () => assert.fail('关闭窗口不应销毁阅读设置'),
  };
  const visibility = createVisibility({ app, platform, getTray: () => tray });
  return { visibility, window, calls, service, dock: () => dock, visible: () => visible, minimized: () => minimized,
    setTray: value => { tray = value; }, setDock: value => { dock = value; }, setDestroyed: value => { destroyed = value; } };
}

test('Mac close hides only the window, preserves Dock and service, and reopens the same window', async () => {
  const f = fixture(); await f.visibility.present(f.window); await settle(); assert.equal(f.dock(), true);
  const service = f.service;
  assert.equal(f.visibility.closeToBackground(f.window), true); assert.equal(f.visible(), false);
  assert.equal(f.dock(), true); assert.equal(f.minimized(), false); assert.equal(f.service, service);
  assert.deepEqual(f.service, { state: 'running', pid: 2468 });
  await f.visibility.present(f.window); assert.equal(f.visible(), true); assert.equal(f.calls.at(-1), 'focus');
  assert.equal(f.calls.filter(call => call === 'dock:show').length, 1, '有效 Dock 不应在每次重开时重复触发原生过渡');
});

test('Mac close keeps Dock independently of a valid, missing or occluded menu-bar item', async () => {
  for (const tray of [null, { isDestroyed: () => false, getBounds: () => ({ x: 500, y: 0, width: 22, height: 22 }) }]) {
    const f = fixture({ dock: true }); f.setTray(tray);
    assert.equal(f.visibility.closeToBackground(f.window), true);
    await settle(); assert.equal(f.visible(), false); assert.equal(f.dock(), true); assert.equal(f.minimized(), false);
    assert.deepEqual(f.calls, ['hide'], 'Mac 关闭策略不依赖托盘是否创建或可见');
  }
});

test('presentation paints a packaged LSUIElement window without awaiting the Dock promise', async () => {
  const pending = deferred(); const f = fixture({ show: () => pending.promise });
  f.visibility.closeToBackground(f.window);
  await f.visibility.present(f.window); await settle();
  assert.equal(f.visible(), true); assert.ok(f.calls.includes('show')); assert.ok(f.calls.includes('focus'));
  assert.equal(f.calls.filter(call => call === 'dock:show').length, 1, '同时打开与关闭应共用一个在途 show');
  f.setDock(true); pending.resolve(); await settle();
  assert.equal(f.visible(), true, '较早的关闭请求不能在 Dock 最终出现时隐藏重新打开的窗口');
});

test('Mac first restores a missing Dock before completing an outstanding close request', async () => {
  const pending = deferred(); const f = fixture({ show: () => pending.promise });
  assert.equal(f.visibility.closeToBackground(f.window), false, '尚未完成的异步关闭不能声称窗口已隐藏');
  await settle(); assert.equal(f.visible(), true); assert.equal(f.minimized(), false);
  f.setDock(true); pending.resolve(); await settle();
  assert.equal(f.visible(), false); assert.equal(f.dock(), true); assert.equal(f.calls.at(-1), 'hide');
});

test('a late Dock show follows only the newest rapid close/reopen intent', async () => {
  const pending = deferred(); const f = fixture({ show: () => pending.promise });
  await f.visibility.present(f.window);
  f.visibility.closeToBackground(f.window); await f.visibility.present(f.window); f.visibility.closeToBackground(f.window);
  await settle(); assert.equal(f.visible(), true); assert.equal(f.calls.filter(call => call === 'dock:show').length, 1);
  f.setDock(true); pending.resolve(); await settle();
  assert.equal(f.visible(), false); assert.equal(f.dock(), true);
  assert.equal(f.calls.filter(call => call === 'hide').length, 1, '只执行最后一个仍有效的关闭请求');
  await f.visibility.present(f.window); assert.equal(f.visible(), true); assert.equal(f.dock(), true);
});

test('Dock failure or an unsuccessful native visibility readback keeps the only window available', async () => {
  for (const show of [() => Promise.reject(new Error('unavailable')), () => { throw new Error('sync failure'); }, () => Promise.resolve()]) {
    const f = fixture({ show });
    assert.equal(f.visibility.closeToBackground(f.window), false); await settle();
    assert.equal(f.visible(), true); assert.equal(f.minimized(), false); assert.ok(!f.calls.includes('hide'));
    await f.visibility.present(f.window); await settle();
    assert.equal(f.visible(), true); assert.ok(f.calls.includes('show'), '恢复 Dock 失败也不能阻塞应用窗口');
  }
});

test('a failed native Dock request can be retried and destroyed windows are never acted on later', async () => {
  let attempts = 0;
  const f = fixture({ show: showDock => ++attempts === 1 ? Promise.reject(new Error('first failure')) : Promise.resolve().then(showDock) });
  f.visibility.closeToBackground(f.window); await settle(); assert.equal(f.visible(), true);
  f.visibility.closeToBackground(f.window); await settle(); assert.equal(f.visible(), false); assert.equal(f.dock(), true);
  assert.equal(attempts, 2);
  const pending = deferred(), destroyed = fixture({ show: () => pending.promise });
  destroyed.visibility.closeToBackground(destroyed.window); destroyed.setDestroyed(true); destroyed.setDock(true);
  pending.resolve(); await settle(); assert.ok(!destroyed.calls.includes('hide'));
  assert.equal(destroyed.visibility.closeToBackground(destroyed.window), false);
  await destroyed.visibility.present(destroyed.window); assert.ok(!destroyed.calls.includes('show'));
});

test('nonfocusing reopen restores a minimized window without forcing activation', async () => {
  const f = fixture({ dock: true }); f.window.minimize();
  await f.visibility.present(f.window, { focus: false });
  assert.deepEqual(f.calls, ['minimize', 'restore', 'showInactive']); assert.equal(f.minimized(), false);
});

test('Windows and other platforms hide to a valid tray and otherwise retain a minimized launcher', async () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture({ platform }); await f.visibility.present(f.window);
    assert.equal(f.visibility.closeToBackground(f.window), true); assert.equal(f.visible(), false);
    await f.visibility.present(f.window); f.setTray(null);
    assert.equal(f.visibility.closeToBackground(f.window), false); assert.equal(f.visible(), true); assert.equal(f.minimized(), true);
    assert.ok(!f.calls.some(call => call.startsWith('dock:')));
  }
});

test('trayAvailable means only a native item with finite valid bounds, never physical visibility', () => {
  const f = fixture(); assert.equal(f.visibility.trayAvailable(), true);
  for (const bounds of [null, {}, { width: 20, height: 20 }, { x: 1, y: 0, width: 0, height: 20 },
    { x: 1, y: 0, width: 20, height: -1 }, { x: 1, y: 0, width: '20', height: 20 },
    { x: NaN, y: 0, width: 20, height: 20 }, { x: 1, y: 0, width: Infinity, height: 20 }]) {
    f.setTray({ isDestroyed: () => false, getBounds: () => bounds }); assert.equal(f.visibility.trayAvailable(), false);
  }
  for (const tray of [null, { isDestroyed: () => true }, { isDestroyed: () => { throw new Error('unavailable'); } },
    { isDestroyed: () => false, getBounds: () => { throw new Error('unavailable'); } }]) {
    f.setTray(tray); assert.equal(f.visibility.trayAvailable(), false);
  }
  f.setTray({ isDestroyed: () => false, getBounds: () => ({ x: -1600, y: -900, width: 20, height: 20 }) });
  assert.equal(f.visibility.trayAvailable(), true, '副屏负坐标也合法，但不证明用户能看到图标');
});

test('single-instance identity distinguishes same-version builds and legacy owners', () => {
  const current = launchIdentity({ executable: '/Applications/ContextFlow.app/Contents/MacOS/ContextFlow', version: '1.0.0', build: 'new' });
  assert.equal(sameLaunch(current, { ...current }), true);
  assert.equal(needsInstanceNotice(current, { ...current, build: 'old' }), true);
  assert.equal(needsInstanceNotice(current, { ...current, executable: '/build/ContextFlow' }), true);
  assert.equal(needsInstanceNotice(current, { pid: 10 }), true);
});
