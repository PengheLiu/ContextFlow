// 本地附件库：图片按内容哈希去重落到 ~/.contextflow/assets，SQLite 只存元数据。
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DIR } from './config.mjs';
import * as db from './db.mjs';

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const TYPES = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'],
]);
const ID_RE = /^[a-f0-9]{64}$/;

const fail = (message, code = 'BAD_ASSET') => Object.assign(new Error(message), { code });
const fileOf = (id, ext) => join(DIR, 'assets', `${id}.${ext}`);

function validSignature(bytes, mime) {
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp') return bytes.length >= 12
    && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}

export function saveAsset({ id, mime, name = 'image', data }) {
  id = String(id || '').toLowerCase(); mime = String(mime || '').toLowerCase();
  if (!ID_RE.test(id)) throw fail('附件 id 无效');
  const ext = TYPES.get(mime);
  if (!ext) throw fail('仅支持 PNG、JPEG 或 WebP 图片');
  let bytes;
  try { bytes = Buffer.from(String(data || ''), 'base64'); }
  catch { throw fail('图片数据无法解析'); }
  if (!bytes.length) throw fail('图片内容为空');
  if (bytes.length > MAX_ASSET_BYTES) throw fail('图片不能超过 8 MB', 'ASSET_TOO_LARGE');
  if (!validSignature(bytes, mime)) throw fail('图片格式与声明类型不一致');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== id) throw fail('图片指纹校验失败');
  const path = fileOf(id, ext);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, bytes);
  const meta = { id, mime, ext, size: bytes.length, name: String(name || 'image').slice(0, 180), createdAt: Date.now() };
  db.putAsset(meta);
  return meta;
}

export function getAsset(id, { includeData = false } = {}) {
  if (!ID_RE.test(String(id || ''))) return null;
  const meta = db.getAsset(id); if (!meta) return null;
  const path = fileOf(meta.id, meta.ext); if (!existsSync(path)) return null;
  return includeData ? { ...meta, data: readFileSync(path).toString('base64') } : { ...meta, path };
}

export function copyAsset(id, targetDir) {
  const asset = getAsset(id); if (!asset) throw fail(`附件不存在：${id}`, 'ASSET_MISSING');
  const name = `${asset.id}.${asset.ext}`, target = join(targetDir, name);
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(target)) copyFileSync(asset.path, target);
  return { ...asset, name, target };
}
