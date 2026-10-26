// Product readiness is based on actual operations, not article content or an
// optimistic browser flag. All persisted identities are keyed opaque hashes.
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { destinationIdentity } from '../src/core/destination.js';
import { AGENT_EXECUTION_IDENTITY, AGENT_READINESS_FAILURES, agentConnectionIdentity } from './connection-checks.mjs';

export class ReadingStatus {
  constructor(directory, secret, { now = Date.now } = {}) {
    this.directory = directory; this.secret = secret; this.now = now;
    this.file = join(directory, 'reading-status.json'); this.entries = new Map();
    try {
      for (const [key, value] of Object.entries(JSON.parse(readFileSync(this.file, 'utf8')))) {
        if (/^[a-f0-9]{64}$/.test(key) && Number.isSafeInteger(value?.at) && value.at > 0 && ['answer', 'failed', 'written', 'unchanged'].includes(value.outcome)) this.entries.set(key, value);
      }
      while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value);
    } catch { /* No receipt is not a successful operation. */ }
  }
  key(kind, cfg, installed = []) {
    let identity;
    if (kind === 'sync') identity = destinationIdentity(cfg);
    else if (kind === 'agent') {
      const a = cfg.agent || {};
      const resolved = installed.find(row => row.id === a.id && row.available && row.path && (row.identity || row.version));
      if (!resolved) return '';
      identity = [agentConnectionIdentity({ ...resolved, profile: a.profile || 'safe', env: a.env || {} }), a.executable || '', a.notesDir || ''];
    } else {
      const t = cfg.translate || {};
      identity = [t.provider || '', (t.baseUrl || '').replace(/\/+$/, ''), t.model || '', t.apiKey || ''];
    }
    return identity ? createHmac('sha256', this.secret).update(JSON.stringify([kind, identity])).digest('hex') : '';
  }
  save(key, outcome) {
    if (!key) return false;
    this.entries.delete(key); this.entries.set(key, { at: this.now(), outcome });
    while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 }); renameSync(temporary, this.file);
    } catch { /* Optional readiness must never fail a completed user action. */ }
    return true;
  }
  answer(cfg, result, { translation = false } = {}) {
    if (!result || result.cached || !String(result.answer || result.summary || result.translation || '').trim()) return false;
    const kind = translation || result.via === 'llm' ? 'model' : result.via === `agent:${cfg.agent?.id}` ? 'agent' : '';
    return !!kind && this.save(this.key(kind, cfg, result[AGENT_EXECUTION_IDENTITY] ? [result[AGENT_EXECUTION_IDENTITY]] : []), 'answer');
  }
  agentFailure(cfg, error) {
    // Cancellation or a rejected user input is not evidence of lost login.
    if(!AGENT_READINESS_FAILURES.has(error?.code))return false;
    const resolved=error[AGENT_EXECUTION_IDENTITY];
    return !!resolved && this.save(this.key('agent',cfg,[resolved]),'failed');
  }
  sync(cfg, result) {
    if (!result || result.backend !== cfg.sync?.backend || !Number.isSafeInteger(result.articles) || result.articles < 0) return false;
    const writes = result.backend === 'siyuan' ? result.docs : result.files;
    if (!Array.isArray(writes)) return false;
    return this.save(this.key('sync', cfg), writes.some(value => typeof value === 'string' && value) ? 'written' : 'unchanged');
  }
  view(cfg, installed = [], checks = {}) {
    const usesAgent = cfg.explain?.backend === 'agent';
    const ai = this.entries.get(this.key(usesAgent ? 'agent' : 'model', cfg, installed));
    const check = usesAgent ? checks.agents?.[cfg.agent?.id] : checks.model;
    const verified = ai?.outcome === 'answer' && !(check?.ok === false && check.checkedAt >= ai.at);
    const sync = this.entries.get(this.key('sync', cfg));
    return { ai: { verified, lastAnswerAt: verified ? ai.at : null, ...(ai?.outcome==='failed' ? {failedAt:ai.at} : {}) },
      sync: { completed: !!sync, changed: sync?.outcome === 'written', at: sync?.at || null } };
  }
}
