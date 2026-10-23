// Shared destination identity binds a UI status to the exact public config it
// describes. Contains no credentials; persistence stores its SHA-256 instead.
export function destinationIdentity(cfg = {}) {
  const backend = cfg.sync?.backend || 'markdown';
  const fields = backend === 'obsidian' ? [cfg.obsidian?.vaultPath, cfg.obsidian?.folder]
    : backend === 'siyuan' ? [cfg.siyuan?.origin, cfg.siyuan?.notebookId, cfg.siyuan?.docPathPrefix]
      : backend === 'markdown' ? [cfg.markdown?.dir, cfg.markdown?.folder] : [];
  if (!fields.length || !fields[0] || (backend === 'siyuan' && !fields[1])) return '';
  return JSON.stringify([backend, ...fields.map(value => String(value || ''))]);
}
