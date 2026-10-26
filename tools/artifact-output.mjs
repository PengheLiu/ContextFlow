import { lstatSync, mkdirSync, realpathSync, readFileSync, openSync, closeSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const info = path => lstatSync(path, { throwIfNoEntry: false });
const inside = (root, path) => {
  const value = relative(root, path);
  return !!value && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};

export function ensureArtifactDirectory(directory, repository) {
  const root = resolve(repository), target = resolve(directory);
  if (!inside(root, target)) throw new Error('交付目录必须在当前源码目录内。');
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    const entry = info(current);
    if (entry) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('构建或交付目录的各级路径必须是普通目录，不能是符号链接。');
    } else mkdirSync(current);
  }
  if (!inside(realpathSync(root), realpathSync(target))) throw new Error('交付目录解析后越出源码目录。');
  return target;
}

function matches(path, bytes) {
  const entry = info(path);
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`交付目标必须是普通文件，不能是符号链接：${basename(path)}`);
  if (entry.size !== bytes.length || !readFileSync(path).equals(bytes)) {
    throw new Error(`已存在不同内容的交付文件，不可覆盖：${basename(path)}。请递增版本或使用独立交付目录。`);
  }
  return true;
}

// Preflight every artifact and sidecar before creating any. Publish complete
// staged files with an exclusive hard link; never rename over a frozen file.
export function publishImmutableArtifacts(entries, { directory, repository }) {
  const target = ensureArtifactDirectory(directory, repository), names = new Set();
  const plan = entries.map(({ name, bytes }) => {
    if (typeof name !== 'string' || name !== basename(name) || /[\\/\u0000-\u001f\u007f]/.test(name) || ['.', '..'].includes(name) || names.has(name)) throw new Error('交付文件名无效或重复。');
    names.add(name);
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const path = join(target, name);
    return { path, bytes: data, exists: matches(path, data) };
  });
  const staged = [], created = [];
  try {
    for (const row of plan.filter(row => !row.exists)) {
      const temporary = join(target, `.${basename(row.path)}.${randomUUID()}.tmp`);
      const descriptor = openSync(temporary, 'wx', 0o644);
      staged.push({ ...row, temporary });
      try { writeFileSync(descriptor, row.bytes); } finally { closeSync(descriptor); }
    }
    for (const row of staged) {
      try { linkSync(row.temporary, row.path); created.push(row.path); }
      catch (error) {
        // Another concurrent packager may have published identical bytes.
        if (error.code !== 'EEXIST' || !matches(row.path, row.bytes)) throw error;
      }
    }
    return plan.map(row => row.path);
  } catch (error) {
    for (const path of created.reverse()) unlinkSync(path);
    throw error;
  } finally {
    for (const { temporary } of staged) unlinkSync(temporary);
  }
}
