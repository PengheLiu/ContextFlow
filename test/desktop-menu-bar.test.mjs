import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMenuBar, inspectTrayPlacement, readMenuBarGeometry, TRAY_GUID } from '../desktop/menu-bar.mjs';

const bounds = (x = 1000, y = 0, width = 32, height = 33) => ({ x, y, width, height });
const screen = { frame: { x: 0, y: 0, width: 1728, height: 1117 },
  left: { x: 0, y: 0, width: 771, height: 32 }, right: { x: 956, y: 0, width: 772, height: 32 } };
const ordinary = { frame: { x: -1920, y: 0, width: 1920, height: 1080 }, left: null, right: null };
const positionKey = `NSStatusItem Preferred Position ${TRAY_GUID}`;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture({ platform = 'darwin', positions = [bounds()], readGeometry = async () => [screen], wait = async () => {}, defaultsFail = false, writeFail = false } = {}) {
  const calls = [], trays = [], changes = [], opened = [];
  class Tray {
    constructor(icon, guid) {
      this.index = trays.length; this.bounds = positions[Math.min(this.index, positions.length - 1)];
      this.destroyed = false; this.events = new Map(); trays.push(this); calls.push(['create', this.index, icon, guid]);
    }
    on(event, fn) { this.events.set(event, fn); }
    emit(event) { this.events.get(event)?.(); }
    isDestroyed() { return this.destroyed; }
    getBounds() { assert.equal(this.destroyed, false, '不得读取已销毁的原生项目'); return this.bounds; }
    closeContextMenu() { calls.push(['closeMenu', this.index]); }
    destroy() { this.destroyed = true; calls.push(['destroy', this.index]); }
    setContextMenu(menu) { this.menu = menu; calls.push(['menu', this.index, menu]); }
    setToolTip(text) { this.tooltip = text; calls.push(['tooltip', this.index, text]); }
  }
  const icon = {}, systemPreferences = {
    registerDefaults(values) { calls.push(['register', values]); if (defaultsFail) throw new Error('registration failed'); },
    setUserDefault(...args) { calls.push(['write', ...args]); if (writeFail) throw new Error('write failed'); },
  };
  const controller = createMenuBar({ Tray, icon, platform, systemPreferences, readGeometry, wait,
    onOpen: () => opened.push('open'), onChange: value => changes.push(value) });
  return { controller, calls, trays, changes, opened, icon };
}

test('the reported 829–861 status item is obscured by the 771–956 camera gap, despite nonempty bounds', () => {
  assert.equal(inspectTrayPlacement(bounds(829), [screen]), 'obscured');
  assert.equal(inspectTrayPlacement(bounds(829, 0, 32, 33), [screen]), 'obscured', '原生菜单栏比辅助区域多 1pt 也必须识别遮挡');
});

test('notch edges require the entire horizontal footprint to fit a safe region', () => {
  for (const [x, expected] of [[0, 'clear'], [739, 'clear'], [740, 'obscured'], [771, 'obscured'], [924, 'obscured'], [955, 'obscured'], [956, 'clear'], [1696, 'clear']]) {
    assert.equal(inspectTrayPlacement(bounds(x), [screen]), expected, `x=${x}`);
  }
  assert.equal(inspectTrayPlacement(bounds(829, 32), [screen]), 'clear', '缺口只影响屏幕顶部辅助区域');
  assert.equal(inspectTrayPlacement(bounds(829, 20), [screen]), 'obscured');
});

test('ordinary displays, negative display origins and a second display use their own geometry', () => {
  assert.equal(inspectTrayPlacement(bounds(-1800), [ordinary, screen]), 'clear');
  assert.equal(inspectTrayPlacement(bounds(-100), [screen, ordinary]), 'clear');
  assert.equal(inspectTrayPlacement(bounds(-10), [screen, ordinary]), 'offscreen', '跨显示器但未完整落在任一屏幕不能冒充安全');
  assert.equal(inspectTrayPlacement(bounds(829), [ordinary, screen]), 'obscured');
  const upper = { frame: { x: 0, y: -1080, width: 1920, height: 1080 }, left: null, right: null };
  assert.equal(inspectTrayPlacement(bounds(300, -1080), [screen, upper]), 'clear');
});

test('invalid bounds are unavailable, unknown geometry is honest, and offscreen rectangles do not pass', () => {
  for (const value of [null, undefined, {}, bounds(0, 0, 0), bounds(0, 0, -1), bounds(NaN), bounds(0, Infinity)]) {
    assert.equal(inspectTrayPlacement(value, [screen]), 'unavailable');
  }
  for (const geometry of [null, undefined, [], 'not screens']) assert.equal(inspectTrayPlacement(bounds(), geometry), 'unknown');
  for (const value of [bounds(1720), bounds(1800), bounds(-3000), bounds(1000, -1), bounds(1000, 1117), bounds(1000, 1110)]) {
    assert.equal(inspectTrayPlacement(value, [screen]), 'offscreen');
  }
  assert.doesNotThrow(() => inspectTrayPlacement(bounds(), [null, screen]));
});

