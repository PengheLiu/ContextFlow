// 同步后端分发器。
//
// 加新后端只需在这里加一条分支 + 一个适配层，其余代码不动 ——
// 事件模型本身与笔记后端无关（14 个字段里 13 个通用）。
import * as siyuan from './siyuan.mjs';
import * as mdfile from './mdfile.mjs';

export const BACKENDS = ['siyuan', 'obsidian', 'markdown'];

export const localDay = mdfile.localDay;

/** 当前后端的目标描述，用于日志与配置界面回显 */
export function describe(cfg) {
  const b = cfg.sync?.backend || 'siyuan';
  switch (b) {
    case 'obsidian': return `${b} · ${cfg.obsidian.vaultPath || '(未配置 vault)'}${cfg.obsidian.folder}`;
    case 'markdown': return `${b} · ${cfg.markdown.dir || '(未配置目录)'}${cfg.markdown.folder}`;
    default: return `${b} · ${cfg.siyuan.docPathPrefix} @ ${cfg.siyuan.notebookId}`;
  }
}

/**
 * 同步全部待同步文章。
 *
 * 不再有 day 参数 —— 同步单位从"某一天"变成了"某篇文章"，一篇文章的记录
 * 跨多少天都汇到它自己那一个文档里。opts.urlKey 可限定只同步某篇。
 */
export async function syncAll(cfg, opts = {}) {
  const backend = cfg.sync?.backend || 'siyuan';
  switch (backend) {
    case 'siyuan':
      return { backend, ...(await siyuan.syncAll(cfg, opts)) };
    case 'obsidian':
      return { backend, ...(await mdfile.syncAll(
        { backend, root: cfg.obsidian.vaultPath, folder: cfg.obsidian.folder }, opts)) };
    case 'markdown':
      return { backend, ...(await mdfile.syncAll(
        { backend, root: cfg.markdown.dir, folder: cfg.markdown.folder }, opts)) };
    default:
      throw Object.assign(new Error(`未知同步后端：${backend}`), { code: 'BAD_BACKEND' });
  }
}
