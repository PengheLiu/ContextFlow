// macOS launchd 管理：把本地服务注册为登录后自动启动的 LaunchAgent。
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const LABEL = 'com.contextflow.server';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = new Set(['install', 'status', 'restart', 'logs', 'uninstall']);

const xml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function servicePaths({ home = homedir(), root = ROOT, node = process.execPath, uid = process.getuid?.() } = {}) {
  const dataDir = process.env.CONTEXTFLOW_DIR || join(home, '.contextflow');
  return {
    home, root, node, uid, dataDir,
    server: join(root, 'server', 'index.mjs'),
    launchAgents: join(home, 'Library', 'LaunchAgents'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    logs: join(dataDir, 'logs'),
    stdout: join(dataDir, 'logs', 'server.stdout.log'),
    stderr: join(dataDir, 'logs', 'server.stderr.log'),
    config: join(dataDir, 'config.json'),
    domain: `gui/${uid}`,
    target: `gui/${uid}/${LABEL}`,
  };
}

export function renderPlist(p) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.node)}</string>
    <string>${xml(p.server)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(p.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(p.home)}</string>
    <key>CONTEXTFLOW_DIR</key>
    <string>${xml(p.dataDir)}</string>
    <key>PATH</key>
    <string>${xml(`${dirname(p.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(p.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(p.stderr)}</string>
</dict>
</plist>
`;
}

export function parseCommand(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help', follow: false };
  const positional = argv.filter((x) => !x.startsWith('-'));
  const command = positional[0] || 'install';
  if (!COMMANDS.has(command) || positional.length > 1) return { command: 'invalid', follow: false };
  if (argv.some((x) => x.startsWith('-') && x !== '--follow')) return { command: 'invalid', follow: false };
  if (argv.includes('--follow') && command !== 'logs') return { command: 'invalid', follow: false };
  return { command, follow: argv.includes('--follow') };
}

const usage = () => `用法: npm run service -- [install|status|restart|logs [--follow]|uninstall]
  不带参数等同于 install；前台调试仍可使用 npm run server。`;

function launchctl(args, { tolerate = false, runner = spawnSync } = {}) {
  const r = runner('/bin/launchctl', args, { encoding: 'utf8' });
  if (r.status !== 0 && !tolerate) {
    const detail = String(r.stderr || r.stdout || '').trim();
    throw new Error(`launchctl ${args[0]} 失败${detail ? `：${detail}` : ''}`);
  }
  return r;
}

function configForHealth(p) {
  try {
    const cfg = JSON.parse(readFileSync(p.config, 'utf8'));
    return { port: Number(cfg.port) || 7317, token: cfg.requireToken ? String(cfg.token || '') : '' };
  } catch { return { port: 7317, token: '' }; }
}

export async function health(p, { fetcher = fetch } = {}) {
  const { port, token } = configForHealth(p);
  const headers = { 'X-ContextFlow': '1' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/health`, { headers, signal: AbortSignal.timeout(1000) });
    return { ok: res.ok, port };
  } catch { return { ok: false, port }; }
}

async function waitForHealth(p, options = {}) {
  const attempts = options.attempts ?? 20;
  const delay = options.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    const state = await health(p, options);
    if (state.ok) return state;
    if (i + 1 < attempts) await delay(250);
  }
  return health(p, options);
}

function atomicWrite(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

export async function runService(command, options = {}) {
  const p = options.paths || servicePaths(options);
  const runner = options.runner || spawnSync;
  const out = options.out || console.log;
  const err = options.err || console.error;
  const lc = (args, tolerate = false) => launchctl(args, { tolerate, runner });

  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('service 命令仅支持 macOS；当前系统请使用 npm run server。');
  }

  if (command === 'install') {
    if (!existsSync(p.node)) throw new Error(`找不到 Node：${p.node}`);
    if (!existsSync(p.server)) throw new Error(`找不到服务入口：${p.server}`);
    mkdirSync(p.launchAgents, { recursive: true });
    mkdirSync(p.logs, { recursive: true });
    atomicWrite(p.plist, renderPlist(p));
    lc(['bootout', p.target], true);
    lc(['bootstrap', p.domain, p.plist]);
    lc(['kickstart', '-k', p.target]);
    out(`已安装并启动 ContextFlow 服务：${p.target}`);
    out(`启动配置：${p.plist}`);
    const state = await waitForHealth(p, options);
    if (state.ok) out(`服务正常：http://127.0.0.1:${state.port}`);
    else {
      err(`launchd 已注册，但服务健康检查未通过。请查看：${p.stderr}`);
      return 2;
    }
    return 0;
  }

  if (command === 'status') {
    if (!existsSync(p.plist)) { err('ContextFlow 服务尚未安装。运行 npm run service'); return 1; }
    const state = lc(['print', p.target], true);
    if (state.status !== 0) { err('启动配置已存在，但 launchd 服务未加载。运行 npm run service 重新安装。'); return 2; }
    const pid = String(state.stdout || '').match(/\bpid\s*=\s*(\d+)/)?.[1];
    const h = await health(p, options);
    if (!h.ok) { err(`launchd 服务已加载${pid ? `（PID ${pid}）` : ''}，但 http://127.0.0.1:${h.port} 不可用。`); return 3; }
    out(`ContextFlow 服务运行正常${pid ? `（PID ${pid}）` : ''}：http://127.0.0.1:${h.port}`);
    out(`日志：${p.stdout} / ${p.stderr}`);
    return 0;
  }

  if (command === 'restart') {
    if (!existsSync(p.plist)) { err('ContextFlow 服务尚未安装。请先运行 npm run service'); return 1; }
    lc(['kickstart', '-k', p.target]);
    const state = await waitForHealth(p, options);
    if (!state.ok) { err(`服务重启后健康检查未通过。请查看：${p.stderr}`); return 2; }
    out(`ContextFlow 服务已重启：http://127.0.0.1:${state.port}`);
    return 0;
  }

  if (command === 'logs') {
    const files = [p.stdout, p.stderr].filter(existsSync);
    if (!files.length) { out(`还没有服务日志。日志目录：${p.logs}`); return 0; }
    if (options.follow) {
      out('按 Ctrl+C 停止查看日志。');
      const child = (options.spawner || spawn)('/usr/bin/tail', ['-n', '80', '-F', ...files], { stdio: 'inherit' });
      return await new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
    }
    for (const file of files) {
      out(`\n==> ${file} <==`);
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
      out(lines.slice(-80).join('\n'));
    }
    return 0;
  }

  if (command === 'uninstall') {
    lc(['bootout', p.target], true);
    rmSync(p.plist, { force: true });
    out('已停止并卸载 ContextFlow launchd 服务。');
    out(`配置、数据库和日志均已保留：${p.dataDir}`);
    return 0;
  }

  throw new Error(`未知命令：${command}`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseCommand(argv);
  if (parsed.command === 'help') { console.log(usage()); return 0; }
  if (parsed.command === 'invalid') { console.error(usage()); return 1; }
  try { return await runService(parsed.command, { ...options, follow: parsed.follow }); }
  catch (e) { console.error(`ContextFlow 服务管理失败：${e.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
