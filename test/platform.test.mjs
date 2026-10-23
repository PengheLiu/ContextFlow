import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { agentEnvironment, findExecutable, invocation, terminateTree, execAgent } from '../server/platform.mjs';

test('Windows executable lookup handles Path, PATHEXT, quoted and Chinese paths', () => {
  const checked = [];
  const bin = findExecutable('codex', { platform: 'win32', env: { Path: '"C:\\Users\\中文 用户\\bin";C:\\Windows', PATHEXT: '.EXE;.CMD' },
    accessible: file => { checked.push(file); return file === 'C:\\Users\\中文 用户\\bin\\codex.cmd'; } });
  assert.equal(bin, 'C:\\Users\\中文 用户\\bin\\codex.cmd');
  assert.ok(checked.includes('C:\\Users\\中文 用户\\bin\\codex.exe'));
  assert.equal(findExecutable('codex', { platform: 'win32', env: { PATH: 'C:\\npm' },
    accessible: file => ['C:\\npm\\codex', 'C:\\npm\\codex.cmd'].includes(file) }), 'C:\\npm\\codex.cmd');
  assert.equal(invocation('C:\\Program Files\\Agent\\agent.exe', ['a & b'], { platform: 'win32' }).args[0], 'a & b');
  assert.throws(() => invocation('C:\\evil.cmd', ['& calc'], { platform: 'win32' }), /批处理/);
});
test('Agent inherits required Windows variables but never desktop or model secrets', () => {
  const source = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\读者', TEMP: 'C:\\Temp',
    APPDATA: 'C:\\AppData', ANTHROPIC_API_KEY: 'secret', CONTEXTFLOW_SECRET_KEY: 'private', CONTEXTFLOW_DESKTOP_TOKEN: 'token' };
  const env = agentEnvironment(source, {}, 'win32');
  assert.equal(env.PATH, 'C:\\bin'); assert.equal(env.HOME, source.USERPROFILE); assert.equal(env.SystemRoot, source.SystemRoot);
  for (const key of ['ANTHROPIC_API_KEY', 'CONTEXTFLOW_SECRET_KEY', 'CONTEXTFLOW_DESKTOP_TOKEN']) assert.equal(env[key], undefined);
});
test('Windows cancellation targets only the retained child PID and its tree', () => {
  let call;
  terminateTree({ pid: 12345, exitCode: null, signalCode: null }, 'SIGTERM', { platform: 'win32', execute: (...args) => { call = args; } });
  assert.equal(call[0], 'taskkill.exe'); assert.deepEqual(call[1], ['/PID', '12345', '/T', '/F']); assert.equal(call[2].windowsHide, true);
});
test('CLI wrapper preserves execFile promisified stdout/stderr contract', async () => {
  const result = await promisify(execAgent)(process.execPath, ['-e', 'process.stdout.write("OK")'], {});
  assert.equal(result.stdout, 'OK'); assert.equal(result.stderr, '');
});
