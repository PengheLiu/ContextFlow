import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const release = join(root, 'release');
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-store-'));
const output = join(temporary, 'extension');
const archive = join(release, `contextflow-chrome-${version}.zip`);
const required = ['app.js', 'sw.js', 'options.js', 'options.html', 'options.css', 'privacy.html',
  'manifest.json', 'toolbar-16.png', 'toolbar-32.png', 'toolbar-48.png', 'toolbar-128.png'];

try {
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    cwd: root,
    env: { ...process.env, CONTEXTFLOW_DIR: join(temporary, 'empty-config'), CONTEXTFLOW_EXT_DIR: output },
    stdio: 'inherit',
  });
  const actual = readdirSync(output).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...required].sort())) throw new Error('发布目录包含缺失或非预期文件');
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  if (manifest.key || manifest.manifest_version !== 3 || manifest.version !== version) throw new Error('商店 manifest 不符合要求');
  for (const file of actual.filter((name) => /\.(js|json|html|css)$/.test(name))) {
    const text = readFileSync(join(output, file), 'utf8');
    if (/__CONTEXTFLOW_TOKEN__|cf-test-token-|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      throw new Error(`发布文件包含凭证残留或未替换标记：${file}`);
    }
  }
  mkdirSync(release, { recursive: true });
  const stagedArchive = join(temporary, 'extension.zip');
  execFileSync('zip', ['-q', stagedArchive, ...required], { cwd: output });
  const bytes = readFileSync(stagedArchive);
  if (existsSync(archive)) {
    const existing = readFileSync(archive);
    if (!existing.equals(bytes)) console.log('重新生成同版本本地产物；若此版本已上传商店，请先递增 package.json 版本。');
  }
  writeFileSync(archive, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${archive}.sha256`, `${digest}  contextflow-chrome-${version}.zip\n`);
  console.log(`商店 ZIP：${archive}`);
  console.log(`SHA-256：${digest}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
