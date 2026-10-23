export const PROTOCOL_VERSION = 1;
export function validateRequest(path, init = {}) {
  if (typeof path !== 'string' || path.length > 4096 || /[\\#\r\n]/.test(path) || /\.\.|%2f|%5c|%2e/i.test(path)) throw new Error('不允许的服务路径');
  const url = new URL(path, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1') throw new Error('不允许的服务地址');
  const method = init.method || 'GET';
  const allowed = {
    GET: /^\/(health|config|desktop\/state|agents\/detect|llm\/models|obsidian\/vaults|fs\/folders|siyuan\/(notebooks|paths)|jobs\/[A-Za-z0-9_-]+)$/,
    POST: /^\/(config|llm\/(models|test)|agents\/test|sync)$/,
    DELETE: /^\/jobs\/[A-Za-z0-9_-]+$/,
  };
  if (!allowed[method]?.test(url.pathname)) throw new Error('不允许的服务操作');
  if (init.body != null && (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 2 * 1024 * 1024)) throw new Error('请求体过大或格式不正确');
  return { path: url.pathname + url.search, method, body: init.body };
}

export function decodeNative(buffer, { maximum = 64 * 1024 } = {}) {
  if (buffer.length < 4) return null;
  const size = buffer.readUInt32LE(0);
  if (!size || size > maximum) throw new Error('浏览器连接消息过大');
  if (buffer.length < size + 4) return null;
  return { value: JSON.parse(buffer.subarray(4, size + 4).toString('utf8')), rest: buffer.subarray(size + 4) };
}
export function encodeNative(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 1024 * 1024) throw new Error('连接响应过大');
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}
