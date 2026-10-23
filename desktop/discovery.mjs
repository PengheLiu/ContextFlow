// Local metadata only: these two endpoints never call a model, authenticate
// third-party accounts, read note contents or grant access to discovered paths.
export class LocalDiscovery {
  constructor({ request, timeoutMs = 10000, now = Date.now, changed = () => {} }) {
    Object.assign(this, { request, timeoutMs, now, changed });
    this.value = { agents: { state: 'idle', items: [] }, notes: { state: 'idle', items: [] }, updatedAt: null };
  }
  snapshot() { return structuredClone(this.value); }
  async run({ fresh = false } = {}) {
    if (this.pending) return this.pending;
    if (!fresh && this.value.updatedAt && this.now() - this.value.updatedAt < 10 * 60 * 1000) return this.snapshot();
    const part = async (key, path, field) => {
      this.value[key] = { state: 'running', items: this.value[key].items }; this.changed();
      let timer;
      try {
        const response = await Promise.race([
          this.request(path, {}, { timeoutMs: this.timeoutMs }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); }),
        ]);
        if (response.status !== 200 || !Array.isArray(response.body?.[field])) throw new Error('检测暂未完成，请稍后重新检测。');
        const items = response.body[field].filter(row => row && typeof row === 'object').slice(0, 100);
        this.value[key] = { state: 'done', items: key === 'notes' ? items.filter(row => row.exists !== false && typeof row.path === 'string').map(row => ({ ...row, backend: 'obsidian' })) : items };
      } catch { this.value[key] = { state: 'error', items: [], error: '暂时无法完成检测。你可以重试，或手动选择。' }; }
      clearTimeout(timer); this.changed();
    };
    this.pending = Promise.all([
      part('agents', `/agents/detect${fresh ? '?fresh=1' : ''}`, 'agents'),
      part('notes', '/obsidian/vaults', 'vaults'),
    ]).then(() => { this.value.updatedAt = this.now(); return this.snapshot(); }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
