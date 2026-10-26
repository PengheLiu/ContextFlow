// Local recovery points, not portable browser-library exports. Only the owned
// core's closed database, config and content-addressed images are included.
import { mkdir, readdir, lstat, readFile, writeFile, copyFile, rename, unlink } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

const validID = /^[0-9]{13}-[a-f0-9-]{36}$/;
const validFile = /^(config\.json|context\.db(?:-wal)?|secret-key\.bin|assets\/[a-f0-9]{64}\.(png|jpg|webp))$/;
async function hash(file) {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex');
}
const rootOf = paths => join(paths.state, 'recovery');
export async function listRecoveryPoints(paths) {
  if (!existsSync(rootOf(paths))) return [];
  const rows = [];
  for (const id of await readdir(rootOf(paths))) {
    if (!validID.test(id)) continue;
    try {
      const record = JSON.parse(await readFile(join(rootOf(paths), id, 'manifest.json'), 'utf8'));
      if (record.format === 'ContextFlowRecovery' && record.version === 1) rows.push({ id, createdAt: record.createdAt, appVersion: record.appVersion });
    } catch { /* incomplete point is never offered as restorable */ }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}
export async function createRecoveryPoint(paths, { appVersion, sealConfig }) {
  const id = `${Date.now()}-${randomUUID()}`, root = join(rootOf(paths), id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = ['config.json', 'context.db', 'secret-key.bin'];
  // A force-ended/older core may leave committed pages in WAL. The core is
  // stopped here: preserve the matching database + WAL pair, never only schema.
  if (existsSync(join(paths.data, 'context.db-wal'))) files.push('context.db-wal');
  const assets = join(paths.data, 'assets');
  if (existsSync(assets)) {
    if ((await lstat(assets)).isSymbolicLink()) throw new Error('附件目录是符号链接，已停止创建恢复点。');
    for (const name of await readdir(assets)) {
      if (validFile.test(`assets/${name}`)) files.push(`assets/${name}`);
    }
  }
  if (files.length > 10004) throw new Error('恢复点附件数量超过上限，请先手动备份。');
  const entries = []; let bytes = 0;
  for (const name of files) {
    const source = name === 'secret-key.bin' ? paths.secret : join(paths.data, name);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('恢复点只接受本地普通文件。');
    bytes += info.size; if (bytes > 2 * 1024 ** 3) throw new Error('数据超过 2 GB，请先手动备份。');
    const target = join(root, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (name === 'config.json') await writeFile(target, JSON.stringify(sealConfig(JSON.parse(await readFile(source, 'utf8')))), { mode: 0o600 });
    else await copyFile(source, target);
    entries.push({ name, size: (await lstat(target)).size, sha256: await hash(target) });
  }
  const manifest = { format: 'ContextFlowRecovery', version: 1, createdAt: Date.now(), appVersion, files: entries };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { id, createdAt: manifest.createdAt, appVersion };
}
export async function validateRecoveryPoint(paths, id) {
  if (!validID.test(id || '')) throw new Error('无效的恢复点编号');
  const root = join(rootOf(paths), id);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('恢复点不能是符号链接');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'ContextFlowRecovery' || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 10004) throw new Error('恢复点格式不兼容');
  const names = new Set(); let total = 0;
  for (const row of manifest.files) {
    if (!validFile.test(row.name || '') || names.has(row.name) || !/^[a-f0-9]{64}$/.test(row.sha256 || '')) throw new Error('恢复点文件清单无效');
    names.add(row.name);
    const file = join(root, row.name);
    if (row.name.startsWith('assets/') && (await lstat(join(root, 'assets'))).isSymbolicLink()) throw new Error('恢复点附件不能是符号链接');
    const info = await lstat(file); total += info.size;
    if (!info.isFile() || info.isSymbolicLink() || total > 2 * 1024 ** 3 || info.size !== row.size || await hash(file) !== row.sha256) throw new Error('恢复点缺失或文件校验失败，未修改当前数据');
  }
  if (!['config.json', 'context.db', 'secret-key.bin'].every(name => names.has(name))) throw new Error('恢复点不完整');
  JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  return { root, manifest };
}
export async function applyRecoveryPoint(paths, id) {
  const { root, manifest } = await validateRecoveryPoint(paths, id);
  if (existsSync(join(paths.data, 'assets')) && (await lstat(join(paths.data, 'assets'))).isSymbolicLink()) throw new Error('当前附件目录是符号链接，已拒绝恢复。');
  // The manager must have stopped its core first. Browser pairings are never
  // restored: undoing a browser revocation would be a privilege escalation.
  for (const suffix of ['-wal', '-shm']) {
    const file = join(paths.data, `context.db${suffix}`);
    if (existsSync(file)) await rename(file, `${file}.pre-restore-${randomUUID()}`);
  }
  for (const { name } of manifest.files) {
    const target = name === 'secret-key.bin' ? paths.secret : join(paths.data, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.restore-${randomUUID()}`;
    await copyFile(join(root, name), temporary); await rename(temporary, target);
  }
  return { encryptedKey: await readFile(paths.secret) };
}

// A failure to decrypt is not permission to replace a user's only key. Keep the
// app available for diagnostics/recovery while refusing to start an unsafe core.
export function loadProtectedSecret(paths, protector) {
  try {
    const config = join(paths.data, 'config.json');
    let configText = '';
    if (existsSync(config)) {
      configText = readFileSync(config, 'utf8');
      try { JSON.parse(configText); }
      catch { return { blockedReason: '本地配置无法读取，原文件与密钥已保留；请在设置与帮助中选择有效的本机恢复点。' }; }
    }
    if (!protector.isEncryptionAvailable()) throw new Error('OS protection unavailable');
    if (existsSync(paths.secret)) {
      const key = protector.decryptString(readFileSync(paths.secret));
      if (Buffer.from(key, 'base64').length !== 32) throw new Error('Invalid key');
      return { key };
    }
    if (configText.includes('contextflow:sealed:v1:')) throw new Error('Missing protected key');
    const key = randomBytes(32).toString('base64');
    writeFileSync(paths.secret, protector.encryptString(key), { mode: 0o600, flag: 'wx' });
    return { key };
  } catch {
    return { blockedReason: '系统密钥暂不可用或已损坏，原文件未被覆盖。请先解锁系统凭据后重试；仍无法启动时，可在设置与帮助中使用有效的本机恢复点。' };
  }
}

const protectedBase = ['config.json', 'context.db', 'context.db-wal', 'context.db-shm', 'secret-key.bin'];
const protectedName = name => protectedBase.includes(name) || /^assets\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(name);
const liveFile = (paths, name) => name === 'secret-key.bin' ? paths.secret : join(paths.data, name);
async function protectOriginal(paths, appVersion) {
  const id = `${Date.now()}-${randomUUID()}`, root = join(paths.state, 'recovery-protection', id);
  const names = [...protectedBase], assets = join(paths.data, 'assets');
  if (existsSync(assets)) {
    if ((await lstat(assets)).isSymbolicLink()) throw new Error('附件目录是符号链接，已停止恢复。');
    names.push(...(await readdir(assets)).map(name => `assets/${name}`).filter(protectedName));
  }
  if (names.length > 10005) throw new Error('原始附件数量超出保护上限，未修改数据。');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = [], missing = []; let total = 0;
  for (const name of names) {
    const source = liveFile(paths, name);
    let info; try { info = await lstat(source); } catch (error) { if (error.code === 'ENOENT') { missing.push(name); continue; } throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('原始数据含非普通文件，已停止恢复。');
    total += info.size; if (total > 2 * 1024 ** 3) throw new Error('原始数据超过 2 GB，未修改数据。');
    const target = join(root, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    files.push({ name, size: info.size, sha256: await hash(target) });
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ format: 'ContextFlowRecoveryProtection', version: 1, appVersion, files, missing }), { mode: 0o600 });
  return { id, root };
}
async function rollbackOriginal(paths, protection) {
  const manifest = JSON.parse(await readFile(join(protection.root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'ContextFlowRecoveryProtection' || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.missing)) throw new Error('保护副本格式无效');
  const names = new Set();
  for (const row of manifest.files) {
    if (!protectedName(row.name) || names.has(row.name)) throw new Error('保护清单无效'); names.add(row.name);
    const source = join(protection.root, row.name), info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== row.size || await hash(source) !== row.sha256) throw new Error('保护副本校验失败');
  }
  for (const name of manifest.missing) {
    if (!protectedBase.includes(name) || names.has(name)) throw new Error('保护清单无效'); names.add(name);
  }
  if (!protectedBase.every(name => names.has(name))) throw new Error('保护副本不完整');
  if (existsSync(join(paths.data, 'assets')) && (await lstat(join(paths.data, 'assets'))).isSymbolicLink()) throw new Error('当前附件目录不安全');
  for (const row of manifest.files) {
    const target = liveFile(paths, row.name), temporary = `${target}.rollback-${randomUUID()}`;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(protection.root, row.name), temporary); await rename(temporary, target);
  }
  for (const name of manifest.missing) {
    const target = liveFile(paths, name);
    if (existsSync(target)) { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('回滚目标不安全'); await unlink(target); }
  }
}

// Works with a stopped/failed core too. Validate before stopping anything; never
// decode a damaged live config just to preserve its bytes for a rollback.
export async function restoreStoppedDesktop(paths, id, { service, safeStorage, decodeConfig, appVersion, acquireOwner }) {
  if (typeof acquireOwner !== 'function') throw new Error('缺少本机数据占用保护，未修改数据。');
  const point = await validateRecoveryPoint(paths, id);
  const key = safeStorage.decryptString(await readFile(join(point.root, 'secret-key.bin')));
  if (Buffer.from(key, 'base64').length !== 32) throw new Error('恢复点密钥无效，未修改数据。');
  const config = decodeConfig(JSON.parse(await readFile(join(point.root, 'config.json'), 'utf8')), key);
  if (service.state === 'external') throw new Error('请先退出旧服务，再进行本机恢复。');
  const original = { key: service.secretKey, port: service.port, blockedReason: service.blockedReason, running: service.state === 'running' };
  let owner, protection;
  try {
    await service.stop(); await service.startDone;
    if (service.child || service.starting || await service.health()) throw new Error('仍有服务占用，请先正常退出其他服务；未修改数据。');
    owner = acquireOwner(paths.data, { kind: 'recovery' });
    protection = await protectOriginal(paths, appVersion);
    await applyRecoveryPoint(paths, id);
    service.secretKey = key; service.port = Number(config.port) || 7317; service.blockedReason = undefined;
    owner.release(); owner = null;
    await service.start();
    if (service.state !== 'running') throw new Error('恢复后的服务未能启动');
    return { ok: true, protectedBy: protection.id };
  } catch (error) {
    owner?.release(); owner = null;
    if (!protection) { if (original.running) await service.start(); throw error; }
    try {
      await service.stop(); await service.startDone;
      if (service.child || service.starting || await service.health()) throw new Error('服务仍占用数据');
      owner = acquireOwner(paths.data, { kind: 'recovery' });
      await rollbackOriginal(paths, protection);
      service.secretKey = original.key; service.port = original.port; service.blockedReason = original.blockedReason;
      owner.release(); owner = null;
      if (original.running) await service.start();
      else service.update?.('error', original.blockedReason || '恢复未完成，已回滚到操作前的保护副本，可选择其他有效恢复点。');
    } catch {
      service.blockedReason = '恢复未完成，保护副本已保留；当前文件状态需要人工核对，未自动启动服务。';
      service.update?.('error', service.blockedReason);
      throw new Error('恢复与自动回滚未完成。原始保护副本保留在桌面状态目录，请停止其他服务后联系支持；不要删除密钥或数据。');
    }
    throw new Error('恢复未完成，已回滚到操作前的保护副本。请检查服务状态或选择其他有效恢复点。');
  } finally { owner?.release(); }
}
