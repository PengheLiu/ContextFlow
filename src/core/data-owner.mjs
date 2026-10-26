// Cooperative ownership for current ContextFlow cores and offline recovery.
// This is not a detector for historical CLIs which predate this protocol.
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const busy = () => Object.assign(new Error('阅读数据正由其他服务或恢复操作使用；请先正常退出其他 ContextFlow 服务。未修改数据。'), { code: 'DATA_DIRECTORY_BUSY' });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
function record(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw busy();
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value?.format !== 'ContextFlowDataOwner' || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce || '')) throw busy();
  return value;
}
function create(file, value) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
}
function release(file, value) {
  try { if (record(file).nonce === value.nonce) unlinkSync(file); } catch { /* Never remove an unknown or replacement owner. */ }
}
export function acquireDataOwner(directory, { kind = 'core', pid = process.pid, isAlive = alive } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, '.contextflow-owner.lock'), reclaim = `${file}.reclaim`;
  const value = { format: 'ContextFlowDataOwner', pid, kind, nonce: randomBytes(32).toString('base64url') };
  try { create(file, value); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-owner removal. A crashed/unknown reclamation stays
    // conservative rather than risking deletion of a newly acquired live lock.
    try { create(reclaim, value); } catch { throw busy(); }
    try {
      let previous;
      try { previous = record(file); } catch { throw busy(); }
      if (isAlive(previous.pid)) throw busy();
      if (record(file).nonce !== previous.nonce) throw busy();
      unlinkSync(file);
      try { create(file, value); } catch { throw busy(); }
    } finally { release(reclaim, value); }
  }
  return { release: () => release(file, value) };
}
