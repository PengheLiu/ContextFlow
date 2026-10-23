import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from '../src/core/uuid.js';

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
test('secure contexts prefer the native method with its Crypto receiver', () => {
  const source = { randomUUID() { assert.equal(this, source); return 'native-uuid'; }, getRandomValues() { throw new Error('not expected'); } };
  assert.equal(randomUUID(source), 'native-uuid'); assert.match(randomUUID(webcrypto), v4);
});
test('ordinary HTTP uses getRandomValues and explicitly sets RFC 4122 version and variant bits', () => {
  let calls = 0;
  const source = { getRandomValues(bytes) { assert.equal(this, source); assert.equal(bytes.length, 16); bytes.fill(255); calls++; return bytes; } };
  assert.equal(randomUUID(source), 'ffffffff-ffff-4fff-bfff-ffffffffffff'); assert.equal(calls, 1);
  assert.equal(randomUUID({ getRandomValues: bytes => bytes.fill(0) }), '00000000-0000-4000-8000-000000000000');
});
test('HTTP fallback retains cryptographic entropy and never falls back to Math.random', () => {
  const original = Math.random; Math.random = () => { throw new Error('insecure RNG used'); };
  try {
    const values = new Set();
    for (let n = 0; n < 1000; n++) { const id = randomUUID({ getRandomValues: bytes => webcrypto.getRandomValues(bytes) }); assert.match(id, v4); values.add(id); }
    assert.equal(values.size, 1000);
    assert.throws(() => randomUUID(null), /无法安全生成/);
    assert.throws(() => randomUUID({}), /无法安全生成/);
  } finally { Math.random = original; }
});
test('browser callsites use the shared HTTP-capable helper, with no direct secure-only randomUUID calls', () => {
  const root = new URL('..', import.meta.url).pathname;
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
  const sources = [...walk(join(root, 'src')), join(root, 'extension/sw.js')].filter(file => file.endsWith('.js') && !file.endsWith('/uuid.js'));
  for (const file of sources) assert.doesNotMatch(readFileSync(file, 'utf8'), /\bcrypto(?:\?\.|\.)randomUUID\b/, file);
  for (const name of ['src/skill/main.js', 'src/core/offline-store.js', 'extension/sw.js']) assert.match(readFileSync(join(root, name), 'utf8'), /from ['"][^'"]*uuid\.js['"]/);
  assert.doesNotMatch(readFileSync(new URL('../src/core/uuid.js', import.meta.url), 'utf8'), /Math\.random/);
});
