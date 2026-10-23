import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { transformSecrets } from '../server/secrets.mjs';

test('Desktop secrets encrypt independently and roundtrip without mutating config', () => {
  const key = randomBytes(32).toString('base64');
  const source = { translate: { apiKey: 'model-private', model: 'public' }, siyuan: { token: 'note-private' }, agent: { env: { PROXY_KEY: 'agent-private' } } };
  const encoded = transformSecrets(source, 'encode', key);
  for (const secret of ['model-private', 'note-private', 'agent-private']) assert.ok(!JSON.stringify(encoded).includes(secret));
  assert.equal(encoded.translate.model, 'public'); assert.equal(source.translate.apiKey, 'model-private');
  assert.deepEqual(transformSecrets(encoded, 'decode', key), source);
  assert.throws(() => transformSecrets(encoded, 'decode', ''), error => error.code === 'CONFIG_SECRET_LOCKED');
  assert.throws(() => transformSecrets(encoded, 'decode', randomBytes(32).toString('base64')), error => error.code === 'CONFIG_SECRET_LOCKED');
  const swapped = structuredClone(encoded); swapped.siyuan.token = encoded.translate.apiKey;
  assert.throws(() => transformSecrets(swapped, 'decode', key), error => error.code === 'CONFIG_SECRET_LOCKED');
  assert.deepEqual(transformSecrets(source, 'encode', ''), source, 'CLI configuration remains compatible');
  const broken = { translate: { apiKey: 'contextflow:sealed:v1:bad' } };
  assert.throws(() => transformSecrets(broken, 'decode', key), error => error.code === 'CONFIG_SECRET_LOCKED');
});
