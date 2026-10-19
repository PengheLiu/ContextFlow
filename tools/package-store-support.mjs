import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeFiles = [
  'server/agent.mjs', 'server/assets.mjs', 'server/config.mjs', 'server/convo.mjs',
  'server/db.mjs', 'server/extension-pairing.mjs', 'server/index.mjs', 'server/jobs.mjs',
  'server/layout.mjs', 'server/llm.mjs', 'server/lookup.mjs', 'server/mdfile.mjs', 'server/paths.mjs',
  'server/obsidian.mjs', 'server/origin.mjs', 'server/siyuan.mjs', 'server/sync.mjs',
  'src/core/assets.js', 'src/core/lookupkey.js', 'src/core/markdown.js',
  'tools/pair-extension.mjs', 'tools/service.mjs', 'package-lock.json', 'LICENSE',
];

export function packageStoreSupport(output = join(root, 'release')) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const temporary = mkdtempSync(join(tmpdir(), 'contextflow-support-'));
  const artifacts = [];
  const copy = (source, destination) => {
    const path = join(root, source);
    if (!lstatSync(path).isFile()) throw new Error(`发布源文件必须为普通文件：${source}`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  };
  const archive = (name, directory, files) => {
    const filename = `${name}-${manifest.version}.zip`;
    const staged = join(temporary, filename);
    execFileSync('zip', ['-q', staged, ...files], { cwd: directory });
    const bytes = readFileSync(staged);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(output, { recursive: true });
    const path = join(output, filename);
    writeFileSync(path, bytes);
    writeFileSync(`${path}.sha256`, `${sha256}  ${filename}\n`);
    artifacts.push({ path, sha256 });
  };
  try {
    const companion = join(temporary, 'companion');
    for (const file of runtimeFiles) copy(file, join(companion, file));
    copy('store/COMPANION.md', join(companion, 'README.md'));
    copy('store/privacy.html', join(companion, 'privacy.html'));
    const scripts = Object.fromEntries(['server', 'pair', 'service'].map(name => [name, manifest.scripts[name]]));
    writeFileSync(join(companion, 'package.json'), `${JSON.stringify({ ...manifest, scripts }, null, 2)}\n`);
    archive('contextflow-companion', companion, [...runtimeFiles, 'README.md', 'privacy.html', 'package.json']);

    const site = join(temporary, 'site');
    const pages = ['index.html', 'privacy.html', 'demo.html'];
    for (const file of pages) copy(`store/${file}`, join(site, file));
    archive('contextflow-store-site', site, pages);
    return artifacts;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const artifact of packageStoreSupport()) {
    console.log(`发布准备包：${artifact.path}\nSHA-256：${artifact.sha256}`);
  }
}
