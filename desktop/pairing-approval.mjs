// Lifetime of one explicit browser approval. A successful dialog is not enough:
// the same request must still be live when its credential is persisted.
export async function approveBrowserPairing({ request, response, ask, grant,
  timeoutMs = 65000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('无效的连接申请期限');
  const deadline = now() + timeoutMs, controller = new AbortController();
  const expired = Symbol('expired');
  let reason = '', resolveExpired, timer;
  const expiration = new Promise(resolve => { resolveExpired = resolve; });
  const expire = why => {
    if (reason) return;
    reason = why; controller.abort(); resolveExpired(expired);
  };
  const disconnected = () => expire('disconnected');
  const live = () => {
    if (request.aborted || response.destroyed || response.writableEnded) expire('disconnected');
    else if (now() >= deadline) expire('timeout');
    return !reason;
  };
  const failure = () => ({ ok: false, error: reason === 'timeout'
    ? '连接申请已超时，未授予浏览器权限。请回到扩展，重新点击「连接桌面端」。'
    : '浏览器连接已结束，未授予权限。请回到扩展，重新点击「连接桌面端」。' });
  request.once('aborted', disconnected);
  response.once('close', disconnected);
  timer = setTimer(() => expire('timeout'), timeoutMs);
  timer?.unref?.();
  try {
    if (!live()) return failure();
    // Even a platform dialog which ignores AbortSignal cannot grant later:
    // only the winner of this race can reach the synchronous grant below.
    const answer = await Promise.race([Promise.resolve().then(() => ask(controller.signal)), expiration]);
    if (!live() || answer === expired) return failure();
    if (answer?.response !== 1) return { ok: false, error: '已取消连接，未授予浏览器访问权限。' };
    // No await between final liveness check and the durable write.
    return { ok: true, token: grant() };
  } catch (error) {
    if (!live()) return failure();
    throw error;
  } finally {
    clearTimer(timer);
    request.removeListener('aborted', disconnected);
    response.removeListener('close', disconnected);
  }
}
