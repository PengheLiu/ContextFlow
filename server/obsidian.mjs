// Obsidian 相关的探测辅助。
//
// 写入走 mdfile.mjs（直接写 vault 里的 .md 文件，零插件依赖）；
// 这里只负责把本机已有的 vault 找出来，让配置界面能像选模型那样下拉选，
// 不用用户手抄路径。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Obsidian 把 vault 列表存在这个文件里（各平台位置不同） */
function registryPath() {
  const h = homedir();
  switch (platform()) {
    case 'darwin': return join(h, 'Library/Application Support/obsidian/obsidian.json');
    case 'win32': return join(process.env.APPDATA || join(h, 'AppData/Roaming'), 'obsidian/obsidian.json');
    default: return join(process.env.XDG_CONFIG_HOME || join(h, '.config'), 'obsidian/obsidian.json');
  }
}

/** @returns {Array<{path:string, name:string, open:boolean, exists:boolean}>} */
export function detectVaults() {
  const f = registryPath();
  if (!existsSync(f)) return [];
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    return Object.values(d.vaults || {})
      .map((v) => ({
        path: v.path,
        name: String(v.path).split('/').filter(Boolean).pop() || v.path,
        open: !!v.open,
        exists: existsSync(v.path),
      }))
      .filter((v) => v.exists)
      .sort((a, b) => Number(b.open) - Number(a.open));   // 当前打开的排最前
  } catch {
    return [];
  }
}

// 不列举这些：Obsidian 内部目录、版本控制、依赖
const SKIP_DIR = new Set(['.obsidian', '.trash', '.git', '.svn', 'node_modules', '.DS_Store']);

/**
 * 列举 root 下已有的目录（相对路径，形如 /Clippings）。
 *
 * 注意 root 由**服务端**从配置解析，不接受客户端传路径 ——
 * 否则这个端点等于把本地服务变成任意文件系统浏览器。
 */
export function listFolders(root, maxDepth = 3) {
  if (!root || !existsSync(root)) return [];
  const out = ['/'];
  const walk = (dir, rel, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const r = `${rel}/${e.name}`;
      out.push(r);
      walk(`${dir}/${e.name}`, r, depth + 1);
    }
  };
  walk(root, '', 1);
  return out.sort();
}
