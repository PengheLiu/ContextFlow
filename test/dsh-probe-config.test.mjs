import assert from 'node:assert/strict';
import { readDshProbeConfig, DSH_CONNECTION_PROMPT } from '../server/dsh-probe-config.mjs';

let passed = 0;
const test = (name, run) => { run(); passed++; console.log('  ok   ' + name); };
function read(global, desktop, parseYaml = JSON.parse, bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
  const files = new Map([
    ['/fixture/dsh/profiles/desktop/package.json', { dsh: { profile: { bundles } } }],
    ['/fixture/dsh/profiles/desktop/cordis.patch.yml', desktop],
    ['/fixture/dsh/cordis.patch.yml', global],
  ]);
  const accessed = [];
  const result = readDshProbeConfig({ dshHome: '/fixture/dsh', parseYaml,
    readFile: path => {
      accessed.push(path);
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  });
  assert.deepEqual(accessed, [...files.keys()]);
  return result;
}
const unsupported = run => assert.throws(run, error => error.code === 'DSH_PROBE_UNSUPPORTED'
  && !error.message.includes('SECRET') && !error.message.includes('/fixture'));

console.log('DSH 受限连接测试配置读取\n');

test('默认选择与固定短消息不需要加载 profile、凭据或其他文件', () => {
  assert.deepEqual(read(), { selection: { provider: 'deepseek-official', model: 'deepseek-flash' }, configs: { 'llm-deepseek': {} } });
  assert.match(DSH_CONNECTION_PROMPT, /Reply with exactly OK/);
});

test('官方桌面语音输入组合不会把正常模型误判为不支持，也不加载语音 bundle', () => {
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle'];
  const result = read(undefined, [{ id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'desktop-model', reasoningEffort: 'high' } }], JSON.parse, bundles);
  assert.deepEqual(result.selection, { provider: 'deepseek-official', model: 'desktop-model', reasoningEffort: 'high' });
  assert.deepEqual(result.configs, { 'llm-deepseek': {} });
});

test('机器全局层在桌面层之后整段替换同名配置，匹配官方优先级', () => {
  const result = read([
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'global-model', reasoningEffort: 'high' } },
    { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:1234', maxTokens: 4096 } },
  ], [
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'desktop-model' } },
    { id: 'llm-deepseek', config: { apiKeyEnv: 'CF_LOCAL_FIXTURE_KEY', maxTokens: 128 } },
  ]);
  assert.deepEqual(result.selection, { provider: 'deepseek-official', model: 'global-model', reasoningEffort: 'high' });
  assert.deepEqual(result.configs, { 'llm-deepseek': { baseURL: 'http://127.0.0.1:1234', maxTokens: 4096 } });
});

test('官方账号提供者只保留账号连接与其适配器配置', () => {
  const result = read([{ id: 'llm-deepseek', disabled: true }], [
    { id: 'agent-default-model', config: { provider: 'deepseek-account', model: 'account-model', reasoningEffort: 'low' } },
    { id: 'deepseek-account', config: { platformOrigin: 'https://platform.deepseek.com' } },
    { id: 'llm-deepseek-account', config: { maxTokens: 128 } },
  ]);
  assert.equal(result.selection.provider, 'deepseek-account');
  assert.deepEqual(Object.keys(result.configs), ['llm-deepseek-account', 'deepseek-account']);
});

test('未知插件与未选中提供者被忽略，选中自定义提供者明确拒绝而不换模型', () => {
  const result = read([
    { id: 'custom-plugin', name: '/SECRET/plugin.js', config: { __jsExpr: 'SECRET()' } },
    { id: 'llm-deepseek-account', disabled: true, config: { __jsExpr: 'SECRET()' } },
  ]);
  assert.equal(result.selection.provider, 'deepseek-official');
  unsupported(() => read([{ id: 'agent-default-model', config: { provider: 'custom-provider', model: 'SECRET-model' } }]));
});

test('选中配置的表达式、禁用、插件替换及损坏值拒绝且不泄露原文', () => {
  for (const row of [
    { id: 'llm-deepseek', config: { baseURL: { __jsExpr: 'SECRET()' } } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek', name: '/SECRET/replacement.js' },
    { id: 'agent-default-model', config: { provider: 'deepseek-official' } },
    { id: 'agent-default-model', disabled: true },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'x', reasoningEffort: 1 } },
  ]) unsupported(() => read([row]));
  unsupported(() => read('SECRET malformed yaml'));
  unsupported(() => read('x'.repeat(512 * 1024 + 1)));
});

test('插入行可选纯数据配置，后层纯数据能够替换前层表达式', () => {
  assert.deepEqual(read([
    { insert: [{ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek', config: { maxTokens: 128 } }] },
  ], [{ id: 'llm-deepseek', config: { __jsExpr: 'SECRET()' } }]).configs, { 'llm-deepseek': { maxTokens: 128 } });
});

// Shape-only parser fixtures model yaml.parseDocument nodes; no YAML dependency
// or installed Desktop is necessary for the portable suite.
const scalar = value => ({ value });
const seq = items => ({ type: 'SEQ', items });
const map = values => ({ type: 'MAP', items: Object.entries(values).map(([key, value]) => ({ key: scalar(key), value })) });
test('语法树里的自定义标签不会求值，无关行忽略但模型配置拒绝', () => {
  let executed = false;
  const expression = { value: 'SECRET()', tag: '!js', toJS() { executed = true; } };
  const parsed = entries => () => ({ contents: seq(entries), errors: [] });
  const unknown = map({ id: scalar('custom-plugin'), config: map({ boot: expression }) });
  assert.equal(read('fixture', undefined, parsed([unknown])).selection.model, 'deepseek-flash');
  const known = map({ id: scalar('llm-deepseek'), config: map({ baseURL: expression }) });
  unsupported(() => read('fixture', undefined, parsed([known])));
  assert.equal(executed, false);
});

test('别名、合并、循环与原型键不会进入实际配置', () => {
  const parsed = contents => () => ({ contents, errors: [] });
  unsupported(() => read('fixture', undefined, parsed(seq([{ source: 'SECRET-alias' }]))));
  const row = map({ id: scalar('llm-deepseek'), config: map({ '<<': scalar('SECRET') }) });
  unsupported(() => read('fixture', undefined, parsed(seq([row]))));
  unsupported(() => read('[{"id":"llm-deepseek","config":{"__proto__":{"polluted":true}}}]'));
  assert.equal({}.polluted, undefined);
});

test('未知 bundle、缺失桌面清单与非标准加载顺序拒绝且不加载代码', () => {
  for (const bundles of [
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '/SECRET/custom-bundle'],
    ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'],
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-voice-input-bundle', '@deepseek-ai/dsh-web-app'],
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle', '@deepseek-ai/dsh-experimental-voice-input-bundle'],
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle', '/SECRET/custom-bundle'],
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-unknown-bundle'],
    [],
  ]) {
    unsupported(() => readDshProbeConfig({ dshHome: '/fixture/dsh', parseYaml: JSON.parse,
      readFile: () => JSON.stringify({ dsh: { profile: { bundles } } }),
    }));
  }
  unsupported(() => readDshProbeConfig({ dshHome: '/fixture/dsh', parseYaml: JSON.parse,
    readFile: () => { throw Object.assign(new Error('SECRET'), { code: 'ENOENT' }); },
  }));
});

console.log(`\n${passed} 项 DSH 连接测试配置读取检查通过`);
