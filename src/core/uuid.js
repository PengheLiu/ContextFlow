// crypto.randomUUID is secure-context-only, while getRandomValues is available
// on ordinary HTTP pages too. IDs must keep CSPRNG quality in either context.
export function randomUUID(source = globalThis.crypto) {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') {
    throw new Error('当前环境无法安全生成记录编号，请更新浏览器后重试。');
  }
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 version 4.
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant 10xx.
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
