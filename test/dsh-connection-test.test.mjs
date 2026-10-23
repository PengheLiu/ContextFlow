import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDshConnectionTester } from '../server/dsh-connection-test.mjs';
import { DSH_CONNECTION_PROMPT } from '../server/dsh-probe-config.mjs';

const root = mkdtempSync(join(tmpdir(), 'cf-dsh-probe-lifecycle-'));
const bin = join(root, 'DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
mkdirSync(dirname(bin), { recursive: true });
writeFileSync(bin, '', { mode: 0o700 });
const base = { bin, env: {}, profile: 'safe', connectionTest: true,
  notesDir: '', prompt: DSH_CONNECTION_PROMPT, timeoutMs: 1000 };
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log('  ok   ' + name); };
function fixture({ scope = 'connection-only', hang = false, ignoreTerm = false, onRun, checkVersion } = {}) {
  const children = [];
  const tester = createDshConnectionTester({ interruptMs: 10, checkVersion: checkVersion || (async () => '0.2.1-rc.2'),
    spawnProcess(command, argv, options) {
      const child = new EventEmitter();
      Object.assign(child, { command, argv, options, stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null, signalCode: null, sent: [], kills: [] });
      const close = (code, signal = null) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.exitCode = code; child.signalCode = signal;
        setImmediate(() => child.emit('close', code, signal));
      };
      child.send = message => {
        child.sent.push(message); onRun?.(child);
        if (!hang) setImmediate(() => {
          child.emit('message', { type: 'result', answer: 'OK' }); close(0);
        });
      };
      child.kill = signal => {
        child.kills.push(signal);
        if (ignoreTerm && signal === 'SIGTERM') return;
        close(null, signal);
      };
      children.push(child);
      setImmediate(() => child.emit('message', { type: 'ready', scope, toolsDisabled: true }));
      return child;
    },
  });
  return { tester, children };
}

try {
  await test('model-only probes always use new owned children and transmit only a run marker', async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const result = await f.tester.run(base);
      assert.equal(result.answer, 'OK'); assert.equal(result.resumed, false); assert.equal(result.persistent, false);
      assert.equal(result.sessionId, undefined);
    }
    assert.equal(f.children.length, 2);
    for (const child of f.children) {
      assert.deepEqual(child.sent, [{ type: 'run' }]);
      assert.equal(child.options.cwd, tmpdir());
      assert.equal(child.options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.ok(child.argv.some(arg => arg.endsWith('dsh-connection-child.mjs')));
      assert.equal(child.exitCode, 0);
    }
    await f.tester.close();
  });
  await test('prompt, notes, or Full authority cannot enter the connection-only carrier', async () => {
    const f = fixture();
    for (const changed of [{ prompt: 'read private notes' }, { notesDir: '/private/notes' }, { profile: 'full' }]) {
      await assert.rejects(f.tester.run({ ...base, ...changed }), e => e.code === 'AGENT_TEST_SCOPE');
    }
    assert.equal(f.children.length, 0); await f.tester.close();
  });
  await test('invalid child capability handshake cannot submit the fixed model request', async () => {
    const f = fixture({ scope: 'full' });
    await assert.rejects(f.tester.run(base), e => e.code === 'AGENT_ERROR');
    assert.equal(f.children[0].sent.length, 0);
    assert.deepEqual(f.children[0].kills, ['SIGTERM']); await f.tester.close();
  });
  await test('abort waits for owned child SIGKILL and never retries the model request', async () => {
    const controller = new AbortController();
    const f = fixture({ hang: true, ignoreTerm: true, onRun: () => controller.abort() });
    await assert.rejects(f.tester.run({ ...base, signal: controller.signal }), e => e.code === 'ABORTED');
    assert.deepEqual(f.children[0].kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(f.children[0].sent.length, 1); await f.tester.close();
  });
  await test('short deadline also reaps the child before returning a timeout', async () => {
    const f = fixture({ hang: true });
    await assert.rejects(f.tester.run({ ...base, timeoutMs: 10 }), e => e.code === 'AGENT_TIMEOUT');
    assert.equal(f.children[0].signalCode, 'SIGTERM'); await f.tester.close();
  });
  await test('shutdown aborts a version probe and waits for it without starting a model worker', async () => {
    let checking, reaped = false;
    const started = new Promise(resolve => { checking = resolve; });
    const f = fixture({ checkVersion: (_id, signal) => new Promise((resolve, reject) => {
      checking(); signal.addEventListener('abort', () => setTimeout(() => {
        reaped = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, 10), { once: true });
    }) });
    const pending = f.tester.run(base);
    const rejected = assert.rejects(pending, e => e.code === 'DSH_DISCONNECTED');
    await started; await f.tester.close(); await rejected;
    assert.equal(reaped, true); assert.equal(f.children.length, 0);
  });
  console.log(`\n${count} DSH model-only lifecycle checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
