// Safe, deterministic menu data only. The main process owns health freshness,
// Electron Menu creation and every action (including confirmation before quit).
const STATUS_LABELS = new Map([
  ['starting', '本地服务正在启动…'],
  ['running', '本地服务运行中'],
  ['stopped', '本地服务已停止'],
  ['stopping', '本地服务正在停止…'],
  ['external', '旧版服务或端口占用'],
  ['error', '本地服务需要处理'],
  ['unavailable', '本地服务暂未响应'],
]);
const taskCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * @param {object} options
 * @param {{state?: string, health?: {jobs?: {running?: number, queued?: number}}}} [options.service]
 * @returns {object[]} An Electron Menu template, without importing Electron.
 * Never render raw service messages, errors, configuration or note metadata.
 */
export function trayMenuTemplate({ service, onOpen, onSettings, onRestart, onQuit } = {}) {
  const state = typeof service?.state === 'string' ? service.state : '';
  const running = taskCount(service?.health?.jobs?.running);
  const queued = taskCount(service?.health?.jobs?.queued);
  const busy = running > 0 || queued > 0;
  const transitioning = state === 'starting' || state === 'stopping';
  const tasks = running === null && queued === null ? '任务状态待确认'
    : `任务：运行中 ${running ?? '待确认'} · 排队 ${queued ?? '待确认'}`;
  const action = (id, label, callback, enabled = true) => ({
    id, label, enabled: enabled && typeof callback === 'function',
    ...(typeof callback === 'function' ? { click: callback } : {}),
  });
  return [
    { id: 'heading', label: 'ContextFlow', enabled: false },
    { id: 'service-status', label: STATUS_LABELS.get(state) || '本地服务状态未知', enabled: false },
    { id: 'tasks-status', label: tasks, enabled: false },
    { type: 'separator' },
    action('open', '打开 ContextFlow', onOpen),
    action('settings', '设置与帮助', onSettings),
    { type: 'separator' },
    action('restart', '重启本地服务', onRestart, !busy && !transitioning),
    action('quit', '退出 ContextFlow', onQuit),
  ];
}
