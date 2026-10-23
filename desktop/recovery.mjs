// Local recovery points, not portable browser-library exports. Only the owned
// core's closed database, config and content-addressed images are included.
import { mkdir, readdir, lstat, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

const validID = /^[0-9]{13}-[a-f0-9-]{36}$/;
const validFile = /^(config\.json|context\.db|secret-key\.bin|assets\/[a-f0-9]{64}\.(png|jpg|webp))$/;
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
  const assets = join(paths.data, 'assets');
  if (existsSync(assets)) {
    if ((await lstat(assets)).isSymbolicLink()) throw new Error('附件目录是符号链接，已停止创建恢复点。');
    for (const name of await readdir(assets)) {
      if (validFile.test(`assets/${name}`)) files.push(`assets/${name}`);
    }
  }
  if (files.length > 10003) throw new Error('恢复点附件数量超过上限，请先手动备份。');
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
  if (manifest.format !== 'ContextFlowRecovery' || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 10003) throw new Error('恢复点格式不兼容');
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
