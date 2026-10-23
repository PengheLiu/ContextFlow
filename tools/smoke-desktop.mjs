import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function smokeEnvironment(state, data, source = process.env) {
  const within = relative(resolve(state), resolve(data));
  if (!basename(state).startsWith('contextflow-desktop-smoke-') || !within || within.startsWith('..') || isAbsolute(within)) {
    throw new Error('桌面冒烟测试必须使用独立临时状态及其内部数据目录');
  }
  // Retain ordinary OS launch variables unchanged, never replace HOME or use
  // a user's Agent configuration. Remove ambient credentials and Node hooks.
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/(?:TOKEN|API.?KEY|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|AUTH)/i.test(key)
    && !/^(?:CONTEXTFLOW_|CODEX_|DSH_|CLAUDE_|ANTHROPIC_|OPENAI_|GEMINI_)/.test(key)
    && !['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key)));
  return { ...environment, CONTEXTFLOW_DESKTOP_SMOKE: '1', CONTEXTFLOW_DESKTOP_TEST_STATE: state, CONTEXTFLOW_DIR: data };
}

export function validateLifecycleEvidence(report) {
  assert.equal(report?.format, 'ContextFlowLifecycleSmoke');
  assert.equal(report.version, 1);
  for (const key of ['initial', 'reopened', 'activated', 'secondInstance', 'final']) {
    const snapshot = report[key]?.snapshot || report[key];
    assert.equal(snapshot?.trayAvailable, true, `${key}: 原生菜单栏 / 托盘必须成功创建`);
    assert.ok(snapshot.trayBounds?.width > 0 && snapshot.trayBounds?.height > 0, `${key}: Tray bounds 不得为空`);
    assert.equal(snapshot.windowVisible, true, `${key}: 应用窗口应显示`);
    assert.equal(snapshot.windowCount, 1, `${key}: 不得创建重复窗口`);
    if (report.platform === 'darwin') {
      assert.equal(snapshot.trayPlacement, 'clear', `${key}: 必须通过真实屏幕几何验证，不得落在刘海遮挡区`);
      assert.equal(snapshot.dockVisible, true, `${key}: 显示窗口时应可从 Dock 找回`);
    }
  }
  for (const key of ['closed', 'rapidClosed', 'hiddenSecondInstance']) {
    const snapshot = report[key]?.snapshot || report[key];
    assert.equal(snapshot?.windowVisible, false, `${key}: 应保持后台状态`);
    assert.equal(snapshot.windowCount, 1, `${key}: 关闭不应销毁后台窗口`);
    if (report.platform === 'darwin') assert.equal(snapshot.dockVisible, true, `${key}: 关闭窗口后仍须保留 Dock 找回入口`);
  }
  for (const key of ['secondInstance', 'hiddenSecondInstance']) {
    assert.equal(report[key].exitCode, 0, `${key}: 第二进程应正常让位`);
    assert.equal(report[key].signal, null, `${key}: 第二进程不得依赖强杀`);
    assert.equal(report[key].eventObserved, true, `${key}: 原进程必须收到真实 second-instance 事件`);
    assert.equal(report[key].sameCoreProcess, true, `${key}: 不得启动或替换另一份服务`);
  }
  assert.equal(report.servicePreservedWhileHidden, true);
  assert.equal(report.isolatedBridgeAbsent, true, '测试不得创建 native 配对桥接');
  return report;
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false));
    socket.setTimeout(400, () => settle(true));
  });
}

export async function runDesktopSmoke() {
  const state = mkdtempSync(join(tmpdir(), 'contextflow-desktop-smoke-'));
  const data = join(state, 'data'); mkdirSync(data, { mode: 0o700 });
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ port }), { mode: 0o600 });
  const electron = (await import('../desktop/node_modules/electron/index.js')).default;
  const child = spawn(electron, [join(root, 'desktop')], { cwd: root,
    env: smokeEnvironment(state, data), stdio: 'inherit' });
  let timedOut = false, forceTimer;
  const timer = setTimeout(() => {
    timedOut = true; child.kill('SIGTERM');
    forceTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
  }, 90000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(timedOut, false, '桌面冒烟测试超时，不能算通过');
    assert.equal(code, 0, `Desktop smoke exited ${code} (${signal || 'no signal'})`);
    assert.equal(signal, null, '桌面端应走正常退出，而非信号终止');
    for (const file of ['onboarding.png', 'ai.png', 'notes.png', 'overview.png']) assert.ok(existsSync(join(state, file)), `缺少实际 UI 截图：${file}`);
    const report = JSON.parse(readFileSync(join(state, 'lifecycle.json'), 'utf8'));
    assert.equal(report.platform, process.platform, '原生生命周期证据必须来自当前系统');
    validateLifecycleEvidence(report);
    for (let attempt = 0; attempt < 50 && await portOpen(port); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await portOpen(port), false, '退出桌面端后不得遗留本次测试的本地服务');
    writeFileSync(join(state, 'shutdown.json'), JSON.stringify({ format: 'ContextFlowSmokeShutdown',
      normalExit: true, testPortClosed: true, port }, null, 2), { mode: 0o600 });
    return state;
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    console.log(`Desktop smoke evidence: ${state}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runDesktopSmoke(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