test('geometry helper is bounded, returns only validated screen data and never requires permissions', async () => {
  let invocation;
  const value = await readMenuBarGeometry('/own-app/menu-bar-geometry', async (...args) => {
    invocation = args; return { stdout: JSON.stringify({ screens: [screen, ordinary] }) };
  });
  assert.deepEqual(value, [screen, ordinary]);
  assert.deepEqual(invocation, ['/own-app/menu-bar-geometry', [], { timeout: 2500, maxBuffer: 32768, encoding: 'utf8', windowsHide: true }]);
  for (const stdout of ['bad json', '{}', '{"screens":{}}', JSON.stringify({ screens: [null] }),
    JSON.stringify({ screens: [{ ...screen, left: bounds(0, 0, 0) }] }),
    JSON.stringify({ screens: [{ frame: bounds(NaN), left: null, right: null }] }),
    JSON.stringify({ screens: Array.from({ length: 33 }, () => screen) })]) {
    assert.equal(await readMenuBarGeometry('/own-app/helper', async () => ({ stdout })), null);
  }
  assert.equal(await readMenuBarGeometry('/own-app/helper', async () => { throw new Error('timeout'); }), null);
});

test('initial macOS placement only registers a volatile own-item default, preserving saved drag positions', async () => {
  const f = fixture();
  assert.deepEqual(f.calls[0], ['register', { [positionKey]: 0 }]);
  assert.deepEqual(f.calls[1], ['create', 0, f.icon, TRAY_GUID]);
  const status = await f.controller.refresh({ repair: true });
  assert.equal(status.trayPlacement, 'clear'); assert.equal(status.trayAvailable, true);
  assert.equal(f.calls.some(row => row[0] === 'write'), false, '安全位置不覆盖用户拖动后的持久位置');
  assert.equal(f.trays.length, 1);
});

test('a confirmed camera gap is repaired once by destroying before changing only the own-app preference', async () => {
  const waits = [], f = fixture({ positions: [bounds(829), bounds(1465)], wait: async ms => waits.push(ms) });
  const menu = { getMenuItemById: () => ({ enabled: true, click: () => f.opened.push('menu-open') }) };
  f.controller.setMenu(menu, 'ContextFlow · 已就绪');
  const before = await f.controller.refresh(); assert.equal(before.trayPlacement, 'obscured');
  assert.equal(f.calls.some(row => row[0] === 'write'), false, '诊断不隐式移动图标');
  const fixed = await f.controller.refresh({ repair: true }); assert.equal(fixed.trayPlacement, 'clear');
  assert.equal(f.trays.length, 2); assert.deepEqual(waits, [300]);
  const destroy = f.calls.findIndex(row => row[0] === 'destroy'), write = f.calls.findIndex(row => row[0] === 'write'), recreate = f.calls.findIndex(row => row[0] === 'create' && row[1] === 1);
  assert.ok(destroy >= 0 && destroy < write && write < recreate);
  assert.deepEqual(f.calls[write], ['write', positionKey, 'double', 0]);
  assert.equal(f.trays[1].menu, menu); assert.equal(f.trays[1].tooltip, 'ContextFlow · 已就绪');
  assert.deepEqual(f.opened, [], '菜单栏恢复不抢焦点/打开窗口');
  f.trays[1].bounds = bounds(829);
  await f.controller.refresh({ repair: true });
  assert.equal(f.trays.length, 2); assert.equal(f.calls.filter(row => row[0] === 'write').length, 1);
});

test('confirmed offscreen placement can be repaired, but unavailable or unknown data cannot authorize writes', async () => {
  const offscreen = fixture({ positions: [bounds(1900), bounds(1465)] });
  assert.equal((await offscreen.controller.refresh({ repair: true })).trayPlacement, 'clear');
  assert.equal(offscreen.trays.length, 2);
  for (const options of [{ positions: [bounds(100, 0, 0)] }, { readGeometry: async () => null }, { readGeometry: async () => [] }]) {
    const f = fixture(options); await f.controller.refresh({ repair: true });
    assert.equal(f.trays.length, 1); assert.equal(f.calls.some(row => row[0] === 'write'), false);
  }
});

test('helper errors and registration/write failures preserve a usable controller and honest unknown status', async () => {
  const unavailable = fixture({ defaultsFail: true, readGeometry: async () => { throw new Error('helper missing'); } });
  assert.equal((await unavailable.controller.refresh({ repair: true })).trayPlacement, 'unknown');
  assert.equal(unavailable.trays.length, 1); assert.equal(unavailable.calls.some(row => row[0] === 'write'), false);
  const refused = fixture({ positions: [bounds(829), bounds(1465)], writeFail: true });
  assert.equal((await refused.controller.refresh({ repair: true })).trayPlacement, 'clear');
  assert.equal(refused.trays.length, 2, '偏好写入失败也需重建已销毁的本应用图标');
});

