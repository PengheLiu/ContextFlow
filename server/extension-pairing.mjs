import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const idPattern = /^[a-p]{32}$/;
const instancePattern = /^[A-Za-z0-9_-]{16,80}$/;
const digest = (token) => createHash('sha256').update(token).digest('hex');

const defaultDirectory = () => process.env.CONTEXTFLOW_DIR || join(homedir(), '.contextflow');
function readPairings(directory = defaultDirectory()) {
  const file = join(directory, 'extension-pairings.json');
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('无法读取扩展配对记录，请检查本地服务配置');
  }
}

export function pairExtension(id, { revoke = false, instanceId = '', legacyOnly = false, label = '', directory = defaultDirectory() } = {}) {
  if (!idPattern.test(id || '')) throw new Error('扩展 ID 应为 32 位 a–p 字符，请从扩展设置页复制');
  if (instanceId && !instancePattern.test(instanceId)) throw new Error('无效的浏览器安装编号');
  if (legacyOnly && (!revoke || instanceId)) throw new Error('仅可对旧版配对执行独立撤销');
  const pairings = readPairings(directory);
  const token = revoke ? '' : randomBytes(32).toString('base64url');
  const entry = revoke ? { revoked: true, updatedAt: Date.now() }
    : { tokenHash: digest(token), updatedAt: Date.now(), label: String(label).slice(0, 80) };
  if (instanceId) pairings[id] = { ...pairings[id], instances: { ...pairings[id]?.instances, [instanceId]: entry } };
  else pairings[id] = { ...entry, instances: revoke && !legacyOnly ? {} : pairings[id]?.instances || {} };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'extension-pairings.json');
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
  return !!pairing && ((!pairing.revoked && !!pairing.tokenHash)
    || Object.values(pairing.instances || {}).some(entry => !entry.revoked && !!entry.tokenHash));
}

export function extensionAuthorized(origin, token, instanceId = '') {
  let pairing = pairingFor(origin);
  if (!pairing) return null;
  if (instanceId) {
    if (!instancePattern.test(instanceId)) return false;
    pairing = pairing.instances?.[instanceId];
    if (!pairing) return false;
  }
  if (pairing.revoked || !/^[a-f0-9]{64}$/.test(pairing.tokenHash || '')) return false;
  return timingSafeEqual(Buffer.from(pairing.tokenHash, 'hex'), Buffer.from(digest(String(token || '')), 'hex'));
}

export function listPairings(directory = defaultDirectory()) {
  return Object.entries(readPairings(directory)).flatMap(([id, pairing]) => {
    const rows = Object.entries(pairing.instances || {}).filter(([, entry]) => !entry.revoked)
      .map(([instanceId, entry]) => ({ id, instanceId, label: entry.label || 'Chrome', updatedAt: entry.updatedAt }));
    if (pairing.tokenHash && !pairing.revoked) rows.push({ id, instanceId: '', label: '命令行配对', updatedAt: pairing.updatedAt });
    return rows;
  });
}
