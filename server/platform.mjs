// All executable resolution is data-only: never ask a login shell to interpret
// aliases, user-controlled paths or model-generated arguments.
import { accessSync, constants, readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function findExecutable(name, { platform = process.platform, env = process.env,
  accessible = file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } } } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const searchPath = env.PATH || env.Path || '';
  // npm also creates an extensionless POSIX shell shim on Windows. Prefer
  // native/PATHEXT entries, or we would find that unusable file before .cmd.
  const extensions = platform === 'win32' ? [...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';'), ''] : [''];
  const roots = /[/\\]/.test(name) ? [''] : searchPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const root of roots) for (const ext of extensions) {
    const candidate = root ? path.join(root.replace(/^"|"$/g, ''), name + ext.toLowerCase()) : name + ext.toLowerCase();
    if (accessible(candidate)) return candidate;
  }
  return null;
}

export function agentEnvironment(source = process.env, extra = {}, platform = process.platform) {
  const keys = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM',
    'XDG_CONFIG_HOME', 'CODEX_HOME', 'DSH_HOME', 'CONTEXTFLOW_DSH_BIN', 'CONTEXTFLOW_NODE'];
  if (platform === 'win32') keys.push('SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME');
  const env = Object.fromEntries(keys.filter(k => source[k]).map(k => [k, source[k]]));
  if (!env.PATH && source.Path) env.PATH = source.Path;
  if (!env.HOME) env.HOME = source.USERPROFILE || homedir();
  if (platform === 'darwin') {
    env.PATH = [...new Set([...(env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin',
      join(env.HOME, '.local/bin')].filter(Boolean))].join(':');
  }
  return { ...env, ...extra };
}

// npm-installed CLIs normally have a .cmd shim on Windows. Read only the
// standard adjacent package.json's declared bin; never execute arbitrary batch
// text through cmd.exe (which would re-interpret prompt metacharacters).
export function invocation(file, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  const path = win32, name = path.basename(file).replace(/\.(cmd|bat)$/i, '');
  const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli' };
  const packageName = packages[name.toLowerCase()];
  if (packageName) {
    const root = path.join(path.dirname(file), 'node_modules', packageName);
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
      const target = entry && path.resolve(root, entry), rel = target && path.relative(root, target);
      if (target && rel && !rel.startsWith('..') && !path.isAbsolute(rel) && existsSync(target)) {
        const node = env.CONTEXTFLOW_NODE || findExecutable('node', { platform, env });
        if (node) return { file: node, args: [target, ...args] };
      }
    } catch { /* nonstandard shim: fail closed */ }
  }
  throw Object.assign(new Error('此 Agent 使用了不受支持的 Windows 批处理入口，请选择原生 EXE 或标准 npm CLI 安装。'), { code: 'AGENT_SPAWN' });
}

export function spawnAgent(file, args, options = {}) {
  const resolved = invocation(file, args, options);
  return spawn(resolved.file, resolved.args, { ...options, windowsHide: true, detached: process.platform !== 'win32', shell: false });
}

export function execAgent(file, args, options, callback) {
  const resolved = invocation(file, args, options);
  return execFile(resolved.file, resolved.args, { ...options, windowsHide: true, shell: false }, callback);
}
execAgent[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
  execAgent(file, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

export function terminateTree(child, signal = 'SIGTERM', { platform = process.platform, execute = execFile } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (!child.pid) { try { child.kill(signal); } catch {} return; }
  if (platform === 'win32') {
    // PID is created and retained by this process, never supplied by a page.
    execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* already exited */ } }
  }
}
