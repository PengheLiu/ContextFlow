// Execute our real isolated carrier against disposable, deliberately changing
// vendor APIs. No installed Agent, personal configuration or model is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DSH_CONNECTION_PROMPT } from '../server/dsh-probe-config.mjs';

const carrier = fileURLToPath(new URL('../server/dsh-connection-child.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'contextflow-dsh-contract-'));
const children = new Set();
const modules = {
  '@deepseek-ai/cordis': `
    export class Context {
      constructor() { this.services = {}; this.fiber = { dispose: async () => {} }; }
      provide(name, value) { this.services[name] = value; }
      get(name) { return this.services[name] ?? this[name]; }
      async plugin(module, config) {
        await (typeof module === 'function' ? module : module.apply)(this, config);
      }
    }
  `,
  '@deepseek-ai/dsh-llm': `
    import { writeFileSync } from 'node:fs';
    export const createUserMessage = message => ({ role: 'user', ...message });
    export default function apply(context) {
      context.llm = { async *stream(request) {
        writeFileSync(process.env.CF_PROBE_MODEL_MARKER, JSON.stringify(request));
        yield { type: 'text-delta', text: 'OK' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    }
  `,
  '@deepseek-ai/dsh-credentials-local': `
    export default function apply(context) {
      context.credentials = Object.fromEntries(
        ['resolve', 'readRecord', 'set', 'unset', 'modifyRecord', 'deleteRecord'].map(name => [name, () => undefined]));
    }
  `,
  '@deepseek-ai/dsh-authorization': 'export default function apply() {}',
  '@deepseek-ai/dsh-app-boot': 'export const loadLayeredEnv = () => ({});',
  '@deepseek-ai/dsh-llm-deepseek-api-key': 'export function apply() {}',
  yaml: 'export const parseDocument = JSON.parse;',
};
const packageAt = (directory, name, code) => {
  const path = join(directory, 'node_modules', ...name.split('/'));
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.mjs' }));
  writeFileSync(join(path, 'index.mjs'), code);
};

async function runFixture({ overrides = {}, ancestorModule, beforeRun } = {}) {
  const directory = mkdtempSync(join(root, 'case-'));
  const runtime = join(directory, 'runtime'), home = join(directory, 'home'), dshHome = join(home, '.dsh');
  const marker = join(directory, 'model-request.json'), imported = join(directory, 'outside-module-imported');
  for (const folder of [runtime, home, join(dshHome, 'profiles/desktop')]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(dshHome, 'profiles/desktop/package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }));
  for (const [name, code] of Object.entries({ ...modules, ...overrides })) {
    if (code !== null) packageAt(runtime, name, code);
  }
  if (ancestorModule) packageAt(directory, ancestorModule,
    `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.CF_PROBE_OUTSIDE_MARKER, 'must not import');\n`
    + modules[ancestorModule]);
  const messages = [];
  let stdout = '', stderr = '', timer, hardTimer, callbackFailure;
  const child = spawn(process.execPath, [carrier, runtime], {
    cwd: home, env: { HOME: home, DSH_HOME: dshHome, PATH: dirname(process.execPath), LANG: 'en_US.UTF-8',
      CF_PROBE_MODEL_MARKER: marker, CF_PROBE_OUTSIDE_MARKER: imported },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  child.on('message', message => {
    messages.push(message);
    if (message?.type === 'ready') {
      try {
        assert.equal(existsSync(marker), false, 'a model request must wait for parent approval');
        beforeRun?.(message, { marker });
        child.send({ type: 'run' });
      } catch (error) { callbackFailure = error; child.kill('SIGTERM'); }
    }
  });
  try {
    const terminal = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => {
        callbackFailure ||= new Error('isolated carrier contract test timed out');
        child.kill('SIGTERM');
        hardTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      }, 8000);
    });
    if (callbackFailure) throw callbackFailure;
    return { ...terminal, messages, stdout, stderr,
      request: existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null,
      outsideImported: existsSync(imported) };
  } finally {
    clearTimeout(timer); clearTimeout(hardTimer); children.delete(child);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok   ' + name); };
const rejectedBeforeRequest = (result, code) => {
  assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.deepEqual(result.messages, [{ type: 'error', code }]);
  assert.equal(result.request, null, 'incompatible or non-isolated APIs cannot call the model');
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '', 'raw module/profile details must stay private');
};

try {
  await test('compatible bundled model APIs attest isolation before the fixed no-tools request', async () => {
    const result = await runFixture();
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    assert.deepEqual(result.messages, [
      { type: 'ready', contract: 1, scope: 'connection-only', toolsDisabled: true },
      { type: 'result', answer: 'OK' },
    ]);
    assert.deepEqual(result.request, { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 128,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: DSH_CONNECTION_PROMPT }] }],
      tools: [], signal: {} });
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  });
  await test('missing bundled APIs fail before ready, without loading an ancestor package', async () => {
    rejectedBeforeRequest(await runFixture({ overrides: { yaml: null } }), 'DSH_DESKTOP_UNSUPPORTED');
    const fallback = await runFixture({ overrides: { '@deepseek-ai/dsh-llm': null }, ancestorModule: '@deepseek-ai/dsh-llm' });
    rejectedBeforeRequest(fallback, 'DSH_DESKTOP_UNSUPPORTED');
    assert.equal(fallback.outsideImported, false);
  });
  await test('changed Context, message, parser and environment APIs report compatibility errors before model use', async () => {
    for (const overrides of [
      { '@deepseek-ai/cordis': 'export const Context = null;' },
      { '@deepseek-ai/cordis': 'export class Context {}' },
      { '@deepseek-ai/dsh-llm': modules['@deepseek-ai/dsh-llm'].replace('createUserMessage = message => ({ role: \'user\', ...message })', 'createUserMessage = null') },
      { yaml: 'export const parseDocument = null;' },
      { '@deepseek-ai/dsh-app-boot': 'export const loadLayeredEnv = null;' },
    ]) rejectedBeforeRequest(await runFixture({ overrides }), 'DSH_DESKTOP_UNSUPPORTED');
  });
  await test('changed stream or credential contracts cannot attest a usable isolated test', async () => {
    rejectedBeforeRequest(await runFixture({ overrides: {
      '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => value; export default context => { context.llm = { stream: null }; };',
    } }), 'DSH_DESKTOP_UNSUPPORTED');
    for (const method of ['resolve', 'readRecord', 'set', 'unset', 'modifyRecord', 'deleteRecord']) {
      // Remove the actual required API rather than only changing plugin metadata.
      rejectedBeforeRequest(await runFixture({ overrides: {
        '@deepseek-ai/dsh-credentials-local': modules['@deepseek-ai/dsh-credentials-local']
          .replace("['resolve', 'readRecord', 'set', 'unset', 'modifyRecord', 'deleteRecord']", JSON.stringify(['resolve', 'readRecord', 'set', 'unset', 'modifyRecord', 'deleteRecord'].filter(name => name !== method))),
      } }), 'DSH_DESKTOP_UNSUPPORTED');
    }
  });
  await test('bootstrap diagnostics are returned as fixed compatibility codes without raw details', async () => {
    rejectedBeforeRequest(await runFixture({ overrides: {
      '@deepseek-ai/dsh-llm-deepseek-api-key': `export function apply() { throw new Error('SECRET_DIAGNOSTIC_CONTENT /private/profile/model-key'); }`,
    } }), 'DSH_DESKTOP_UNSUPPORTED');
  });
  await test('credential mutators are locked even when a future service defines own writable methods', async () => {
    const result = await runFixture({ overrides: {
      '@deepseek-ai/dsh-llm-deepseek-api-key': `export function apply(context) {
        for (const name of ['set', 'unset', 'modifyRecord', 'deleteRecord']) {
          const descriptor = Object.getOwnPropertyDescriptor(context.credentials, name);
          if (!descriptor || descriptor.writable || descriptor.configurable) throw new Error('mutable guard');
          let blocked = false;
          try { context.credentials[name] = () => {}; } catch (error) { blocked = error instanceof TypeError; }
          if (!blocked) throw new Error('replaceable guard');
        }
      }`,
    } });
    assert.equal(result.code, 0, JSON.stringify(result.messages));
    assert.deepEqual(result.messages.at(-1), { type: 'result', answer: 'OK' });
    for (const name of ['set', 'unset', 'modifyRecord', 'deleteRecord']) {
      rejectedBeforeRequest(await runFixture({ overrides: {
        '@deepseek-ai/dsh-llm-deepseek-api-key': `export function apply(context) { context.credentials[${JSON.stringify(name)}](); }`,
      } }), 'AGENT_AUTH');
    }
  });
  await test('unexpected agent, tools, skill or schedule services cannot reach a model request', async () => {
    for (const service of ['agent', 'tools', 'skill', 'schedule']) {
      rejectedBeforeRequest(await runFixture({ overrides: {
        '@deepseek-ai/dsh-llm-deepseek-api-key': `export function apply(context) { context.provide(${JSON.stringify(service)}, {}); }`,
      } }), 'DSH_TEST_ISOLATION');
    }
  });
  await test('isolation is checked again after the ready handshake and before inference', async () => {
    const result = await runFixture({ overrides: {
      '@deepseek-ai/dsh-llm-deepseek-api-key': `export function apply(context) {
        process.on('message', message => { if (message?.type === 'run') context.provide('tools', {}); });
      }`,
    } });
    assert.equal(result.code, 1); assert.equal(result.request, null);
    assert.deepEqual(result.messages, [
      { type: 'ready', contract: 1, scope: 'connection-only', toolsDisabled: true },
      { type: 'error', code: 'DSH_TEST_ISOLATION' },
    ]);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  });
  console.log(`\n${passed} DSH probe contract checks passed (no installed runtime or real model used)`);
} finally {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
