import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { spawn } from 'node:child_process';

// Reading actions belong in Chrome, even if the OS default browser is Safari.
// Never enumerate Chrome profiles or pass a page-controlled executable/URL.
export function chromeCommand(url, { platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (!['https://pengheliu.github.io/ContextFlow/demo.html'].includes(url)) throw new Error('不允许的阅读地址');
  if (platform === 'darwin') return { file: '/usr/bin/open', args: ['-b', 'com.google.Chrome', url] };
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    const file = roots.map(root => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(exists);
    if (file) return { file, args: [url] };
  }
  return null;
}
export async function openReadingInChrome(url, { execute, spawnProcess = spawn, ...options } = {}) {
  const command = chromeCommand(url, options);
  if (!command) throw new Error('未找到 Chrome。请回到安装了 ContextFlow 的 Chrome 配置中打开练习文章：https://pengheliu.github.io/ContextFlow/demo.html');
  try {
    if (command.file === '/usr/bin/open') await execute(command.file, command.args);
    else await new Promise((resolve, reject) => {
      const child = spawnProcess(command.file, command.args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch { throw new Error('无法打开 Chrome。请回到原来的 Chrome 用户配置中继续阅读，或手动打开练习文章。'); }
  return true;
}
