import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pairExtension } from '../server/extension-pairing.mjs';

// This path is invoked only with the explicit isolated smoke environment. No
// user's Chrome profile, installed Agent, vault or external model is used.
export async function runSmoke({ window, service, paths, discovery, lifecycle }) {
  assert.equal(process.env.CONTEXTFLOW_DESKTOP_SMOKE, '1');
  assert.match(paths.state, /contextflow-desktop-smoke-/);
  assert.equal(paths.data, process.env.CONTEXTFLOW_DIR);
  const relativeData = relative(paths.state, paths.data);
  assert.ok(relativeData && !relativeData.startsWith('..') && !isAbsolute(relativeData), '服务数据必须位于本轮隔离状态目录内部');
  assert.equal(typeof lifecycle?.snapshot, 'function', '必须验证原生生命周期，不得继续跳过 Tray');
  assert.equal(service.state, 'running', service.message);
  const noteRoot = join(paths.state, 'notes-fixture'); mkdirSync(noteRoot, { recursive: true });
  const configured = await service.request('/config', { method: 'POST', body: JSON.stringify({ markdown: { dir: noteRoot, folder: '/阅读记录' } }) });
  assert.equal(configured.status, 200);
  if (discovery) discovery.value = {
    agents: { state: 'done', items: [{ id: 'codex', label: 'Codex CLI', available: true, path: join(paths.state, 'fixtures', 'codex'), version: '测试样例', safeSupport: 'verified' }] },
    notes: { state: 'done', items: [{ backend: 'obsidian', name: '示例知识库', path: join(paths.state, 'vault-fixture'), open: false }] }, updatedAt: Date.now(),
  };
  const errors = [];
  window.webContents.on('console-message', details => { if (/Uncaught|ReferenceError|TypeError/.test(details.message || '')) errors.push(details.message); });
  window.webContents.setBackgroundThrottling(false);
  const evaluate = expression => window.webContents.executeJavaScript(expression);
  async function until(expression) {
    for (let n = 0; n < 150; n++) { try { if (await evaluate(expression)) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`UI did not become ready: ${expression}`);
  }
  async function capture(file) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    writeFileSync(join(paths.state, file), (await window.webContents.capturePage()).toPNG());
  }
  async function nativeUntil(label, predicate) {
    for (let n = 0; n < 100; n++) {
      const snapshot = lifecycle.snapshot();
      if (predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const snapshot = lifecycle.snapshot();
    writeFileSync(join(paths.state, 'lifecycle-failure.json'), JSON.stringify({
      format: 'ContextFlowLifecycleSmokeFailure', label, platform: process.platform, snapshot,
    }, null, 2), { mode: 0o600 });
    throw new Error(`原生生命周期未就绪 (${label}): ${JSON.stringify(snapshot)}`);
  }
  const dockVisible = snapshot => process.platform !== 'darwin' || snapshot.dockVisible === true;
  await nativeUntil('首次打开窗口、Dock 与菜单栏', snapshot => snapshot.windowVisible && snapshot.trayAvailable
    && (process.platform !== 'darwin' || snapshot.trayPlacement === 'clear') && dockVisible(snapshot));
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await until('document.getElementById("service-badge")?.textContent === "运行中"');
  await until('document.querySelector("[data-view=setup]")?.hidden === false');
  assert.equal(await evaluate('typeof require'), 'undefined'); assert.equal(await evaluate('typeof process'), 'undefined');
  assert.equal((await evaluate('window.contextflowDesktop.request("/health")')).body.desktopManaged, true);
  assert.equal(await evaluate('document.getElementById("model-badge").dataset.state'), '');
  assert.equal(await evaluate('document.getElementById("notes-badge").textContent'), '尚未确认位置');
  await capture('onboarding.png');
  await evaluate('document.getElementById("setup-skip").click()');
  await until('document.getElementById("configuration").shadowRoot?.getElementById("s-mdDir")?.value.length > 0');
  assert.equal(await evaluate('document.getElementById("configuration").shadowRoot.getElementById("s-agent").value'), '');
  assert.equal(await evaluate('document.getElementById("configuration").shadowRoot.getElementById("s-exBackend").value'), 'llm');
  const mock = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'second-model' }] }));
    else res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  try {
    await evaluate('document.querySelector("nav [data-page=ai]").click()');
    await until('document.querySelector("[data-view=ai]").hidden === false');
    await until('document.activeElement === document.querySelector("[data-view=ai] h1") && document.getElementById("configuration").shadowRoot.querySelector(".folio").hidden === false');
    await evaluate(`(() => {
      const root = document.getElementById('configuration').shadowRoot;
      for (const [id,value] of Object.entries(${JSON.stringify({ 's-provider': 'openai', 's-baseUrl': `http://127.0.0.1:${mock.address().port}`, 's-model': 'unsaved-focus-fixture', 's-apiKey': 'smoke-key-never-ship' })})) {
        const field = root.getElementById(id); field.value=value; field.dispatchEvent(new Event('input', {bubbles:true}));
      }
      root.getElementById('s-model').focus(); root.getElementById('s-model').setSelectionRange(3,7);
      window.dispatchEvent(new Event('focus'));
    })()`);
    assert.equal(await evaluate('document.getElementById("configuration").shadowRoot.activeElement?.id'), 's-model');
    // Exercise a real background poll, not just a synthetic DOM assertion.
    await new Promise(resolve => setTimeout(resolve, 4600));
    assert.equal(await evaluate('document.getElementById("configuration").shadowRoot.activeElement?.id'), 's-model');
    assert.equal(await evaluate('document.getElementById("configuration").shadowRoot.getElementById("s-model").selectionStart'), 3);
    assert.equal(await evaluate('document.getElementById("configuration").shadowRoot.getElementById("s-model").value'), 'unsaved-focus-fixture');
    await evaluate(`(() => { const root=document.getElementById('configuration').shadowRoot; root.getElementById('s-model').value='mock-model'; root.getElementById('s-model').dispatchEvent(new Event('input',{bubbles:true})); root.getElementById('s-fetchModels').click(); })()`);
    await until('document.getElementById("configuration").shadowRoot?.textContent.includes("2 个模型")');
    await evaluate('document.getElementById("configuration").shadowRoot.getElementById("s-testModel").click()');
    await until('document.getElementById("configuration").shadowRoot?.textContent.includes("连接成功")');
    await evaluate('document.getElementById("configuration").shadowRoot.getElementById("s-save").click()');
    await until('document.getElementById("toast-message").textContent.includes("更改已保存")');
    const config = await service.request('/config');
    assert.equal(config.body.translate.model, 'mock-model'); assert.equal(config.body.connectionChecks.model.ok, true);
    assert.equal(config.body.agent.id, ''); assert.equal(config.body.agent.notesDir, '');
    assert.ok(!readFileSync(join(paths.data, 'config.json'), 'utf8').includes('smoke-key-never-ship'));
    await evaluate(`(() => { const root=document.getElementById('configuration').shadowRoot; for(const [id,open] of [['s-chapter-translate',false],['s-chapter-explain',true]]){const chapter=root.getElementById(id);chapter.open=open;chapter.disclosure.sync();}root.getElementById('s-toast').hidden=true;document.getElementById('dismiss-toast').click();document.getElementById('main').scrollTop=0; })()`);
    await capture('ai.png');
    await evaluate('document.querySelector("nav [data-page=notes]").click()');
    await until('document.getElementById("configuration").shadowRoot.getElementById("s-chapter-archive").hidden === false');
    assert.equal(await evaluate('document.getElementById("configuration").shadowRoot.getElementById("s-chapter-translate").hidden'), true);
    await evaluate('document.getElementById("confirm-notes").click()');
    await until('document.getElementById("notes-badge").textContent === "位置已确认 · 待同步"');
    assert.equal(await evaluate('document.getElementById("notes-badge").dataset.state'), '', 'a saved path is not sync success');
    await evaluate('document.getElementById("dismiss-toast").click(); document.getElementById("main").scrollTop=0;');
    await capture('notes.png');
    // Synthetic authorization is confined to the disposable service data.
    pairExtension('cgimipjfmopjcaedmgccaodjppdpkfjf', { directory: paths.data, instanceId: 'smoke-browser-instance-0001', label: 'Chrome · 测试浏览器' });
    await evaluate('window.contextflowDesktop.onboarding({dismissed:true})');
    await evaluate('document.querySelector("nav [data-page=home]").click(); window.dispatchEvent(new Event("focus"));');
    await until('document.getElementById("model-badge").textContent === "回答测试通过"');
    await until('document.getElementById("home-primary").textContent === "去网页开始阅读"');
    await capture('overview.png');
    const report = { format: 'ContextFlowLifecycleSmoke', version: 1, platform: process.platform,
      initial: lifecycle.snapshot(), isolatedBridgeAbsent: !existsSync(paths.bridge) };
    const corePid = service.child.pid;
    const closeAndWait = async label => {
      lifecycle.closeWindow();
      const snapshot = await nativeUntil(label, value => !value.windowVisible && dockVisible(value));
      assert.equal(snapshot.windowCount, 1, '关闭按钮应隐藏，不销毁窗口');
      assert.equal(service.child?.pid, corePid, '关闭窗口不得重启或停止服务');
      assert.equal((await service.health()).desktopManaged, true, '后台仍应有本轮服务响应');
      return snapshot;
    };
    report.closed = await closeAndWait('关闭后进入后台');
    report.servicePreservedWhileHidden = true;
    lifecycle.reopenFromTray();
    report.reopened = await nativeUntil('菜单栏重新打开', value => value.windowVisible && dockVisible(value));
    // Rapid close/reopen must preserve the final hidden window and Dock fallback.
    lifecycle.closeWindow(); lifecycle.reopenFromTray(); lifecycle.closeWindow();
    report.rapidClosed = await nativeUntil('快速关闭、重开、再关闭', value => !value.windowVisible && dockVisible(value));
    lifecycle.activate();
    report.activated = await nativeUntil('应用 activate 重新打开', value => value.windowVisible && dockVisible(value));
    const secondary = async hidden => {
      await closeAndWait(hidden ? '后台重复启动前' : '重复打开前');
      const before = lifecycle.snapshot().secondInstanceEvents;
      let output = '', timedOut = false;
      const child = spawn(process.execPath, [lifecycle.appPath, '--contextflow-smoke-secondary', ...(hidden ? ['--hidden'] : [])],
        { cwd: lifecycle.appPath, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-1200); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-1200); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 10000);
      let code, signal;
      try { [code, signal] = await once(child, 'exit'); }
      finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
      assert.equal(timedOut, false, `第二实例启动超时: ${output}`);
      assert.equal(code, 0, `第二实例应正常让位而不是启动另一服务: ${output}`);
      const snapshot = await nativeUntil(hidden ? '后台重复启动不抢窗口' : '第二实例唤起原窗口', value =>
        value.secondInstanceEvents > before && (hidden ? !value.windowVisible && dockVisible(value) : value.windowVisible && dockVisible(value)));
      return { exitCode: code, signal, eventObserved: snapshot.secondInstanceEvents > before,
        sameCoreProcess: service.child?.pid === corePid, snapshot };
    };
    report.secondInstance = await secondary(false);
    report.hiddenSecondInstance = await secondary(true);
    lifecycle.reopenFromTray();
    report.final = await nativeUntil('最终从菜单栏找回', value => value.windowVisible && dockVisible(value));
    assert.equal(service.child?.pid, corePid);
    writeFileSync(join(paths.state, 'lifecycle.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    assert.deepEqual(errors, []);
    console.log('Desktop product UI smoke passed: first-run flow, four real screenshots, single-form drafts, live poll focus, explicit confirmation, model listing/testing, encrypted persistence and shared state.');
    console.log('Native lifecycle smoke passed: real Tray bounds and screen-shape check, preserved Dock fallback, close/reopen via native menu callback, rapid close, activate, two real secondary Electron launches, one core and one window; no Chrome registration. OS pointer hit testing is not covered.');
  } finally { await new Promise(resolve => mock.close(resolve)); }
}
