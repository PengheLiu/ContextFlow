import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trayMenuTemplate } from '../desktop/tray-menu.mjs';

const callbacks = () => ({ onOpen() {}, onSettings() {}, onRestart() {}, onQuit() {} });
const item = (menu, id) => menu.find(entry => entry.id === id);

test('tray status distinguishes every service state without echoing a raw message', () => {
  const expected = new Map([
    ['starting', '本地服务正在启动…'], ['running', '本地服务运行中'],
    ['stopped', '本地服务已停止'], ['stopping', '本地服务正在停止…'],
    ['external', '旧版服务或端口占用'], ['error', '本地服务需要处理'],
    ['unavailable', '本地服务暂未响应'],
  ]);
  const seen = new Set();
  for (const [state, label] of expected) {
    const menu = trayMenuTemplate({ service: { state, message: '/private/user/notes API_KEY=secret' }, ...callbacks() });
    const status = item(menu, 'service-status');
    assert.equal(status.label, label); assert.equal(status.enabled, false);
    assert.equal(status.click, undefined); seen.add(status.label);
    assert.ok(!JSON.stringify(menu).includes('secret'));
  }
  assert.equal(seen.size, expected.size, '启动、停止与故障不能合并成含糊的“需要处理”');
});

test('tray shows safe running and queued task counts, including real zeroes', () => {
  for (const [running, queued] of [[0, 0], [2, 5], [1, 0], [0, 3]]) {
    const menu = trayMenuTemplate({ service: { state: 'running', health: { jobs: { running, queued } } }, ...callbacks() });
    const status = item(menu, 'tasks-status');
    assert.equal(status.label, `任务：运行中 ${running} · 排队 ${queued}`);
    assert.equal(status.enabled, false); assert.equal(status.click, undefined);
    assert.equal(item(menu, 'restart').enabled, running === 0 && queued === 0);
    assert.equal(item(menu, 'quit').enabled, true, '有任务时也必须能进入主进程的退出确认流程');
  }
});

test('starting and stopping prevent duplicate restarts even when reported task counts are zero', () => {
  for (const state of ['starting', 'stopping']) {
    const menu = trayMenuTemplate({ service: { state, health: { jobs: { running: 0, queued: 0 } } }, ...callbacks() });
    assert.equal(item(menu, 'restart').enabled, false);
    assert.equal(item(menu, 'open').enabled, true);
    assert.equal(item(menu, 'settings').enabled, true);
    assert.equal(item(menu, 'quit').enabled, true);
  }
});

test('unknown task counts are not invented as zero or coerced from unsafe values', () => {
  for (const value of [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', '<private>', {}, []]) {
    const menu = trayMenuTemplate({ service: { state: 'running', health: { jobs: { running: value, queued: value } } }, ...callbacks() });
    assert.equal(item(menu, 'tasks-status').label, '任务状态待确认');
    assert.ok(!JSON.stringify(menu).includes('<private>'));
  }
  const menu = trayMenuTemplate({ service: { state: 'running', health: { jobs: { running: 2 } } }, ...callbacks() });
  assert.equal(item(menu, 'tasks-status').label, '任务：运行中 2 · 排队 待确认');
  assert.equal(item(menu, 'restart').enabled, false, '部分任务状态未知也不能忽略已知的运行任务');
});

test('menu is deterministic, does not mutate the snapshot or call actions while building', () => {
  const calls = [];
  const handlers = Object.fromEntries(['Open', 'Settings', 'Restart', 'Quit'].map(name => ['on' + name, () => calls.push(name)]));
  const service = Object.freeze({ state: 'running', health: Object.freeze({ jobs: Object.freeze({ running: 0, queued: 0 }) }) });
  const menu = trayMenuTemplate({ service, ...handlers });
  assert.deepEqual(menu, trayMenuTemplate({ service, ...handlers })); assert.deepEqual(calls, []);
  assert.equal(item(menu, 'heading').label, 'ContextFlow'); assert.equal(item(menu, 'heading').enabled, false);
  assert.deepEqual(menu.filter(entry => entry.click).map(entry => entry.id), ['open', 'settings', 'restart', 'quit']);
  for (const id of ['open', 'settings', 'restart', 'quit']) item(menu, id).click();
  assert.deepEqual(calls, ['Open', 'Settings', 'Restart', 'Quit']);
  assert.equal(item(menu, 'quit').role, undefined, '退出不能绕过注入的主进程保护逻辑');
});

test('missing callbacks cannot leave enabled controls that silently do nothing', () => {
  const menu = trayMenuTemplate();
  for (const id of ['open', 'settings', 'restart', 'quit']) {
    assert.equal(item(menu, id).enabled, false); assert.equal(item(menu, id).click, undefined);
  }
  assert.equal(item(menu, 'service-status').label, '本地服务状态未知');
  assert.equal(item(menu, 'tasks-status').label, '任务状态待确认');
});

test('raw failures, inherited state names and unrelated personal fields never reach native labels', () => {
  const sensitive = '/Users/example/Private Vault API_KEY=sk-private https://private.example/secret';
  for (const state of [sensitive, 'constructor', '__proto__', { toString: () => sensitive }]) {
    const service = { state, message: sensitive, error: sensitive, path: sensitive, config: { token: sensitive },
      health: { jobs: { running: 0, queued: 0, name: sensitive }, notes: sensitive } };
    const menu = trayMenuTemplate({ service, ...callbacks() });
    assert.equal(item(menu, 'service-status').label, '本地服务状态未知');
    assert.ok(!JSON.stringify(menu).includes(sensitive));
    assert.ok(!menu.some(entry => entry.toolTip || entry.sublabel), '不通过辅助文本泄露原始细节');
  }
});
