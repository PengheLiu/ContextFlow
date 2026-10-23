import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

const DESKTOP_ENTRY = ['DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'];
const SOURCE_LABELS = { desktop: '桌面版', cli: '命令行兼容版', explicit: '自定义入口' };

function executable(path) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

function desktopBundle(path) {
  let canonical = path;
  try { canonical = realpathSync(path); } catch { /* Keep unavailable explicit paths identifiable. */ }
  return /^(.*[/\\]DeepSeek Harness\.app)[/\\]Contents[/\\]Resources[/\\]runtime[/\\]cli[/\\]bin[/\\]dsh$/.exec(canonical)?.[1];
}

/**
 * Resolve the same DSH entry for installation detection and actual execution.
 * Explicit settings win; otherwise prefer the bundled macOS desktop CLI.
 * appRoots are directories containing DeepSeek Harness.app (injectable in tests).
 */
export function resolveDshInstallation({
  env = process.env, bin, platform = process.platform, appRoots, isExecutable = executable,
} = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const home = env.HOME || env.USERPROFILE || homedir();
  const directories = (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = platform === 'win32'
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const onPath = command => {
    for (const directory of directories) for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  };
  const describe = (entry, source, available) => {
    const appPath = desktopBundle(entry);
    if (appPath) source = 'desktop';
    return { bin: entry, source, sourceLabel: SOURCE_LABELS[source], available, ...(appPath ? { appPath } : {}) };
  };

  const requested = (bin || env.CONTEXTFLOW_DSH_BIN || '').trim();
  if (requested) {
    const expanded = requested.startsWith('~/') ? path.join(home, requested.slice(2)) : requested;
    const hasPath = /[/\\]/.test(expanded);
    const resolved = hasPath ? path.resolve(expanded) : onPath(expanded);
    const entry = resolved || expanded;
    // A broken explicit choice must not silently switch to another installation.
    return describe(entry, 'explicit', !!resolved && isExecutable(resolved));
  }

  if (platform === 'darwin') {
    for (const root of appRoots || ['/Applications', path.join(home, 'Applications')]) {
      const entry = path.join(root, ...DESKTOP_ENTRY);
      if (isExecutable(entry)) return describe(entry, 'desktop', true);
    }
  }
  const entry = onPath('dsh');
  return describe(entry || 'dsh', 'cli', !!entry);
}
