import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { destinationIdentity } from '../src/core/destination.js';
export { destinationIdentity };

// A destination receipt proves a successful user-triggered sync, not merely
// that a default path happens to be present. Never persist article identifiers.
export function destinationKey(cfg = {}) {
  const identity = destinationIdentity(cfg);
  return identity ? createHash('sha256').update(identity).digest('hex') : '';
}

export class SyncStatus {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = directory; this.now = now; this.file = join(directory, 'sync-status.json'); this.receipt = null;
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8'));
      if (value.version === 1 && /^[a-f0-9]{64}$/.test(value.destination) && Number.isSafeInteger(value.at) && value.at > 0) this.receipt = value;
    } catch { /* New or damaged receipt never blocks reading or syncing. */ }
  }
  record(cfg, result) {
    const destination = destinationKey(cfg);
    if (!destination || result?.backend !== cfg.sync?.backend || !Number.isSafeInteger(result?.articles) || result.articles < 1) return false;
    const writes = cfg.sync.backend === 'siyuan' ? result.docs : result.files;
    if (!Array.isArray(writes) || !writes.some(value => typeof value === 'string' && value.length > 0)) return false;
    const receipt = { version: 1, destination, at: this.now() };
    // Failure to save optional status must not turn a completed write into a
    // failed sync that the user retries (and potentially duplicates).
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 }); renameSync(temporary, this.file);
      this.receipt = receipt; return true;
    } catch { return false; }
  }
  view(cfg) {
    const matched = !!this.receipt && this.receipt.destination === destinationKey(cfg);
    return { verified: matched, lastSyncAt: matched ? this.receipt.at : null };
  }
}
