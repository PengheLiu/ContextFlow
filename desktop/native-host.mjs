import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { decodeNative, encodeNative } from './protocol.mjs';
import { EXTENSIONS } from './platform.mjs';

// Chrome launches a separate, short-lived host. It never owns the core service.
export async function runNativeHost({ app, paths, development = false, input = process.stdin, output = process.stdout,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), readinessTimeoutMs = 15000, spawnProcess = spawn }) {
  app.disableHardwareAcceleration();
  const origin = process.argv.find(value => /^chrome-extension:\/\/[a-p]{32}\/?$/.test(value));
  const id = origin?.match(/[a-p]{32}/)?.[0];
  const allowed = development ? EXTENSIONS : EXTENSIONS.slice(0, 1);
  if (!allowed.includes(id)) { app.exit(1); return; }
  let buffer = Buffer.alloc(0), used = false, finished = false;
  const controller = new AbortController();
  const finish = value => { if (finished) return; finished = true; controller.abort(); output.write(encodeNative(value), () => app.exit(0)); };
  const timer = setTimeout(() => { finish({ ok: false, error: '连接授权超时，请回到桌面端重试。' }); }, 90000);
  input.on('end', () => { controller.abort(); clearTimeout(timer); if (!finished) { finished = true; app.exit(0); } });
  input.on('data', async chunk => {
    if (used) return;
    try {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeNative(buffer); if (!decoded) return;
      used = true; buffer = null;
      const request = decoded.value;
      if (request?.type !== 'pair' || request.protocolVersion !== 1 || request.consent !== true ||
        !/^[A-Za-z0-9_-]{16,80}$/.test(request.instanceId || '')) throw new Error('无效的连接请求');
      let started = false;
      const deadline = now() + Math.min(15000, Math.max(1, readinessTimeoutMs));
      for (let n = 0; n < 60 && now() < deadline && !finished; n++) {
        let state;
        try { state = JSON.parse(readFileSync(paths.bridge, 'utf8')); } catch { /* not running */ }
        let status;
        if (state && Number.isInteger(state.port) && state.port > 0 && state.port < 65536 && /^[A-Za-z0-9_-]{43}$/.test(state.secret || '')) {
          try {
            // Publishing the bridge precedes core startup. Wait for readiness,
            // not merely a live Electron process, before asking the user once.
            const response = await fetch(`http://127.0.0.1:${state.port}/status`, { method: 'POST', redirect: 'error',
              headers: { Authorization: `Bearer ${state.secret}`, 'Content-Type': 'application/json' },
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - now())))]),
            });
            if (response.ok) status = await response.json();
          } catch { /* stale bridge record, wake the desktop app once */ }
          if (status?.ok && status.service === 'running') {
            const response = await fetch(`http://127.0.0.1:${state.port}/pair`, { method: 'POST', redirect: 'error',
              headers: { Authorization: `Bearer ${state.secret}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, instanceId: request.instanceId, label: String(request.label || 'Chrome').slice(0, 80) }),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(75000)]),
            });
            const result = await response.json(); clearTimeout(timer); finish(result); return;
          }
          if (status?.ok && ['external', 'error', 'stopped', 'stopping'].includes(status.service)) {
            throw new Error(status.service === 'external' ? '本地连接被旧服务或其他程序占用，请先在桌面端处理后重试。'
              : '本地服务尚未就绪，请在 ContextFlow「设置与帮助」恢复连接后重试。');
          }
        }
        if (!status?.ok && !started) {
          const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
          const child = spawnProcess(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
          child.on('error', () => {}); child.unref(); started = true;
        }
        await wait(Math.max(1, Math.min(250, deadline - now())));
      }
      throw new Error('桌面端启动尚未就绪，请先打开 ContextFlow，等待本地连接正常后再重试。');
    } catch (error) { clearTimeout(timer); finish({ ok: false, error: error.message }); }
  });
}
