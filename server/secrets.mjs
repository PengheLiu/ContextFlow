import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'contextflow:sealed:v1:';
const fields = [['translate', 'apiKey'], ['siyuan', 'token'], ['agent', 'env']];
export function transformSecrets(config, mode, encodedKey = process.env.CONTEXTFLOW_SECRET_KEY) {
  const out = structuredClone(config);
  for (const [section, field] of fields) {
    const value = out[section]?.[field];
    if (value == null || value === '') continue;
    if (mode === 'decode' && (typeof value !== 'string' || !value.startsWith(PREFIX))) continue;
    if (!encodedKey) {
      if (mode === 'decode') throw Object.assign(new Error('此配置的密钥由桌面端保护，请通过 ContextFlow 桌面应用启动服务。'), { code: 'CONFIG_SECRET_LOCKED' });
      continue;
    }
    const key = Buffer.from(encodedKey, 'base64');
    if (key.length !== 32) throw Object.assign(new Error('无效的桌面密钥'), { code: 'CONFIG_SECRET_LOCKED' });
    if (mode === 'encode') {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${section}.${field}`));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      out[section][field] = PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    } else {
      try {
        const data = Buffer.from(value.slice(PREFIX.length), 'base64');
        if (data.length < 29) throw new Error('Invalid encrypted value');
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${section}.${field}`)); decipher.setAuthTag(data.subarray(12, 28));
        out[section][field] = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
      }
      catch { throw Object.assign(new Error('无法解密本地配置，请检查桌面端密钥或恢复备份。'), { code: 'CONFIG_SECRET_LOCKED' }); }
    }
  }
  return out;
}
