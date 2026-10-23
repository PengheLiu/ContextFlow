const MAX_BLOB_BYTES = 8 * 1024 * 1024;

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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('扩展后台无响应，请刷新网页后重试')), message.type === 'cf-connect-native' ? 95000 : 30000);
    chrome.runtime.sendMessage(encoded, (response) => {
      clearTimeout(timer);
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !response?.ok) {
        reject(new Error(runtimeError?.message || response?.error || '扩展通道不可用'));
      } else {
        try { resolve(decodeMessage(response.value)); } catch (error) { reject(error); }
      }
    });
  });
}
