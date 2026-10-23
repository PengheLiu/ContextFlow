import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { decodeNative, encodeNative } from './protocol.mjs';
import { EXTENSIONS } from './platform.mjs';

// Chrome launches a separate, short-lived host. It never owns the core service.
export async function runNativeHost({ app, paths, development = false, input = process.stdin, output = process.stdout }) {
  app.disableHardwareAcceleration();
  const origin = process.argv.find(value => /^chrome-extension:\/\/[a-p]{32}\/?$/.test(value));
  const id = origin?.match(/[a-p]{32}/)?.[0];
  const allowed = development ? EXTENSIONS : EXTENSIONS.slice(0, 1);
  if (!allowed.includes(id)) { app.exit(1); return; }
  let buffer = Buffer.alloc(0), used = false;
  const finish = value => { output.write(encodeNative(value), () => app.exit(0)); };
  const timer = setTimeout(() => { finish({ ok: false, error: '连接授权超时，请回到桌面端重试。' }); }, 90000);
  input.on('end', () => { if (!used) app.exit(0); });
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
      for (let n = 0; n < 60; n++) {
        let state;
        try { state = JSON.parse(readFileSync(paths.bridge, 'utf8')); } catch { /* not running */ }
        if (state && Number.isInteger(state.port) && state.port > 0 && state.port < 65536 && /^[A-Za-z0-9_-]{43}$/.test(state.secret || '')) {
          try {
            const response = await fetch(`http://127.0.0.1:${state.port}/pair`, { method: 'POST', redirect: 'error',
              headers: { Authorization: `Bearer ${state.secret}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, instanceId: request.instanceId, label: String(request.label || 'Chrome').slice(0, 80) }),
              signal: AbortSignal.timeout(75000),
            });
            const result = await response.json(); clearTimeout(timer); finish(result); return;
          } catch { /* stale bridge record, wake the desktop app once */ }
        }
        if (!started) {
          const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
          const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
          child.on('error', () => {}); child.unref(); started = true;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('桌面端未响应，请先打开 ContextFlow 再重试。');
    } catch (error) { clearTimeout(timer); finish({ ok: false, error: error.message }); }
  });
}