test('native bounds failure is unavailable, not proof of visibility', async () => {
  const f = fixture(); f.trays[0].getBounds = () => { throw new Error('native item unavailable'); };
  assert.equal(f.controller.snapshot().trayAvailable, false);
  assert.equal((await f.controller.refresh({ repair: true })).trayPlacement, 'unavailable');
  assert.equal(f.calls.some(row => row[0] === 'write'), false);
});

test('macOS tray clicks open only the context menu; explicit enabled menu action opens the window', () => {
  const f = fixture(); f.trays[0].emit('click'); assert.deepEqual(f.opened, []);
  f.controller.setMenu({ getMenuItemById: id => id === 'open' ? { enabled: false, click: () => f.opened.push('disabled') } : undefined }, 'ContextFlow');
  f.controller.openFromMenu(); assert.deepEqual(f.opened, []);
  f.controller.setMenu({ getMenuItemById: id => id === 'open' ? { enabled: true, click: () => f.opened.push('menu-open') } : undefined }, 'ContextFlow');
  f.controller.openFromMenu(); assert.deepEqual(f.opened, ['menu-open']);
});

test('health polls reuse the same native menu without reattaching or collapsing an open menu', async () => {
  const f = fixture(), menu = { getMenuItemById: () => undefined };
  f.controller.setMenu(menu, 'ContextFlow · 本地服务运行中');
  const first = f.calls.length;
  for (let tick = 0; tick < 3; tick++) {
    f.controller.setMenu(menu, 'ContextFlow · 本地服务运行中');
    await f.controller.refresh();
  }
  assert.equal(f.calls.length, first, '轮询既不重复附加同一菜单，也不重复刷新同一 tooltip');
  f.controller.setMenu(menu, 'ContextFlow · 本地服务暂未响应');
  assert.equal(f.calls.filter(row => row[0] === 'menu').length, 1, '同一 Menu 原地更新条目不应重设 context menu');
  assert.equal(f.trays[0].tooltip, 'ContextFlow · 本地服务暂未响应');
  f.controller.setMenu({ getMenuItemById: () => undefined }, 'ContextFlow · 本地服务暂未响应');
  assert.equal(f.calls.filter(row => row[0] === 'menu').length, 2, '新的 Menu 实例仍须正常附加');
});

test('Windows keeps click-to-open and never reads macOS geometry or writes user defaults', async () => {
  const f = fixture({ platform: 'win32', readGeometry: async () => { throw new Error('not on Windows'); } });
  assert.equal((await f.controller.refresh({ repair: true, reloadGeometry: true })).trayPlacement, 'unknown');
  assert.equal(f.calls.some(row => ['write', 'register'].includes(row[0])), false);
  f.trays[0].emit('click'); assert.deepEqual(f.opened, ['open']);
});

test('destruction while awaiting geometry never repairs or resurrects a tray', async () => {
  const gate = deferred(), f = fixture({ positions: [bounds(829)], readGeometry: () => gate.promise });
  const refresh = f.controller.refresh({ repair: true });
  f.controller.destroy(); gate.resolve([screen]);
  const result = await refresh;
  assert.equal(result.trayAvailable, false); assert.equal(f.trays.length, 1);
  assert.equal(f.calls.some(row => row[0] === 'write'), false); assert.deepEqual(f.changes, []);
  await f.controller.refresh({ repair: true }); assert.equal(f.trays.length, 1);
});

test('destruction during repair settle never publishes a live tray or recreates it again', async () => {
  const gate = deferred(), f = fixture({ positions: [bounds(829), bounds(1465)], wait: () => gate.promise });
  const refresh = f.controller.refresh({ repair: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.trays.length, 2); f.controller.destroy(); gate.resolve();
  const result = await refresh;
  assert.equal(result.trayAvailable, false); assert.equal(f.trays[1].destroyed, true); assert.deepEqual(f.changes, []);
  await f.controller.refresh({ repair: true }); assert.equal(f.trays.length, 2);
});

test('concurrent refreshes share one native probe and cached geometry refreshes explicitly', async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture({ readGeometry: () => { calls++; return calls === 1 ? gate.promise : Promise.resolve([screen]); } });
  const first = f.controller.refresh(), second = f.controller.refresh(); gate.resolve([screen]);
  assert.deepEqual(await first, await second); assert.equal(calls, 1); assert.equal(f.changes.length, 1);
  await f.controller.refresh(); assert.equal(calls, 1);
  await f.controller.refresh({ reloadGeometry: true }); assert.equal(calls, 2);
});

test('a display change during an in-flight probe is replayed instead of caching obsolete geometry', async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture({ positions: [bounds(829)], readGeometry: () => {
    calls++; return calls === 1 ? gate.promise : Promise.resolve([{ frame: { x: 0, y: 0, width: 1728, height: 1117 }, left: null, right: null }]);
  } });
  const first = f.controller.refresh();
  const changed = f.controller.refresh({ reloadGeometry: true });
  gate.resolve([screen]);
  assert.equal((await first).trayPlacement, 'clear');
  assert.equal((await changed).trayPlacement, 'clear');
  assert.equal(calls, 2);
  assert.equal(f.changes.length, 1, 'publish the settled geometry, not an obsolete intermediate frame');
});
