// Last explicit connection checks, shared by welcome/settings and reading pages.
// Only opaque, service-keyed identities and timestamps are persisted: no keys,
// endpoints, prompts, CLI output or article content. Testing never saves config.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { trimBase } from './llm.mjs';

export class ConnectionChecks {
  constructor(dir, secret) {
    this.dir = dir; this.secret = secret;
    this.file = join(dir, 'connection-checks.json');
    this.entries = new Map(); this.pending = new Map();
    try {
      const rows = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [key, value] of Object.entries(rows)) {
        if (/^[a-f0-9]{64}$/.test(key) && typeof value?.ok === 'boolean' && Number.isFinite(value.checkedAt)) {
          this.entries.set(key, { ok: value.ok, checkedAt: value.checkedAt });
        }
      }
      while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value);
    } catch { /* First run or corrupt history: never claim a check passed. */ }
  }

  identity(kind, data) {
    return createHmac('sha256', this.secret).update(JSON.stringify([kind, data])).digest('hex');
  }
  modelKey(cfg) {
    const t = cfg.translate;
    return this.identity('model', [t.provider, trimBase(t.baseUrl || (t.provider === 'anthropic' ? 'https://api.anthropic.com' : '')), t.model || '', t.apiKey || '']);
  }
  agentKey(agent) {
    return this.identity('agent', [agent.id, agent.path || '', agent.version || '',
      agent.profile || 'safe',
      Object.entries(agent.env || {}).sort(([a], [b]) => a.localeCompare(b))]);
  }
  begin(key) {
    const ticket = { key, sequence: Symbol() };
    this.pending.set(key, ticket.sequence);
    return ticket;
  }
  discard(ticket) {
    if (this.pending.get(ticket.key) === ticket.sequence) this.pending.delete(ticket.key);
  }
  finish(ticket, ok, checkedAt = Date.now()) {
    // A slow, older attempt must not overwrite the outcome of a newer test.
    if (this.pending.get(ticket.key) !== ticket.sequence) return;
    this.pending.delete(ticket.key);
    this.entries.delete(ticket.key);
    this.entries.set(ticket.key, { ok: !!ok, checkedAt });
    while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value);
    try {
      mkdirSync(this.dir, { recursive: true });
      const staged = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(staged, JSON.stringify(Object.fromEntries(this.entries)) + '\n', { mode: 0o600 });
      renameSync(staged, this.file);
    } catch { console.warn('[connection-checks] 无法保存连接测试记录；本次结果仅在服务运行期间有效'); }
  }
  view(cfg, installed = []) {
    const agents = {};
    for (const row of installed) {
      if (!row.available || !(row.connectionTestSupported ?? row.safeSupport !== 'unsupported')) continue;
      const profile = cfg.agent?.id === row.id ? cfg.agent.profile || 'safe' : 'safe';
      const result = this.entries.get(this.agentKey({ ...row, profile, env: cfg.agent?.id === row.id ? cfg.agent.env : {} }));
      if (result) agents[row.id] = { ...result, version: row.version || '', path: row.path || '', profile };
    }
    return { model: this.entries.get(this.modelKey(cfg)) || null, agents };
  }
}
