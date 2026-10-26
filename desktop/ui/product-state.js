// Discovery is not authorization, and an existing path is not a verified sync.
import { destinationIdentity } from '../../src/core/destination.js';
export const STEPS = ['connect', 'tools', 'notes', 'finish'];
export function noteDestination(cfg) {
  if (!cfg) return null;
  const backend = cfg.sync?.backend || 'markdown';
  if (backend === 'obsidian') return cfg.obsidian?.vaultPath ? { backend, name: 'Obsidian', path: cfg.obsidian.vaultPath, folder: cfg.obsidian.folder || '' } : null;
  if (backend === 'siyuan') return cfg.siyuan?.notebookId ? { backend, name: '思源笔记', path: cfg.siyuan.notebookId, folder: cfg.siyuan.docPathPrefix || '' } : null;
  return cfg.markdown?.dir ? { backend, name: 'Markdown 文件夹', path: cfg.markdown.dir, folder: cfg.markdown.folder || '' } : null;
}
export function productState(snapshot = {}, cfg = null) {
  const service = snapshot.service || {}, journey = snapshot.journey || {};
  const running = service.state === 'running';
  const preparing = !service.state || ['starting', 'stopping'].includes(service.state) || service.state === 'stopped' && !service.message;
  const pairingError = !!snapshot.pairingError;
  const connections = pairingError ? null : snapshot.pairings?.length || 0;
  const usesAgent = cfg?.explain?.backend === 'agent';
  const check = usesAgent ? cfg?.connectionChecks?.agents?.[cfg?.agent?.id] : cfg?.connectionChecks?.model;
  const answer = snapshot.readingStatus?.ai;
  const failedAfterAnswer = check?.ok === false && (!answer?.lastAnswerAt || !check.checkedAt || check.checkedAt >= answer.lastAnswerAt);
  const answered = answer?.verified === true && !failedAfterAnswer;
  const tested=check?.ok===true && (!answer?.failedAt || check.checkedAt>answer.failedAt);
  const ai = { ok: running && (tested || answered), checked: !!check, answered: running && answered, name: usesAgent ? (cfg?.agent?.id || '本地 Agent') : (cfg?.translate?.model || '模型连接'),
    label: !running ? '等待本地连接' : answered ? '已完成网页回答' : tested ? '回答测试通过' : answer?.failedAt ? '需要重新验证' : check ? '测试未通过' : '尚未验证',
    detail: answered ? '当前回答方式已在网页实际完成回答；不代表所有工具或笔记权限均已验证。' : tested ? '仅代表所选回答方式的连接测试，不代表工具或笔记权限。' : answer?.failedAt ? '最近一次 Agent 连接或回答失败，请检查程序与登录后重新测试；基础批注不受影响。' : '使用自己的模型或已登录的 Agent；基础批注不需要 AI。' };
  const destination = noteDestination(cfg), matched = !!destination && journey.destination === destinationIdentity(cfg);
  const verified = running && matched && journey.notesVerified === true;
  // A deliberate successful browser sync is already an explicit use of this
  // exact destination; don't demand a second desktop confirmation afterwards.
  const confirmed = matched && (journey.notesConfirmed === true || verified);
  const unchanged = running && matched && snapshot.readingStatus?.sync?.completed === true && snapshot.readingStatus.sync.changed === false;
  const notes = { destination, confirmed, verified,
    label: !running ? '等待本地连接' : verified ? '已验证写入' : unchanged ? '同步完成 · 无新改动' : confirmed ? '位置已确认 · 待同步' : '尚未确认位置',
    detail: verified ? '已记录当前目的地的一次真实同步成功。' : unchanged ? '网页同步已完成，本次没有需要新增或更新的内容；未将它冒充为新的写入验证。' : confirmed ? '在网页侧栏点击「同步」，才会写入笔记。' : '默认文件夹不代表你的选择。请确认保存位置，不会自动写入。' };
  const browser = { count: connections, error: pairingError, ok: running && !pairingError && connections > 0,
    label: pairingError ? '授权记录需处理' : connections ? `已授权 ${connections} 个浏览器` : '尚未授权',
    detail: pairingError ? '授权记录无法读取，连接已暂停；原文件已保留。请在「设置与帮助」查看处理指引；基础批注与导出仍可用。'
      : connections ? '授权记录不代表浏览器正在打开；每个 Chrome 配置独立连接。' : '在 Chrome 扩展中发起连接，再由你确认授权。' };
  let action;
  if (pairingError) action = { kind: 'support', label: '查看处理指引', title: '浏览器授权记录需要处理', detail: browser.detail };
  else if (!running) action = preparing ? { kind: 'none', label: '正在准备本地连接…', title: '正在准备你的阅读环境', detail: '窗口已就绪，本地连接正在后台准备。稍候即可继续。' }
    : { kind: 'support', label: '检查本地连接', title: '先恢复本地连接', detail: service.message || '阅读批注和下载不受影响；AI 与笔记同步需要本地连接。' };
  else if (!connections) action = { kind: 'browser', label: '连接 Chrome 扩展', title: '把阅读页面连接进来', detail: '安装、发现和授权是不同的步骤。你决定哪个浏览器可以访问本地服务。' };
  else if (!journey.dismissed) action = { kind: 'setup', label: '继续首次准备', title: '接着完成你的阅读设置', detail: '可以跳过 AI 或笔记设置，之后随时回来继续。' };
  else if (!confirmed && destination) action = { kind: 'notes', label: '确认笔记保存位置', title: '阅读记录，保存到你选择的地方', detail: '现有路径已保留，但还需要你确认。确认本身不会写入笔记。' };
  else action = { kind: 'practice', label: '去网页开始阅读', title: '准备好了，回到阅读吧', detail: ai.ok ? '选中文字即可解释；自己的想法可以就地批注。' : '高亮、批注与下载可以直接用。需要 AI 时，再配置并测试。' };
  return { running, preparing, browser, ai, notes, action };
}
