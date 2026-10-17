import { setBrowserStorage } from '../core/browser-storage.js';
import { setOfflineTransport } from '../core/offline-store.js';
import { request } from './rpc.js';

const preferenceKeys = new Set(['contextflow:ui', 'contextflow:pop', 'contextflow:blocklist']);
const values = new Map();
let pendingWrites = Promise.resolve();

function persist(key, value) {
  pendingWrites = pendingWrites.then(() => request({ type: 'cf-ui-write', key, value })).catch((error) => {
    console.error('[ContextFlow] 无法保存扩展偏好：', error.message);
  });
}

setBrowserStorage({
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) {
    if (!preferenceKeys.has(key)) return;
    values.set(key, String(value));
    persist(key, String(value));
  },
  removeItem(key) {
    if (!preferenceKeys.has(key)) return;
    values.delete(key);
    persist(key, null);
  },
});

setOfflineTransport((method, args) => request({ type: 'cf-offline', method, args }));

export async function initializePrivateStorage() {
  const snapshot = await request({ type: 'cf-ui-snapshot' });
  for (const [key, value] of Object.entries(snapshot)) {
    if (preferenceKeys.has(key) && typeof value === 'string') values.set(key, value);
  }
}
