import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export const HOST_NAME = 'io.github.pengheliu.contextflow';
export const EXTENSIONS = ['aemncphfnlpbhlddifhohpgegejjejfm', 'cgimipjfmopjcaedmgccaodjppdpkfjf'];
export const STORE_URL = 'https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm';
export const WEBSITE = 'https://pengheliu.github.io/ContextFlow/';

export function desktopPaths({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = platform === 'win32' ? win32 : posix;
  const state = platform === 'win32'
    ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'ContextFlow')
    : p.join(home, 'Library', 'Application Support', 'ContextFlow');
  // Keep established data in place. Never create a second reading database or
  // silently copy a live SQLite WAL database on first desktop launch.
  return { state, data: env.CONTEXTFLOW_DIR || p.join(home, '.contextflow'),
    bridge: p.join(state, 'desktop-bridge.json'), preferences: p.join(state, 'desktop.json'),
    secret: p.join(state, 'secret-key.bin'), logs: p.join(state, 'logs') };
}

export function nativeManifest(executable, { development = false } = {}) {
  return { name: HOST_NAME, description: 'ContextFlow Desktop browser bridge', path: executable,
    type: 'stdio', allowed_origins: (development ? EXTENSIONS : EXTENSIONS.slice(0, 1)).map(id => `chrome-extension://${id}/`) };
}

export function chromeHostFile({ platform = process.platform, home = homedir(), state, resources } = {}) {
  return platform === 'win32' ? win32.join(resources, 'native-messaging.json')
    : posix.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
}

export function atomicJSON(file, data) {
  mkdirSync((process.platform === 'win32' ? win32 : posix).dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

export function readJSON(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}
