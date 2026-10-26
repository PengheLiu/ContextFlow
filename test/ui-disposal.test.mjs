import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Panel } from '../src/skill/panel.js';
import { Popover, ticker } from '../src/skill/popover.js';
import { CommentPopover } from '../src/skill/comment-popover.js';
import { MarkDeleteControl } from '../src/skill/mark-delete.js';
import { BlockControl } from '../src/skill/blocklist.js';
import { shadowHost, releaseThemeHost } from '../src/skill/theme.js';

const dom = new JSDOM('<!doctype html><html><body><button id="before">before</button><button id="next">next</button></body></html>', { pretendToBeVisual: true, url: 'https://fixture.invalid/reading' });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Range', 'getComputedStyle', 'localStorage', 'location']) globalThis[key] = dom.window[key];
globalThis.innerWidth = 1400; globalThis.innerHeight = 900;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rect = { left: 100, top: 200, bottom: 220, right: 300, width: 200, height: 20 };
const handlers = () => ({ getItems: () => [], getStats: () => ({ position: 0, quote: 0, fuzzy: 0, orphan: 0 }), getNote: () => '',
  isOnline: () => true, outbox: () => 0, positionOf: () => 0, isOrphan: () => false, getLookups: () => [], api: {} });
after(() => dom.window.close());

test('Panel retirement removes resize work, cancels active drag, restores page styles and preserves open memory', async () => {
  localStorage.clear(); const root = document.documentElement;
  root.style.marginRight = '12px'; root.style.transition = 'color .2s ease'; root.style.userSelect = 'text';
  const initial = { margin: root.style.marginRight, transition: root.style.transition };
  const panel = new Panel(handlers()); panel.toggle(true, false);
  const remembered = localStorage.getItem('contextflow:ui'); assert.equal(JSON.parse(remembered).open, true);
  panel.$('grab').dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 300, button: 0 }));
  assert.equal(root.style.userSelect, 'none');
  let resized = 0, delayed = 0; panel.applyLayout = () => resized++;
  panel._hitTimer = setTimeout(() => delayed++, 5); panel.syncLabelTimer = setTimeout(() => delayed++, 5);
  panel.dispose(); panel.dispose();
  window.dispatchEvent(new window.Event('resize'));
  await pause(20);
  assert.equal(resized, 0); assert.equal(delayed, 0); assert.equal(panel.events.cleanups.size, 0);
  assert.equal(root.style.marginRight, initial.margin); assert.equal(root.style.transition, initial.transition); assert.equal(root.style.userSelect, 'text');
  assert.equal(localStorage.getItem('contextflow:ui'), remembered); assert.equal(panel.sh.host.isConnected, false);
});
test('An old panel transition cannot overwrite the next SPA panel after disposal', async () => {
  localStorage.clear(); const root = document.documentElement; root.style.marginRight = '9px'; root.style.transition = 'color .1s ease';
  const first = new Panel(handlers()); first.toggle(true, false); first.toggle(false, false); first.dispose();
  const second = new Panel(handlers()); second.toggle(true, false);
  const transition = root.style.transition, margin = root.style.marginRight;
  try { await pause(310); assert.equal(root.style.transition, transition); assert.equal(root.style.marginRight, margin); }
  finally { second.dispose(); }
});
test('Popover retirement revokes ticker and window gestures without committing or restoring old focus', async () => {
  let commits = 0;
  const before = document.getElementById('before'), next = document.getElementById('next'); before.focus();
  const pop = new Popover({ name: 'dispose-popover', title: '解释', input: true, supplement: true, onSupplementCommit: () => commits++ });
  pop.open(rect).supplement('old-record');
  const text = pop.supplementComposer.list.querySelector('.rc-text'); text.value = 'root will flush this separately'; text.dispatchEvent(new window.Event('input'));
  const tk = ticker(pop); pop.$('q').focus();
  let focusRestored = 0; const originalFocus = before.focus; before.focus = () => focusRestored++;
  pop.$('hd').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 110, clientY: 110 }));
  window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 300, clientY: 350 })); const left = pop.el.style.left;
  pop.focus('late focus'); pop.dispose(); next.focus();
  window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 700, clientY: 750 })); window.dispatchEvent(new window.MouseEvent('mouseup'));
  await pause(650);
  assert.equal(pop.el.style.left, left); assert.equal(tk.current, false); assert.equal(commits, 0); assert.equal(focusRestored, 0);
  assert.equal(document.activeElement, next); assert.equal(pop.sh.host.isConnected, false); assert.equal(pop.events.cleanups.size, 0);
  before.focus = originalFocus;
});
test('Comment retirement cancels composer debounce without saving again or invoking the old close callback', async () => {
  let commits = 0, closes = 0;
  const pop = new CommentPopover({ onCommit: () => commits++, onClose: () => closes++ });
  pop.open(rect, { id: 'old-comment' });
  pop.input.value = 'typed draft'; pop.input.dispatchEvent(new window.Event('input'));
  pop.dispose(); pop.dispose();
  document.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await pause(550);
  assert.equal(commits, 0); assert.equal(closes, 0); assert.equal(pop.events.cleanups.size, 0); assert.equal(pop.sh.host.isConnected, false);
});
test('Retired deletion/block controls no longer observe global input; released hosts leave theme tracking', async () => {
  const mark = new MarkDeleteControl(() => {}), block = new BlockControl(() => {});
  mark.show('old-mark', rect); block.show(rect); mark.dispose(); block.dispose();
  let events = 0; mark.hide = block.hide = () => events++;
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new window.Event('scroll')); window.dispatchEvent(new window.Event('resize'));
  assert.equal(events, 0); assert.equal(mark.sh.host.isConnected, false); assert.equal(block.sh.host.isConnected, false);
  document.body.style.background = 'rgb(255,255,255)';
  const sh = shadowHost('released-theme-probe', ''); assert.equal(sh.host.dataset.theme, 'light');
  releaseThemeHost(sh); sh.host.remove(); document.body.style.background = 'rgb(20,20,20)'; await pause(40);
  assert.equal(sh.host.dataset.theme, 'light', 'a removed host is not retained and updated by the shared theme observer');
  document.body.style.background = 'rgb(255,255,255)';
});
