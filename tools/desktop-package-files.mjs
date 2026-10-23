import assert from 'node:assert/strict';

export const REQUIRED_DESKTOP_ARCHIVE_FILES = Object.freeze([
  'main.mjs', 'preload.cjs', 'service.mjs', 'native-host.mjs', 'pairing-approval.mjs',
  'recovery.mjs', 'discovery.mjs', 'journey.mjs', 'browser.mjs', 'visibility.mjs',
  'instance.mjs', 'tray-icon.mjs', 'menu-bar.mjs', 'tray-menu.mjs',
  'ui/trayTemplate.png', 'ui/trayTemplate@2x.png', 'ui/app.js', 'ui/index.html',
]);

// @electron/asar builds listPackage paths with node:path.join. Its archive-root
// prefix therefore is "/" on POSIX and "\\" on Windows, although both describe
// the same archive-relative file. Canonicalize separators only, not traversal,
// case, duplicate entries or filesystem/drive paths.
export function assertDesktopArchiveFiles(entries) {
  assert.ok(Array.isArray(entries), 'Invalid ASAR listing');
  const files = new Set();
  for (const entry of entries) {
    assert.equal(typeof entry, 'string', 'Invalid ASAR path');
    const path = entry.replace(/\\/g, '/');
    assert.ok(path.startsWith('/') && !path.startsWith('//') && !/[\0\r\n:]/.test(path), 'Invalid ASAR path');
    const relative = path.slice(1), parts = relative.split('/');
    assert.ok(parts.every(part => part && part !== '.' && part !== '..'), 'Invalid ASAR path');
    assert.ok(!files.has(relative), 'Duplicate ASAR path');
    files.add(relative);
  }
  for (const file of REQUIRED_DESKTOP_ARCHIVE_FILES) assert.ok(files.has(file), `Missing ${file}`);
  for (const file of ['smoke.mjs', 'build-guard.cjs']) assert.ok(!files.has(file), `Unexpected ${file}`);
  return files;
}
