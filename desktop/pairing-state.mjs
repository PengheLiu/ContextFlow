// Authorization read failures are not an empty grant list. Preserve the file,
// refuse changes, and keep diagnostics/recovery available to the desktop UI.
export const PAIRING_READ_ERROR = '浏览器授权记录无法读取，当前连接已暂停。原文件已保留；请在「设置与帮助」查看处理指引。';

export function browserPairingState(readPairings) {
  try {
    const pairings = readPairings();
    if (!Array.isArray(pairings)) throw new Error('Invalid pairing list');
    return { pairings, pairingError: '' };
  } catch {
    return { pairings: null, pairingError: PAIRING_READ_ERROR };
  }
}

export function requireBrowserPairings(readPairings) {
  const result = browserPairingState(readPairings);
  if (result.pairingError) throw Object.assign(new Error(PAIRING_READ_ERROR), { code: 'PAIRING_STORAGE_UNREADABLE' });
  return result.pairings;
}
