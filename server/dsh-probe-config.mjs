// Read only the data needed for a model-only Desktop connection check. This
// never runs a profile, resolves its bundles, or evaluates Cordis expressions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DSH_CONNECTION_PROMPT = 'Connection check only. Do not use tools, read files, or access the network yourself. Reply with exactly OK, without explanation.';

const UNSAFE = Symbol('unsupported configuration');
const MAX_BYTES = 512 * 1024;
const NAMES = {
  'agent-default-model': '@deepseek-ai/dsh-agent-default-model',
  'llm-deepseek': '@deepseek-ai/dsh-llm-deepseek',
  'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
};
const PROVIDERS = {
  'deepseek-official': ['llm-deepseek'],
  'deepseek-account': ['llm-deepseek-account', 'deepseek-account'],
};
const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map(tag => 'tag:yaml.org,2002:' + tag));
const error = () => Object.assign(new Error('当前桌面模型配置无法用于受限连接测试。请使用普通数据配置的 DeepSeek 官方账号或 API 模型。'), { code: 'DSH_PROBE_UNSUPPORTED' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// yaml.parseDocument retains custom tags in its syntax tree without executing
// them. Decode that tree ourselves; do not call toJS() or a Cordis YAML loader.
function decodeNode(node, depth = 0, parents = new Set()) {
  if (depth > 40) return UNSAFE;
  if (node === null || typeof node !== 'object') return node;
  if (parents.has(node)) return UNSAFE;
  if (node.tag && !CORE_TAGS.has(node.tag)) return UNSAFE;
  if (node.constructor?.name === 'Alias' || ('source' in node && !('value' in node))) return UNSAFE;
  const nested = new Set(parents); nested.add(node);
  if (Array.isArray(node.items)) {
    if (node.constructor?.name === 'YAMLSeq' || node.type === 'SEQ') {
      return node.items.map(item => decodeNode(item, depth + 1, nested));
    }
    if (node.constructor?.name !== 'YAMLMap' && node.type !== 'MAP') return UNSAFE;
    const result = Object.create(null);
    for (const pair of node.items) {
      const key = decodeNode(pair?.key, depth + 1, nested);
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor', '<<'].includes(key)
        || Object.hasOwn(result, key)) return UNSAFE;
      result[key] = decodeNode(pair.value, depth + 1, nested);
    }
    return result;
  }
  if (!Object.hasOwn(node, 'value')) return UNSAFE;
  const value = node.value;
  return value === null || ['string', 'boolean'].includes(typeof value)
    || (typeof value === 'number' && Number.isFinite(value)) ? value : UNSAFE;
}

function safeCopy(value, depth = 0, parents = new Set()) {
  if (depth > 40 || value === UNSAFE) throw error();
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || parents.has(value)) throw error();
  const nested = new Set(parents); nested.add(value);
  if (Array.isArray(value)) return value.map(item => safeCopy(item, depth + 1, nested));
  if (!plain(value) || Object.hasOwn(value, '__jsExpr')) throw error();
  const result = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || ['__proto__', 'constructor', 'prototype', '<<'].includes(key)) throw error();
    result[key] = safeCopy(descriptor.value, depth + 1, nested);
  }
  return result;
}

function parseRows(source, parseYaml) {
  let parsed;
  try { parsed = parseYaml(source); } catch { throw error(); }
  if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'contents')) {
    if (parsed.errors?.length) throw error();
    parsed = decodeNode(parsed.contents);
  }
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw error();
  return parsed;
}

/**
 * parseYaml must be a non-executing parser, normally the installed Desktop's
 * yaml.parseDocument. A plain JSON parser is also accepted for unit fixtures.
 */
export function readDshProbeConfig({ dshHome, parseYaml, readFile = readFileSync } = {}) {
  if (typeof dshHome !== 'string' || !dshHome || typeof parseYaml !== 'function') throw error();
  // A custom bundle can replace the model defaults before the user's patch.
  // Inspect only its declaration and refuse it; never resolve or load the bundle.
  let manifest;
  try {
    const source = readFile(join(dshHome, 'profiles/desktop/package.json'), 'utf8');
    if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) throw error();
    manifest = JSON.parse(source);
  } catch { throw error(); }
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.length !== 2 || bundles[0] !== '@deepseek-ai/dsh-base'
    || bundles[1] !== '@deepseek-ai/dsh-web-app') throw error();
  const rows = new Map(Object.keys(NAMES).map(id => [id, { config: {}, disabled: false }]));
  rows.set('agent-default-model', { config: { provider: 'deepseek-official', model: 'deepseek-flash' }, disabled: false });
  const apply = (entries, depth = 0) => {
    if (depth > 20) throw error();
    for (const row of entries) {
      if (!plain(row)) throw error();
      if (Object.hasOwn(row, 'insert')) {
        if (!Array.isArray(row.insert)) throw error();
        apply(row.insert, depth + 1);
      }
      if (!Object.hasOwn(row, 'id')) {
        if (!Object.hasOwn(row, 'insert')) throw error();
        continue;
      }
      if (typeof row.id !== 'string') throw error();
      if (!Object.hasOwn(NAMES, row.id)) continue;
      const state = rows.get(row.id);
      if (Object.hasOwn(row, 'name') && row.name !== NAMES[row.id]) state.unsafe = true;
      if (Object.hasOwn(row, 'disabled')) {
        if (typeof row.disabled !== 'boolean') state.unsafe = true;
        else state.disabled = row.disabled;
      }
      if (Object.keys(row).some(key => !['id', 'name', 'config', 'disabled'].includes(key))) state.unsafe = true;
      if (Object.hasOwn(row, 'config')) {
        try {
          if (!plain(row.config)) throw error();
          state.config = safeCopy(row.config);
          state.configUnsafe = false;
        } catch { state.configUnsafe = true; }
      }
    }
  };
  // Official profile-boot order: bundles, profile patch, then home-level patch.
  // The latter contains machine-wide preferences and deliberately wins.
  for (const relative of ['profiles/desktop/cordis.patch.yml', 'cordis.patch.yml']) {
    let source;
    try { source = readFile(join(dshHome, relative), 'utf8'); }
    catch (cause) { if (cause.code === 'ENOENT') continue; throw error(); }
    if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) throw error();
    apply(parseRows(source, parseYaml));
  }
  const requireConfig = id => {
    const state = rows.get(id);
    if (state.unsafe || state.configUnsafe || state.disabled) throw error();
    return state.config;
  };
  const selected = requireConfig('agent-default-model');
  if (typeof selected.provider !== 'string' || !Object.hasOwn(PROVIDERS, selected.provider)
    || typeof selected.model !== 'string' || !selected.model.trim() || selected.model.length > 200
    || (selected.reasoningEffort !== undefined && (typeof selected.reasoningEffort !== 'string' || selected.reasoningEffort.length > 50))) throw error();
  const selection = { provider: selected.provider, model: selected.model,
    ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
  const configs = {};
  for (const id of PROVIDERS[selected.provider]) configs[id] = requireConfig(id);
  return { selection, configs };
}
