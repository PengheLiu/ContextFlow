// Static pages stay script-free. This generated prefix is their bridge to the
// same token module used by the extension's Shadow UI. Builds reject drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LIGHT, rootThemeCSS } from '../src/core/design-tokens.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export const surfaces = Object.freeze([
  { path: 'desktop/ui/styles.css', systemDark: false },
  { path: 'extension/options.css', systemDark: true },
  { path: 'store/site.css', systemDark: false },
  { path: 'store/privacy.html', systemDark: false, html: true },
  { path: 'store/demo.html', systemDark: false, html: true },
]);
// Native window startup and browser toolbar metadata cannot consume CSS vars.
// Keep these small literals generated from the same canvas token as well.
export const canvasPins = Object.freeze([
  { path: 'desktop/main.mjs', pattern: /(backgroundColor: ')(#[a-f\d]{6})(')/i },
  { path: 'store/index.html', pattern: /(<meta name="theme-color" content=")(#[a-f\d]{6})(")/i },
  { path: 'store/download.html', pattern: /(<meta name="theme-color" content=")(#[a-f\d]{6})(")/i },
]);
export function synchronizedCanvas(source, pin) {
  if (!pin.pattern.test(source)) throw new Error(`Missing canvas token: ${pin.path}`);
  return source.replace(pin.pattern, (_match, before, _color, after) => before + LIGHT.paper + after);
}
const start = '/* ContextFlow shared tokens — generated; edit src/core/design-tokens.js */';
const end = '/* End ContextFlow shared tokens */';
export function generatedBlock(surface) { return `${start}\n${rootThemeCSS(surface)}${end}\n`; }
export function synchronizedSource(source, surface) {
  const from = source.indexOf(start), to = source.indexOf(end);
  // Windows Git checkouts may use CRLF. Keep source line endings while checking
  // the generated values, rather than falsely reporting every block as stale.
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const block = generatedBlock(surface).replaceAll('\n', newline);
  if (from !== -1 || to !== -1) {
    if (from < 0 || to < from || source.indexOf(start, from + start.length) !== -1) throw new Error(`Malformed token block: ${surface.path}`);
    return source.slice(0, from) + block + source.slice(to + end.length).replace(/^\r?\n/, '');
  }
  if (surface.html) {
    if (!source.includes('<style>')) throw new Error(`Missing style block: ${surface.path}`);
    return source.replace('<style>', `<style>${newline}${block}`);
  }
  return block + source;
}
export function checkDesignTokens() {
  for (const surface of surfaces) {
    const source = readFileSync(resolve(root, surface.path), 'utf8');
    if (synchronizedSource(source, surface) !== source) throw new Error(`Shared theme out of date: ${surface.path}. Run npm run design:sync.`);
  }
  for (const pin of canvasPins) {
    const source = readFileSync(resolve(root, pin.path), 'utf8');
    if (synchronizedCanvas(source, pin) !== source) throw new Error(`Canvas out of date: ${pin.path}. Run npm run design:sync.`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    for (const surface of surfaces) {
      const path = resolve(root, surface.path), source = readFileSync(path, 'utf8');
      const updated = synchronizedSource(source, surface);
      if (updated !== source) writeFileSync(path, updated);
    }
    for (const pin of canvasPins) {
      const path = resolve(root, pin.path), source = readFileSync(path, 'utf8');
      const updated = synchronizedCanvas(source, pin);
      if (updated !== source) writeFileSync(path, updated);
    }
  }
  checkDesignTokens();
  console.log('Shared design tokens: all 5 static surfaces are in sync.');
}
