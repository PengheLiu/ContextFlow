// Build-only, shared by both desktop targets. The production installer below
// pins the same license bytes whether sourced from the verified tar or HTTPS.
import { createHash, randomBytes } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, fstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export const NODE_LICENSE_VERSION = '24.22.1';
export const NODE_LICENSE_SHA256 = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
const MAX_BYTES = 2 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => failure('NODE_LICENSE_INVALID', 'Node 许可文件 SHA-256 或内容校验失败，拒绝构建。');
const unsafe = () => failure('NODE_LICENSE_UNSAFE_PATH', 'Node 许可缓存或输出路径必须为无符号链接的普通目录和文件。');
const unavailable = () => failure('NODE_LICENSE_UNAVAILABLE', '无法获取经校验的 Node 许可文件，请检查网络后重试。');

function info(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw unsafe(); }
}
function directory(path) {
  const absolute = resolve(path), parent = dirname(absolute);
  if (parent !== absolute) directory(parent);
  let entry = info(absolute);
  if (!entry) { try { mkdirSync(absolute, { mode: 0o755 }); } catch { throw unsafe(); } entry = info(absolute); }
  if (!entry?.isDirectory() || entry.isSymbolicLink()) throw unsafe();
  return absolute;
}
function regular(file) {
  const entry = info(file);
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw unsafe();
  return entry;
}
function readCache(file) {
  if (!regular(file)) return null;
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > MAX_BYTES) return null;
    return readFileSync(fd);
  } catch { throw unsafe(); } finally { if (fd !== undefined) closeSync(fd); }
}
function atomicWrite(file, bytes) {
  const parent = directory(dirname(file)); regular(file);
  const temporary = join(parent, `.node-license-${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o644);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    directory(parent); regular(file);
    // rename replaces the directory entry, never a symlink's external target.
    renameSync(temporary, file);
  } catch { throw unsafe(); } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Already atomically committed. */ }
  }
}
async function responseBytes(response) {
  if (!response?.ok || /text\/html/i.test(response.headers?.get?.('content-type') || '')) throw invalid();
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) throw invalid();
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw invalid();
    return bytes;
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_BYTES) throw invalid(); chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// A generic factory permits deterministic offline tests. prepare-desktop uses
// only installNodeLicense, whose version and digest cannot be overridden.
export function createLicenseInstaller({ version, sha256 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw invalid();
  const verify = value => {
    let bytes; try { bytes = Buffer.from(value); } catch { throw invalid(); }
    if (!bytes.length || bytes.length > MAX_BYTES || /^\s*(?:<!doctype\s+html|<html(?:\s|>))/i.test(bytes.subarray(0, 256).toString('utf8')) || createHash('sha256').update(bytes).digest('hex') !== sha256) throw invalid();
    return bytes;
  };
  return async function install({ cacheDir, output, sourceBytes, fetcher = fetch, attemptTimeoutMs = 15000, totalTimeoutMs = 45000, attempts = 3 }) {
    if (!cacheDir || !output || !Number.isInteger(attempts) || attempts < 1 || attempts > 3 ||
      !Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 15000 ||
      !Number.isFinite(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 45000) throw invalid();
    const cache = join(directory(cacheDir), `node-${version}-LICENSE`);
    directory(dirname(output)); regular(output);
    let bytes;
    if (sourceBytes !== undefined) {
      // Mac passes LICENSE from the already SHA-verified Node archive.
      bytes = verify(sourceBytes); regular(cache); atomicWrite(cache, bytes);
    } else {
      const cached = readCache(cache);
      if (cached) { try { bytes = verify(cached); } catch { /* A corrupt regular cache is a miss, never trusted. */ } }
      const deadline = performance.now() + totalTimeoutMs;
      for (let attempt = 0; !bytes && attempt < attempts; attempt++) {
        const budget = Math.min(attemptTimeoutMs, deadline - performance.now()); if (budget <= 0) break;
        const controller = new AbortController(); let timer;
        try {
          bytes = await Promise.race([
            (async () => verify(await responseBytes(await fetcher(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`, { signal: controller.signal, redirect: 'error' }))))(),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, budget); }),
          ]);
        } catch { /* Bounded retry; never expose upstream text, URL or credentials. */ }
        finally { clearTimeout(timer); controller.abort(); }
      }
      if (!bytes) throw unavailable();
      // Verified cache hits are not rewritten. Downloads repair corrupt bytes.
      if (!cached || !cached.equals(bytes)) atomicWrite(cache, bytes);
    }
    atomicWrite(output, bytes);
    return { version, sha256, cache };
  };
}

export const installNodeLicense = createLicenseInstaller({ version: NODE_LICENSE_VERSION, sha256: NODE_LICENSE_SHA256 });
