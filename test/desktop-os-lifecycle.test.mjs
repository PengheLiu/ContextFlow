import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { smokeEnvironment, validateLifecycleEvidence } from '../tools/smoke-desktop.mjs';

test('OS lifecycle smoke isolates data and drops ambient credentials without repurposing HOME', () => {
  const state = join(tmpdir(), 'contextflow-desktop-smoke-fixture'), data = join(state, 'data');
  const source = { HOME: '/actual-user-home', PATH: '/ordinary/path', LANG: 'zh_CN.UTF-8',
    ANTHROPIC_API_KEY: 'must-not-pass', OPENAI_API_KEY: 'must-not-pass', CONTEXTFLOW_DIR: '/real-service-data',
    CODEX_HOME: '/personal-codex', DSH_HOME: '/personal-dsh', GITHUB_TOKEN: 'must-not-pass',
    NODE_OPTIONS: '--require personal-hook', ELECTRON_RUN_AS_NODE: '1', HTTPS_PROXY: 'http://proxy' };
  const environment = smokeEnvironment(state, data, source);
  assert.equal(environment.HOME, source.HOME);
  assert.equal(environment.PATH, source.PATH);
  assert.equal(environment.LANG, source.LANG);
  assert.equal(environment.CONTEXTFLOW_DESKTOP_SMOKE, '1');
  assert.equal(environment.CONTEXTFLOW_DIR, data);
  assert.equal(environment.CONTEXTFLOW_DESKTOP_TEST_STATE, state);
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME', 'DSH_HOME', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HTTPS_PROXY']) {
    assert.equal(environment[key], undefined, key);
  }
  assert.equal(source.CONTEXTFLOW_DIR, '/real-service-data', '不得修改父进程环境');
  assert.throws(() => smokeEnvironment('/real-service-data', '/real-service-data/data', source), /独立临时/);
  assert.throws(() => smokeEnvironment(state, join(tmpdir(), 'outside-data'), source), /独立临时/);
  assert.throws(() => smokeEnvironment(state, state, source), /独立临时/);
});

function evidence(platform = 'darwin') {
  const visible = { trayAvailable: true, trayPlacement: 'clear', trayBounds: { x: 28, y: 0, width: 18, height: 24 },
    windowVisible: true, windowCount: 1, dockVisible: platform === 'darwin' ? true : null };
  const hidden = { ...visible, windowVisible: false };
  return { format: 'ContextFlowLifecycleSmoke', version: 1, platform,
    initial: visible, closed: hidden, reopened: visible, rapidClosed: hidden, activated: visible,
    secondInstance: { exitCode: 0, signal: null, eventObserved: true, sameCoreProcess: true, snapshot: visible },
    hiddenSecondInstance: { exitCode: 0, signal: null, eventObserved: true, sameCoreProcess: true, snapshot: hidden },
    final: visible, servicePreservedWhileHidden: true, isolatedBridgeAbsent: true };
}

test('Native lifecycle evidence requires actual Tray bounds, macOS Dock transitions and normal single-instance handoff', () => {
  assert.equal(validateLifecycleEvidence(evidence()).platform, 'darwin');
  assert.equal(validateLifecycleEvidence(evidence('win32')).platform, 'win32', 'Windows 不冒充存在 macOS Dock');
  const invalid = [
    report => { report.initial.trayAvailable = false; },
    report => { report.initial.trayBounds.width = 0; },
    report => { report.reopened.dockVisible = false; },
    report => { report.closed.dockVisible = false; },
    report => { report.initial.trayPlacement = 'obscured'; },
    report => { report.initial.trayPlacement = 'unknown'; },
    report => { report.rapidClosed.windowVisible = true; },
    report => { report.final.windowCount = 2; },
    report => { report.secondInstance.exitCode = 42; },
    report => { report.secondInstance.signal = 'SIGTERM'; },
    report => { report.secondInstance.eventObserved = false; },
    report => { report.hiddenSecondInstance.sameCoreProcess = false; },
    report => { report.hiddenSecondInstance.snapshot.windowVisible = true; },
    report => { report.isolatedBridgeAbsent = false; },
    report => { report.servicePreservedWhileHidden = false; },
  ];
  for (const mutate of invalid) {
    const report = structuredClone(evidence()); mutate(report);
    assert.throws(() => validateLifecycleEvidence(report), undefined, mutate.toString());
  }
  assert.throws(() => validateLifecycleEvidence({ overviewScreenshot: true }), /ContextFlowLifecycleSmoke/,
    '只存在截图不代表菜单栏、退出或第二实例验证通过');
});
