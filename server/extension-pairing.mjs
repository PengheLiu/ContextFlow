import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const directory = process.env.CONTEXTFLOW_DIR || join(homedir(), '.contextflow');
const file = join(directory, 'extension-pairings.json');
const idPattern = /^[a-p]{32}$/;
const digest = (token) => createHash('sha256').update(token).digest('hex');

function readPairings() {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('无法读取扩展配对记录，请检查本地服务配置');
  }
}

export function pairExtension(id, { revoke = false } = {}) {
  if (!idPattern.test(id || '')) throw new Error('扩展 ID 应为 32 位 a–p 字符，请从扩展设置页复制');
  const pairings = readPairings();
  const token = revoke ? '' : randomBytes(32).toString('base64url');
  pairings[id] = revoke ? { revoked: true, updatedAt: Date.now() }
    : { tokenHash: digest(token), updatedAt: Date.now() };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(pairings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return token;
}

function pairingFor(origin) {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || '');
  return match ? readPairings()[match[1]] : null;
}

export function pairedOrigin(origin) {
  const pairing = pairingFor(origin);
  return !!pairing && !pairing.revoked;
}

export function extensionAuthorized(origin, token) {
  const pairing = pairingFor(origin);
  if (!pairing) return null;
  if (pairing.revoked || !/^[a-f0-9]{64}$/.test(pairing.tokenHash || '')) return false;
  return timingSafeEqual(Buffer.from(pairing.tokenHash, 'hex'), Buffer.from(digest(String(token || '')), 'hex'));
}
