const MAX_BLOB_BYTES = 8 * 1024 * 1024;

export const EXTENSION_CONTEXT_INVALIDATED = 'EXTENSION_CONTEXT_INVALIDATED';
const contextLost = () => Object.assign(new Error('扩展已更新或重载，本页保存通道已断开。请先复制或下载未保存内容，再刷新页面恢复。'), { code: EXTENSION_CONTEXT_INVALIDATED });

export function runtimeFailure(cause) {
  if (cause?.code === EXTENSION_CONTEXT_INVALIDATED) return cause;
  if (/extension context invalidated|context has been invalidated|reading ['"](?:sendMessage|runtime|lastError)['"]/i.test(String(cause?.message || cause || ''))) return contextLost();
  return Object.assign(new Error('扩展后台暂时无法连接，尚未确认保存。请保留内容后重试。'), { code: 'EXTENSION_BACKGROUND_UNAVAILABLE' });
}

export function extensionRuntime(method) {
  try {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime || method && typeof runtime[method] !== 'function') throw contextLost();
    return runtime;
  } catch { throw contextLost(); }
}

// One guarded channel for private storage and companion requests. A reloaded
// extension leaves orphaned content scripts alive, but their runtime APIs can
// disappear or throw. Never turn that into a page-origin storage fallback.
export function sendRuntimeMessage(message, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const finish = (error, response) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(response);
    };
    try {
      const runtime = extensionRuntime('sendMessage');
      timer = setTimeout(() => {
        try {
          extensionRuntime('sendMessage');
          finish(Object.assign(new Error('扩展后台未响应，尚未确认保存。请保留内容后重试。'), { code: 'EXTENSION_TIMEOUT' }));
        } catch (error) { finish(runtimeFailure(error)); }
      }, timeoutMs);
      runtime.sendMessage(message, response => {
        try {
          // lastError only exists for the duration of this callback. Read it
          // even after a deadline, without settling a late callback again.
          const error = runtime.lastError;
          if (done) return;
          extensionRuntime('sendMessage');
          finish(error ? runtimeFailure(error) : null, response);
        } catch (error) { finish(runtimeFailure(error)); }
      });
    } catch (error) { finish(runtimeFailure(error)); }
  });
}

export async function encodeMessage(value) {
  if (value instanceof Blob) {
    if (value.size > MAX_BLOB_BYTES) throw new Error('图片不能超过 8 MB');
    const bytes = new Uint8Array(await value.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return { __contextflowBlob: true, mime: value.type, data: btoa(binary) };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeMessage));
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeMessage(item)])));
  }
  return value;
}

export function decodeMessage(value) {
  if (value?.__contextflowBlob === true) {
    if (typeof value.data !== 'string' || value.data.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4) {
      throw new Error('图片数据无效或过大');
    }
    const binary = atob(value.data);
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type: value.mime });
  }
  if (Array.isArray(value)) return value.map(decodeMessage);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeMessage(item)]));
  }
  return value;
}

export async function request(message) {
  const encoded = await encodeMessage(message);
  const response = await sendRuntimeMessage(encoded, { timeoutMs: message.type === 'cf-connect-native' ? 95000 : 30000 });
  if (!response?.ok) throw Object.assign(new Error(response?.error || '扩展后台尚未确认操作成功，请保留内容后重试。'), { code: response?.code || 'EXTENSION_BACKGROUND_UNAVAILABLE' });
  return decodeMessage(response.value);
}
