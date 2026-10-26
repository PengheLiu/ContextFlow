// Actual Chromium loading is different from injecting the UI into a web page:
// the extension loader rejects Unicode noncharacters before JS can run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LIGHT, DARK } from '../src/core/design-tokens.js';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to a runtime containing playwright.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = join(root, 'release', 'product-evidence', 'theme-new');
mkdirSync(evidence, { recursive: true });
const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(channel => Number.parseInt(channel, 16)).join(', ')})`;
// Chromium serializes its BlinkMacSystemFont generic alias as system-ui.
const fonts = value => value.split(',').map(family => family.trim().replace(/^["']|["']$/g, '').replace(/^BlinkMacSystemFont$/, 'system-ui'));
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-extension-load-'));
const config = join(temporary, 'empty-config'); mkdirSync(config);
const fixture = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const dark = new URL(req.url, 'http://127.0.0.1').pathname.endsWith('/dark');
  res.end(`<!doctype html><meta charset="utf-8"><title>Extension loading fixture</title><style>html,body{background:${dark ? '#151515' : '#ffffff'};color:${dark ? '#eeeeee' : '#222222'};font:18px/1.8 sans-serif}body{margin:40px}</style><h1>Brier loss</h1><p>A squared probability error.</p>`);
});
let context;
try {
  await new Promise(ready => fixture.listen(0, '127.0.0.1', ready));
  for (const mode of ['development', 'store']) {
    const extension = join(temporary, mode);
    execFileSync(process.execPath, ['tools/build.mjs', '--ext', ...(mode === 'store' ? ['--store'] : [])], {
      cwd: root, env: { ...process.env, CONTEXTFLOW_DIR: config, CONTEXTFLOW_EXT_DIR: extension }, stdio: 'pipe',
    });
    context = await chromium.launchPersistentContext(join(temporary, `${mode}-profile`), {
      channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
      headless: true, viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.setDefaultTimeout(10000);
    const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', { predicate: w => w.url().startsWith('chrome-extension://'), timeout: 10000 });
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${fixture.address().port}/reading`);
    await page.locator('[data-contextflow="panel"]').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
    assert.equal(await page.locator('[data-contextflow="panel"]').locator('#wrap').isVisible(), true);
    assert.deepEqual(errors, [], `${mode} content script errors`);
    const options = await context.newPage();
    options.on('pageerror', error => errors.push(`options: ${error.message}`));
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#welcome-title').waitFor();
    assert.equal(await options.evaluate(() => chrome.runtime.id), id);
    for (const [tone, tokens] of [['light', LIGHT], ['dark', DARK]]) {
      await options.emulateMedia({ colorScheme: tone, reducedMotion: 'reduce' });
      const actual = await options.evaluate(() => {
        const root = getComputedStyle(document.documentElement), body = getComputedStyle(document.body);
        const cta = getComputedStyle(document.querySelector('#start-reading'));
        return { background: root.backgroundColor, text: body.color, accent: root.getPropertyValue('--cf-accent').trim(),
          font: body.fontFamily, headingFont: getComputedStyle(document.querySelector('#welcome-title')).fontFamily,
          eyebrow: getComputedStyle(document.querySelector('.welcome .eyebrow')).color,
          ctaBackground: cta.backgroundColor, ctaText: cta.color, ctaFont: cta.fontFamily };
      });
      assert.equal(actual.background, rgb(tokens.paper), `${mode} options ${tone}: paper`);
      assert.equal(actual.text, rgb(tokens.ink), `${mode} options ${tone}: ink`);
      assert.equal(actual.accent, tokens.accent, `${mode} options ${tone}: canonical brand token`);
      assert.equal(actual.eyebrow, rgb(tokens.accent), `${mode} options ${tone}: brand colour`);
      assert.equal(actual.ctaBackground, rgb(tokens.accent), `${mode} options ${tone}: primary action`);
      assert.equal(actual.ctaText, rgb(tokens['on-accent']), `${mode} options ${tone}: primary action contrast`);
      assert.deepEqual(fonts(actual.font), fonts(tokens['font-sans']), `${mode} options ${tone}: body font`);
      assert.deepEqual(fonts(actual.ctaFont), fonts(tokens['font-sans']), `${mode} options ${tone}: action font`);
      assert.deepEqual(fonts(actual.headingFont), fonts(tokens['font-serif']), `${mode} options ${tone}: editorial heading`);
      await options.screenshot({ path: join(evidence, `extension-${mode}-options-${tone}.png`) });
    }
    for (const [tone, os, tokens] of [['light', 'dark', LIGHT], ['dark', 'light', DARK]]) {
      await page.emulateMedia({ colorScheme: os, reducedMotion: 'reduce' });
      await page.goto(`http://127.0.0.1:${fixture.address().port}/reading/${tone}`);
      const host = page.locator('[data-contextflow="panel"]'), wrap = host.locator('#wrap');
      await host.waitFor({ state: 'attached' });
      if (!await wrap.isVisible()) await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
      await wrap.waitFor({ state: 'visible' });
      await page.waitForFunction(expected => document.querySelector('[data-contextflow="panel"]')?.dataset.theme === expected, tone);
      const actual = await host.evaluate(element => {
        const hostStyle = getComputedStyle(element), wrap = getComputedStyle(element.shadowRoot.querySelector('#wrap'));
        const brand = getComputedStyle(element.shadowRoot.querySelector('.brand-name em'));
        return { background: wrap.backgroundColor, text: wrap.color, font: wrap.fontFamily,
          accent: hostStyle.getPropertyValue('--cf-accent').trim(), brand: brand.color };
      });
      assert.equal(actual.background, rgb(tokens.paper), `${mode} panel ${tone} / OS ${os}: follows page canvas`);
      assert.equal(actual.text, rgb(tokens.ink), `${mode} panel ${tone}: ink`);
      assert.equal(actual.accent, tokens.accent, `${mode} panel ${tone}: canonical brand token`);
      assert.equal(actual.brand, rgb(tokens.accent), `${mode} panel ${tone}: brand colour`);
      assert.deepEqual(fonts(actual.font), fonts(tokens['font-sans']), `${mode} panel ${tone}: body font`);
      await page.screenshot({ path: join(evidence, `extension-${mode}-panel-${tone}-os-${os}.png`) });
    }
    assert.deepEqual(errors, [], `${mode}: no errors across theme changes`);
    console.log(`${mode}: Chromium ${context.browser().version()} 实际加载成功；service worker、阅读页 content script、设置页均通过`);
    console.log(`${mode}: 欢迎页明暗主题与真实注入面板的网页优先主题、共享品牌/字体/主按钮对比度通过`);
    await context.close(); context = null;
  }
} finally {
  await context?.close();
  await new Promise(done => fixture.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
