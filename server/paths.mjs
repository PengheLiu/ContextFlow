import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function normalizeRoot(value) {
  let root = String(value || '').trim();
  if ((root.startsWith('"') && root.endsWith('"')) || (root.startsWith("'") && root.endsWith("'"))) root = root.slice(1, -1);
  if (root === '~') root = homedir();
  else if (/^~[/\\]/.test(root)) root = join(homedir(), root.slice(2));
  if (root && !isAbsolute(root)) throw Object.assign(new Error('保存位置请填写绝对路径，或使用 ~/ 开头的用户目录'), { code: 'BAD_TARGET' });
  return root ? resolve(root) : '';
}

export function resolveWithin(root, folder) {
  const base = normalizeRoot(root);
  const target = resolve(base, String(folder || '').replace(/^[/\\]+/, ''));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw Object.assign(new Error('子目录不能越出根目录，请移除 ../'), { code: 'BAD_TARGET' });
  }
  return target;
}
