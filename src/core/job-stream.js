// Shared by the userscript client and the extension's trusted service worker.
// Only job snapshots are accepted; comments are heartbeats, never executable data.
export async function readJobStream(response, onJob, { signal, idleMs = 45000 } = {}) {
  if (response.status !== 200 || !response.headers?.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new Error('任务事件流不可用');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', timer;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
      const part = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('任务事件流中断')), idleMs); }),
      ]);
      clearTimeout(timer);
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new Error('任务事件过大');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const message = JSON.parse(data);
        if (message?.job && typeof message.job.status === 'string') onJob(message.job);
      }
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
